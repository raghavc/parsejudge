import { Data, Effect } from "effect";
import { PDFDocument } from "pdf-lib";

export class InvalidDocument extends Data.TaggedError("InvalidDocument")<{ readonly message: string }> {}

/** Splits a PDF into single-page PDFs, in page order. */
export const splitPages = (bytes: Uint8Array, maxPages: number) =>
  Effect.tryPromise({
    try: async () => {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const count = source.getPageCount();
      if (count > maxPages) throw new RangeError(`Document has ${count} pages; the limit is ${maxPages}.`);
      const pages: Array<Uint8Array> = [];
      for (let index = 0; index < count; index++) {
        const page = await PDFDocument.create();
        const [copied] = await page.copyPages(source, [index]);
        if (copied !== undefined) page.addPage(copied);
        pages.push(await page.save());
      }
      return pages;
    },
    catch: (error) =>
      new InvalidDocument({
        message: error instanceof RangeError ? error.message : `File is not a readable PDF: ${String(error).slice(0, 200)}`,
      }),
  });
