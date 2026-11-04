import { Data, Effect } from "effect";
import { PDFDocument } from "pdf-lib";

export class InvalidDocument extends Data.TaggedError("InvalidDocument")<{ readonly message: string }> {}

/** Splits a PDF into single-page PDFs, in page order. */
export const splitPages = (bytes: Uint8Array, maxPages: number) =>
  Effect.gen(function* () {
    const pdf = <A>(load: () => Promise<A>) =>
      Effect.tryPromise({
        try: load,
        catch: (error) => new InvalidDocument({ message: `File is not a readable PDF: ${String(error).slice(0, 200)}` }),
      });
    const source = yield* pdf(() => PDFDocument.load(bytes, { ignoreEncryption: true }));
    const count = source.getPageCount();
    if (count > maxPages) return yield* new InvalidDocument({ message: `Document has ${count} pages; the limit is ${maxPages}.` });
    const pages: Array<Uint8Array> = [];
    for (let index = 0; index < count; index++) {
      const page = yield* pdf(() => PDFDocument.create());
      const [copied] = yield* pdf(() => page.copyPages(source, [index]));
      if (copied !== undefined) page.addPage(copied);
      pages.push(yield* pdf(() => page.save()));
    }
    return pages;
  });
