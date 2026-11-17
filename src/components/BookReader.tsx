import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  SlidersHorizontal,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  BookMetadata,
  ParsedBook,
  QuickActionType,
  ReaderPrefs,
  ReaderTheme,
} from '../types/bookshelf';
import { formatPercent } from '../utils/dateStats';
import { ensurePdfWorker } from '../utils/pdfService';

interface BookReaderProps {
  book: BookMetadata;
  parsedBook: ParsedBook;
  initialPage: number;
  prefs: ReaderPrefs;
  onPrefsChange: (prefs: ReaderPrefs) => void;
  onProgressChange: (page: number, totalPages: number) => void;
  onExit: (finalPage: number, totalPages: number) => void;
  onSelectTextAction: (text: string, action: QuickActionType | 'quote') => void;
  onPageTextChange?: (plainText: string) => void;
}

const THEME_OPTIONS: {
  id: ReaderTheme;
  label: string;
  bgClass: string;
  swatchStyle: React.CSSProperties;
}[] = [
  {
    id: 'paper',
    label: '纸白',
    bgClass: 'bg-[#fbf8f1] text-[#2c2923]',
    swatchStyle: { background: '#fbf8f1', color: '#2c2923' },
  },
  {
    id: 'warm',
    label: '羊皮',
    bgClass: 'bg-[#f3e9d2] text-[#3d3121]',
    swatchStyle: { background: '#f3e9d2', color: '#3d3121' },
  },
  {
    id: 'green',
    label: '护眼',
    bgClass: 'bg-[#e7f0e6] text-[#233325]',
    swatchStyle: { background: '#e7f0e6', color: '#233325' },
  },
  {
    id: 'night',
    label: '夜间',
    bgClass: 'bg-[#1d1f21] text-[#cfd3d8]',
    swatchStyle: { background: '#1d1f21', color: '#cfd3d8' },
  },
];

export const BookReader: React.FC<BookReaderProps> = ({
  book,
  parsedBook,
  initialPage,
  prefs,
  onPrefsChange,
  onProgressChange,
  onExit,
  onSelectTextAction,
  onPageTextChange,
}) => {
  const totalPages = parsedBook.pages.length;
  const [pageIdx, setPageIdx] = useState(() =>
    Math.min(Math.max(0, initialPage), Math.max(0, totalPages - 1))
  );
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // PDF document state
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfRenderSize, setPdfRenderSize] = useState({ width: 0, height: 0 });
  const pdfScale = prefs.pdfScale ?? 1.25;

  const [selectionState, setSelectionState] = useState<{
    visible: boolean;
    text: string;
    top: number;
    left: number;
  }>({ visible: false, text: '', top: 0, left: 0 });

  const bodyWrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const pdfTextLayerRef = useRef<HTMLDivElement>(null);

  const currentPage = parsedBook.pages[pageIdx] || parsedBook.pages[0];
  const currentPercent =
    totalPages <= 1 ? 100 : Math.round((pageIdx / (totalPages - 1)) * 1000) / 10;

  const activeTheme = THEME_OPTIONS.find((t) => t.id === prefs.theme) || THEME_OPTIONS[0];
  const isNight = prefs.theme === 'night';

  // Load PDF document when kind === 'pdf'
  useEffect(() => {
    if (parsedBook.kind !== 'pdf' || !parsedBook.pdfBytes) {
      setPdfDoc(null);
      return;
    }
    let cancelled = false;
    setPdfLoading(true);
    let activeTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    ensurePdfWorker()
      .then(() => {
        if (cancelled) return;
        const task = pdfjsLib.getDocument({
          data: new Uint8Array(parsedBook.pdfBytes!.slice(0)),
        });
        activeTask = task;
        return task.promise;
      })
      .then((doc) => {
        if (!doc) return;
        if (cancelled) {
          activeTask?.destroy();
          return;
        }
        setPdfDoc(doc);
        setPdfLoading(false);
      })
      .catch(() => {
        if (!cancelled) setPdfLoading(false);
      });

    return () => {
      cancelled = true;
      activeTask?.destroy();
    };
  }, [parsedBook]);

  // Render active PDF page onto Canvas + Selectable TextLayer
  useEffect(() => {
    if (parsedBook.kind !== 'pdf' || !pdfDoc) return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let textLayerInstance: pdfjsLib.TextLayer | null = null;

    const renderPdfPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageIdx + 1);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: pdfScale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const canvas = pdfCanvasRef.current;
        const textLayerDiv = pdfTextLayerRef.current;
        if (!canvas || !textLayerDiv) return;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        setPdfRenderSize({
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height),
        });

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        });
        await renderTask.promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        // Expose plain text to Doubao Assistant
        const pagePlain = textContent.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        onPageTextChange?.(pagePlain);

        textLayerDiv.innerHTML = '';
        textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
        textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
        textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale));

        textLayerInstance = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayerInstance.render();
      } catch {
        // ignore cancelled render tasks
      }
    };

    renderPdfPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerInstance?.cancel();
    };
  }, [parsedBook.kind, pdfDoc, pageIdx, pdfScale, onPageTextChange]);

  // Sync non-PDF page plain text
  useEffect(() => {
    if (parsedBook.kind !== 'pdf') {
      onPageTextChange?.(currentPage?.plainText || '');
    }
  }, [parsedBook.kind, currentPage, onPageTextChange]);

  const goToPage = useCallback(
    (nextIdx: number) => {
      const clamped = Math.min(Math.max(0, nextIdx), Math.max(0, totalPages - 1));
      setPageIdx(clamped);
      setSelectionState((prev) => ({ ...prev, visible: false }));
      if (bodyWrapRef.current) {
        bodyWrapRef.current.scrollTop = 0;
      }
      onProgressChange(clamped, totalPages);
    },
    [totalPages, onProgressChange]
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' && pageIdx > 0) {
        e.preventDefault();
        goToPage(pageIdx - 1);
      } else if (e.key === 'ArrowRight' && pageIdx < totalPages - 1) {
        e.preventDefault();
        goToPage(pageIdx + 1);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [pageIdx, totalPages, goToPage]);

  // Dismiss selection toolbar on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setSelectionState((prev) => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  const handleTextMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelectionState((prev) => ({ ...prev, visible: false }));
        return;
      }
      const txt = sel.toString().trim();
      if (!txt || txt.length < 2) {
        setSelectionState((prev) => ({ ...prev, visible: false }));
        return;
      }
      const container =
        parsedBook.kind === 'pdf' ? pdfTextLayerRef.current : contentRef.current;
      if (!container || !container.contains(sel.anchorNode)) {
        setSelectionState((prev) => ({ ...prev, visible: false }));
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const top = Math.max(14, rect.top - 52);
      const left = Math.min(window.innerWidth - 420, Math.max(16, rect.left));
      setSelectionState({ visible: true, text: txt, top, left });
    }, 20);
  };

  const handleToolbarAction = (action: QuickActionType | 'quote') => {
    const txt = selectionState.text;
    setSelectionState((prev) => ({ ...prev, visible: false }));
    window.getSelection()?.removeAllRanges();
    if (txt) {
      onSelectTextAction(txt, action);
    }
  };

  return (
    <div
      className={`flex flex-col h-full relative transition-colors duration-200 ${activeTheme.bgClass}`}
    >
      {/* Reader Top Bar */}
      <header
        className={`flex items-center justify-between gap-3 px-6 py-3 border-b shrink-0 ${
          isNight
            ? 'border-white/10 bg-[#191b1d]/90'
            : 'border-[#807869]/20 bg-white/40 backdrop-blur-xs'
        }`}
      >
        <button
          type="button"
          onClick={() => onExit(pageIdx, totalPages)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[13px] font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
            isNight
              ? 'border-white/15 bg-white/5 text-[#e4e7ec] hover:bg-white/10'
              : 'border-[#ded7ca] bg-[#fffdf9] text-[#26231f] hover:bg-[#ece7dc]'
          }`}
        >
          <ArrowLeft className="w-4 h-4" />
          返回书架
        </button>

        <div className="min-w-0 flex-1 text-center px-2">
          <div className="text-[15px] font-semibold truncate">{book.title}</div>
          <div className="text-[12px] opacity-70 truncate mt-0.5">
            {currentPage?.chapter || '正文'}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setTocOpen((v) => !v);
              setSettingsOpen(false);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[13px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
              isNight
                ? 'border-white/15 bg-white/5 text-[#e4e7ec] hover:bg-white/10'
                : 'border-[#ded7ca] bg-[#fffdf9] text-[#26231f] hover:bg-[#ece7dc]'
            }`}
          >
            <List className="w-4 h-4" />
            目录
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsOpen((v) => !v);
              setTocOpen(false);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[13px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
              isNight
                ? 'border-white/15 bg-white/5 text-[#e4e7ec] hover:bg-white/10'
                : 'border-[#ded7ca] bg-[#fffdf9] text-[#26231f] hover:bg-[#ece7dc]'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            阅读设置
          </button>
        </div>
      </header>

      {/* TOC Drawer */}
      {tocOpen && (
        <aside className="absolute top-[57px] left-0 bottom-[57px] w-[300px] max-w-[85%] bg-[#fffdf9] text-[#26231f] border-r border-[#e4ded3] shadow-lg z-20 flex flex-col">
          <div className="px-4 py-3 border-b border-[#e4ded3] flex items-center justify-between">
            <span className="text-[14px] font-semibold">
              章节目录 ({parsedBook.toc.length})
            </span>
            <button
              type="button"
              onClick={() => setTocOpen(false)}
              className="px-2.5 py-1 rounded border border-[#e4ded3] text-[12px] text-[#6b655b] hover:bg-[#ece7dc] cursor-pointer"
            >
              关闭
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {parsedBook.toc.map((item, idx) => {
              const isCurrent =
                pageIdx >= item.pageIndex &&
                (idx === parsedBook.toc.length - 1 ||
                  pageIdx < parsedBook.toc[idx + 1].pageIndex);
              return (
                <button
                  key={`${item.title}-${idx}`}
                  type="button"
                  onClick={() => {
                    goToPage(item.pageIndex);
                    setTocOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-[13px] flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                    isCurrent
                      ? 'bg-[#e7efe9] text-[#3e5c47] font-semibold'
                      : 'text-[#6b655b] hover:bg-[#ece7dc] hover:text-[#26231f]'
                  }`}
                >
                  <span className="truncate">{item.title}</span>
                  <span className="text-[11px] opacity-65 tabular-nums shrink-0">
                    P.{item.pageIndex + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      )}

      {/* Reader Settings Popover */}
      {settingsOpen && (
        <div className="absolute top-[58px] right-6 w-[264px] bg-[#fffdf9] text-[#26231f] border border-[#e4ded3] rounded-xl shadow-lg p-4 z-25">
          {parsedBook.kind === 'pdf' ? (
            <div className="mb-4">
              <div className="text-[12px] text-[#6b655b] mb-2 flex items-center justify-between">
                <span>PDF 页面缩放</span>
                <span className="font-semibold text-[#26231f] tabular-nums">
                  {Math.round(pdfScale * 100)}%
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onPrefsChange({
                      ...prefs,
                      pdfScale: Math.max(0.75, Math.round((pdfScale - 0.15) * 100) / 100),
                    })
                  }
                  className="flex-1 py-1.5 rounded-lg border border-[#e4ded3] bg-[#f6f4ef] hover:bg-[#ece7dc] text-[13px] font-medium flex items-center justify-center gap-1 cursor-pointer"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                  缩小
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onPrefsChange({
                      ...prefs,
                      pdfScale: Math.min(2.2, Math.round((pdfScale + 0.15) * 100) / 100),
                    })
                  }
                  className="flex-1 py-1.5 rounded-lg border border-[#e4ded3] bg-[#f6f4ef] hover:bg-[#ece7dc] text-[13px] font-medium flex items-center justify-center gap-1 cursor-pointer"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                  放大
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-4">
              <div className="text-[12px] text-[#6b655b] mb-2 flex items-center justify-between">
                <span>正文字号</span>
                <span className="font-semibold text-[#26231f] tabular-nums">
                  {prefs.fontSize}px
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onPrefsChange({ ...prefs, fontSize: Math.max(14, prefs.fontSize - 2) })
                  }
                  className="flex-1 py-1.5 rounded-lg border border-[#e4ded3] bg-[#f6f4ef] hover:bg-[#ece7dc] text-[13px] font-medium cursor-pointer"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onPrefsChange({ ...prefs, fontSize: Math.min(28, prefs.fontSize + 2) })
                  }
                  className="flex-1 py-1.5 rounded-lg border border-[#e4ded3] bg-[#f6f4ef] hover:bg-[#ece7dc] text-[13px] font-medium cursor-pointer"
                >
                  A+
                </button>
              </div>
            </div>
          )}

          <div>
            <div className="text-[12px] text-[#6b655b] mb-2">护眼背景</div>
            <div className="grid grid-cols-4 gap-2">
              {THEME_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onPrefsChange({ ...prefs, theme: t.id })}
                  style={t.swatchStyle}
                  className={`h-8 rounded-lg border-2 text-[11px] font-medium cursor-pointer transition-all ${
                    prefs.theme === t.id
                      ? 'border-[#3e5c47] ring-2 ring-[#3e5c47]/20'
                      : 'border-[#ded7ca]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Reading Content Body */}
      <div
        ref={bodyWrapRef}
        className="flex-1 overflow-auto px-6 sm:px-10 py-8 flex justify-center items-start"
      >
        {parsedBook.kind === 'pdf' ? (
          <div className="flex flex-col items-center pb-10">
            {pdfLoading ? (
              <div className="py-20 text-[13px] opacity-70">正在加载 PDF 页面...</div>
            ) : (
              <div
                onMouseUp={handleTextMouseUp}
                style={{
                  width: pdfRenderSize.width || 'auto',
                  height: pdfRenderSize.height || 'auto',
                }}
                className="relative bg-white shadow-[0_8px_28px_rgba(0,0,0,0.14)] rounded-sm overflow-hidden"
              >
                <canvas ref={pdfCanvasRef} className="block" />
                <div ref={pdfTextLayerRef} className="textLayer" />
              </div>
            )}
          </div>
        ) : parsedBook.kind === 'comic' ? (
          <div className="flex flex-col items-center pb-10 max-w-full">
            {currentPage?.imageUrl && (
              <img
                src={currentPage.imageUrl}
                alt={currentPage.chapter}
                className="max-w-full max-h-[calc(100vh-180px)] object-contain rounded-lg shadow-lg"
              />
            )}
          </div>
        ) : (
          <article
            ref={contentRef}
            onMouseUp={handleTextMouseUp}
            style={{ fontSize: `${prefs.fontSize}px`, lineHeight: 1.9 }}
            className="reader-prose font-serif-reading w-full max-w-[720px] pb-12 select-text tracking-[0.015em]"
            dangerouslySetInnerHTML={{ __html: currentPage?.html || '' }}
          />
        )}
      </div>

      {/* Bottom Bar: Pagination & Progress Scrubbing */}
      <footer
        className={`flex items-center gap-4 px-6 py-3 border-t shrink-0 ${
          isNight
            ? 'border-white/10 bg-[#191b1d]/90'
            : 'border-[#807869]/20 bg-white/45'
        }`}
      >
        <button
          type="button"
          disabled={pageIdx <= 0}
          onClick={() => goToPage(pageIdx - 1)}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-[13px] font-medium whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            isNight
              ? 'border-white/15 bg-white/5 text-[#e4e7ec] hover:bg-white/10'
              : 'border-[#ded7ca] bg-[#fffdf9] text-[#26231f] hover:bg-[#ece7dc]'
          }`}
        >
          <ChevronLeft className="w-4 h-4" />
          上一页
        </button>

        <div className="flex-1 flex items-center gap-3 min-w-0">
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={currentPercent}
            aria-label="调节阅读进度"
            onChange={(e) => {
              const pct = Number(e.target.value) || 0;
              const target = totalPages <= 1 ? 0 : Math.round((pct / 100) * (totalPages - 1));
              goToPage(target);
            }}
            className="flex-1 accent-[#3e5c47] cursor-pointer"
          />
          <span className="text-[12px] opacity-85 tabular-nums whitespace-nowrap min-w-[118px] text-right">
            {formatPercent(currentPercent)} ｜ {pageIdx + 1}/{totalPages} 页
          </span>
        </div>

        <button
          type="button"
          disabled={pageIdx >= totalPages - 1}
          onClick={() => goToPage(pageIdx + 1)}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-[13px] font-medium whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            isNight
              ? 'border-white/15 bg-white/5 text-[#e4e7ec] hover:bg-white/10'
              : 'border-[#ded7ca] bg-[#fffdf9] text-[#26231f] hover:bg-[#ece7dc]'
          }`}
        >
          下一页
          <ChevronRight className="w-4 h-4" />
        </button>
      </footer>

      {/* Floating Selection Toolbar for Doubao */}
      {selectionState.visible && (
        <div
          ref={toolbarRef}
          style={{ top: selectionState.top, left: selectionState.left }}
          className="fixed z-50 bg-[#26231f] text-white px-2 py-1.5 rounded-xl shadow-xl flex items-center gap-1 flex-wrap max-w-[460px]"
        >
          <span className="px-1.5 text-[11px] text-[#b9c9be] flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            豆包
          </span>
          {(
            [
              { key: 'explain', label: '释义' },
              { key: 'summarize', label: '总结' },
              { key: 'notes', label: '提炼笔记' },
              { key: 'analyze', label: '分析内容' },
              { key: 'review', label: '读后感' },
              { key: 'quote', label: '引用到助手' },
            ] as const
          ).map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => handleToolbarAction(btn.key)}
              className="px-2.5 py-1 rounded-md text-[12px] bg-white/10 hover:bg-[#3e5c47] text-white transition-colors cursor-pointer whitespace-nowrap"
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
