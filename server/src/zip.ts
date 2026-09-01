import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer (no dependencies).
 *
 * A batch run puts several résumés in one output folder and the user wants them as a
 * single download. Pulling in `archiver` would mean another install step on the VPS,
 * which is already the awkward part of deploying here — and the job is small: a handful
 * of files, all in one flat folder, written in one go. So this builds the archive in
 * memory using only `node:zlib`.
 *
 * Format: ZIP with DEFLATE entries (method 8), no ZIP64, no encryption, no data
 * descriptors — every size and CRC is known before its header is written. That is the
 * subset every extractor handles, Windows Explorer included.
 */

/** CRC-32 (IEEE 802.3), the checksum ZIP requires for every entry. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the ZIP header stores (2-second resolution). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

export type ZipEntry = { name: string; data: Buffer; date?: Date };

/**
 * Build a ZIP archive from in-memory entries.
 *
 * `name` is stored as-is and must be a forward-slash relative path. Callers are expected
 * to pass plain basenames from a single folder.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const compressed = deflateRawSync(e.data);
    // Never let "compression" grow the entry: fall back to stored (method 0).
    const useDeflate = compressed.length < e.data.length;
    const payload = useDeflate ? compressed : e.data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(e.date ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 = deflate)
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // offset of local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * A run folder packed for sending.
 *
 * `shareable` (the default) is what leaves the building: the generated documents plus the
 * job description. The folder also holds llm_input.json, which carries the FULL resume and
 * extraction system prompts - shipping that hands over the prompt engineering the product
 * is built on - plus metadata/result run records nobody outside needs.
 *
 * One function so the download endpoint and the Telegram sender can never disagree about
 * what is safe to share.
 */
export function isShareableArtifact(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf") || name === "job_description.txt";
}

export async function buildFolderZip(
  root: string,
  opts: { all?: boolean } = {}
): Promise<{ zip: Buffer; names: string[] }> {
  const dirents = await fs.readdir(root, { withFileTypes: true });
  // Flat folder only: generation writes no subdirectories, and skipping them keeps this
  // from silently producing a half-archive if that ever changes.
  let names = dirents.filter((d) => d.isFile()).map((d) => d.name).sort();
  if (!opts.all) names = names.filter(isShareableArtifact);
  if (names.length === 0) return { zip: buildZip([]), names: [] };

  const entries: ZipEntry[] = [];
  for (const name of names) {
    const filePath = path.resolve(root, name);
    // Defensive: never follow anything resolving outside the run folder.
    if (path.relative(root, filePath).startsWith("..")) continue;
    const [data, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    entries.push({ name, data, date: stat.mtime });
  }
  return { zip: buildZip(entries), names };
}
