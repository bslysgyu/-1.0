import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Download,
  FolderCheck,
  FolderOpen,
  FolderSync as FolderSyncIcon,
  HelpCircle,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import type {
  BookMetadata,
  ParsedBook,
  QuickActionType,
  ReaderPrefs,
} from './types/bookshelf';
import {
  computeReadingStats,
  formatDateStr,
  genId,
  sanitizeFileName,
} from './utils/dateStats';
import {
  generateDefaultCoverBlob,
  parseBookFile,
} from './utils/bookParser';
import {
  exportLibraryZip,
  FolderSync,
  loadAssistantCollapsed,
  loadBooksFromLocalStorage,
  loadReaderPrefs,
  LocalShelfDB,
  saveAssistantCollapsed,
  saveBooksToLocalStorage,
  saveReaderPrefs,
  type FolderSyncState,
} from './services/localStorageDb';
import { StatsBar } from './components/StatsBar';
import {
  BookshelfGrid,
  isBookFinished,
  type ShelfFilterMode,
} from './components/BookshelfGrid';
import { BookReader } from './components/BookReader';
import { DoubaoAssistantPanel } from './components/DoubaoAssistantPanel';
import {
  ConfirmModal,
  EditBookModal,
  FolderGuideModal,
  UploadBookModal,
} from './components/Modals';

interface ToastItem {
  id: number;
  message: string;
}

export default function App() {
  const [books, setBooks] = useState<BookMetadata[]>(() => loadBooksFromLocalStorage());
  const [folderState, setFolderState] = useState<FolderSyncState>(() => FolderSync.getState());
  const [assistantCollapsed, setAssistantCollapsed] = useState<boolean>(() =>
    loadAssistantCollapsed()
  );
  const [readerPrefs, setReaderPrefs] = useState<ReaderPrefs>(() => loadReaderPrefs());

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'recent' | 'added' | 'progress' | 'title'>('recent');
  const [shelfFilter, setShelfFilter] = useState<ShelfFilterMode>('all');

  const [readingState, setReadingState] = useState<{
    book: BookMetadata;
    parsed: ParsedBook;
    initialPage: number;
  } | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [activePagePlainText, setActivePagePlainText] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingBook, setEditingBook] = useState<BookMetadata | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    danger: boolean;
    onConfirm: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    confirmLabel: '确认',
    danger: false,
    onConfirm: () => {},
  });

  const [doubaoTrigger, setDoubaoTrigger] = useState<{
    id: number;
    quote: string;
    action: QuickActionType | 'quote';
  } | null>(null);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const coverUrlCacheRef = useRef<Map<string, string>>(new Map());
  const booksRef = useRef<BookMetadata[]>(books);
  const autoSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  const showToast = useCallback((message: string, duration = 2600) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const persistBooks = useCallback(
    async (nextBooks: BookMetadata[], syncDisk = true) => {
      booksRef.current = nextBooks;
      setBooks(nextBooks);
      saveBooksToLocalStorage(nextBooks);
      if (syncDisk && FolderSync.isConnected()) {
        await FolderSync.writeBooksJson(nextBooks);
      }
    },
    []
  );

  const syncWithConnectedFolder = useCallback(async () => {
    if (!FolderSync.isConnected()) return;
    const diskData = await FolderSync.readBooksJson();
    const currentLocal = booksRef.current;

    if (diskData && Array.isArray(diskData.books) && diskData.books.length > 0) {
      const diskMap = new Map(diskData.books.map((b) => [b.id, b]));
      for (const localBook of currentLocal) {
        if (!diskMap.has(localBook.id)) {
          diskMap.set(localBook.id, localBook);
          const cov = await LocalShelfDB.get<Blob>('covers', localBook.id);
          if (cov && localBook.coverPath) {
            await FolderSync.writeFileToSubDir('cover', localBook.coverPath, cov);
          }
          const bf = await LocalShelfDB.get<Blob>('bookfiles', localBook.id);
          if (bf && localBook.filePath) {
            await FolderSync.writeFileToSubDir('bookfile', localBook.filePath, bf);
          }
        }
      }
      const merged = Array.from(diskMap.values());
      coverUrlCacheRef.current.clear();
      await persistBooks(merged, true);
    } else {
      for (const b of currentLocal) {
        const cov = await LocalShelfDB.get<Blob>('covers', b.id);
        if (cov && b.coverPath) {
          await FolderSync.writeFileToSubDir('cover', b.coverPath, cov);
        }
        const bf = await LocalShelfDB.get<Blob>('bookfiles', b.id);
        if (bf && b.filePath) {
          await FolderSync.writeFileToSubDir('bookfile', b.filePath, bf);
        }
      }
      await persistBooks(currentLocal, true);
    }
    setFolderState(FolderSync.getState());
  }, [persistBooks]);

  useEffect(() => {
    let active = true;
    FolderSync.tryRestoreSavedHandle(false).then(async (restored) => {
      if (!active) return;
      setFolderState(FolderSync.getState());
      if (restored) {
        await syncWithConnectedFolder();
      }
    });
    return () => {
      active = false;
    };
  }, [syncWithConnectedFolder]);

  const handleBindOrReconnectFolder = async () => {
    if (FolderSync.hasSavedHandle() && !FolderSync.isConnected()) {
      const ok = await FolderSync.tryRestoreSavedHandle(true);
      setFolderState(FolderSync.getState());
      if (ok) {
        await syncWithConnectedFolder();
        showToast('已恢复本地文件夹读写同步');
        return;
      }
    }

    const res = await FolderSync.pickAndConnect();
    setFolderState(FolderSync.getState());
    if (res.ok) {
      await syncWithConnectedFolder();
      showToast('已绑定本地文件夹，cover / bookfile / data 目录已就绪');
    } else if (res.error) {
      showToast(res.error, 3800);
    }
  };

  const resolveCoverUrl = useCallback(async (book: BookMetadata): Promise<string> => {
    const cached = coverUrlCacheRef.current.get(book.id);
    if (cached) return cached;

    let blob = await LocalShelfDB.get<Blob>('covers', book.id);
    if (!blob && FolderSync.isConnected() && book.coverPath) {
      const diskFile = await FolderSync.readFileFromSubDir('cover', book.coverPath);
      if (diskFile) {
        blob = diskFile;
        await LocalShelfDB.put('covers', book.id, blob);
      }
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      coverUrlCacheRef.current.set(book.id, url);
      return url;
    }
    return '';
  }, []);

  const readingStats = useMemo(() => computeReadingStats(books), [books]);

  const filteredBooks = useMemo(() => {
    const kw = searchQuery.trim().toLowerCase();
    const list = books.filter((b) => !kw || b.title.toLowerCase().includes(kw));
    list.sort((a, b) => {
      if (sortBy === 'progress') return (b.readPercent || 0) - (a.readPercent || 0);
      if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh-CN');
      if (sortBy === 'added') return (b.addedTimestamp || 0) - (a.addedTimestamp || 0);
      return (
        (b.lastReadTimestamp || b.addedTimestamp || 0) -
        (a.lastReadTimestamp || a.addedTimestamp || 0)
      );
    });
    return list;
  }, [books, searchQuery, sortBy]);

  const handleConfirmUpload = async ({
    bookFile,
    title,
    coverFile,
  }: {
    bookFile: File;
    title: string;
    coverFile: File | null;
  }) => {
    const id = genId('book');
    const rawExt = bookFile.name.split('.').pop()?.toLowerCase() || 'txt';
    const ext = rawExt === 'markdown' ? 'md' : rawExt === 'htm' ? 'html' : rawExt;
    const safeBookFileName = `${id}_${sanitizeFileName(bookFile.name)}`;
    const filePath = `bookfile/${safeBookFileName}`;

    let coverBlob: Blob | null = coverFile;
    let coverExt = 'png';
    if (coverFile) {
      coverExt = (coverFile.name.split('.').pop() || 'png').toLowerCase();
    } else {
      if (['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'fb2', 'cbz'].includes(ext)) {
        try {
          const ab = await bookFile.arrayBuffer();
          const res = await parseBookFile(ab, ext, true);
          if (res.coverBlob) {
            coverBlob = res.coverBlob;
            coverExt = res.coverBlob.type.includes('jpeg') ? 'jpg' : 'png';
          }
        } catch {
          // ignore cover extraction fallback
        }
      }
    }

    const resolvedCoverBlob: Blob =
      coverBlob ?? (await generateDefaultCoverBlob(title));

    const coverPath = `cover/${id}_cover.${coverExt}`;
    await LocalShelfDB.put('bookfiles', id, bookFile);
    await LocalShelfDB.put('covers', id, resolvedCoverBlob);

    if (FolderSync.isConnected()) {
      await FolderSync.writeFileToSubDir('bookfile', filePath, bookFile);
      await FolderSync.writeFileToSubDir('cover', coverPath, resolvedCoverBlob);
    }

    const newBook: BookMetadata = {
      id,
      title,
      coverPath,
      filePath,
      fileType: ext,
      fileSize: bookFile.size,
      addedAt: formatDateStr(),
      addedTimestamp: Date.now(),
      lastReadTimestamp: Date.now(),
      startReadTime: '',
      readPercent: 0,
      lastPosition: { page: 0, totalPages: 1 },
      readHistory: [],
    };

    const nextBooks = [newBook, ...booksRef.current];
    await persistBooks(nextBooks, true);
    showToast(
      FolderSync.isConnected()
        ? '已保存至本地文件夹（cover / bookfile / data）'
        : '已加入本地书架'
    );
  };

  const handleConfirmEdit = async (
    bookId: string,
    newTitle: string,
    newCover: File | null
  ) => {
    const target = booksRef.current.find((b) => b.id === bookId);
    if (!target) return;

    let updatedCoverPath = target.coverPath;
    if (newCover) {
      const ext = (newCover.name.split('.').pop() || 'png').toLowerCase();
      const oldPath = target.coverPath;
      updatedCoverPath = `cover/${bookId}_cover_${Date.now()}.${ext}`;
      await LocalShelfDB.put('covers', bookId, newCover);

      const oldUrl = coverUrlCacheRef.current.get(bookId);
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
        coverUrlCacheRef.current.delete(bookId);
      }

      if (FolderSync.isConnected()) {
        if (oldPath) await FolderSync.deleteFileFromSubDir('cover', oldPath);
        await FolderSync.writeFileToSubDir('cover', updatedCoverPath, newCover);
      }
    }

    const nextBooks = booksRef.current.map((b) =>
      b.id === bookId ? { ...b, title: newTitle, coverPath: updatedCoverPath } : b
    );
    await persistBooks(nextBooks, true);
    showToast('图书信息已更新');
  };

  const handleRequestDeleteBook = (book: BookMetadata) => {
    setConfirmState({
      open: true,
      title: '删除书籍',
      description: `确定要从本地书架删除《${book.title}》吗？删除后将同步移除本地封面图片、电子书原文件与阅读进度记录。`,
      confirmLabel: '确认删除',
      danger: true,
      onConfirm: async () => {
        setConfirmState((prev) => ({ ...prev, open: false }));
        const nextBooks = booksRef.current.filter((b) => b.id !== book.id);
        await LocalShelfDB.del('covers', book.id);
        await LocalShelfDB.del('bookfiles', book.id);

        const cachedUrl = coverUrlCacheRef.current.get(book.id);
        if (cachedUrl) {
          URL.revokeObjectURL(cachedUrl);
          coverUrlCacheRef.current.delete(book.id);
        }

        if (FolderSync.isConnected()) {
          await FolderSync.deleteFileFromSubDir('cover', book.coverPath);
          await FolderSync.deleteFileFromSubDir('bookfile', book.filePath);
        }

        await persistBooks(nextBooks, true);
        showToast(`已删除《${book.title}》`);
      },
    });
  };

  const recordReadingProgress = useCallback(
    async (bookId: string, page: number, totalPages: number, syncDisk: boolean) => {
      const target = booksRef.current.find((b) => b.id === bookId);
      if (!target) return;

      const newPct =
        totalPages <= 1 ? 100 : Math.round((page / (totalPages - 1)) * 1000) / 10;
      const prevPct = Number(target.readPercent) || 0;
      const delta = Math.round((newPct - prevPct) * 10) / 10;
      const today = formatDateStr();

      const nextHistory = Array.isArray(target.readHistory) ? [...target.readHistory] : [];
      if (delta !== 0) {
        const lastEntry = nextHistory[nextHistory.length - 1];
        if (lastEntry && lastEntry.date === today) {
          nextHistory[nextHistory.length - 1] = {
            ...lastEntry,
            deltaPercent: Math.round((lastEntry.deltaPercent + delta) * 10) / 10,
            percentAfter: newPct,
            timestamp: Date.now(),
          };
        } else {
          nextHistory.push({
            date: today,
            deltaPercent: delta,
            percentAfter: newPct,
            timestamp: Date.now(),
          });
        }
      }

      const nextBooks = booksRef.current.map((b) =>
        b.id === bookId
          ? {
              ...b,
              startReadTime: b.startReadTime || today,
              lastReadTimestamp: Date.now(),
              readPercent: newPct,
              isFinished: newPct >= 100 ? true : b.isFinished,
              finishedAt: newPct >= 100 ? b.finishedAt || today : b.finishedAt,
              lastPosition: { page, totalPages },
              readHistory: nextHistory,
            }
          : b
      );

      await persistBooks(nextBooks, syncDisk);
    },
    [persistBooks]
  );

  const handleToggleFinished = async (book: BookMetadata) => {
    const currentlyFinished = isBookFinished(book);
    const today = formatDateStr();

    const nextBooks = booksRef.current.map((b) => {
      if (b.id !== book.id) return b;
      if (currentlyFinished) {
        return {
          ...b,
          isFinished: false,
          finishedAt: undefined,
          readPercent: (Number(b.readPercent) || 0) >= 100 ? 99 : b.readPercent,
        };
      }
      return {
        ...b,
        isFinished: true,
        finishedAt: today,
      };
    });

    await persistBooks(nextBooks, true);
    showToast(currentlyFinished ? `已将《${book.title}》移回在读书架` : `已将《${book.title}》标为已读`);
  };

  const handleOpenBook = async (bookId: string) => {
    const book = booksRef.current.find((b) => b.id === bookId);
    if (!book) return;

    let fileBlob = await LocalShelfDB.get<Blob>('bookfiles', book.id);
    if (!fileBlob && FolderSync.isConnected() && book.filePath) {
      const diskFile = await FolderSync.readFileFromSubDir('bookfile', book.filePath);
      if (diskFile) {
        fileBlob = diskFile;
        await LocalShelfDB.put('bookfiles', book.id, diskFile);
      }
    }

    if (!fileBlob) {
      showToast('未找到电子书原文件，请检查本地 bookfile 目录或重新上传');
      return;
    }

    try {
      const ab = await fileBlob.arrayBuffer();
      const parsed = await parseBookFile(ab, book.fileType, false);

      const totalPages = parsed.pages.length;
      let startPage = 0;
      if (
        book.lastPosition &&
        typeof book.lastPosition.page === 'number' &&
        book.lastPosition.totalPages === totalPages
      ) {
        startPage = Math.min(totalPages - 1, Math.max(0, book.lastPosition.page));
      } else if (book.readPercent > 0 && totalPages > 1) {
        startPage = Math.min(
          totalPages - 1,
          Math.round((book.readPercent / 100) * (totalPages - 1))
        );
      }

      setCurrentPageIndex(startPage);
      setActivePagePlainText(parsed.pages[startPage]?.plainText || '');
      setReadingState({ book, parsed, initialPage: startPage });
      await recordReadingProgress(book.id, startPage, totalPages, true);
    } catch (err) {
      showToast(
        `解析电子书失败：${err instanceof Error ? err.message : '未知错误'}`,
        3500
      );
    }
  };

  const handleReaderProgressChange = useCallback(
    (page: number, totalPages: number) => {
      setCurrentPageIndex(page);
      if (!readingState) return;
      const bookId = readingState.book.id;
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = window.setTimeout(() => {
        recordReadingProgress(bookId, page, totalPages, true);
      }, 400);
    },
    [readingState, recordReadingProgress]
  );

  const handleExitReader = useCallback(
    async (finalPage: number, totalPages: number) => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      if (readingState) {
        await recordReadingProgress(readingState.book.id, finalPage, totalPages, true);
      }
      setReadingState(null);
    },
    [readingState, recordReadingProgress]
  );

  useEffect(() => {
    const handleUnload = () => {
      if (readingState) {
        recordReadingProgress(
          readingState.book.id,
          currentPageIndex,
          readingState.parsed.pages.length,
          false
        );
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [readingState, currentPageIndex, recordReadingProgress]);

  const toggleAssistant = (nextCollapsed?: boolean) => {
    const val = nextCollapsed !== undefined ? nextCollapsed : !assistantCollapsed;
    setAssistantCollapsed(val);
    saveAssistantCollapsed(val);
  };

  const handleSelectTextAction = (text: string, action: QuickActionType | 'quote') => {
    toggleAssistant(false);
    setDoubaoTrigger({
      id: Date.now(),
      quote: text,
      action,
    });
  };

  const handleExportZip = async () => {
    if (books.length === 0) {
      showToast('书架为空，暂无可导出的书籍数据');
      return;
    }
    showToast('正在打包本地书库 (cover + bookfile + data)...');
    await exportLibraryZip(books);
    showToast('已导出完整三目录本地书库 ZIP 包');
  };

  const folderButtonConfig = (() => {
    if (folderState.status === 'connected') {
      return {
        label: `已同步：${folderState.folderName}`,
        icon: FolderCheck,
        cls: 'bg-[#e6efe8] text-[#3a5742] border-[#c4d6c8]',
      };
    }
    if (folderState.status === 'pending') {
      return {
        label: `点击恢复同步：${folderState.folderName}`,
        icon: FolderSyncIcon,
        cls: 'bg-[#f4eadc] text-[#7c5630] border-[#decab1]',
      };
    }
    if (folderState.status === 'unsupported') {
      return {
        label: '浏览器本地存储模式',
        icon: FolderOpen,
        cls: 'bg-[#ede5d8] text-[#6b5d4f] border-[#d6c8b4]',
      };
    }
    return {
      label: '绑定本地文件夹',
      icon: FolderOpen,
      cls: 'bg-[#fbf7ef] text-[#261e17] border-[#d6c8b4] hover:bg-[#ede5d8]',
    };
  })();

  const FolderBtnIcon = folderButtonConfig.icon;
  const currentPagePlainText =
    activePagePlainText || readingState?.parsed.pages[currentPageIndex]?.plainText || '';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#e7dfd3] text-[#261e17]">
      {/* Left Main Workspace (Wooden Bookstore Shelf OR Reader) */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        {readingState ? (
          <BookReader
            book={readingState.book}
            parsedBook={readingState.parsed}
            initialPage={readingState.initialPage}
            prefs={readerPrefs}
            onPrefsChange={(p) => {
              setReaderPrefs(p);
              saveReaderPrefs(p);
            }}
            onProgressChange={handleReaderProgressChange}
            onExit={handleExitReader}
            onSelectTextAction={handleSelectTextAction}
            onPageTextChange={setActivePagePlainText}
          />
        ) : (
          <>
            {/* Warm Study Gallery Top Bar */}
            <header className="px-6 py-3 bg-[#fbf7ef] border-b border-[#d6c8b4] flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-2.5 shrink-0">
                <div className="w-8 h-8 rounded-lg bg-[#4d321f] text-[#fbf7ef] flex items-center justify-center shadow-xs">
                  <BookOpen className="w-4 h-4" />
                </div>
                <span className="text-[17px] font-bold tracking-tight text-[#261e17] whitespace-nowrap">
                  墨韵书架
                </span>
              </div>

              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  type="button"
                  onClick={handleBindOrReconnectFolder}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12.5px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${folderButtonConfig.cls}`}
                >
                  <FolderBtnIcon className="w-3.5 h-3.5" />
                  {folderButtonConfig.label}
                </button>

                <button
                  type="button"
                  onClick={() => setGuideOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-white hover:bg-[#ede5d8] text-[12.5px] font-medium text-[#6b5d4f] hover:text-[#261e17] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  本地目录说明
                </button>

                <button
                  type="button"
                  onClick={handleExportZip}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-white hover:bg-[#ede5d8] text-[12.5px] font-medium text-[#261e17] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出本地书库
                </button>

                <button
                  type="button"
                  onClick={() => setUploadOpen(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#3e5c47] hover:bg-[#2f4836] text-white text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  上传图书
                </button>

                {assistantCollapsed && (
                  <button
                    type="button"
                    onClick={() => toggleAssistant(false)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#c4d6c8] bg-[#e6efe8] text-[#3a5742] text-[12.5px] font-medium cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <PanelRightOpen className="w-3.5 h-3.5" />
                    展开豆包助手
                  </button>
                )}
              </div>
            </header>

            {/* Warm Wall + Bookcase Scrollable Canvas */}
            <main className="flex-1 overflow-y-auto px-6 py-5 bg-gradient-to-b from-[#e9e1d5] via-[#dfd5c6] to-[#d6cbb9]">
              <div className="max-w-[1320px] mx-auto">
                {/* 3 Reading Statistics Cards */}
                <StatsBar stats={readingStats} />

                {/* Shelf Search, Filter Tabs & Sort Toolbar */}
                <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h1 className="text-[16px] font-bold text-[#261e17]">木质书架陈列</h1>
                    <div
                      role="tablist"
                      aria-label="书架栏目筛选"
                      className="inline-flex items-center p-0.5 rounded-lg bg-[#d9cebc] border border-[#cbbda7]"
                    >
                      {(
                        [
                          { id: 'all', label: `全部 (${books.length})` },
                          {
                            id: 'reading',
                            label: `在读 (${books.filter((b) => !isBookFinished(b)).length})`,
                          },
                          {
                            id: 'finished',
                            label: `已读 (${books.filter((b) => isBookFinished(b)).length})`,
                          },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={shelfFilter === tab.id}
                          onClick={() => setShelfFilter(tab.id)}
                          className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors cursor-pointer tabular-nums whitespace-nowrap ${
                            shelfFilter === tab.id
                              ? 'bg-[#fbf7ef] text-[#261e17] shadow-xs'
                              : 'text-[#615344] hover:text-[#261e17]'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[#857564] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索书名..."
                        className="pl-8 pr-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-[#fbf7ef] text-[13px] text-[#261e17] w-[200px] outline-none focus:border-[#3e5c47]"
                      />
                    </div>
                    <select
                      value={sortBy}
                      onChange={(e) =>
                        setSortBy(e.target.value as 'recent' | 'added' | 'progress' | 'title')
                      }
                      aria-label="排序方式"
                      className="px-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-[#fbf7ef] text-[13px] text-[#261e17] outline-none focus:border-[#3e5c47] cursor-pointer"
                    >
                      <option value="recent">按最近阅读</option>
                      <option value="added">按添加时间</option>
                      <option value="progress">按阅读进度</option>
                      <option value="title">按书名排序</option>
                    </select>
                  </div>
                </div>

                {/* Walnut Bookcase with Pendant Lamps */}
                <BookshelfGrid
                  books={filteredBooks}
                  totalCount={books.length}
                  shelfFilter={shelfFilter}
                  resolveCoverUrl={resolveCoverUrl}
                  onOpenBook={handleOpenBook}
                  onEditBook={(b) => setEditingBook(b)}
                  onDeleteBook={handleRequestDeleteBook}
                  onToggleFinished={handleToggleFinished}
                  onOpenUpload={() => setUploadOpen(true)}
                />
              </div>
            </main>
          </>
        )}
      </div>

      {/* Right Fixed & Collapsible Doubao Assistant Sidebar */}
      <DoubaoAssistantPanel
        collapsed={assistantCollapsed}
        onToggleCollapse={() => toggleAssistant()}
        currentBookTitle={readingState?.book.title || null}
        currentPageText={currentPagePlainText}
        externalTrigger={doubaoTrigger}
        onNotify={showToast}
        onRequestClearConfirm={(onConfirm) =>
          setConfirmState({
            open: true,
            title: '清空豆包对话记录',
            description:
              '确定要清空本地保存的豆包对话历史吗？此操作不会影响您的书籍与阅读进度统计。',
            confirmLabel: '确认清空',
            danger: true,
            onConfirm: () => {
              setConfirmState((prev) => ({ ...prev, open: false }));
              onConfirm();
            },
          })
        }
      />

      {assistantCollapsed && readingState && (
        <button
          type="button"
          onClick={() => toggleAssistant(false)}
          className="fixed right-5 bottom-16 z-40 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#3e5c47] hover:bg-[#2f4836] text-white text-[12.5px] font-medium shadow-lg cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" />
          豆包助手
        </button>
      )}

      {/* Modals */}
      <UploadBookModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onConfirm={handleConfirmUpload}
      />

      <EditBookModal
        book={editingBook}
        resolveCoverUrl={resolveCoverUrl}
        onClose={() => setEditingBook(null)}
        onConfirm={handleConfirmEdit}
      />

      <FolderGuideModal
        open={guideOpen}
        folderName={folderState.folderName}
        isSupported={FolderSync.isSupported()}
        onClose={() => setGuideOpen(false)}
        onBindFolder={handleBindOrReconnectFolder}
        onExportZip={handleExportZip}
      />

      <ConfirmModal
        open={confirmState.open}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        danger={confirmState.danger}
        onCancel={() => setConfirmState((prev) => ({ ...prev, open: false }))}
        onConfirm={confirmState.onConfirm}
      />

      {/* Toast Notifications */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[120] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-[#261e17] text-[#fbf7ef] px-4 py-2 rounded-full text-[12.5px] shadow-lg"
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
