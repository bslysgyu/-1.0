import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-expect-error pdfjs-dist worker entry has no separate .d.ts file
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type { ParsedBook, ReaderPage, TocItem } from '../types/bookshelf';

export async function ensurePdfWorker(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (!g.pdfjsWorker) {
    g.pdfjsWorker = pdfjsWorker;
  }
}

void ensurePdfWorker();

export async function parsePdfMetadata(
  arrayBuffer: ArrayBuffer,
  extractCoverOnly = false
): Promise<ParsedBook> {
  await ensurePdfWorker();
  const dataCopy = new Uint8Array(arrayBuffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  // Render Page 1 to PNG Blob as automatic cover thumbnail
  let coverBlob: Blob | null = null;
  try {
    const firstPage = await pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1.0 });
    const targetWidth = 360;
    const scale = targetWidth / Math.max(1, viewport.width);
    const scaledViewport = firstPage.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(scaledViewport.width);
    canvas.height = Math.round(scaledViewport.height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await firstPage.render({
        canvasContext: ctx,
        canvas,
        viewport: scaledViewport,
      }).promise;
      coverBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
    }
  } catch {
    coverBlob = null;
  }

  if (extractCoverOnly) {
    await loadingTask.destroy();
    return {
      kind: 'pdf',
      pages: [],
      toc: [],
      coverBlob,
      pdfTotalPages: numPages,
    };
  }

  // Extract PDF Outline (TOC)
  const toc: TocItem[] = [];
  try {
    const outline = await pdfDoc.getOutline();
    if (outline && outline.length > 0) {
      const walkOutline = async (
        items: Awaited<ReturnType<typeof pdfDoc.getOutline>>,
        depth = 0
      ) => {
        if (!items) return;
        for (const item of items) {
          let pageIdx = 0;
          try {
            let dest = item.dest;
            if (typeof dest === 'string') {
              dest = await pdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0]) {
              pageIdx = await pdfDoc.getPageIndex(dest[0]);
            }
          } catch {
            pageIdx = 0;
          }
          const prefix = depth > 0 ? '  '.repeat(Math.min(depth, 3)) + '· ' : '';
          toc.push({
            title: `${prefix}${item.title || `第 ${pageIdx + 1} 页`}`,
            pageIndex: Math.min(Math.max(0, pageIdx), Math.max(0, numPages - 1)),
          });
          if (item.items && item.items.length > 0 && toc.length < 300) {
            await walkOutline(item.items, depth + 1);
          }
        }
      };
      await walkOutline(outline, 0);
    }
  } catch {
    // ignore outline errors
  }

  if (toc.length === 0) {
    const step = numPages > 40 ? 10 : 5;
    for (let i = 0; i < numPages; i += step) {
      toc.push({ title: `第 ${i + 1} 页`, pageIndex: i });
    }
  }

  const pages: ReaderPage[] = Array.from({ length: numPages }, (_, idx) => ({
    html: '',
    plainText: '',
    chapter: `第 ${idx + 1} / ${numPages} 页`,
  }));

  await loadingTask.destroy();

  return {
    kind: 'pdf',
    pages,
    toc,
    coverBlob,
    pdfBytes: arrayBuffer,
    pdfTotalPages: numPages,
  };
}
