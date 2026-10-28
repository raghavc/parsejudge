import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidDocument, sniffFormat } from "../src/index.ts";

const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${path}`, import.meta.url)));

describe("sniffFormat", () => {
  it("detects PDF, DOCX and PPTX from their bytes", () => {
    expect(Effect.runSync(sniffFormat(fixture("one.pdf")))).toBe("pdf");
    expect(Effect.runSync(sniffFormat(fixture("two-pages.docx")))).toBe("docx");
    expect(Effect.runSync(sniffFormat(fixture("two-slides.pptx")))).toBe("pptx");
  });

  it("rejects other files, including other ZIPs", () => {
    expect(Effect.runSync(Effect.flip(sniffFormat(new TextEncoder().encode("hello"))))).toBeInstanceOf(InvalidDocument);
    expect(Effect.runSync(Effect.flip(sniffFormat(new TextEncoder().encode("PK\u0003\u0004xl/workbook.xml"))))).toBeInstanceOf(
      InvalidDocument,
    );
  });
});
