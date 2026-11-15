import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookCheck, BookOpen, CheckCircle2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { BookMetadata } from '../types/bookshelf';
import { formatPercent } from '../utils/dateStats';

export type ShelfFilterMode = 'all' | 'reading' | 'finished';

export function isBookFinished(book: BookMetadata): boolean {
  return Boolean(book.isFinished) || (Number(book.readPercent) || 0) >= 100;
}

interface BookshelfGridProps {
  books: BookMetadata[];
  totalCount: number;
  shelfFilter: ShelfFilterMode;
  resolveCoverUrl: (book: BookMetadata) => Promise<string>;
  onOpenBook: (bookId: string) => void;
  onEditBook: (book: BookMetadata) => void;
  onDeleteBook: (book: BookMetadata) => void;
  onToggleFinished: (book: BookMetadata) => void;
  onOpenUpload: () => void;
}

interface BookOnShelfProps {
  book: BookMetadata;
  resolveCoverUrl: (book: BookMetadata) => Promise<string>;
  onOpenBook: (bookId: string) => void;
  onEditBook: (book: BookMetadata) => void;
  onDeleteBook: (book: BookMetadata) => void;
  onToggleFinished: (book: BookMetadata) => void;
}

const SPINE_PALETTE = [
  { bg: 'linear-gradient(90deg, #3c4a3e 0%, #526454 45%, #2f3b31 100%)', band: '#c8b288', h: 178, w: 20 },
  { bg: 'linear-gradient(90deg, #69412e 0%, #83543d 45%, #513020 100%)', band: '#dfc9a4', h: 192, w: 24 },
  { bg: 'linear-gradient(90deg, #313d4f 0%, #435269 45%, #222b38 100%)', band: '#c5b18c', h: 184, w: 22 },
  { bg: 'linear-gradient(90deg, #745b3d 0%, #8e714e 45%, #58442c 100%)', band: '#efe3cb', h: 170, w: 19 },
  { bg: 'linear-gradient(90deg, #5d3538 0%, #76464a 45%, #462628 100%)', band: '#d8c29d', h: 188, w: 23 },
  { bg: 'linear-gradient(90deg, #8c7b65 0%, #a5937b 45%, #6e5f4c 100%)', band: '#3e3226', h: 175, w: 18 },
  { bg: 'linear-gradient(90deg, #3e4d50 0%, #526468 45%, #2d383a 100%)', band: '#d6c6a9', h: 186, w: 21 },
];

const DecorativeSpines: React.FC<{ count: number; seedOffset: number }> = ({
  count,
  seedOffset,
}) => {
  return (
    <div
      aria-hidden="true"
      className="hidden sm:flex items-end gap-[2px] shrink-0 pointer-events-none select-none opacity-90"
    >
      {Array.from({ length: count }).map((_, idx) => {
        const spec = SPINE_PALETTE[(idx + seedOffset) % SPINE_PALETTE.length];
        return (
          <div
            key={idx}
            style={{
              width: `${spec.w}px`,
              height: `${spec.h}px`,
              background: spec.bg,
            }}
            className="rounded-t-[2px] relative shadow-[2px_0_4px_rgba(0,0,0,0.45)] border-t border-white/10"
          >
            <div
              style={{ backgroundColor: spec.band }}
              className="absolute top-4 left-0 right-0 h-[3px] opacity-65"
            />
            <div
              style={{ backgroundColor: spec.band }}
              className="absolute bottom-5 left-0 right-0 h-[2px] opacity-55"
            />
          </div>
        );
      })}
    </div>
  );
};

const BookOnShelf: React.FC<BookOnShelfProps> = ({
  book,
  resolveCoverUrl,
  onOpenBook,
  onEditBook,
  onDeleteBook,
  onToggleFinished,
}) => {
  const [coverUrl, setCoverUrl] = useState<string>('');
  const finished = isBookFinished(book);

  useEffect(() => {
    let active = true;
    resolveCoverUrl(book).then((url) => {
      if (active) setCoverUrl(url);
    });
    return () => {
      active = false;
    };
  }, [book, book.coverPath, resolveCoverUrl]);

  return (
    <article
      onClick={() => onOpenBook(book.id)}
      className="group relative flex flex-col items-center w-[144px] sm:w-[152px] shrink-0 cursor-pointer"
    >
      <div className="relative w-full aspect-[3/4] rounded-[5px] overflow-hidden bg-[#3a281a] shadow-[0_8px_16px_rgba(0,0,0,0.65),3px_0_0_#d8cfbe,4px_0_4px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-out group-hover:-translate-y-2 group-hover:scale-[1.02]">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={book.title}
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover block"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center bg-gradient-to-br from-[#3e5c47] to-[#24372a] text-[#f6f4ef]">
            <BookOpen className="w-6 h-6 mb-2 opacity-80" />
            <span className="text-[12px] font-medium line-clamp-3">{book.title}</span>
          </div>
        )}

        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-black/35 via-white/15 to-transparent pointer-events-none"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/25 pointer-events-none"
        />

        {/* Format Badge */}
        <span className="absolute left-2 bottom-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-black/70 text-[#f5efe4] backdrop-blur-xs">
          {book.fileType}
        </span>

        {/* Finished Indicator Seal (bottom right) */}
        {finished && (
          <span
            title="已读完成"
            className="absolute right-2 bottom-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#3e5c47]/90 text-[#fbf7ef] backdrop-blur-xs"
          >
            已读
          </span>
        )}

        {/* Hover Actions: Toggle Finished / Edit / Delete */}
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 z-20">
          <button
            type="button"
            title={finished ? '移回在读书架' : '标为已读'}
            aria-label={finished ? `将《${book.title}》移回在读` : `将《${book.title}》标为已读`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFinished(book);
            }}
            className={`w-7 h-7 rounded-md border flex items-center justify-center shadow cursor-pointer ${
              finished
                ? 'bg-[#e6efe8] text-[#3a5742] border-[#b7cebc] hover:bg-white'
                : 'bg-[#fbf7ef]/95 text-[#261e17] hover:text-[#3e5c47] border-[#d6c8b4]'
            }`}
          >
            {finished ? (
              <RotateCcw className="w-3.5 h-3.5" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            title="修改书名或封面"
            aria-label={`修改《${book.title}》信息`}
            onClick={(e) => {
              e.stopPropagation();
              onEditBook(book);
            }}
            className="w-7 h-7 rounded-md bg-[#fbf7ef]/95 text-[#261e17] hover:text-[#3e5c47] border border-[#d6c8b4] flex items-center justify-center shadow cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="删除书籍"
            aria-label={`删除《${book.title}》`}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteBook(book);
            }}
            className="w-7 h-7 rounded-md bg-[#fbf7ef]/95 text-[#261e17] hover:text-[#b84a42] border border-[#d6c8b4] flex items-center justify-center shadow cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
};

interface BookPlaqueProps {
  book: BookMetadata;
  onOpenBook: (bookId: string) => void;
}

const BookPlaque: React.FC<BookPlaqueProps> = ({ book, onOpenBook }) => {
  const finished = isBookFinished(book);
  const startLabel = book.startReadTime ? book.startReadTime : '未开始';
  const pctLabel = formatPercent(book.readPercent || 0);
  const pctWidth = Math.min(100, Math.max(0, Number(book.readPercent) || 0));

  return (
    <button
      type="button"
      onClick={() => onOpenBook(book.id)}
      className="w-[144px] sm:w-[152px] shrink-0 text-left bg-[#fbf7ef] hover:bg-white border border-[#d4c5af] rounded-lg px-2.5 py-2 shadow-[0_2px_6px_rgba(20,12,5,0.22)] transition-colors cursor-pointer"
    >
      <div
        title={book.title}
        className="text-[12.5px] font-semibold text-[#261e17] leading-snug truncate mb-1"
      >
        {book.title}
      </div>
      <div className="text-[11px] text-[#6b5d4f] flex items-center justify-between gap-1 tabular-nums">
        <span className="truncate">{startLabel}</span>
        <span aria-hidden="true" className="opacity-50">｜</span>
        <span className="font-semibold text-[#3e5c47] shrink-0">
          {finished ? `已读 ${pctLabel}` : pctLabel}
        </span>
      </div>
      <div className="h-1 bg-[#e5dccd] rounded-full overflow-hidden mt-1.5">
        <div
          className="h-full bg-[#3e5c47] rounded-full transition-all duration-300"
          style={{ width: `${finished ? 100 : pctWidth}%` }}
        />
      </div>
    </button>
  );
};

interface ShelfBayProps {
  title: string;
  subtitle: string;
  books: BookMetadata[];
  booksPerShelf: number;
  seedBase: number;
  emptyText: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  resolveCoverUrl: (book: BookMetadata) => Promise<string>;
  onOpenBook: (bookId: string) => void;
  onEditBook: (book: BookMetadata) => void;
  onDeleteBook: (book: BookMetadata) => void;
  onToggleFinished: (book: BookMetadata) => void;
  isFinishedBay?: boolean;
}

const ShelfBay: React.FC<ShelfBayProps> = ({
  title,
  subtitle,
  books,
  booksPerShelf,
  seedBase,
  emptyText,
  emptyActionLabel,
  onEmptyAction,
  resolveCoverUrl,
  onOpenBook,
  onEditBook,
  onDeleteBook,
  onToggleFinished,
  isFinishedBay = false,
}) => {
  const rows = useMemo(() => {
    const out: BookMetadata[][] = [];
    for (let i = 0; i < books.length; i += booksPerShelf) {
      out.push(books.slice(i, i + booksPerShelf));
    }
    return out;
  }, [books, booksPerShelf]);

  return (
    <section className="relative">
      {/* Wooden Section Header Strip */}
      <div className="bg-[#3b2516] border-b border-[#24150c] px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isFinishedBay ? (
            <BookCheck className="w-4 h-4 text-[#d6be96]" />
          ) : (
            <BookOpen className="w-4 h-4 text-[#d6be96]" />
          )}
          <span className="text-[13.5px] font-semibold text-[#f3eadb] tracking-wide">
            {title}
          </span>
          <span className="text-[12px] text-[#cbb799] tabular-nums">
            · {books.length} 本
          </span>
        </div>
        <span className="text-[11.5px] text-[#b9a282] hidden sm:inline">{subtitle}</span>
      </div>

      {rows.length === 0 ? (
        <div>
          <div className="relative px-4 sm:px-6 pt-6 flex items-end justify-between gap-4 min-h-[195px]">
            <DecorativeSpines count={4} seedOffset={seedBase} />
            <div className="flex-1 flex flex-col items-center justify-center text-center py-5 px-4 bg-[#fbf7ef]/95 border border-[#d6c8b4] rounded-xl shadow-lg max-w-md mx-auto mb-3 z-10">
              <p className="text-[12.5px] text-[#6b5d4f] leading-relaxed">
                {emptyText}
              </p>
              {emptyActionLabel && onEmptyAction && (
                <button
                  type="button"
                  onClick={onEmptyAction}
                  className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] text-white text-[12.5px] font-medium transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {emptyActionLabel}
                </button>
              )}
            </div>
            <DecorativeSpines count={4} seedOffset={seedBase + 3} />
          </div>
          <div className="wood-shelf-plank h-5 w-full" />
        </div>
      ) : (
        rows.map((rowBooks, rowIndex) => (
          <div key={rowIndex} className="relative">
            <div className="relative px-4 sm:px-6 pt-6 flex items-end justify-between gap-3">
              <DecorativeSpines count={2} seedOffset={seedBase + rowIndex * 3} />

              <div className="flex-1 flex items-end justify-center sm:justify-start gap-5 flex-wrap sm:flex-nowrap z-10">
                {rowBooks.map((book) => (
                  <BookOnShelf
                    key={book.id}
                    book={book}
                    resolveCoverUrl={resolveCoverUrl}
                    onOpenBook={onOpenBook}
                    onEditBook={onEditBook}
                    onDeleteBook={onDeleteBook}
                    onToggleFinished={onToggleFinished}
                  />
                ))}
              </div>

              <DecorativeSpines
                count={Math.max(2, booksPerShelf - rowBooks.length + 2)}
                seedOffset={seedBase + rowIndex * 5 + 2}
              />

              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-2 right-2 bottom-[54px] h-[2px] bg-gradient-to-r from-[#7e6442]/40 via-[#d2b484]/75 to-[#7e6442]/40 shadow-[0_1px_2px_rgba(0,0,0,0.4)] z-15"
              />
            </div>

            <div className="wood-shelf-plank h-5 w-full relative z-10" />

            <div className="bg-[#342113]/95 border-b border-[#22140b] px-4 sm:px-6 py-3 flex items-start justify-between gap-3">
              <div className="hidden sm:block w-[42px] shrink-0" />
              <div className="flex-1 flex items-start justify-center sm:justify-start gap-5 flex-wrap sm:flex-nowrap">
                {rowBooks.map((book) => (
                  <BookPlaque
                    key={book.id}
                    book={book}
                    onOpenBook={onOpenBook}
                  />
                ))}
              </div>
              <div className="hidden sm:block w-[42px] shrink-0" />
            </div>
          </div>
        ))
      )}
    </section>
  );
};

export const BookshelfGrid: React.FC<BookshelfGridProps> = ({
  books,
  totalCount,
  shelfFilter,
  resolveCoverUrl,
  onOpenBook,
  onEditBook,
  onDeleteBook,
  onToggleFinished,
  onOpenUpload,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [booksPerShelf, setBooksPerShelf] = useState(4);

  useEffect(() => {
    const updateCapacity = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const usable = Math.max(200, w - (w > 760 ? 220 : 60));
      const perRow = Math.max(1, Math.floor(usable / 172));
      setBooksPerShelf(Math.min(6, perRow));
    };
    updateCapacity();
    const ro = new ResizeObserver(updateCapacity);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const readingBooks = useMemo(() => books.filter((b) => !isBookFinished(b)), [books]);
  const finishedBooks = useMemo(() => books.filter((b) => isBookFinished(b)), [books]);

  const showReadingBay = shelfFilter === 'all' || shelfFilter === 'reading';
  const showFinishedBay = shelfFilter === 'all' || shelfFilter === 'finished';

  return (
    <div ref={containerRef} className="relative">
      {/* Three Hanging Pendant Lamps with Warm Glow */}
      <div
        aria-hidden="true"
        className="relative h-14 flex items-start justify-around px-8 pointer-events-none select-none overflow-hidden"
      >
        {[0, 1, 2].map((lampIdx) => (
          <div key={lampIdx} className="relative flex flex-col items-center">
            <div className="w-[2px] h-3 bg-[#362c24]" />
            <div className="w-16 h-6 rounded-t-full bg-gradient-to-b from-[#332b24] to-[#1f1914] shadow-md relative flex items-end justify-center">
              <div className="w-6 h-2 rounded-full bg-[#fff3d1] shadow-[0_0_18px_6px_rgba(255,220,145,0.85)] translate-y-1" />
            </div>
            <div className="lamp-glow w-64 h-24 -mt-1 pointer-events-none" />
          </div>
        ))}
      </div>

      {/* Main Walnut Bookcase Cabinet */}
      <div className="wood-frame-outer rounded-xl p-3 sm:p-4 border border-[#3a2415]">
        <div
          aria-hidden="true"
          className="h-2 rounded-t bg-gradient-to-r from-[#6c482d] via-[#895d3c] to-[#6c482d] mb-2 opacity-85"
        />

        <div className="wood-back-recess rounded-lg overflow-hidden">
          {showReadingBay && (
            <ShelfBay
              title="在读与待阅书架"
              subtitle="点击封面继续阅读，悬停可标为已读或编辑"
              books={readingBooks}
              booksPerShelf={booksPerShelf}
              seedBase={0}
              emptyText={
                totalCount === 0
                  ? '上传 PDF、EPUB、MOBI、AZW3 或 TXT 电子书与封面，它们将立于这排胡桃木书架上。'
                  : finishedBooks.length > 0 && shelfFilter === 'all'
                  ? '在读书架的书籍已全部读完，已归入下方「已读书架」栏。'
                  : '没有找到匹配的在读书籍。'
              }
              emptyActionLabel={totalCount === 0 ? '上传第一本书' : undefined}
              onEmptyAction={totalCount === 0 ? onOpenUpload : undefined}
              resolveCoverUrl={resolveCoverUrl}
              onOpenBook={onOpenBook}
              onEditBook={onEditBook}
              onDeleteBook={onDeleteBook}
              onToggleFinished={onToggleFinished}
            />
          )}

          {showFinishedBay && (
            <ShelfBay
              title="已读书架"
              subtitle="读至 100% 或手动标为已读的书籍自动陈列于此栏"
              books={finishedBooks}
              booksPerShelf={booksPerShelf}
              seedBase={4}
              emptyText="暂无已读书籍。将书籍阅读至 100%，或悬停图书封面点击右上角「标为已读」图标，即可收入此栏。"
              resolveCoverUrl={resolveCoverUrl}
              onOpenBook={onOpenBook}
              onEditBook={onEditBook}
              onDeleteBook={onDeleteBook}
              onToggleFinished={onToggleFinished}
              isFinishedBay
            />
          )}
        </div>
      </div>
    </div>
  );
};
