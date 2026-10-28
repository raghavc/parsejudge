import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import pdfiumWasm from "@embedpdf/pdfium/pdfium.wasm";

const DPI = 150;
const MAX_DIMENSION = 2000;
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
  if (doc === 0) {
    m.pdfium.wasmExports.free(pdfPtr);
    throw new Error("PDFium could not open the page.");
  }
  const page = m.FPDF_LoadPage(doc, 0);
  const widthPt = m.FPDF_GetPageWidthF(page);
  const heightPt = m.FPDF_GetPageHeightF(page);
  const scale = Math.min(DPI / 72, MAX_DIMENSION / Math.max(widthPt, heightPt));
  const width = Math.max(1, Math.round(widthPt * scale));
  const height = Math.max(1, Math.round(heightPt * scale));
  const bitmap = m.FPDFBitmap_CreateEx(width, height, BITMAP_BGRA, 0, 0);
  m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
  m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_ANNOTATIONS);
  const pngSizePtr = m.pdfium.wasmExports.malloc(4);
  const pngPtr = m.EPDF_PNG_EncodeRGBA(m.FPDFBitmap_GetBuffer(bitmap), width, height, width * 4, 0, pngSizePtr);
  const pngSize = m.pdfium.getValue(pngSizePtr, "i32");
  const png = m.pdfium.HEAPU8.slice(pngPtr, pngPtr + pngSize);
  m.pdfium.wasmExports.free(pngPtr);
  m.pdfium.wasmExports.free(pngSizePtr);
  m.FPDFBitmap_Destroy(bitmap);
  m.FPDF_ClosePage(page);
  m.FPDF_CloseDocument(doc);
  m.pdfium.wasmExports.free(pdfPtr);
  return png;
};
