export interface MobiParseResult {
  title?: string;
  htmlContent: string;
  coverBlob: Blob | null;
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
  const view0 = new DataView(huff0.buffer, huff0.byteOffset, huff0.byteLength);
  const magic = new TextDecoder().decode(huff0.subarray(0, 4));
  if (magic !== 'HUFF') {
    throw new Error('无效的 MOBI HUFF 压缩头');
  }
  const off1 = view0.getUint32(16, true);
  const off2 = view0.getUint32(20, true);

  const dict1: { codelen: number; term: boolean; maxcode: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const v = view0.getUint32(off1 + i * 4, true);
    const codelen = v & 0x1f;
    const term = (v & 0x80) !== 0;
    const rawMax = v >> 8;
    const maxcode = ((rawMax + 1) << (32 - codelen)) - 1;
    dict1.push({ codelen, term, maxcode: maxcode >>> 0 });
  }

  const mincode = new Array<number>(33).fill(0);
  const maxcode = new Array<number>(33).fill(0);
  for (let codelen = 1; codelen <= 32; codelen++) {
    const base = off2 + (codelen - 1) * 8;
    const rawMin = view0.getUint32(base, true);
    const rawMax = view0.getUint32(base + 4, true);
    mincode[codelen] = (rawMin << (32 - codelen)) >>> 0;
    maxcode[codelen] = (((rawMax + 1) << (32 - codelen)) - 1) >>> 0;
  }

  const dicts: Uint8Array[] = [];
  for (let i = 1; i < huffRecords.length; i++) {
    const rec = huffRecords[i];
    const recMagic = new TextDecoder().decode(rec.subarray(0, 4));
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
      let isTerm = t1.term;

      if (!isTerm) {
        while (codelen < 32 && dw < ctx.mincode[codelen]) {
          codelen++;
        }
        dictCode = ctx.maxcode[codelen];
      }

      bitPos += codelen;
      if (bitPos > totalBits) break;

      const index = ((dictCode - dw) >>> (32 - codelen)) >>> 0;
      const cdic = ctx.dicts[index >> 16] || ctx.dicts[0];
      if (!cdic) break;

      const cdicView = new DataView(cdic.buffer, cdic.byteOffset, cdic.byteLength);
      const codeLenHeader = cdicView.getUint32(8, true);
      const sliceOffsetPos = 16 + (index & 0xffff) * 2;
      if (sliceOffsetPos + 2 > cdic.length) break;
      const sliceOff = 16 + cdicView.getUint16(sliceOffsetPos, true);
      if (sliceOff + 2 > cdic.length) break;

      const sliceMeta = cdicView.getUint16(sliceOff, true);
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
      void codeLenHeader;
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

  const numRecords = view.getUint16(76, true);
  if (numRecords === 0 || 78 + numRecords * 8 > bytes.length) {
    throw new Error('MOBI 记录表损坏');
  }

  const offsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(view.getUint32(78 + i * 8, true));
  }

  const getRecord = (idx: number): Uint8Array => {
    if (idx < 0 || idx >= numRecords) return new Uint8Array(0);
    const start = offsets[idx];
    const end = idx + 1 < numRecords ? offsets[idx + 1] : bytes.length;
    return bytes.subarray(start, Math.max(start, end));
  };

  // Check if dual-format MOBI+KF8 has a BOUNDARY record; prefer primary readable header
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
    firstImageIndex = rec0View.getUint32(108, false);
    if (compression === 17480 && rec0.length >= 120) {
      huffOffset = rec0View.getUint32(112, false);
      huffCount = rec0View.getUint32(116, false);
    }
    if (mobiHeaderLength >= 228 && rec0.length >= 244) {
      extraDataFlags = rec0View.getUint16(242, false);
    }

    const exthStart = 16 + mobiHeaderLength;
    if ((exthFlags & 0x40) !== 0 && exthStart + 12 <= rec0.length) {
      const exthMagic = new TextDecoder('ascii').decode(rec0.subarray(exthStart, exthStart + 4));
      if (exthMagic === 'EXTH') {
        const exthCount = rec0View.getUint32(exthStart + 8, false);
        let ptr = exthStart + 12;
        const txtDec = new TextDecoder(encodingCode === 1252 ? 'windows-1252' : 'utf-8');
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
    if (huffOffset <= 0 || huffCount <= 0) {
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
  const decoder = new TextDecoder(encodingCode === 1252 ? 'windows-1252' : 'utf-8');
  const htmlContent = decoder.decode(fullBytes);

  let coverBlob: Blob | null = null;
  if (firstImageIndex > 0 && coverOffset !== null) {
    const imgBytes = getRecord(firstImageIndex + coverOffset);
    const mime = detectImageMime(imgBytes);
    if (mime) {
      coverBlob = new Blob([new Uint8Array(imgBytes).buffer], { type: mime });
    }
  }
  if (!coverBlob && firstImageIndex > 0) {
    for (let idx = firstImageIndex; idx < Math.min(firstImageIndex + 6, numRecords); idx++) {
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
