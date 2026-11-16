export interface MobiParseResult {
  title?: string;
  htmlContent: string;
  coverBlob: Blob | null;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function getTextDecoderForCode(encodingCode: number): TextDecoder {
  if (encodingCode === 1252) {
    return new TextDecoder('windows-1252');
  }
  if (encodingCode === 936 || encodingCode === 54936) {
    try {
      return new TextDecoder('gb18030');
    } catch {
      return new TextDecoder('utf-8');
    }
  }
  return new TextDecoder('utf-8');
}

function stripTrailingExtraBytes(record: Uint8Array, extraDataFlags: number): Uint8Array {
  if (!extraDataFlags || record.length === 0) return record;
  let end = record.length;

  for (let bit = 15; bit >= 1; bit--) {
    if ((extraDataFlags & (1 << bit)) !== 0) {
      let size = 0;
      let shift = 0;
      while (end > 0) {
        end--;
        const b = record[end];
        size |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) !== 0) break;
      }
      if (size > 0 && size <= end) {
        end -= size;
      }
    }
  }

  if ((extraDataFlags & 1) !== 0 && end > 0) {
    const trailingCount = (record[end - 1] & 0x03) + 1;
    if (trailingCount <= end) {
      end -= trailingCount;
    }
  }

  return record.subarray(0, Math.max(0, end));
}

function decompressPalmDocLz77(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i++];
    if (c === 0) {
      out.push(0);
    } else if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && i < input.length; k++) {
        out.push(input[i++]);
      }
    } else if (c <= 0x7f) {
      out.push(c);
    } else if (c >= 0xc0) {
      out.push(0x20, c ^ 0x80);
    } else {
      if (i >= input.length) break;
      const next = input[i++];
      const pair = (c << 8) | next;
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 0x07) + 3;
      if (distance > 0) {
        for (let k = 0; k < length; k++) {
          const srcIdx = out.length - distance;
          out.push(srcIdx >= 0 ? out[srcIdx] : 0x20);
        }
      }
    }
  }
  return new Uint8Array(out);
}

interface HuffContext {
  dict1: { codelen: number; term: boolean; maxcode: number }[];
  mincode: number[];
  maxcode: number[];
  dicts: Uint8Array[];
}

function createHuffContext(huffRecords: Uint8Array[]): HuffContext {
  const huff0 = huffRecords[0];
  if (!huff0 || huff0.length < 24) {
    throw new Error('无效的 MOBI HUFF 压缩头');
  }
  const view0 = new DataView(huff0.buffer, huff0.byteOffset, huff0.byteLength);
  const magic = new TextDecoder('ascii').decode(huff0.subarray(0, 4));
  if (magic !== 'HUFF') {
    throw new Error('无效的 MOBI HUFF 压缩头');
  }
  // HUFF tables in PalmDB/Mobipocket are Big-Endian
  const off1 = view0.getUint32(16, false);
  const off2 = view0.getUint32(20, false);

  const dict1: { codelen: number; term: boolean; maxcode: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const v = view0.getUint32(off1 + i * 4, false);
    const codelen = v & 0x1f;
    const term = (v & 0x80) !== 0;
    const rawMax = v >>> 8;
    const maxcode = codelen === 0 ? 0 : (((rawMax + 1) << (32 - codelen)) - 1) >>> 0;
    dict1.push({ codelen, term, maxcode });
  }

  const mincode = new Array<number>(33).fill(0);
  const maxcode = new Array<number>(33).fill(0);
  for (let codelen = 1; codelen <= 32; codelen++) {
    const base = off2 + (codelen - 1) * 8;
    if (base + 8 > huff0.length) break;
    const rawMin = view0.getUint32(base, false);
    const rawMax = view0.getUint32(base + 4, false);
    mincode[codelen] = (rawMin << (32 - codelen)) >>> 0;
    maxcode[codelen] = (((rawMax + 1) << (32 - codelen)) - 1) >>> 0;
  }

  const dicts: Uint8Array[] = [];
  for (let i = 1; i < huffRecords.length; i++) {
    const rec = huffRecords[i];
    const recMagic = new TextDecoder('ascii').decode(rec.subarray(0, 4));
    if (recMagic === 'CDIC') {
      dicts.push(rec);
    }
  }

  return { dict1, mincode, maxcode, dicts };
}

function decompressHuffCdic(input: Uint8Array, ctx: HuffContext): Uint8Array {
  const out: number[] = [];

  function unpackBits(buf: Uint8Array, depth = 0) {
    if (depth > 32) return;
    let bitPos = 0;
    const totalBits = buf.length * 8;

    const read32 = (pos: number): number => {
      const byteIdx = pos >> 3;
      const bitOff = pos & 7;
      let val = 0n;
      for (let i = 0; i < 5; i++) {
        val = (val << 8n) | BigInt(byteIdx + i < buf.length ? buf[byteIdx + i] : 0);
      }
      val = (val >> BigInt(8 - bitOff)) & 0xffffffffn;
      return Number(val) >>> 0;
    };

    while (bitPos < totalBits) {
      const dw = read32(bitPos);
      const t1 = ctx.dict1[dw >>> 24];
      let codelen = t1.codelen;
      let dictCode = t1.maxcode;
      const isTerm = t1.term;

      if (!isTerm) {
        while (codelen < 32 && dw < ctx.mincode[codelen]) {
          codelen++;
        }
        dictCode = ctx.maxcode[codelen];
      }

      if (codelen === 0) break;
      bitPos += codelen;
      if (bitPos > totalBits) break;

      const index = ((dictCode - dw) >>> (32 - codelen)) >>> 0;
      const cdic = ctx.dicts[index >> 16] || ctx.dicts[0];
      if (!cdic || cdic.length < 16) break;

      const cdicView = new DataView(cdic.buffer, cdic.byteOffset, cdic.byteLength);
      const codeLenHeader = cdicView.getUint32(8, false);
      const entryIndex = index & ((1 << (codeLenHeader || 16)) - 1);
      const sliceOffsetPos = 16 + entryIndex * 2;
      if (sliceOffsetPos + 2 > cdic.length) break;
      const sliceOff = 16 + cdicView.getUint16(sliceOffsetPos, false);
      if (sliceOff + 2 > cdic.length) break;

      const sliceMeta = cdicView.getUint16(sliceOff, false);
      const sliceLen = sliceMeta & 0x7fff;
      const flag = (sliceMeta & 0x8000) !== 0;
      const sliceBytes = cdic.subarray(sliceOff + 2, sliceOff + 2 + sliceLen);

      if (flag) {
        for (let k = 0; k < sliceBytes.length; k++) {
          out.push(sliceBytes[k]);
        }
      } else {
        unpackBits(sliceBytes, depth + 1);
      }
    }
  }

  unpackBits(input);
  return new Uint8Array(out);
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return 'image/webp';
  }
  return null;
}

export function parseMobiBuffer(arrayBuffer: ArrayBuffer): MobiParseResult {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes.length < 86) {
    throw new Error('无效的 MOBI / AZW3 文件');
  }

  // PalmDB header fields are Big-Endian (offset 76 = numRecords, 78+ = 8-byte record info)
  const numRecords = view.getUint16(76, false);
  if (numRecords === 0 || 78 + numRecords * 8 > bytes.length) {
    throw new Error('MOBI 记录表损坏');
  }

  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(view.getUint32(78 + i * 8, false));
  }

  const getRecord = (idx: number): Uint8Array => {
    if (idx < 0 || idx >= numRecords) return new Uint8Array(0);
    const start = Math.min(bytes.length, offsets[idx]);
    const rawEnd = idx + 1 < numRecords ? offsets[idx + 1] : bytes.length;
    const end = Math.min(bytes.length, Math.max(start, rawEnd));
    return bytes.subarray(start, end);
  };

  const rec0 = getRecord(0);
  if (rec0.length < 16) throw new Error('MOBI Record 0 损坏');
  const rec0View = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);

  const compression = rec0View.getUint16(0, false);
  const textRecordCount = rec0View.getUint16(8, false);
  const encryptionType = rec0View.getUint16(12, false);

  if (encryptionType !== 0) {
    throw new Error('该电子书受 DRM 版权加密保护，请先解除 DRM 后再导入');
  }

  const magic = new TextDecoder('ascii').decode(rec0.subarray(16, 20));
  let encodingCode = 65001;
  let extraDataFlags = 0;
  let firstImageIndex = -1;
  let huffOffset = 0;
  let huffCount = 0;
  let coverOffset: number | null = null;
  let bookTitle: string | undefined;

  if (magic === 'MOBI' && rec0.length >= 132) {
    const mobiHeaderLength = rec0View.getUint32(20, false);
    encodingCode = rec0View.getUint32(28, false);
    const exthFlags = rec0View.getUint32(80, false);
    const fullNameOffset = rec0View.getUint32(84, false);
    const fullNameLength = rec0View.getUint32(88, false);
    const rawFirstImg = rec0View.getUint32(108, false);
    firstImageIndex = rawFirstImg < numRecords ? rawFirstImg : -1;

    if (compression === 17480 && rec0.length >= 120) {
      huffOffset = rec0View.getUint32(112, false);
      huffCount = rec0View.getUint32(116, false);
    }
    if (mobiHeaderLength >= 228 && rec0.length >= 244) {
      extraDataFlags = rec0View.getUint16(242, false);
    }

    const txtDec = getTextDecoderForCode(encodingCode);
    if (
      fullNameOffset > 0 &&
      fullNameLength > 0 &&
      fullNameOffset + fullNameLength <= rec0.length
    ) {
      const fn = txtDec.decode(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength)).trim();
      if (fn) bookTitle = fn;
    }

    const exthStart = 16 + mobiHeaderLength;
    if ((exthFlags & 0x40) !== 0 && exthStart + 12 <= rec0.length) {
      const exthMagic = new TextDecoder('ascii').decode(rec0.subarray(exthStart, exthStart + 4));
      if (exthMagic === 'EXTH') {
        const exthCount = rec0View.getUint32(exthStart + 8, false);
        let ptr = exthStart + 12;
        for (let i = 0; i < exthCount && ptr + 8 <= rec0.length; i++) {
          const recType = rec0View.getUint32(ptr, false);
          const recLen = rec0View.getUint32(ptr + 4, false);
          if (recLen < 8 || ptr + recLen > rec0.length) break;
          const valBytes = rec0.subarray(ptr + 8, ptr + recLen);
          if (recType === 201 && valBytes.length >= 4) {
            coverOffset = new DataView(
              valBytes.buffer,
              valBytes.byteOffset,
              valBytes.byteLength
            ).getUint32(0, false);
          } else if (recType === 503) {
            const t = txtDec.decode(valBytes).trim();
            if (t) bookTitle = t;
          }
          ptr += recLen;
        }
      }
    }
  }

  let huffCtx: HuffContext | null = null;
  if (compression === 17480) {
    if (huffOffset <= 0 || huffCount <= 0 || huffOffset + huffCount > numRecords) {
      throw new Error('缺少 HUFF/CDIC 解压词典记录');
    }
    const huffRecs: Uint8Array[] = [];
    for (let i = 0; i < huffCount; i++) {
      huffRecs.push(getRecord(huffOffset + i));
    }
    huffCtx = createHuffContext(huffRecs);
  }

  const decompressedChunks: Uint8Array[] = [];
  const maxTextRec = Math.min(textRecordCount, numRecords - 1);
  for (let i = 1; i <= maxTextRec; i++) {
    const rawRec = getRecord(i);
    if (rawRec.length >= 8) {
      const head = new TextDecoder('ascii').decode(rawRec.subarray(0, 8));
      if (head === 'BOUNDARY' || head.startsWith('FLIS') || head.startsWith('FCIS')) {
        break;
      }
    }
    const stripped = stripTrailingExtraBytes(rawRec, extraDataFlags);
    if (compression === 1) {
      decompressedChunks.push(stripped);
    } else if (compression === 2) {
      decompressedChunks.push(decompressPalmDocLz77(stripped));
    } else if (compression === 17480 && huffCtx) {
      decompressedChunks.push(decompressHuffCdic(stripped, huffCtx));
    } else {
      throw new Error(`不支持的 MOBI 压缩类型: ${compression}`);
    }
  }

  const fullBytes = concatBytes(decompressedChunks);
  const decoder = getTextDecoderForCode(encodingCode);
  const htmlContent = decoder.decode(fullBytes);

  let coverBlob: Blob | null = null;
  if (firstImageIndex > 0 && firstImageIndex < numRecords && coverOffset !== null) {
    const imgIdx = firstImageIndex + coverOffset;
    if (imgIdx >= 0 && imgIdx < numRecords) {
      const imgBytes = getRecord(imgIdx);
      const mime = detectImageMime(imgBytes);
      if (mime) {
        coverBlob = new Blob([new Uint8Array(imgBytes).buffer], { type: mime });
      }
    }
  }
  if (!coverBlob && firstImageIndex > 0 && firstImageIndex < numRecords) {
    for (let idx = firstImageIndex; idx < Math.min(firstImageIndex + 8, numRecords); idx++) {
      const candidate = getRecord(idx);
      const mime = detectImageMime(candidate);
      if (mime && candidate.length > 2000) {
        coverBlob = new Blob([new Uint8Array(candidate).buffer], { type: mime });
        break;
      }
    }
  }

  return { title: bookTitle, htmlContent, coverBlob };
}

function extractReadableStrings(bytes: Uint8Array): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const pushStr = (raw: string) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 4 || seen.has(cleaned)) return;
    if (/^[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+$/.test(cleaned)) return;
    seen.add(cleaned);
    found.push(cleaned);
  };

  // Pass 1: UTF-8 printable text runs (including CJK)
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const utf8Runs = utf8Text.match(/[\u4e00-\u9fffA-Za-z0-9\u3000-\u303f\uff00-\uffef.,;:!?'"()\[\]{}\-_/\\@#%&*+=~ ]{4,}/g);
  if (utf8Runs) {
    for (const run of utf8Runs) {
      if (/[A-Za-z0-9\u4e00-\u9fff]{2,}/.test(run)) {
        pushStr(run);
      }
    }
  }

  // Pass 2: UTF-16BE / UTF-16LE runs (common in Kindle KRDS / Java / .NET binary records)
  for (const enc of ['utf-16be', 'utf-16le'] as const) {
    try {
      const decoded = new TextDecoder(enc, { fatal: false }).decode(bytes);
      const runs = decoded.match(/[\u4e00-\u9fffA-Za-z0-9\u3000-\u303f\uff00-\uffef.,;:!?'"()\[\]{}\-_ ]{5,}/g);
      if (runs) {
        for (const run of runs) {
          if (/[\u4e00-\u9fff]{2,}|[A-Za-z]{4,}/.test(run)) {
            pushStr(run);
          }
        }
      }
    } catch {
      // ignore unsupported encoding
    }
  }

  return found.slice(0, 300);
}

function formatJsonObjectToHtml(obj: unknown): { title?: string; html: string } {
  const sections: string[] = [];
  let title: string | undefined;

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    const rawTitle = rec.title || rec.bookTitle || rec.name || rec.asin;
    if (typeof rawTitle === 'string' && rawTitle.trim()) {
      title = rawTitle.trim();
    }

    sections.push('<h2>MBPV2 书籍元数据摘要</h2>');
    const metaKeys = Object.keys(rec).filter((k) => {
      const v = rec[k];
      return v !== null && typeof v !== 'object';
    });
    if (metaKeys.length > 0) {
      for (const k of metaKeys) {
        sections.push(`<p><strong>${escapeHtml(k)}：</strong>${escapeHtml(String(rec[k]))}</p>`);
      }
    }

    const listKeys = Object.keys(rec).filter((k) => Array.isArray(rec[k]) || (rec[k] && typeof rec[k] === 'object'));
    for (const k of listKeys) {
      const val = rec[k];
      sections.push(`<h3>${escapeHtml(k)}</h3>`);
      if (Array.isArray(val)) {
        if (val.length === 0) {
          sections.push('<p>（暂无记录）</p>');
        } else {
          for (const item of val) {
            if (item && typeof item === 'object') {
              const itemObj = item as Record<string, unknown>;
              const text = itemObj.text || itemObj.highlight || itemObj.note || itemObj.content || JSON.stringify(item);
              const note = itemObj.note && itemObj.text ? `（笔记：${String(itemObj.note)}）` : '';
              const loc = itemObj.location || itemObj.position || itemObj.page || '';
              const prefix = loc ? `[位置 ${String(loc)}] ` : '';
              sections.push(`<blockquote>${escapeHtml(prefix + String(text) + note)}</blockquote>`);
            } else {
              sections.push(`<p>${escapeHtml(String(item))}</p>`);
            }
          }
        }
      } else {
        sections.push(`<blockquote>${escapeHtml(JSON.stringify(val, null, 2))}</blockquote>`);
      }
    }
  } else {
    sections.push('<h2>MBPV2 内容解析</h2>');
    sections.push(`<blockquote>${escapeHtml(JSON.stringify(obj, null, 2))}</blockquote>`);
  }

  return { title, html: sections.join('\n') };
}

export function parseMbpv2Buffer(arrayBuffer: ArrayBuffer): MobiParseResult {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 4) {
    throw new Error('MBPV2 文件内容为空或已损坏');
  }

  // 1. Check if it's actually a PalmDB / MOBI container renamed to .mbp / .mbpv2
  if (bytes.length >= 68) {
    const pdbType = new TextDecoder('ascii').decode(bytes.subarray(60, 68));
    if (pdbType === 'BOOKMOBI' || pdbType === 'TEXtREAd') {
      return parseMobiBuffer(arrayBuffer);
    }
  }

  // 2. Check if it's UTF-8 JSON or wraps a JSON payload
  const rawUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '').trim();
  if (rawUtf8.startsWith('{') || rawUtf8.startsWith('[')) {
    try {
      const parsed = JSON.parse(rawUtf8);
      const formatted = formatJsonObjectToHtml(parsed);
      return {
        title: formatted.title,
        htmlContent: formatted.html,
        coverBlob: null,
      };
    } catch {
      // fall through to embedded JSON or binary extraction
    }
  }

  const firstBrace = rawUtf8.indexOf('{');
  const lastBrace = rawUtf8.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace + 4) {
    const candidate = rawUtf8.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      const formatted = formatJsonObjectToHtml(parsed);
      return {
        title: formatted.title,
        htmlContent: formatted.html,
        coverBlob: null,
      };
    } catch {
      // fall through to binary string extraction
    }
  }

  // 3. Binary Kindle .mbpV2 (KRDS / SQLite / Kindle sidecar annotations & state)
  const headerAscii = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(16, bytes.length)));
  const isSqlite = headerAscii.startsWith('SQLite format 3');
  const extracted = extractReadableStrings(bytes);
  const asinMatch = rawUtf8.match(/\b(B0[A-Z0-9]{8})\b/);

  const parts: string[] = [];
  parts.push('<h2>MBPV2 阅读记录与笔记解析</h2>');
  parts.push(
    '<blockquote>提示：Kindle 的 <code>.mbpV2</code> 文件属于伴生标注与进度数据包（记录书签、高亮划线、阅读位置与元数据），并非电子书正文原文件；如需阅读完整正文，请同时导入同目录下的 <code>.mobi</code> / <code>.azw3</code> / <code>.azw</code> 主文件。</blockquote>'
  );
  parts.push(`<p><strong>容器特征：</strong>${isSqlite ? 'SQLite 3 数据库结构' : 'Kindle 二进制记录结构 (KRDS / MBPv2)'}（${(bytes.length / 1024).toFixed(1)} KB）</p>`);
  if (asinMatch) {
    parts.push(`<p><strong>识别到的 ASIN 编号：</strong>${escapeHtml(asinMatch[1])}</p>`);
  }

  parts.push('<h3>提取到的文本片段与标注内容</h3>');
  if (extracted.length > 0) {
    for (const line of extracted) {
      parts.push(`<p>${escapeHtml(line)}</p>`);
    }
  } else {
    parts.push('<p>该 MBPV2 文件为纯二进制加密/压缩状态记录，未检测到明文笔记片段。</p>');
  }

  return {
    title: asinMatch ? `Kindle_MBPV2_${asinMatch[1]}` : undefined,
    htmlContent: parts.join('\n'),
    coverBlob: null,
  };
}
