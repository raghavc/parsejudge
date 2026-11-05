import { Effect } from "effect";
import { InvalidDocument } from "./pdf.ts";

/** Formats parsejudge accepts. Everything is normalized to PDF, then to one PNG per page. */
export type DocumentFormat = "pdf" | "docx" | "pptx";

export const MIME_TYPES: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The part that only a DOCX or only a PPTX package contains. */
const MAIN_PARTS: ReadonlyArray<readonly [DocumentFormat, string]> = [
  ["docx", "word/document.xml"],
  ["pptx", "ppt/presentation.xml"],
];

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

/** Entry names from a ZIP's central directory, or none if the bytes are not a ZIP. */
const zipEntries = (bytes: Uint8Array): ReadonlyArray<string> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let end = bytes.length - 22; end >= lowest; end--) {
    if (view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const names: Array<string> = [];
    let offset = view.getUint32(end + 16, true);
    for (let i = view.getUint16(end + 10, true); i > 0 && offset + 46 <= bytes.length; i--) {
      if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) return [];
      const nameLength = view.getUint16(offset + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return names;
  }
  return [];
};

/** Detects the format from the bytes, not the filename or content-type. */
export const sniffFormat = (bytes: Uint8Array): Effect.Effect<DocumentFormat, InvalidDocument> => {
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) return Effect.succeed("pdf");
  const entries = new Set(zipEntries(bytes));
  const match = MAIN_PARTS.find(([, part]) => entries.has(part));
  return match !== undefined
    ? Effect.succeed(match[0])
    : Effect.fail(new InvalidDocument({ message: "Expected a PDF, DOCX or PPTX file." }));
};
