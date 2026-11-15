import type { ParsedBook, ReaderPage, TocItem } from '../types/bookshelf';
import { parseZip } from './zipEngine';
import { parseMobiBuffer } from './mobiParser';
import { parsePdfMetadata } from './pdfService';

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveRelativePath(baseDir: string, relPath: string): string {
  const cleanRel = decodeURIComponent(relPath.split('#')[0]);
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const part of cleanRel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function decodeTextSmart(arrayBuffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(arrayBuffer);
    } catch {
      return new TextDecoder('utf-8').decode(arrayBuffer);
    }
  }
}

function textWeight(str: string): number {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += str.charCodeAt(i) > 255 ? 2 : 1;
  }
  return w;
}

interface ContentBlock {
  chapterKey?: string;
  chapterTitle?: string;
  text: string;
  html: string;
}

function paginateBlocks(
  blocks: ContentBlock[],
  tocEntries: { key: string; title: string }[]
): { pages: ReaderPage[]; toc: TocItem[] } {
  const MAX_WEIGHT = 1850;
  const pages: ReaderPage[] = [];
  let currentHtml = '';
  let currentPlain = '';
  let currentWeight = 0;
  let currentChapter = tocEntries.length ? tocEntries[0].title : '正文';
  const chapterPageMap = new Map<string, number>();

  const flushPage = () => {
    if (currentHtml) {
      pages.push({
        html: currentHtml,
        plainText: currentPlain.trim(),
        chapter: currentChapter,
      });
      currentHtml = '';
      currentPlain = '';
      currentWeight = 0;
    }
  };

  for (const block of blocks) {
    if (block.chapterTitle && block.chapterKey) {
      currentChapter = block.chapterTitle;
      if (currentWeight > 280) {
        flushPage();
      }
      if (!chapterPageMap.has(block.chapterKey)) {
        chapterPageMap.set(block.chapterKey, pages.length);
      }
    }

    const w = textWeight(block.text) + 60;
    if (currentWeight > 0 && currentWeight + w > MAX_WEIGHT) {
      flushPage();
    }

    currentHtml += block.html;
    currentPlain += (currentPlain ? '\n' : '') + block.text;
    currentWeight += w;
  }
  flushPage();

  if (pages.length === 0) {
    pages.push({
      html: '<p>本书暂无可显示的文本内容。</p>',
      plainText: '本书暂无可显示的文本内容。',
      chapter: '正文',
    });
  }

  const finalToc: TocItem[] = tocEntries.map((item, idx) => ({
    title: item.title,
    pageIndex: chapterPageMap.has(item.key)
      ? chapterPageMap.get(item.key)!
      : Math.min(idx, pages.length - 1),
  }));

  return { pages, toc: finalToc };
}

function htmlStringToPaginatedBook(
  htmlString: string,
  coverBlob: Blob | null = null
): ParsedBook {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  const body = doc.body || doc.documentElement;
  body.querySelectorAll('script, style, svg, nav').forEach((el) => el.remove());

  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];
  const chapterRegex =
    /^(第[零一二三四五六七八九十百千万0-9]+[章节回卷部篇集].{0,35}|Chapter\s+\d+.*|序章.*|前言.*|楔子.*|尾声.*|后记.*|番外.*)$/i;

  let chIdx = 0;
  const elements = body.querySelectorAll('h1, h2, h3, h4, p, blockquote, li, pre');

  if (elements.length > 0) {
    for (const el of Array.from(elements)) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const tag = el.tagName.toLowerCase();
      const isHeading = ['h1', 'h2', 'h3'].includes(tag) || (txt.length <= 42 && chapterRegex.test(txt));

      if (isHeading && toc.length < 400) {
        const key = `ch_${chIdx++}`;
        const label = txt.slice(0, 60);
        toc.push({ key, title: label });
        blocks.push({
          chapterKey: key,
          chapterTitle: label,
          text: txt,
          html: `<${tag === 'p' ? 'h2' : tag}>${escapeHtml(txt)}</${tag === 'p' ? 'h2' : tag}>`,
        });
      } else {
        const safeTag = ['h1', 'h2', 'h3', 'h4', 'blockquote'].includes(tag) ? tag : 'p';
        blocks.push({
          text: txt,
          html: `<${safeTag}>${escapeHtml(txt)}</${safeTag}>`,
        });
      }
    }
  } else {
    const plainLines = (body.textContent || '').split(/\r?\n/);
    for (const raw of plainLines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.length <= 45 && chapterRegex.test(line)) {
        const key = `ch_${chIdx++}`;
        toc.push({ key, title: line });
        blocks.push({
          chapterKey: key,
          chapterTitle: line,
          text: line,
          html: `<h2>${escapeHtml(line)}</h2>`,
        });
      } else {
        blocks.push({ text: line, html: `<p>${escapeHtml(line)}</p>` });
      }
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'ch_0', title: '正文内容' });
    if (blocks.length > 0) {
      blocks[0].chapterKey = 'ch_0';
      blocks[0].chapterTitle = '正文内容';
    }
  }

  const paginated = paginateBlocks(blocks, toc);
  return { kind: 'text', ...paginated, coverBlob };
}

export function parseTxt(arrayBuffer: ArrayBuffer): ParsedBook {
  const rawText = decodeTextSmart(arrayBuffer);
  const lines = rawText.split(/\r?\n/);
  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];
  const chapterRegex =
    /^(第[零一二三四五六七八九十百千万0-9]+[章节回卷部篇集].{0,35}|Chapter\s+\d+.*|序章.*|前言.*|楔子.*|尾声.*|后记.*|番外.*)$/i;

  let chapterIdx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.length <= 45 && chapterRegex.test(line)) {
      const key = `ch_${chapterIdx++}`;
      toc.push({ key, title: line });
      blocks.push({
        chapterKey: key,
        chapterTitle: line,
        text: line,
        html: `<h2>${escapeHtml(line)}</h2>`,
      });
    } else if (line.length > 600) {
      for (let i = 0; i < line.length; i += 450) {
        const sub = line.slice(i, i + 450);
        blocks.push({ text: sub, html: `<p>${escapeHtml(sub)}</p>` });
      }
    } else {
      blocks.push({ text: line, html: `<p>${escapeHtml(line)}</p>` });
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'ch_0', title: '全文正文' });
    if (blocks.length > 0) {
      blocks[0].chapterKey = 'ch_0';
      blocks[0].chapterTitle = '全文正文';
    }
  }

  return { kind: 'text', ...paginateBlocks(blocks, toc) };
}

export function parseMarkdown(arrayBuffer: ArrayBuffer): ParsedBook {
  const rawText = decodeTextSmart(arrayBuffer);
  const lines = rawText.split(/\r?\n/);
  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];
  let chapterIdx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = Math.min(4, hMatch[1].length);
      const title = hMatch[2].replace(/\*\*/g, '').trim();
      const key = `md_${chapterIdx++}`;
      toc.push({ key, title });
      blocks.push({
        chapterKey: key,
        chapterTitle: title,
        text: title,
        html: `<h${level}>${escapeHtml(title)}</h${level}>`,
      });
    } else if (line.startsWith('>')) {
      const quote = line.replace(/^>\s*/, '');
      blocks.push({
        text: quote,
        html: `<blockquote>${escapeHtml(quote)}</blockquote>`,
      });
    } else {
      const cleaned = line
        .replace(/^[-*+]\s+/, '• ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
      blocks.push({ text: cleaned, html: `<p>${escapeHtml(cleaned)}</p>` });
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'md_0', title: '文档正文' });
    if (blocks.length > 0) {
      blocks[0].chapterKey = 'md_0';
      blocks[0].chapterTitle = '文档正文';
    }
  }

  return { kind: 'text', ...paginateBlocks(blocks, toc) };
}

export async function parseDocx(arrayBuffer: ArrayBuffer): Promise<ParsedBook> {
  const zip = await parseZip(arrayBuffer);
  const docXml = await zip.getEntryText('word/document.xml');
  if (!docXml) throw new Error('无效的 DOCX 文件（缺少 word/document.xml）');

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXml, 'application/xml');
  const paragraphs = Array.from(xmlDoc.getElementsByTagNameNS('*', 'p'));

  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];
  let chIdx = 0;

  for (const p of paragraphs) {
    const textNodes = Array.from(p.getElementsByTagNameNS('*', 't'));
    const txt = textNodes.map((n) => n.textContent || '').join('').trim();
    if (!txt) continue;

    const pStyle = p.getElementsByTagNameNS('*', 'pStyle')[0]?.getAttribute('w:val') || '';
    const isHeading = /Heading[1-3]|Title|标题/i.test(pStyle);

    if (isHeading) {
      const key = `doc_${chIdx++}`;
      const label = txt.slice(0, 60);
      toc.push({ key, title: label });
      blocks.push({
        chapterKey: key,
        chapterTitle: label,
        text: txt,
        html: `<h2>${escapeHtml(txt)}</h2>`,
      });
    } else {
      blocks.push({ text: txt, html: `<p>${escapeHtml(txt)}</p>` });
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'doc_0', title: '文档正文' });
    if (blocks.length > 0) {
      blocks[0].chapterKey = 'doc_0';
      blocks[0].chapterTitle = '文档正文';
    }
  }

  return { kind: 'text', ...paginateBlocks(blocks, toc) };
}

export function parseFb2(
  arrayBuffer: ArrayBuffer,
  extractCoverOnly = false
): ParsedBook {
  const xmlText = decodeTextSmart(arrayBuffer);
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

  // Cover extraction
  let coverBlob: Blob | null = null;
  const coverImageEl = xmlDoc.querySelector('coverpage image');
  const hrefAttr =
    coverImageEl?.getAttribute('l:href') ||
    coverImageEl?.getAttribute('xlink:href') ||
    coverImageEl?.getAttribute('href') ||
    '';
  const coverId = hrefAttr.replace(/^#/, '');

  const binaries = Array.from(xmlDoc.querySelectorAll('binary'));
  const targetBin =
    binaries.find((b) => b.getAttribute('id') === coverId) || binaries[0];
  if (targetBin && targetBin.textContent) {
    try {
      const cleanB64 = targetBin.textContent.replace(/\s+/g, '');
      const binStr = atob(cleanB64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const mime = targetBin.getAttribute('content-type') || 'image/jpeg';
      coverBlob = new Blob([bytes.buffer], { type: mime });
    } catch {
      coverBlob = null;
    }
  }

  if (extractCoverOnly) {
    return { kind: 'text', pages: [], toc: [], coverBlob };
  }

  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];
  let chIdx = 0;

  const bodies = Array.from(xmlDoc.querySelectorAll('FictionBook > body'));
  for (const body of bodies) {
    const sections = Array.from(body.querySelectorAll('section'));
    const targets = sections.length > 0 ? sections : [body];

    for (const sec of targets) {
      const titleEl = Array.from(sec.children).find((c) => c.tagName === 'title');
      const titleText = titleEl?.textContent?.replace(/\s+/g, ' ').trim();
      let assigned = false;
      const key = `fb_${chIdx++}`;

      if (titleText) {
        toc.push({ key, title: titleText.slice(0, 60) });
        blocks.push({
          chapterKey: key,
          chapterTitle: titleText.slice(0, 60),
          text: titleText,
          html: `<h2>${escapeHtml(titleText)}</h2>`,
        });
        assigned = true;
      }

      for (const child of Array.from(sec.children)) {
        if (child.tagName === 'section' || child.tagName === 'title') continue;
        const txt = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const tag = child.tagName === 'cite' || child.tagName === 'epigraph' ? 'blockquote' : 'p';
        const blk: ContentBlock = {
          text: txt,
          html: `<${tag}>${escapeHtml(txt)}</${tag}>`,
        };
        if (!assigned && titleText) {
          blk.chapterKey = key;
          blk.chapterTitle = titleText.slice(0, 60);
          assigned = true;
        }
        blocks.push(blk);
      }
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'fb_0', title: '正文开始' });
  }

  return { kind: 'text', ...paginateBlocks(blocks, toc), coverBlob };
}

export async function parseCbz(
  arrayBuffer: ArrayBuffer,
  extractCoverOnly = false
): Promise<ParsedBook> {
  const zip = await parseZip(arrayBuffer);
  const imageNames = Array.from(zip.entries.keys())
    .filter((name) => /\.(jpe?g|png|webp|gif)$/i.test(name) && !name.startsWith('__MACOSX'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  if (imageNames.length === 0) {
    throw new Error('CBZ 压缩包内未找到有效图片文件');
  }

  const getMime = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/jpeg';
  };

  let coverBlob: Blob | null = null;
  const firstBytes = await zip.getEntryBytes(imageNames[0]);
  if (firstBytes) {
    coverBlob = new Blob([new Uint8Array(firstBytes).buffer], {
      type: getMime(imageNames[0]),
    });
  }

  if (extractCoverOnly) {
    return { kind: 'comic', pages: [], toc: [], coverBlob };
  }

  const pages: ReaderPage[] = [];
  const toc: TocItem[] = [];
  for (let i = 0; i < imageNames.length; i++) {
    const name = imageNames[i];
    const b = await zip.getEntryBytes(name);
    if (!b) continue;
    const blob = new Blob([new Uint8Array(b).buffer], { type: getMime(name) });
    const objectUrl = URL.createObjectURL(blob);
    pages.push({
      html: '',
      plainText: `第 ${i + 1} 页（图文画页）`,
      chapter: `第 ${i + 1} / ${imageNames.length} 页`,
      imageUrl: objectUrl,
    });
    if (i % 10 === 0) {
      toc.push({ title: `第 ${i + 1} 页`, pageIndex: i });
    }
  }

  return { kind: 'comic', pages, toc, coverBlob };
}

export async function parseEpub(
  arrayBuffer: ArrayBuffer,
  extractCoverOnly = false
): Promise<ParsedBook> {
  const zip = await parseZip(arrayBuffer);
  const containerXml = await zip.getEntryText('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 缺少 META-INF/container.xml');

  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile ? rootfile.getAttribute('full-path') : null;
  if (!opfPath) throw new Error('EPUB 未找到 content.opf 路径');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = await zip.getEntryText(opfPath);
  if (!opfXml) throw new Error('EPUB 无法读取 content.opf');
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  const manifest = new Map<
    string,
    { id: string; href: string; fullPath: string; mediaType: string; props: string }
  >();
  let coverHref: string | null = null;
  let ncxPath: string | null = null;
  let navPath: string | null = null;

  for (const item of Array.from(opfDoc.querySelectorAll('manifest > item'))) {
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';
    const mediaType = item.getAttribute('media-type') || '';
    const props = item.getAttribute('properties') || '';
    const fullPath = resolveRelativePath(opfDir, href);

    manifest.set(id, { id, href, fullPath, mediaType, props });
    if (
      props.includes('cover-image') ||
      (mediaType.startsWith('image/') && id.toLowerCase().includes('cover'))
    ) {
      if (!coverHref) coverHref = fullPath;
    }
    if (mediaType === 'application/x-dtbncx+xml') ncxPath = fullPath;
    if (props.includes('nav')) navPath = fullPath;
  }

  const coverMeta = opfDoc.querySelector('metadata meta[name="cover"]');
  if (coverMeta) {
    const cid = coverMeta.getAttribute('content');
    if (cid && manifest.has(cid)) {
      coverHref = manifest.get(cid)!.fullPath;
    }
  }

  let extractedCoverBlob: Blob | null = null;
  if (coverHref) {
    const coverBytes = await zip.getEntryBytes(coverHref);
    if (coverBytes) {
      const ext = coverHref.split('.').pop()?.toLowerCase() || 'jpg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      extractedCoverBlob = new Blob([new Uint8Array(coverBytes).buffer], { type: mime });
    }
  }

  if (extractCoverOnly) {
    return { kind: 'text', pages: [], toc: [], coverBlob: extractedCoverBlob };
  }

  const pathToTitle = new Map<string, string>();
  if (navPath) {
    const navHtml = await zip.getEntryText(navPath);
    if (navHtml) {
      const navDir = navPath.includes('/') ? navPath.slice(0, navPath.lastIndexOf('/')) : '';
      const navDoc = parser.parseFromString(navHtml, 'text/html');
      navDoc.querySelectorAll('nav a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href) return;
        const target = resolveRelativePath(navDir, href);
        const label = a.textContent?.trim() || '';
        if (target && label && !pathToTitle.has(target)) {
          pathToTitle.set(target, label);
        }
      });
    }
  } else if (ncxPath) {
    const ncxXml = await zip.getEntryText(ncxPath);
    if (ncxXml) {
      const ncxDir = ncxPath.includes('/') ? ncxPath.slice(0, ncxPath.lastIndexOf('/')) : '';
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      ncxDoc.querySelectorAll('navPoint').forEach((np) => {
        const label = np.querySelector('navLabel > text')?.textContent?.trim();
        const src = np.querySelector('content')?.getAttribute('src');
        if (label && src) {
          const target = resolveRelativePath(ncxDir, src);
          if (!pathToTitle.has(target)) pathToTitle.set(target, label);
        }
      });
    }
  }

  const spineRefs = Array.from(opfDoc.querySelectorAll('spine > itemref'));
  const blocks: ContentBlock[] = [];
  const toc: { key: string; title: string }[] = [];

  for (let sIdx = 0; sIdx < spineRefs.length; sIdx++) {
    const idref = spineRefs[sIdx].getAttribute('idref');
    if (!idref) continue;
    const item = manifest.get(idref);
    if (!item) continue;
    const htmlStr = await zip.getEntryText(item.fullPath);
    if (!htmlStr) continue;

    const doc = parser.parseFromString(htmlStr, 'text/html');
    const body = doc.body;
    if (!body) continue;

    body.querySelectorAll('script, style, svg').forEach((el) => el.remove());

    let chTitle = pathToTitle.get(item.fullPath);
    if (!chTitle) {
      const h = body.querySelector('h1, h2, h3');
      if (h && h.textContent?.trim()) chTitle = h.textContent.trim().slice(0, 60);
    }

    const chapterKey = `sp_${sIdx}`;
    let assignedChapter = false;
    if (chTitle) {
      toc.push({ key: chapterKey, title: chTitle });
    }

    const elements = body.querySelectorAll('h1, h2, h3, h4, p, blockquote, li, pre');
    if (elements.length > 0) {
      elements.forEach((el) => {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        const tag = el.tagName.toLowerCase();
        const safeTag = ['h1', 'h2', 'h3', 'h4', 'blockquote'].includes(tag) ? tag : 'p';
        const blk: ContentBlock = {
          text: txt,
          html: `<${safeTag}>${escapeHtml(txt)}</${safeTag}>`,
        };
        if (!assignedChapter && chTitle) {
          blk.chapterKey = chapterKey;
          blk.chapterTitle = chTitle;
          assignedChapter = true;
        }
        blocks.push(blk);
      });
    } else {
      const plain = (body.textContent || '').replace(/\s+/g, ' ').trim();
      if (plain) {
        const blk: ContentBlock = { text: plain, html: `<p>${escapeHtml(plain)}</p>` };
        if (chTitle) {
          blk.chapterKey = chapterKey;
          blk.chapterTitle = chTitle;
        }
        blocks.push(blk);
      }
    }
  }

  if (toc.length === 0) {
    toc.push({ key: 'sp_0', title: '正文开始' });
  }

  const paginated = paginateBlocks(blocks, toc);
  return { kind: 'text', ...paginated, coverBlob: extractedCoverBlob };
}

export async function parseBookFile(
  arrayBuffer: ArrayBuffer,
  fileType: string,
  extractCoverOnly = false
): Promise<ParsedBook> {
  const ext = fileType.toLowerCase();
  if (ext === 'epub') {
    return parseEpub(arrayBuffer, extractCoverOnly);
  }
  if (ext === 'pdf') {
    return parsePdfMetadata(arrayBuffer, extractCoverOnly);
  }
  if (['mobi', 'azw', 'azw3', 'prc'].includes(ext)) {
    const mobi = parseMobiBuffer(arrayBuffer);
    if (extractCoverOnly) {
      return { kind: 'text', pages: [], toc: [], coverBlob: mobi.coverBlob };
    }
    return htmlStringToPaginatedBook(mobi.htmlContent, mobi.coverBlob);
  }
  if (ext === 'fb2') {
    return parseFb2(arrayBuffer, extractCoverOnly);
  }
  if (ext === 'cbz') {
    return parseCbz(arrayBuffer, extractCoverOnly);
  }
  if (extractCoverOnly) {
    return { kind: 'text', pages: [], toc: [], coverBlob: null };
  }
  if (ext === 'docx') {
    return parseDocx(arrayBuffer);
  }
  if (ext === 'md' || ext === 'markdown') {
    return parseMarkdown(arrayBuffer);
  }
  if (ext === 'html' || ext === 'htm') {
    return htmlStringToPaginatedBook(decodeTextSmart(arrayBuffer), null);
  }
  return parseTxt(arrayBuffer);
}

export function generateDefaultCoverBlob(title: string): Promise<Blob> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;

    const palettes = [
      ['#3E5C47', '#273B2D', '#F4F1EA'],
      ['#73573E', '#4B3725', '#F7F2E8'],
      ['#3E5063', '#26323F', '#EEF2F6'],
      ['#6E4549', '#472B2E', '#F8EEEE'],
    ];
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = title.charCodeAt(i) + ((hash << 5) - hash);
    }
    const pal = palettes[Math.abs(hash) % palettes.length];

    const grad = ctx.createLinearGradient(0, 0, 360, 480);
    grad.addColorStop(0, pal[0]);
    grad.addColorStop(1, pal[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 360, 480);

    ctx.strokeStyle = 'rgba(255,255,255,0.26)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(24, 24, 312, 432);
    ctx.strokeRect(32, 32, 296, 416);

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, 14, 480);

    ctx.fillStyle = pal[2];
    ctx.font = 'bold 28px "Songti SC", "Noto Serif SC", serif';
    ctx.textAlign = 'center';

    const chars = Array.from(title || '未命名书籍');
    const lines: string[] = [];
    let line = '';
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > 236) {
        lines.push(line);
        line = ch;
        if (lines.length >= 4) break;
      } else {
        line += ch;
      }
    }
    if (line && lines.length < 4) lines.push(line);

    const startY = 205 - (lines.length - 1) * 22;
    lines.forEach((ln, idx) => {
      ctx.fillText(ln, 186, startY + idx * 44);
    });

    ctx.font = '13px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('LOCAL LIBRARY', 186, 414);

    canvas.toBlob((blob) => {
      resolve(blob || new Blob([], { type: 'image/png' }));
    }, 'image/png');
  });
}
