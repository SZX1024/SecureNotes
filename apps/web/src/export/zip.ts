import { type Bytes } from "@securenotes/shared";

/**
 * A minimal ZIP writer and reader (§20: "plaintext ZIP with dedicated application structure").
 *
 * Written rather than pulled in, for two reasons that matter here: the archive is the *only* thing that leaves
 * the encryption boundary, so what goes into it should be readable in this repository rather than trusted to a
 * dependency's defaults; and the reader has to hand every byte back unchanged, because an import validates what
 * it finds before it commits anything.
 *
 * Entries are deflated when the platform offers it and stored otherwise. Both are valid ZIP, and both are
 * understood by every unzip tool — which is the point of using the format at all.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** UTF-8 entry names, which is what a note title or a filename may need. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  /** Forward slashes, relative to the archive root. */
  path: string;
  bytes: Bytes;
  modifiedAt?: number;
}

/** The CRC-32 the format requires, table-driven because the naive version is O(n·8). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Bytes): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(when: Date): { time: number; date: number } {
  // ZIP stores local time with a 1980 epoch and two-second resolution. Nothing here depends on the value being
  // exact; it is what a user sees in their file manager.
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** Whether this platform can compress at all. Store is always available, so this is an optimisation. */
export function canCompress(): boolean {
  return typeof CompressionStream !== "undefined" && typeof ReadableStream !== "undefined";
}

function sourceStream(bytes: Bytes): ReadableStream<Uint8Array> {
  // A stream built from the bytes rather than from `Blob.stream`, which not every environment provides.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function deflate(bytes: Bytes): Promise<Bytes | null> {
  if (!canCompress()) {
    return null;
  }
  const stream = sourceStream(bytes).pipeThrough(
    new CompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer()) as Bytes;
}

async function inflate(bytes: Bytes): Promise<Bytes> {
  if (typeof DecompressionStream === "undefined" || typeof ReadableStream === "undefined") {
    throw new Error("this environment cannot read a compressed archive");
  }
  const stream = sourceStream(bytes).pipeThrough(
    new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer()) as Bytes;
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

export interface ZipOptions {
  /** Compression is an optimisation; `false` stores every entry, which is always valid ZIP. */
  compress?: boolean;
}

export async function createZip(
  entries: readonly ZipEntry[],
  options: ZipOptions = {},
): Promise<Bytes> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const compressed = options.compress === false ? null : await deflate(entry.bytes);
    const payload = compressed ?? entry.bytes;
    const method = compressed ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.modifiedAt ? new Date(entry.modifiedAt) : new Date());

    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    writeUint32(headerView, 0, LOCAL_HEADER);
    writeUint16(headerView, 4, 20);
    writeUint16(headerView, 6, FLAG_UTF8);
    writeUint16(headerView, 8, method);
    writeUint16(headerView, 10, time);
    writeUint16(headerView, 12, date);
    writeUint32(headerView, 14, crc);
    writeUint32(headerView, 18, payload.byteLength);
    writeUint32(headerView, 22, entry.bytes.byteLength);
    writeUint16(headerView, 26, name.length);
    writeUint16(headerView, 28, 0);
    header.set(name, 30);

    parts.push(header, payload);
    offset += header.byteLength + payload.byteLength;

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    writeUint32(directoryView, 0, CENTRAL_HEADER);
    writeUint16(directoryView, 4, 20);
    writeUint16(directoryView, 6, 20);
    writeUint16(directoryView, 8, FLAG_UTF8);
    writeUint16(directoryView, 10, method);
    writeUint16(directoryView, 12, time);
    writeUint16(directoryView, 14, date);
    writeUint32(directoryView, 16, crc);
    writeUint32(directoryView, 20, payload.byteLength);
    writeUint32(directoryView, 24, entry.bytes.byteLength);
    writeUint16(directoryView, 28, name.length);
    writeUint32(directoryView, 42, offset - header.byteLength - payload.byteLength);
    directory.set(name, 46);
    central.push(directory);
  }

  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, END_OF_CENTRAL);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, centralOffset);

  const total = offset + centralSize + end.byteLength;
  const output = new Uint8Array(total) as Bytes;
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

/**
 * Reads every entry back.
 *
 * The central directory is the index, and each entry's data is located through its own local header because the
 * two are allowed to disagree about lengths — trusting the index alone is how a reader misreads a valid archive.
 */
export async function readZip(archive: Bytes): Promise<Map<string, Bytes>> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();

  let endOffset = -1;
  for (let cursor = archive.byteLength - 22; cursor >= 0; cursor -= 1) {
    if (view.getUint32(cursor, true) === END_OF_CENTRAL) {
      endOffset = cursor;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("the archive is not a ZIP file");
  }

  const count = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const files = new Map<string, Bytes>();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER) {
      throw new Error("the archive's index is damaged");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) {
      throw new Error(`the archive entry for ${name} is damaged`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);

    if (method === METHOD_DEFLATE) {
      files.set(name, await inflate(raw as Bytes));
    } else if (method === METHOD_STORE) {
      files.set(name, raw as Bytes);
    } else {
      throw new Error(`the archive entry ${name} uses an unsupported compression method`);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}
