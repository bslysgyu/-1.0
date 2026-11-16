import type {
  BookMetadata,
  ChatMessage,
  DoubaoConfig,
  ReaderPrefs,
  WebDavConfig,
} from '../types/bookshelf';
import { createZipBlob, parseZip, type ZipInputFile } from '../utils/zipEngine';
import { formatDateStr, genId, sanitizeFileName } from '../utils/dateStats';
import { generateDefaultCoverBlob, parseBookFile } from '../utils/bookParser';

// Strictly separated localStorage keys: book data never mixes with Doubao assistant or WebDAV credentials
const LS_BOOKS_META = 'local_shelf_books_meta_v1';
const LS_DELETED_IDS = 'local_shelf_deleted_ids_v1';
const LS_IGNORED_SOURCES = 'local_shelf_ignored_sources_v1';
const LS_READER_PREFS = 'local_shelf_reader_prefs_v1';
const LS_UI_STATE = 'local_shelf_ui_state_v1';
const LS_WEBDAV_CFG = 'local_shelf_webdav_config_v1';
const LS_DOUBAO_CFG = 'local_shelf_doubao_config_v1';
const LS_DOUBAO_CHAT = 'local_shelf_doubao_chats_v1';

export interface ExtendedDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<ExtendedDirectoryHandle>;
  }
}

export const LocalShelfDB = (() => {
  const DB_NAME = 'LocalBookshelfDB_v1';
  const DB_VER = 1;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers');
        if (!db.objectStoreNames.contains('bookfiles')) db.createObjectStore('bookfiles');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function put(storeName: string, key: string, val: unknown): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function get<T = unknown>(storeName: string, key: string): Promise<T | undefined> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async function del(storeName: string, key: string): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { put, get, del };
})();

export type FolderSyncStatus = 'unsupported' | 'unbound' | 'pending' | 'connected';

export interface FolderSyncState {
  status: FolderSyncStatus;
  folderName: string;
}

class FolderSyncService {
  private rootHandle: ExtendedDirectoryHandle | null = null;
  private hasPermission = false;

  isSupported(): boolean {
    return typeof window.showDirectoryPicker === 'function';
  }

  isCrossOriginIframe(): boolean {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }

  getState(): FolderSyncState {
    if (!this.isSupported()) {
      return { status: 'unsupported', folderName: '' };
    }
    if (this.rootHandle && this.hasPermission) {
      return { status: 'connected', folderName: this.rootHandle.name };
    }
    if (this.rootHandle && !this.hasPermission) {
      return { status: 'pending', folderName: this.rootHandle.name };
    }
    return { status: 'unbound', folderName: '' };
  }

  isConnected(): boolean {
    return !!(this.rootHandle && this.hasPermission);
  }

  hasSavedHandle(): boolean {
    return !!this.rootHandle;
  }

  private async ensureSubDirs(root: ExtendedDirectoryHandle) {
    await root.getDirectoryHandle('cover', { create: true });
    await root.getDirectoryHandle('bookfile', { create: true });
    await root.getDirectoryHandle('data', { create: true });
  }

  async pickAndConnect(): Promise<{ ok: boolean; blockedByIframe?: boolean; error?: string }> {
    if (!this.isSupported()) {
      return {
        ok: false,
        error: '当前浏览器或窗口环境不支持目录直写，请使用最新版 Chrome/Edge 桌面端（或使用导入/导出书库 ZIP 功能）。',
      };
    }
    if (this.isCrossOriginIframe()) {
      return {
        ok: false,
        blockedByIframe: true,
        error: '当前处于预览嵌套框内，浏览器安全策略禁止弹出硬盘读写授权，请在新标签页打开或使用桌面版。',
      };
    }
    try {
      const handle = await window.showDirectoryPicker!({
        id: 'local-bookshelf-root',
        mode: 'readwrite',
      });
      await this.ensureSubDirs(handle);
      this.rootHandle = handle;
      this.hasPermission = true;
      await LocalShelfDB.put('handles', 'rootDir', handle);
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false };
      }
      if (
        err instanceof Error &&
        (err.name === 'SecurityError' ||
          /cross[- ]origin|sub ?frame/i.test(err.message))
      ) {
        return {
          ok: false,
          blockedByIframe: true,
          error: '当前处于预览嵌套框内，浏览器安全策略禁止弹出硬盘读写授权，请在新标签页打开或使用桌面版。',
        };
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : '绑定本地文件夹失败',
      };
    }
  }

  async tryRestoreSavedHandle(requestIfPrompt = false): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const saved = await LocalShelfDB.get<ExtendedDirectoryHandle>('handles', 'rootDir');
      if (!saved) return false;
      this.rootHandle = saved;
      let perm = await saved.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && requestIfPrompt) {
        perm = await saved.requestPermission({ mode: 'readwrite' });
      }
      this.hasPermission = perm === 'granted';
      if (this.hasPermission) {
        await this.ensureSubDirs(saved);
      }
      return this.hasPermission;
    } catch {
      return false;
    }
  }

  async writeFileToSubDir(
    subDirName: 'cover' | 'bookfile' | 'data',
    filePath: string,
    data: Blob | string
  ): Promise<boolean> {
    if (!this.rootHandle || !this.hasPermission) return false;
    const stripped = filePath.replace(new RegExp(`^${subDirName}/`), '');
    const parts = stripped.split('/').filter(Boolean);
    const fileName = parts.pop() || stripped;
    let dir: FileSystemDirectoryHandle = await this.rootHandle.getDirectoryHandle(subDirName, {
      create: true,
    });
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  }

  async readFileFromSubDir(
    subDirName: 'cover' | 'bookfile' | 'data',
    filePath: string
  ): Promise<File | null> {
    if (!this.rootHandle || !this.hasPermission) return null;
    try {
      const stripped = filePath.replace(new RegExp(`^${subDirName}/`), '');
      const parts = stripped.split('/').filter(Boolean);
      const fileName = parts.pop() || stripped;
      let dir: FileSystemDirectoryHandle = await this.rootHandle.getDirectoryHandle(subDirName, {
        create: false,
      });
      for (const seg of parts) {
        dir = await dir.getDirectoryHandle(seg, { create: false });
      }
      const fileHandle = await dir.getFileHandle(fileName, { create: false });
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }

  async deleteFileFromSubDir(
    subDirName: 'cover' | 'bookfile' | 'data',
    filePath: string
  ): Promise<void> {
    if (!this.rootHandle || !this.hasPermission || !filePath) return;
    try {
      const stripped = filePath.replace(new RegExp(`^${subDirName}/`), '');
      const parts = stripped.split('/').filter(Boolean);
      const fileName = parts.pop() || stripped;
      let dir: FileSystemDirectoryHandle = await this.rootHandle.getDirectoryHandle(subDirName, {
        create: false,
      });
      for (const seg of parts) {
        dir = await dir.getDirectoryHandle(seg, { create: false });
      }
      await dir.removeEntry(fileName);
    } catch {
      // ignore missing file
    }
  }

  async scanBookFiles(): Promise<
    Array<{
      file: File;
      inBookfileDir: boolean;
      relPath: string;
      ext: string;
      sourceKey: string;
    }>
  > {
    if (!this.rootHandle || !this.hasPermission) return [];

    const SUPPORTED = new Set([
      'epub',
      'pdf',
      'mobi',
      'azw3',
      'azw',
      'prc',
      'mbpv2',
      'mbp',
      'txt',
      'docx',
      'fb2',
      'md',
      'markdown',
      'html',
      'htm',
      'cbz',
    ]);

    const results: Array<{
      file: File;
      inBookfileDir: boolean;
      relPath: string;
      ext: string;
      sourceKey: string;
    }> = [];

    const walk = async (
      dirHandle: ExtendedDirectoryHandle,
      prefix: string,
      inBookfileDir: boolean,
      depth: number
    ) => {
      if (depth > 4) return;
      try {
        for await (const [name, handle] of dirHandle.entries()) {
          if (!name || name.startsWith('.')) continue;
          const lowerName = name.toLowerCase();
          if (handle.kind === 'directory') {
            if (!prefix && (lowerName === 'cover' || lowerName === 'data')) {
              continue;
            }
            const nextInBookfile = inBookfileDir || (!prefix && lowerName === 'bookfile');
            const nextPrefix = prefix ? `${prefix}/${name}` : name;
            await walk(handle as ExtendedDirectoryHandle, nextPrefix, nextInBookfile, depth + 1);
          } else if (handle.kind === 'file') {
            const rawExt = lowerName.split('.').pop() || '';
            if (!SUPPORTED.has(rawExt)) continue;
            const ext = rawExt === 'markdown' ? 'md' : rawExt === 'htm' ? 'html' : rawExt;
            try {
              const file = await (handle as FileSystemFileHandle).getFile();
              const relPath = prefix ? `${prefix}/${name}` : name;
              results.push({
                file,
                inBookfileDir,
                relPath,
                ext,
                sourceKey: `${relPath}::${file.size}`,
              });
            } catch {
              // ignore unreadable file
            }
          }
        }
      } catch {
        // ignore directory iteration errors
      }
    };

    await walk(this.rootHandle, '', false, 0);
    return results;
  }

  async readBooksJson(): Promise<{ books: BookMetadata[] } | null> {
    const file = await this.readFileFromSubDir('data', 'books.json');
    if (!file) return null;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.books) ? parsed : null;
    } catch {
      return null;
    }
  }

  async writeBooksJson(booksArray: BookMetadata[]): Promise<boolean> {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      books: booksArray,
    };
    return this.writeFileToSubDir('data', 'books.json', JSON.stringify(payload, null, 2));
  }
}

export const FolderSync = new FolderSyncService();

// LocalStorage persistence helpers
export function loadBooksFromLocalStorage(): BookMetadata[] {
  try {
    const raw = localStorage.getItem(LS_BOOKS_META);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveBooksToLocalStorage(books: BookMetadata[]): void {
  try {
    localStorage.setItem(LS_BOOKS_META, JSON.stringify(books));
  } catch (e) {
    console.warn('localStorage write failed:', e);
  }
}

export function loadDeletedBookIds(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_DELETED_IDS);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDeletedBookIds(deletedIds: Record<string, number>): void {
  try {
    localStorage.setItem(LS_DELETED_IDS, JSON.stringify(deletedIds));
  } catch {
    // ignore quota errors
  }
}

export function loadIgnoredSourceKeys(): string[] {
  try {
    const raw = localStorage.getItem(LS_IGNORED_SOURCES);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveIgnoredSourceKeys(keys: string[]): void {
  try {
    localStorage.setItem(LS_IGNORED_SOURCES, JSON.stringify(keys.slice(-500)));
  } catch {
    // ignore quota errors
  }
}

export function loadWebDavConfig(): WebDavConfig {
  try {
    const raw = localStorage.getItem(LS_WEBDAV_CFG);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      enabled: Boolean(parsed?.enabled),
      url: typeof parsed?.url === 'string' ? parsed.url : '',
      username: typeof parsed?.username === 'string' ? parsed.username : '',
      password: typeof parsed?.password === 'string' ? parsed.password : '',
      autoSync: parsed?.autoSync !== false,
      lastSyncAt: typeof parsed?.lastSyncAt === 'string' ? parsed.lastSyncAt : undefined,
    };
  } catch {
    return {
      enabled: false,
      url: '',
      username: '',
      password: '',
      autoSync: true,
    };
  }
}

export function saveWebDavConfig(cfg: WebDavConfig): void {
  try {
    localStorage.setItem(LS_WEBDAV_CFG, JSON.stringify(cfg));
  } catch {
    // ignore quota errors
  }
}

export function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(LS_READER_PREFS);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      fontSize: typeof parsed?.fontSize === 'number' ? parsed.fontSize : 18,
      theme: parsed?.theme || 'paper',
    };
  } catch {
    return { fontSize: 18, theme: 'paper' };
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  localStorage.setItem(LS_READER_PREFS, JSON.stringify(prefs));
}

export function loadAssistantCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(LS_UI_STATE);
    if (raw) {
      return Boolean(JSON.parse(raw).assistantCollapsed);
    }
    return typeof window !== 'undefined' && window.innerWidth < 768;
  } catch {
    return false;
  }
}

export function saveAssistantCollapsed(collapsed: boolean): void {
  localStorage.setItem(LS_UI_STATE, JSON.stringify({ assistantCollapsed: collapsed }));
}

export function loadDoubaoConfig(): DoubaoConfig {
  try {
    const raw = localStorage.getItem(LS_DOUBAO_CFG);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      endpoint: parsed?.endpoint || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      apiKey: parsed?.apiKey || '',
      model: parsed?.model || 'doubao-1-5-pro-32k-250115',
      stream: parsed?.stream !== false,
    };
  } catch {
    return {
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      apiKey: '',
      model: 'doubao-1-5-pro-32k-250115',
      stream: true,
    };
  }
}

export function saveDoubaoConfig(cfg: DoubaoConfig): void {
  localStorage.setItem(LS_DOUBAO_CFG, JSON.stringify(cfg));
}

export function loadChatHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(LS_DOUBAO_CHAT);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveChatHistory(messages: ChatMessage[]): void {
  try {
    localStorage.setItem(LS_DOUBAO_CHAT, JSON.stringify(messages.slice(-80)));
  } catch {
    // ignore quota errors
  }
}

export async function exportLibraryZip(books: BookMetadata[]): Promise<void> {
  const filesList: ZipInputFile[] = [
    {
      path: 'data/books.json',
      data: JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          books,
        },
        null,
        2
      ),
    },
  ];

  for (const book of books) {
    let cov = await LocalShelfDB.get<Blob>('covers', book.id);
    if (!cov && FolderSync.isConnected() && book.coverPath) {
      cov = (await FolderSync.readFileFromSubDir('cover', book.coverPath)) || undefined;
    }
    if (cov && book.coverPath) {
      filesList.push({ path: book.coverPath, data: cov });
    }

    let bf = await LocalShelfDB.get<Blob>('bookfiles', book.id);
    if (!bf && FolderSync.isConnected() && book.filePath) {
      bf = (await FolderSync.readFileFromSubDir('bookfile', book.filePath)) || undefined;
    }
    if (bf && book.filePath) {
      filesList.push({ path: book.filePath, data: bf });
    }
  }

  const zipBlob = await createZipBlob(filesList);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `LocalBookshelf_${formatDateStr()}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function guessMimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'epub') return 'application/epub+zip';
  return 'application/octet-stream';
}

export async function importLibraryZip(
  zipFile: File,
  existingBooks: BookMetadata[]
): Promise<{ books: BookMetadata[]; importedCount: number }> {
  const ab = await zipFile.arrayBuffer();
  const zip = await parseZip(ab);

  const jsonText = await zip.getEntryText('data/books.json');
  if (!jsonText) {
    throw new Error('压缩包内未找到 data/books.json，无法识别为墨韵书库备份包');
  }

  const parsed = JSON.parse(jsonText);
  const incomingBooks: BookMetadata[] = Array.isArray(parsed?.books) ? parsed.books : [];
  if (incomingBooks.length === 0) {
    throw new Error('data/books.json 中没有有效书籍记录');
  }

  const mergedMap = new Map<string, BookMetadata>();
  for (const b of existingBooks) {
    mergedMap.set(b.id, b);
  }

  for (const book of incomingBooks) {
    if (book.coverPath) {
      const covBytes = await zip.getEntryBytes(book.coverPath);
      if (covBytes) {
        const covBlob = new Blob([new Uint8Array(covBytes).buffer], {
          type: guessMimeFromPath(book.coverPath),
        });
        await LocalShelfDB.put('covers', book.id, covBlob);
        if (FolderSync.isConnected()) {
          await FolderSync.writeFileToSubDir('cover', book.coverPath, covBlob);
        }
      }
    }

    if (book.filePath) {
      const bfBytes = await zip.getEntryBytes(book.filePath);
      if (bfBytes) {
        const bfBlob = new Blob([new Uint8Array(bfBytes).buffer], {
          type: guessMimeFromPath(book.filePath),
        });
        await LocalShelfDB.put('bookfiles', book.id, bfBlob);
        if (FolderSync.isConnected()) {
          await FolderSync.writeFileToSubDir('bookfile', book.filePath, bfBlob);
        }
      }
    }

    mergedMap.set(book.id, book);
  }

  const merged = Array.from(mergedMap.values());
  saveBooksToLocalStorage(merged);
  if (FolderSync.isConnected()) {
    await FolderSync.writeBooksJson(merged);
  }

  return { books: merged, importedCount: incomingBooks.length };
}

export async function importLibraryFromFolderFiles(
  fileList: FileList,
  existingBooks: BookMetadata[]
): Promise<{ books: BookMetadata[]; importedCount: number }> {
  const files = Array.from(fileList);
  const byRelPath = new Map<string, File>();
  let booksJsonFile: File | null = null;

  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const parts = rel.split('/');
    const subPath = parts.length > 1 ? parts.slice(1).join('/') : rel;
    byRelPath.set(subPath, f);
    if (subPath === 'data/books.json' || rel.endsWith('/data/books.json')) {
      booksJsonFile = f;
    }
  }

  const mergedMap = new Map<string, BookMetadata>();
  for (const b of existingBooks) {
    mergedMap.set(b.id, b);
  }

  let importedCount = 0;

  if (booksJsonFile) {
    const jsonText = await booksJsonFile.text();
    const parsed = JSON.parse(jsonText);
    const incomingBooks: BookMetadata[] = Array.isArray(parsed?.books) ? parsed.books : [];
    for (const book of incomingBooks) {
      if (book.coverPath) {
        const covFile = byRelPath.get(book.coverPath);
        if (covFile) {
          await LocalShelfDB.put('covers', book.id, covFile);
        }
      }
      if (book.filePath) {
        const bfFile = byRelPath.get(book.filePath);
        if (bfFile) {
          await LocalShelfDB.put('bookfiles', book.id, bfFile);
        }
      }
      mergedMap.set(book.id, book);
      importedCount++;
    }
  }

  // Also auto-import any raw ebook files placed directly in the folder or bookfile/
  const SUPPORTED = new Set([
    'epub',
    'pdf',
    'mobi',
    'azw3',
    'azw',
    'prc',
    'mbpv2',
    'mbp',
    'txt',
    'docx',
    'fb2',
    'md',
    'markdown',
    'html',
    'htm',
    'cbz',
  ]);
  const knownFilePaths = new Set(Array.from(mergedMap.values()).map((b) => b.filePath));
  const knownNameSize = new Set(
    Array.from(mergedMap.values()).map(
      (b) => `${(b.filePath.split('/').pop() || '').toLowerCase()}::${b.fileSize}`
    )
  );

  for (const [subPath, f] of byRelPath.entries()) {
    const lowerPath = subPath.toLowerCase();
    if (lowerPath.startsWith('cover/') || lowerPath.startsWith('data/')) continue;
    const rawExt = lowerPath.split('.').pop() || '';
    if (!SUPPORTED.has(rawExt)) continue;
    if (knownFilePaths.has(subPath)) continue;
    if (knownNameSize.has(`${f.name.toLowerCase()}::${f.size}`)) continue;

    const ext = rawExt === 'markdown' ? 'md' : rawExt === 'htm' ? 'html' : rawExt;
    const id = genId('book');
    const title = f.name.replace(/\.[^.]+$/, '').trim() || f.name;
    const filePath = subPath.startsWith('bookfile/')
      ? subPath
      : `bookfile/${id}_${sanitizeFileName(f.name)}`;

    let coverBlob: Blob | null = null;
    let coverExt = 'png';
    if (
      ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'mbpv2', 'mbp', 'fb2', 'cbz'].includes(ext) &&
      f.size <= 80 * 1024 * 1024
    ) {
      try {
        const ab = await f.arrayBuffer();
        const res = await parseBookFile(ab, ext, true);
        if (res.coverBlob) {
          coverBlob = res.coverBlob;
          coverExt = res.coverBlob.type.includes('jpeg') ? 'jpg' : 'png';
        }
      } catch {
        // ignore fallback
      }
    }

    const resolvedCover = coverBlob ?? (await generateDefaultCoverBlob(title));
    const coverPath = `cover/${id}_cover.${coverExt}`;
    await LocalShelfDB.put('bookfiles', id, f);
    await LocalShelfDB.put('covers', id, resolvedCover);

    mergedMap.set(id, {
      id,
      title,
      coverPath,
      filePath,
      fileType: ext,
      fileSize: f.size,
      addedAt: formatDateStr(),
      addedTimestamp: Date.now(),
      lastReadTimestamp: Date.now(),
      startReadTime: '',
      readPercent: 0,
      lastPosition: { page: 0, totalPages: 1 },
      readHistory: [],
      sourceKey: `${subPath}::${f.size}`,
    });
    importedCount++;
  }

  if (importedCount === 0) {
    throw new Error('所选文件夹内未找到支持的电子书文件或 data/books.json');
  }

  const merged = Array.from(mergedMap.values());
  saveBooksToLocalStorage(merged);
  return { books: merged, importedCount };
}

