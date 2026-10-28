/** R2 object keys. */
/** The upload as received, in its own format. */
export const sourceKey = (documentId: string, format: string) => `documents/${documentId}/source.${format}`;
/** The upload normalized to PDF; pages are split from this. */
export const documentKey = (documentId: string) => `documents/${documentId}.pdf`;
export const pagePdfKey = (pageId: string) => `pages/${pageId}.pdf`;
export const pagePngKey = (pageId: string) => `pages/${pageId}.png`;
export const markdownKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.md`;
export const rawKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.json`;
export const pageId = (documentId: string, index: number) => `${documentId}-${index}`;
