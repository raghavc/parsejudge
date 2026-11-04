import type { Credentials } from "@parsejudge/core";
import { Data, Schema } from "effect";

/** CREDENTIALS_KEY is wrong, or the stored keys were changed. Retrying does not help. */
export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{ readonly message: string }> {
  readonly retryable = false;
}

const StoredCredentials = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const key = (secret: string) => crypto.subtle.importKey("raw", fromBase64(secret), "AES-GCM", false, ["encrypt", "decrypt"]);

/** AES-GCM with a 256-bit base64 key (CREDENTIALS_KEY); the run id is bound as additional data. */
export const encryptCredentials = async (secret: string, runId: string, credentials: Credentials) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(runId) },
    await key(secret),
    encoder.encode(JSON.stringify(credentials)),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
};

export const decryptCredentials = async (secret: string, runId: string, iv: string, ciphertext: string): Promise<Credentials> => {
  const plaintext = await (async () =>
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(runId) },
      await key(secret),
      fromBase64(ciphertext),
    ))().catch((error: unknown) => {
    throw new CredentialsUnreadable({ message: `Could not decrypt the keys stored for run ${runId}: ${String(error)}` });
  });
  const decoded = Schema.decodeUnknownExit(StoredCredentials)(decoder.decode(plaintext));
  if (decoded._tag === "Failure")
    throw new CredentialsUnreadable({ message: `The keys stored for run ${runId} are not readable.` });
  return decoded.value;
};
