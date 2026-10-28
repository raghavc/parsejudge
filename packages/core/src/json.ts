export type JsonRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const record = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

export const array = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

export const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const joinNonEmpty = (parts: ReadonlyArray<string>, separator = "\n\n"): string =>
  parts.filter((part) => part.length > 0).join(separator);

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};
