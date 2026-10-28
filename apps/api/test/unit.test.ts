import { describe, expect, it } from "vitest";
import { signedBlobUrl, verifyBlobUrl } from "../src/blobs.ts";
import { decryptCredentials, encryptCredentials } from "../src/credentials.ts";
import { encodePng } from "../src/png.ts";

const SECRET = "test-secret";

describe("signed blob URLs", () => {
  it("accept their own signature and reject a different key or an expired link", async () => {
    const url = new URL(await signedBlobUrl("https://x.test/", SECRET, "pages/a.pdf"));
    const [exp, sig] = [url.searchParams.get("exp"), url.searchParams.get("sig")];
    expect(url.pathname).toBe("/blobs/pages/a.pdf");
    expect(await verifyBlobUrl(SECRET, "pages/a.pdf", exp, sig)).toBe(true);
    expect(await verifyBlobUrl(SECRET, "pages/b.pdf", exp, sig)).toBe(false);
    expect(await verifyBlobUrl(SECRET, "pages/a.pdf", "1", sig)).toBe(false);
  });
});

describe("credentials", () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

  it("round-trip only under the run id they were sealed for", async () => {
    const sealed = await encryptCredentials(key, "run-1", { LLAMA_CLOUD_API_KEY: "k" });
    expect(await decryptCredentials(key, "run-1", sealed.iv, sealed.ciphertext)).toEqual({ LLAMA_CLOUD_API_KEY: "k" });
    await expect(decryptCredentials(key, "run-2", sealed.iv, sealed.ciphertext)).rejects.toThrow();
  });
});

describe("encodePng", () => {
  it("writes a valid PNG header with the bitmap size", async () => {
    const png = await encodePng(new Uint8Array(3 * 2 * 4).fill(255), 3, 2, 12);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([3, 2]);
  });
});
