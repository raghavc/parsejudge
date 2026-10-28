import { Effect } from "effect";
import { InvalidDocument } from "./pdf.ts";

/** Formats parsejudge accepts. Everything is normalized to PDF, then to one PNG per page. */
export type DocumentFormat = "pdf" | "docx" | "pptx";

export const MIME_TYPES: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** OOXML part names sit uncompressed in each ZIP local header, so a byte search identifies the format. */
const OOXML_PARTS: ReadonlyArray<readonly [DocumentFormat, string]> = [
  ["docx", "word/document.xml"],
  ["pptx", "ppt/presentation.xml"],
];

/** Detects the format from the bytes, not the filename or content-type. */
export const sniffFormat = (bytes: Uint8Array): Effect.Effect<DocumentFormat, InvalidDocument> => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (head.includes("%PDF-")) return Effect.succeed("pdf");
  if (head.startsWith("PK\u0003\u0004")) {
    const text = new TextDecoder("latin1").decode(bytes);
    const match = OOXML_PARTS.find(([, part]) => text.includes(part));
    if (match !== undefined) return Effect.succeed(match[0]);
  }
  return Effect.fail(new InvalidDocument({ message: "Expected a PDF, DOCX or PPTX file." }));
};
