import { Effect, Exit } from "effect";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { splitPages } from "../src/pdf.ts";

const makePdf = async (pages: number) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300]);
  return doc.save();
};

describe("splitPages", () => {
  it("splits into single-page PDFs in order", async () => {
    const pages = await Effect.runPromise(splitPages(await makePdf(3), 10));
    expect(pages).toHaveLength(3);
    const widths = await Promise.all(pages.map(async (bytes) => (await PDFDocument.load(bytes)).getPage(0).getWidth()));
    expect(widths).toEqual([200, 201, 202]);
  });

  it("rejects documents over the page limit and non-PDF bytes", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(splitPages(await makePdf(3), 2)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(splitPages(new TextEncoder().encode("hello"), 2)))).toBe(true);
  });
});
