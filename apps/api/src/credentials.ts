import type { Credentials } from "@parsejudge/core";

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

export const decryptCredentials = async (secret: string, runId: string, iv: string, ciphertext: string) => {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(runId) },
    await key(secret),
    fromBase64(ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as Credentials;
};
