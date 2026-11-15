const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryMeta {
  fileName: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export async function parseZip(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const len = bytes.length;

  let eocdOffset = -1;
  const minOffset = Math.max(0, len - 65557);
  for (let i = len - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('无效的 EPUB/ZIP 文件结构');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, ZipEntryMeta>();

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > len || view.getUint32(ptr, true) !== 0x02014b50) break;
    const compression = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const fileName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.set(fileName, {
      fileName,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  async function getEntryBytes(entryName: string): Promise<Uint8Array | null> {
    const entry = entries.get(entryName);
    if (!entry) return null;
    const lho = entry.localHeaderOffset;
    if (view.getUint32(lho, true) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏: ${entryName}`);
    }
    const lNameLen = view.getUint16(lho + 26, true);
    const lExtraLen = view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compression === 0) {
      return compressed;
    } else if (entry.compression === 8) {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('当前浏览器不支持原生 DecompressionStream 解压 EPUB');
      }
      const ds = new DecompressionStream('deflate-raw');
      const copyBuffer = new Uint8Array(compressed).buffer;
      const stream = new Blob([copyBuffer]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } else {
      throw new Error(`不支持的 ZIP 压缩格式: ${entry.compression}`);
    }
  }

  async function getEntryText(entryName: string): Promise<string | null> {
    const b = await getEntryBytes(entryName);
    return b ? decoder.decode(b) : null;
  }

  return { entries, getEntryBytes, getEntryText };
}

export interface ZipInputFile {
  path: string;
  data: Uint8Array | Blob | string;
}

export async function createZipBlob(filesList: ZipInputFile[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const localChunks: BlobPart[] = [];
  const cdChunks: BlobPart[] = [];
  let offset = 0;

  for (const item of filesList) {
    const nameBytes = encoder.encode(item.path);
    let dataBytes: Uint8Array;
    if (item.data instanceof Uint8Array) {
      dataBytes = item.data;
    } else if (item.data instanceof Blob) {
      dataBytes = new Uint8Array(await item.data.arrayBuffer());
    } else {
      dataBytes = encoder.encode(String(item.data));
    }

    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lhv = new DataView(lh.buffer);
    lhv.setUint32(0, 0x04034b50, true);
    lhv.setUint16(4, 20, true);
    lhv.setUint16(6, 0x0800, true);
    lhv.setUint16(8, 0, true);
    lhv.setUint32(14, crc, true);
    lhv.setUint32(18, size, true);
    lhv.setUint32(22, size, true);
    lhv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    localChunks.push(lh.buffer, new Uint8Array(dataBytes).buffer);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd.buffer);

    offset += lh.length + size;
  }

  const cdSize = cdChunks.reduce((acc, b) => acc + (b as ArrayBuffer).byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, filesList.length, true);
  ev.setUint16(10, filesList.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...localChunks, ...cdChunks, eocd.buffer], { type: 'application/zip' });
}
