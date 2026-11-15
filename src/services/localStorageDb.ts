import type {
  BookMetadata,
  ChatMessage,
  DoubaoConfig,
  ReaderPrefs,
} from '../types/bookshelf';
import { createZipBlob, type ZipInputFile } from '../utils/zipEngine';
import { formatDateStr } from '../utils/dateStats';

// Strictly separated localStorage keys: book data never mixes with Doubao assistant data
const LS_BOOKS_META = 'local_shelf_books_meta_v1';
const LS_READER_PREFS = 'local_shelf_reader_prefs_v1';
const LS_UI_STATE = 'local_shelf_ui_state_v1';
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

  async pickAndConnect(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isSupported()) {
      return {
        ok: false,
        error: '当前浏览器或窗口环境不支持目录直写，请使用最新版 Chrome/Edge 桌面端（或使用导出书库 ZIP 功能）。',
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
    const cleanName = filePath.split('/').pop() || filePath;
    const subDir = await this.rootHandle.getDirectoryHandle(subDirName, { create: true });
    const fileHandle = await subDir.getFileHandle(cleanName, { create: true });
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
      const cleanName = filePath.split('/').pop() || filePath;
      const subDir = await this.rootHandle.getDirectoryHandle(subDirName, { create: false });
      const fileHandle = await subDir.getFileHandle(cleanName, { create: false });
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
      const cleanName = filePath.split('/').pop() || filePath;
      const subDir = await this.rootHandle.getDirectoryHandle(subDirName, { create: false });
      await subDir.removeEntry(cleanName);
    } catch {
      // ignore missing file
    }
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
    return Boolean(raw ? JSON.parse(raw).assistantCollapsed : false);
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
