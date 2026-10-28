/** R2 object keys. */
export const documentKey = (documentId: string) => `documents/${documentId}.pdf`;
export const pagePdfKey = (pageId: string) => `pages/${pageId}.pdf`;
export const pagePngKey = (pageId: string) => `pages/${pageId}.png`;
export const markdownKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.md`;
export const rawKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.json`;
export const pageId = (documentId: string, index: number) => `${documentId}-${index}`;
