import type { BookMetadata, WebDavConfig } from '../types/bookshelf';

export interface RemoteLibraryPayload {
  version: number;
  updatedAt: string;
  books: BookMetadata[];
  deletedIds?: Record<string, number>;
}

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

function encodeBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return `Basic ${btoa(bin)}`;
}

function joinDavPath(baseUrl: string, relPath: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const cleanRel = relPath
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${base}/${cleanRel}`;
}

function buildHeaders(cfg: WebDavConfig, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...(extra || {}) };
  if (cfg.username || cfg.password) {
    headers['Authorization'] = encodeBasicAuth(cfg.username, cfg.password);
  }
  return headers;
}

function diagnoseFetchError(err: unknown, url: string): string {
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    /^http:\/\//i.test(url.trim())
  ) {
    return '当前网页通过 HTTPS 打开，浏览器安全策略禁止直接访问 HTTP 局域网地址。请改用 HTTPS WebDAV、将网页部署到局域网 HTTP 地址（如 NAS/路由器），或在电脑上使用桌面端。';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return '无法连接 WebDAV 服务：请检查局域网地址是否可达，或确认 NAS/AList/dufs 已开启跨域允许 (CORS)。';
  }
  return `WebDAV 请求异常：${msg}`;
}

export async function testWebDavConnection(
  cfg: WebDavConfig
): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeBaseUrl(cfg.url);
  if (!base || !/^https?:\/\//i.test(base)) {
    return { ok: false, error: '请填写完整的 http:// 或 https:// WebDAV 目录地址' };
  }

  try {
    // First try PROPFIND (Depth: 0) or fallback to GET data/books.json
    let resp = await fetch(base, {
      method: 'PROPFIND',
      headers: buildHeaders(cfg, { Depth: '0' }),
    });

    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(joinDavPath(base, 'data/books.json'), {
        method: 'GET',
        headers: buildHeaders(cfg),
      });
    }

    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: '账号或密码（应用专用密码）校验失败，请检查权限设置' };
    }

    if (!resp.ok && resp.status !== 207 && resp.status !== 404) {
      return { ok: false, error: `服务器返回状态码 ${resp.status}，请确认该路径存在且允许读写` };
    }

    await ensureWebDavSubDirs(cfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: diagnoseFetchError(err, base) };
  }
}

export async function ensureWebDavSubDirs(cfg: WebDavConfig): Promise<void> {
  const dirs = ['cover', 'bookfile', 'data'];
  for (const dir of dirs) {
    try {
      await fetch(joinDavPath(cfg.url, dir) + '/', {
        method: 'MKCOL',
        headers: buildHeaders(cfg),
      });
    } catch {
      // ignore if already exists or server auto-creates directories on PUT
    }
  }
}

export async function readWebDavBooksJson(
  cfg: WebDavConfig
): Promise<RemoteLibraryPayload | null> {
  const resp = await fetch(joinDavPath(cfg.url, 'data/books.json'), {
    method: 'GET',
    headers: buildHeaders(cfg, { 'Cache-Control': 'no-cache' }),
  });
  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    throw new Error(`读取远端 books.json 失败 (${resp.status})`);
  }
  const text = await resp.text();
  if (!text.trim()) return null;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.books)) return null;
  return {
    version: Number(parsed.version) || 1,
    updatedAt: String(parsed.updatedAt || ''),
    books: parsed.books,
    deletedIds:
      parsed.deletedIds && typeof parsed.deletedIds === 'object' ? parsed.deletedIds : {},
  };
}

export async function writeWebDavBooksJson(
  cfg: WebDavConfig,
  books: BookMetadata[],
  deletedIds: Record<string, number>
): Promise<void> {
  await ensureWebDavSubDirs(cfg);
  const payload: RemoteLibraryPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    books,
    deletedIds,
  };
  const resp = await fetch(joinDavPath(cfg.url, 'data/books.json'), {
    method: 'PUT',
    headers: buildHeaders(cfg, { 'Content-Type': 'application/json; charset=utf-8' }),
    body: JSON.stringify(payload, null, 2),
  });
  if (!resp.ok) {
    throw new Error(`写入远端 books.json 失败 (${resp.status})`);
  }
}

export async function uploadWebDavFile(
  cfg: WebDavConfig,
  relPath: string,
  data: Blob
): Promise<void> {
  const resp = await fetch(joinDavPath(cfg.url, relPath), {
    method: 'PUT',
    headers: buildHeaders(cfg, {
      'Content-Type': data.type || 'application/octet-stream',
    }),
    body: data,
  });
  if (!resp.ok) {
    throw new Error(`上传 ${relPath} 失败 (${resp.status})`);
  }
}

export async function downloadWebDavFile(
  cfg: WebDavConfig,
  relPath: string
): Promise<Blob | null> {
  try {
    const resp = await fetch(joinDavPath(cfg.url, relPath), {
      method: 'GET',
      headers: buildHeaders(cfg),
    });
    if (!resp.ok) return null;
    return await resp.blob();
  } catch {
    return null;
  }
}

export async function deleteWebDavFile(
  cfg: WebDavConfig,
  relPath: string
): Promise<void> {
  if (!relPath) return;
  try {
    await fetch(joinDavPath(cfg.url, relPath), {
      method: 'DELETE',
      headers: buildHeaders(cfg),
    });
  } catch {
    // ignore missing or unsupported delete
  }
}

export function mergeBookLibraries(
  localBooks: BookMetadata[],
  remoteBooks: BookMetadata[],
  localDeletedIds: Record<string, number>,
  remoteDeletedIds: Record<string, number>
): {
  mergedBooks: BookMetadata[];
  mergedDeletedIds: Record<string, number>;
  toUploadToRemote: BookMetadata[];
} {
  const mergedDeletedIds: Record<string, number> = { ...localDeletedIds };
  for (const [id, ts] of Object.entries(remoteDeletedIds || {})) {
    if (!mergedDeletedIds[id] || ts > mergedDeletedIds[id]) {
      mergedDeletedIds[id] = ts;
    }
  }

  const remoteMap = new Map<string, BookMetadata>();
  for (const rb of remoteBooks) {
    const delTs = mergedDeletedIds[rb.id] || 0;
    const bookTs = Math.max(rb.lastReadTimestamp || 0, rb.addedTimestamp || 0);
    if (delTs > bookTs) continue;
    remoteMap.set(rb.id, rb);
  }

  const mergedMap = new Map<string, BookMetadata>(remoteMap);
  const toUploadToRemote: BookMetadata[] = [];

  for (const lb of localBooks) {
    const delTs = mergedDeletedIds[lb.id] || 0;
    const localTs = Math.max(lb.lastReadTimestamp || 0, lb.addedTimestamp || 0);
    if (delTs > localTs) continue;

    const rb = remoteMap.get(lb.id);
    if (!rb) {
      mergedMap.set(lb.id, lb);
      toUploadToRemote.push(lb);
    } else {
      const remoteTs = Math.max(rb.lastReadTimestamp || 0, rb.addedTimestamp || 0);
      if (localTs > remoteTs) {
        mergedMap.set(lb.id, lb);
      } else if (localTs === remoteTs && (lb.readPercent || 0) > (rb.readPercent || 0)) {
        mergedMap.set(lb.id, lb);
      }
    }
  }

  return {
    mergedBooks: Array.from(mergedMap.values()),
    mergedDeletedIds,
    toUploadToRemote,
  };
}
