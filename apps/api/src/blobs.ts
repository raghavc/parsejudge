const encoder = new TextEncoder();

const hmac = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** A public, expiring URL for an R2 object, so providers can fetch a page without our credentials. */
export const signedBlobUrl = async (publicUrl: string, secret: string, key: string, ttlSeconds = 3600) => {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmac(secret, `${key}:${expires}`);
  return `${publicUrl.replace(/\/+$/, "")}/blobs/${key}?exp=${expires}&sig=${signature}`;
};

export const verifyBlobUrl = async (secret: string, key: string, expires: string | null, signature: string | null) => {
  if (expires === null || signature === null || Number(expires) < Date.now() / 1000) return false;
  return (await hmac(secret, `${key}:${expires}`)) === signature;
};
