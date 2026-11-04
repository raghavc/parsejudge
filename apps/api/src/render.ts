import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import pdfiumWasm from "../node_modules/@embedpdf/pdfium/dist/pdfium.wasm";
import { encodePng } from "./png.ts";

const DPI = 200;
const MAX_DIMENSION = 2400;
const BITMAP_BGRA = 4;
const RENDER_ANNOTATIONS = 0x01;

let pdfium: Promise<WrappedPdfiumModule> | undefined;

const module = () => {
  pdfium ??= init({
    instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
      WebAssembly.instantiate(pdfiumWasm, imports).then((instance) => receive(instance));
      return {};
    },
  }).then((loaded) => {
    loaded.FPDF_InitLibrary();
    return loaded;
  });
  return pdfium;
};

/** Renders the first page of a PDF to PNG bytes. */
export const renderFirstPagePng = async (pdf: Uint8Array): Promise<Uint8Array> => {
  const m = await module();
  const pdfPtr = m.pdfium.wasmExports.malloc(pdf.length);
  m.pdfium.HEAPU8.set(pdf, pdfPtr);
  const doc = m.FPDF_LoadMemDocument(pdfPtr, pdf.length, "");
  // Every allocation is freed on every path, or failed renders would leak wasm memory until renders fail.
  try {
    if (doc === 0) throw new Error("PDFium could not open the page.");
    const page = m.FPDF_LoadPage(doc, 0);
    if (page === 0) throw new Error("PDFium could not load the page.");
    try {
      const widthPt = m.FPDF_GetPageWidthF(page);
      const heightPt = m.FPDF_GetPageHeightF(page);
      const scale = Math.min(DPI / 72, MAX_DIMENSION / Math.max(widthPt, heightPt));
      const width = Math.max(1, Math.round(widthPt * scale));
      const height = Math.max(1, Math.round(heightPt * scale));
      const bitmap = m.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, 0, 0);
      if (bitmap === 0) throw new Error(`PDFium could not allocate a ${width}x${height} bitmap.`);
      try {
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_ANNOTATIONS);
        const stride = m.FPDFBitmap_GetStride(bitmap);
        const buffer = m.FPDFBitmap_GetBuffer(bitmap);
        return encodePng(m.pdfium.HEAPU8.slice(buffer, buffer + stride * height), width, height, stride);
      } finally {
        m.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
  } finally {
    if (doc !== 0) m.FPDF_CloseDocument(doc);
    m.pdfium.wasmExports.free(pdfPtr);
  }
};
