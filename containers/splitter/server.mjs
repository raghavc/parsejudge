// POST /split?max=N with a PDF body. Answers 422 (text) when the PDF is unreadable or has more than N pages.
// Otherwise 200 with frames: a uint32 page count, then per page a uint32 length and that page's PDF.
// Pages are written as they are made, so the caller can store each one without holding them all.
import { createServer } from "node:http";
import { PDFDocument } from "pdf-lib";

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

const write = (res, chunk) => (res.write(chunk) ? Promise.resolve() : new Promise((r) => res.once("drain", r)));

const reject = (res, message) => {
  res.writeHead(422, { "content-type": "text/plain" });
  res.end(message);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://splitter");
  if (req.method === "GET" && url.pathname === "/ping") return res.end("ok");
  if (req.method !== "POST" || url.pathname !== "/split") {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let source;
  try {
    source = await PDFDocument.load(Buffer.concat(chunks), { ignoreEncryption: true });
  } catch (error) {
    return reject(res, `File is not a readable PDF: ${String(error).slice(0, 200)}`);
  }
  const count = source.getPageCount();
  const max = Number(url.searchParams.get("max") ?? Infinity);
  if (count > max) return reject(res, `Document has ${count} pages; the limit is ${max}.`);
  res.writeHead(200, { "content-type": "application/octet-stream" });
  try {
    await write(res, u32(count));
    for (let index = 0; index < count; index++) {
      const page = await PDFDocument.create();
      const [copied] = await page.copyPages(source, [index]);
      if (copied !== undefined) page.addPage(copied);
      const bytes = await page.save();
      await write(res, u32(bytes.length));
      await write(res, bytes);
    }
    res.end();
  } catch (error) {
    console.error("split failed", error);
    res.destroy(error);
  }
}).listen(8080);
