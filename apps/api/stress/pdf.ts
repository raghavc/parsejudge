/** Small, real-looking PDFs: a title, paragraphs and a ruled table per page, in Helvetica. No dependencies. */

const WORDS =
  "the invoice total amount due net thirty days payment terms account statement balance forward period ending revenue cost of goods sold operating expenses schedule quarter fiscal year tax rate deferred accrued liabilities".split(
    " ",
  );

const escapeText = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

const words = (random: () => number, n: number) =>
  Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");

/** Seeded so a document's pages are stable between harness runs. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

const pageContent = (random: () => number, title: string, index: number) => {
  const lines: Array<string> = ["BT /F2 16 Tf 72 720 Td", `(${escapeText(`${title} - page ${index + 1}`)}) Tj ET`];
  let y = 690;
  for (let p = 0; p < 3; p++) {
    for (let l = 0; l < 4; l++) {
      lines.push(`BT /F1 10 Tf 72 ${y} Td (${escapeText(words(random, 12))}) Tj ET`);
      y -= 14;
    }
    y -= 10;
  }
  const rows = 6;
  const top = y - 10;
  for (let r = 0; r <= rows; r++) lines.push(`72 ${top - r * 20} m 540 ${top - r * 20} l S`);
  for (const x of [72, 300, 420, 540]) lines.push(`${x} ${top} m ${x} ${top - rows * 20} l S`);
  for (let r = 0; r < rows; r++) {
    const cells = [words(random, 3), (random() * 10000).toFixed(2), (random() * 100).toFixed(1)];
    [76, 304, 424].forEach((x, c) => {
      lines.push(
        `BT /F${r === 0 ? 2 : 1} 9 Tf ${x} ${top - r * 20 - 14} Td (${escapeText(r === 0 ? (["Item", "Amount", "Rate %"][c] ?? "") : (cells[c] ?? ""))}) Tj ET`,
      );
    });
  }
  lines.push(`BT /F1 8 Tf 300 40 Td (${index + 1}) Tj ET`);
  return lines.join("\n");
};

export const makePdf = (title: string, pageCount: number, seed: number): Uint8Array<ArrayBuffer> => {
  const random = seeded(seed);
  const objects: Array<string> = [];
  const add = (body: string) => objects.push(body) - 1 + 1;
  const catalog = add("");
  const pages = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids: Array<number> = [];
  for (let index = 0; index < pageCount; index++) {
    const content = pageContent(random, title, index);
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
};
