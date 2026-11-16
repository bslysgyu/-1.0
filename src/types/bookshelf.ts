export type BookFormat =
  | 'epub'
  | 'pdf'
  | 'mobi'
  | 'azw3'
  | 'azw'
  | 'prc'
  | 'mbpv2'
  | 'mbp'
  | 'txt'
  | 'docx'
  | 'fb2'
  | 'md'
  | 'html'
  | 'cbz';

export const SUPPORTED_BOOK_EXTENSIONS: BookFormat[] = [
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
  'html',
  'cbz',
];

export interface ReadHistoryEntry {
  date: string; // YYYY-MM-DD
  deltaPercent: number;
  percentAfter: number;
  timestamp: number;
}

export interface BookLastPosition {
  page: number;
  totalPages: number;
}

export interface BookMetadata {
  id: string;
  title: string;
  coverPath: string; // e.g., "cover/book_123_cover.png"
  filePath: string; // e.g., "bookfile/book_123_example.epub"
  fileType: BookFormat | string;
  fileSize: number;
  addedAt: string; // YYYY-MM-DD
  addedTimestamp: number;
  lastReadTimestamp: number;
  startReadTime: string; // YYYY-MM-DD or "" if not opened yet
  readPercent: number; // 0 - 100
  isFinished?: boolean;
  finishedAt?: string; // YYYY-MM-DD
  lastPosition: BookLastPosition;
  readHistory: ReadHistoryEntry[];
}

export interface ReadingStats {
  weekTotal: number;
  monthTotal: number;
  yearTotal: number;
  weekBookCount: number;
  monthBookCount: number;
  yearBookCount: number;
}

export interface ReaderPage {
  html: string;
  chapter: string;
  plainText: string;
  imageUrl?: string;
}

export interface TocItem {
  title: string;
  pageIndex: number;
}

export interface ParsedBook {
  kind: 'text' | 'pdf' | 'comic';
  pages: ReaderPage[];
  toc: TocItem[];
  coverBlob?: Blob | null;
  pdfBytes?: ArrayBuffer;
  pdfTotalPages?: number;
}

export type ReaderTheme = 'paper' | 'warm' | 'green' | 'night';

export interface ReaderPrefs {
  fontSize: number;
  theme: ReaderTheme;
  pdfScale?: number;
}

export interface DoubaoConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  stream: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time: string;
  quote?: string;
  bookTitle?: string;
}

export type QuickActionType = 'explain' | 'summarize' | 'notes' | 'analyze' | 'review';

export interface WebDavConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  autoSync: boolean;
  lastSyncAt?: string;
}
