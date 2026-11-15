import type { BookMetadata, ReadingStats } from '../types/bookshelf';

export function formatDateStr(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getWeekStartDateStr(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setDate(d.getDate() + diff);
  return formatDateStr(d);
}

export function getMonthStartDateStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export function getYearStartDateStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-01-01`;
}

export function formatPercent(val: number): string {
  const n = Math.max(0, Math.round((Number(val) || 0) * 10) / 10);
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`;
}

export function genId(prefix = 'book'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeFileName(name: string): string {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
}

export function computeReadingStats(books: BookMetadata[], now: Date = new Date()): ReadingStats {
  const weekStart = getWeekStartDateStr(now);
  const monthStart = getMonthStartDateStr(now);
  const yearStart = getYearStartDateStr(now);

  let weekTotal = 0;
  let monthTotal = 0;
  let yearTotal = 0;
  const weekBooks = new Set<string>();
  const monthBooks = new Set<string>();
  const yearBooks = new Set<string>();

  for (const book of books) {
    const history = Array.isArray(book.readHistory) ? book.readHistory : [];
    if (history.length > 0) {
      for (const entry of history) {
        const d = entry.date || '';
        const delta = Number(entry.deltaPercent) || 0;
        if (d >= weekStart) {
          weekTotal += delta;
          if (delta > 0) weekBooks.add(book.id);
        }
        if (d >= monthStart) {
          monthTotal += delta;
          if (delta > 0) monthBooks.add(book.id);
        }
        if (d >= yearStart) {
          yearTotal += delta;
          if (delta > 0) yearBooks.add(book.id);
        }
      }
    } else if ((Number(book.readPercent) || 0) > 0 && book.startReadTime) {
      const pct = Number(book.readPercent) || 0;
      if (book.startReadTime >= weekStart) {
        weekTotal += pct;
        weekBooks.add(book.id);
      }
      if (book.startReadTime >= monthStart) {
        monthTotal += pct;
        monthBooks.add(book.id);
      }
      if (book.startReadTime >= yearStart) {
        yearTotal += pct;
        yearBooks.add(book.id);
      }
    }
  }

  return {
    weekTotal: Math.max(0, Math.round(weekTotal * 10) / 10),
    monthTotal: Math.max(0, Math.round(monthTotal * 10) / 10),
    yearTotal: Math.max(0, Math.round(yearTotal * 10) / 10),
    weekBookCount: weekBooks.size,
    monthBookCount: monthBooks.size,
    yearBookCount: yearBooks.size,
  };
}
