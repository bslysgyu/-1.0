import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Cloud,
  Download,
  FolderCheck,
  FolderOpen,
  FolderSearch,
  FolderSync as FolderSyncIcon,
  HelpCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  BookMetadata,
  ParsedBook,
  QuickActionType,
  ReaderPrefs,
  WebDavConfig,
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
  importLibraryFromFolderFiles,
  importLibraryZip,
  loadAssistantCollapsed,
  loadBooksFromLocalStorage,
  loadDeletedBookIds,
  loadIgnoredSourceKeys,
  loadReaderPrefs,
  loadWebDavConfig,
  LocalShelfDB,
  saveAssistantCollapsed,
  saveBooksToLocalStorage,
  saveDeletedBookIds,
  saveIgnoredSourceKeys,
  saveReaderPrefs,
  saveWebDavConfig,
  type FolderSyncState,
} from './services/localStorageDb';
import {
  deleteWebDavFile,
  downloadWebDavFile,
  mergeBookLibraries,
  readWebDavBooksJson,
  uploadWebDavFile,
  writeWebDavBooksJson,
} from './services/webdavSync';
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
import { WebDavModal } from './components/WebDavModal';

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
  const [webdavConfig, setWebdavConfig] = useState<WebDavConfig>(() => loadWebDavConfig());
  const [webdavOpen, setWebdavOpen] = useState(false);
  const [webdavSyncing, setWebdavSyncing] = useState(false);
  const [folderScanning, setFolderScanning] = useState(false);
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
  const deletedIdsRef = useRef<Record<string, number>>(loadDeletedBookIds());
  const ignoredSourcesRef = useRef<Set<string>>(new Set(loadIgnoredSourceKeys()));
  const webdavConfigRef = useRef<WebDavConfig>(webdavConfig);
  const autoSaveTimerRef = useRef<number | null>(null);
  const webdavPushTimerRef = useRef<number | null>(null);
  const folderScanningRef = useRef(false);
  const lastFocusScanRef = useRef(0);
  const importZipInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  useEffect(() => {
    webdavConfigRef.current = webdavConfig;
  }, [webdavConfig]);

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
      const dav = webdavConfigRef.current;
      if (syncDisk && dav.enabled && dav.autoSync && dav.url) {
        if (webdavPushTimerRef.current) {
          window.clearTimeout(webdavPushTimerRef.current);
        }
        webdavPushTimerRef.current = window.setTimeout(() => {
          writeWebDavBooksJson(dav, booksRef.current, deletedIdsRef.current).catch(() => {
            // ignore silent background sync failure while offline
          });
        }, 650);
      }
    },
    []
  );

  const scanConnectedFolderForNewBooks = useCallback(
    async (silent = false): Promise<number> => {
      if (!FolderSync.isConnected() || folderScanningRef.current) return 0;
      folderScanningRef.current = true;
      setFolderScanning(true);

      try {
        const scanned = await FolderSync.scanBookFiles();
        const current = booksRef.current;
        const knownFilePaths = new Set(current.map((b) => b.filePath));
        const knownSourceKeys = new Set(
          current.map((b) => b.sourceKey).filter((v): v is string => Boolean(v))
        );
        const knownNameSize = new Set(
          current.map((b) => `${(b.filePath.split('/').pop() || '').toLowerCase()}::${b.fileSize}`)
        );

        const newItems = scanned.filter((item) => {
          if (ignoredSourcesRef.current.has(item.sourceKey)) return false;
          if (knownSourceKeys.has(item.sourceKey)) return false;
          if (knownFilePaths.has(item.relPath)) return false;
          if (
            item.inBookfileDir &&
            knownNameSize.has(`${item.file.name.toLowerCase()}::${item.file.size}`)
          ) {
            return false;
          }
          return true;
        });

        if (newItems.length === 0) {
          if (!silent) {
            showToast('本地文件夹已是最新，未发现新放入的电子书');
          }
          return 0;
        }

        if (!silent) {
          showToast(`发现 ${newItems.length} 本新图书，正在解析封面并上架...`);
        }

        const addedBooks: BookMetadata[] = [];
        for (const item of newItems) {
          const id = genId('book');
          const title = item.file.name.replace(/\.[^.]+$/, '').trim() || item.file.name;
          const filePath = item.inBookfileDir
            ? item.relPath
            : `bookfile/${id}_${sanitizeFileName(item.file.name)}`;

          let coverBlob: Blob | null = null;
          let coverExt = 'png';
          if (
            ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'mbpv2', 'mbp', 'fb2', 'cbz'].includes(
              item.ext
            ) &&
            item.file.size <= 80 * 1024 * 1024
          ) {
            try {
              const ab = await item.file.arrayBuffer();
              const res = await parseBookFile(ab, item.ext, true);
              if (res.coverBlob) {
                coverBlob = res.coverBlob;
                coverExt = res.coverBlob.type.includes('jpeg') ? 'jpg' : 'png';
              }
            } catch {
              // ignore cover extraction failure and use default cover
            }
          }

          const resolvedCoverBlob = coverBlob ?? (await generateDefaultCoverBlob(title));
          const coverPath = `cover/${id}_cover.${coverExt}`;

          await LocalShelfDB.put('bookfiles', id, item.file);
          await LocalShelfDB.put('covers', id, resolvedCoverBlob);

          if (!item.inBookfileDir) {
            await FolderSync.writeFileToSubDir('bookfile', filePath, item.file);
          }
          await FolderSync.writeFileToSubDir('cover', coverPath, resolvedCoverBlob);

          if (webdavConfigRef.current.enabled && webdavConfigRef.current.url) {
            await uploadWebDavFile(webdavConfigRef.current, filePath, item.file).catch(() => {});
            await uploadWebDavFile(webdavConfigRef.current, coverPath, resolvedCoverBlob).catch(
              () => {}
            );
          }

          addedBooks.push({
            id,
            title,
            coverPath,
            filePath,
            fileType: item.ext,
            fileSize: item.file.size,
            addedAt: formatDateStr(),
            addedTimestamp: Date.now(),
            lastReadTimestamp: Date.now(),
            startReadTime: '',
            readPercent: 0,
            lastPosition: { page: 0, totalPages: 1 },
            readHistory: [],
            sourceKey: item.sourceKey,
          });
        }

        const nextBooks = [...addedBooks, ...booksRef.current];
        await persistBooks(nextBooks, true);
        showToast(`已自动识别并上架 ${addedBooks.length} 本新书`);
        return addedBooks.length;
      } finally {
        folderScanningRef.current = false;
        setFolderScanning(false);
      }
    },
    [persistBooks, showToast]
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
    await scanConnectedFolderForNewBooks(true);
    setFolderState(FolderSync.getState());
  }, [persistBooks, scanConnectedFolderForNewBooks]);

  const syncWithWebDav = useCallback(
    async (cfgOverride?: WebDavConfig, silent = false) => {
      const cfg = cfgOverride || webdavConfigRef.current;
      if (!cfg.enabled || !cfg.url) return;

      setWebdavSyncing(true);
      try {
        const remote = await readWebDavBooksJson(cfg);
        const { mergedBooks, mergedDeletedIds, toUploadToRemote } = mergeBookLibraries(
          booksRef.current,
          remote?.books || [],
          deletedIdsRef.current,
          remote?.deletedIds || {}
        );

        for (const book of toUploadToRemote) {
          let cov = await LocalShelfDB.get<Blob>('covers', book.id);
          if (!cov && FolderSync.isConnected() && book.coverPath) {
            cov = (await FolderSync.readFileFromSubDir('cover', book.coverPath)) || undefined;
          }
          if (cov && book.coverPath) {
            await uploadWebDavFile(cfg, book.coverPath, cov);
          }

          let bf = await LocalShelfDB.get<Blob>('bookfiles', book.id);
          if (!bf && FolderSync.isConnected() && book.filePath) {
            bf = (await FolderSync.readFileFromSubDir('bookfile', book.filePath)) || undefined;
          }
          if (bf && book.filePath) {
            await uploadWebDavFile(cfg, book.filePath, bf);
          }
        }

        deletedIdsRef.current = mergedDeletedIds;
        saveDeletedBookIds(mergedDeletedIds);

        await writeWebDavBooksJson(cfg, mergedBooks, mergedDeletedIds);

        for (const url of coverUrlCacheRef.current.values()) {
          URL.revokeObjectURL(url);
        }
        coverUrlCacheRef.current.clear();

        booksRef.current = mergedBooks;
        setBooks(mergedBooks);
        saveBooksToLocalStorage(mergedBooks);
        if (FolderSync.isConnected()) {
          await FolderSync.writeBooksJson(mergedBooks);
        }

        const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
        const updatedCfg: WebDavConfig = { ...cfg, lastSyncAt: stamp };
        webdavConfigRef.current = updatedCfg;
        setWebdavConfig(updatedCfg);
        saveWebDavConfig(updatedCfg);

        if (!silent) {
          showToast(`WebDAV 同步完成（共 ${mergedBooks.length} 本书）`);
        }
      } catch (err) {
        if (!silent) {
          showToast(
            `WebDAV 同步失败：${err instanceof Error ? err.message : '请检查网络与跨域设置'}`,
            3800
          );
        }
      } finally {
        setWebdavSyncing(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    let active = true;
    FolderSync.tryRestoreSavedHandle(false).then(async (restored) => {
      if (!active) return;
      setFolderState(FolderSync.getState());
      if (restored) {
        await syncWithConnectedFolder();
      }
      if (
        active &&
        webdavConfigRef.current.enabled &&
        webdavConfigRef.current.autoSync &&
        webdavConfigRef.current.url
      ) {
        await syncWithWebDav(webdavConfigRef.current, true);
      }
    });
    return () => {
      active = false;
    };
  }, [syncWithConnectedFolder, syncWithWebDav]);

  // Automatically scan connected folder for newly dropped books whenever returning to the window
  useEffect(() => {
    const maybeScan = () => {
      if (!FolderSync.isConnected()) return;
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastFocusScanRef.current < 2500) return;
      lastFocusScanRef.current = now;
      scanConnectedFolderForNewBooks(true);
    };
    window.addEventListener('focus', maybeScan);
    document.addEventListener('visibilitychange', maybeScan);
    return () => {
      window.removeEventListener('focus', maybeScan);
      document.removeEventListener('visibilitychange', maybeScan);
    };
  }, [scanConnectedFolderForNewBooks]);

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
    } else if (res.blockedByIframe) {
      setGuideOpen(true);
      showToast('预览框内受浏览器安全策略限制，已打开引导窗口', 3200);
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
    if (!blob && webdavConfigRef.current.enabled && webdavConfigRef.current.url && book.coverPath) {
      const remoteBlob = await downloadWebDavFile(webdavConfigRef.current, book.coverPath);
      if (remoteBlob) {
        blob = remoteBlob;
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
      if (['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'mbpv2', 'mbp', 'fb2', 'cbz'].includes(ext)) {
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
    if (webdavConfigRef.current.enabled && webdavConfigRef.current.url) {
      try {
        await uploadWebDavFile(webdavConfigRef.current, filePath, bookFile);
        await uploadWebDavFile(webdavConfigRef.current, coverPath, resolvedCoverBlob);
      } catch (err) {
        showToast(
          `本地已保存，但上传至 WebDAV 失败：${err instanceof Error ? err.message : '网络错误'}`,
          3500
        );
      }
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
      FolderSync.isConnected() || webdavConfigRef.current.enabled
        ? '已保存并同步书籍（cover / bookfile / data）'
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
      if (webdavConfigRef.current.enabled && webdavConfigRef.current.url) {
        if (oldPath) await deleteWebDavFile(webdavConfigRef.current, oldPath);
        await uploadWebDavFile(webdavConfigRef.current, updatedCoverPath, newCover).catch(() => {});
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
        deletedIdsRef.current = {
          ...deletedIdsRef.current,
          [book.id]: Date.now(),
        };
        saveDeletedBookIds(deletedIdsRef.current);

        if (book.sourceKey) {
          ignoredSourcesRef.current.add(book.sourceKey);
          saveIgnoredSourceKeys(Array.from(ignoredSourcesRef.current));
        }

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
        if (webdavConfigRef.current.enabled && webdavConfigRef.current.url) {
          await deleteWebDavFile(webdavConfigRef.current, book.coverPath);
          await deleteWebDavFile(webdavConfigRef.current, book.filePath);
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
    if (!fileBlob && webdavConfigRef.current.enabled && webdavConfigRef.current.url && book.filePath) {
      showToast('正在从 WebDAV 网盘缓存电子书...');
      const remoteFile = await downloadWebDavFile(webdavConfigRef.current, book.filePath);
      if (remoteFile) {
        fileBlob = remoteFile;
        await LocalShelfDB.put('bookfiles', book.id, remoteFile);
      }
    }

    if (!fileBlob) {
      showToast('未找到电子书原文件，请检查本地 bookfile 目录、WebDAV 连接或重新上传');
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

  const handleImportZip = async (zipFile: File) => {
    try {
      showToast('正在解析并导入本地书库 ZIP 包...');
      const res = await importLibraryZip(zipFile, booksRef.current);
      for (const url of coverUrlCacheRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      coverUrlCacheRef.current.clear();
      booksRef.current = res.books;
      setBooks(res.books);
      showToast(`已成功导入 ${res.importedCount} 本书籍、封面与阅读进度`);
    } catch (err) {
      showToast(
        `导入书库失败：${err instanceof Error ? err.message : 'ZIP 格式无效'}`,
        3800
      );
    }
  };

  const handleImportFolder = async (fileList: FileList) => {
    try {
      showToast('正在读取本地书库文件夹...');
      const res = await importLibraryFromFolderFiles(fileList, booksRef.current);
      for (const url of coverUrlCacheRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      coverUrlCacheRef.current.clear();
      booksRef.current = res.books;
      setBooks(res.books);
      showToast(`已从本地文件夹导入 ${res.importedCount} 本书籍与进度`);
    } catch (err) {
      showToast(
        `读取文件夹失败：${err instanceof Error ? err.message : '目录格式不符合'}`,
        3800
      );
    }
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

                {folderState.status === 'connected' && (
                  <button
                    type="button"
                    disabled={folderScanning}
                    onClick={() => scanConnectedFolderForNewBooks(false)}
                    title="扫描绑定文件夹内新放入的电子书"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#c4d6c8] bg-white hover:bg-[#e6efe8] disabled:opacity-60 text-[12.5px] font-medium text-[#3a5742] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <FolderSearch className={`w-3.5 h-3.5 ${folderScanning ? 'animate-pulse' : ''}`} />
                    {folderScanning ? '扫描中...' : '扫描新书'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setWebdavOpen(true)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12.5px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    webdavConfig.enabled
                      ? 'bg-[#e6efe8] text-[#3a5742] border-[#c4d6c8]'
                      : 'bg-[#fbf7ef] text-[#261e17] border-[#d6c8b4] hover:bg-[#ede5d8]'
                  }`}
                >
                  <Cloud className="w-3.5 h-3.5" />
                  {webdavConfig.enabled ? 'WebDAV 已连接' : 'WebDAV 网盘'}
                </button>

                {webdavConfig.enabled && (
                  <button
                    type="button"
                    disabled={webdavSyncing}
                    onClick={() => syncWithWebDav()}
                    title="立即与 WebDAV 网盘双向同步"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#c4d6c8] bg-white hover:bg-[#e6efe8] disabled:opacity-60 text-[12.5px] font-medium text-[#3a5742] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${webdavSyncing ? 'animate-spin' : ''}`} />
                    同步
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setGuideOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-white hover:bg-[#ede5d8] text-[12.5px] font-medium text-[#6b5d4f] hover:text-[#261e17] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  本地目录说明
                </button>

                <input
                  ref={importZipInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) handleImportZip(f);
                  }}
                />

                <button
                  type="button"
                  onClick={() => importZipInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#d6c8b4] bg-white hover:bg-[#ede5d8] text-[12.5px] font-medium text-[#261e17] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  导入书库
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

      {/* Mobile / Tablet Backdrop for Slide-Over Doubao Drawer */}
      {!assistantCollapsed && (
        <div
          aria-hidden="true"
          onClick={() => toggleAssistant(true)}
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-[1px] md:hidden"
        />
      )}

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
        iframeBlocked={FolderSync.isCrossOriginIframe()}
        onClose={() => setGuideOpen(false)}
        onBindFolder={handleBindOrReconnectFolder}
        onExportZip={handleExportZip}
        onImportZip={handleImportZip}
        onImportFolder={handleImportFolder}
      />

      <WebDavModal
        open={webdavOpen}
        config={webdavConfig}
        syncing={webdavSyncing}
        onClose={() => setWebdavOpen(false)}
        onSaveAndSync={async (nextCfg) => {
          webdavConfigRef.current = nextCfg;
          setWebdavConfig(nextCfg);
          saveWebDavConfig(nextCfg);
          await syncWithWebDav(nextCfg, false);
        }}
        onDisconnect={() => {
          const disabled: WebDavConfig = { ...webdavConfigRef.current, enabled: false };
          webdavConfigRef.current = disabled;
          setWebdavConfig(disabled);
          saveWebDavConfig(disabled);
          showToast('已断开 WebDAV 同步，本地书架不受影响');
        }}
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
