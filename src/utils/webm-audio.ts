// Parses a captured WebM/Opus stream into clusters and builds stand-alone
// files from chosen clusters. Pure functions: no DOM, no Chrome APIs.

export interface WebmCluster {
  offset: number;
  length: number;
  timecodeMs: number;
  timecodeValueOffset: number;
  timecodeValueLength: number;
}

export interface ParsedWebmAudio {
  initLength: number;
  clusters: WebmCluster[];
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const TIMECODE_ID = 0xe7;

function hasBytes(bytes: Uint8Array, at: number, id: number[]): boolean {
  if (at < 0 || at + id.length > bytes.length) return false;
  return id.every((b, i) => bytes[at + i] === b);
}

/** Length of an EBML variable-length integer from its first byte, or 0 if invalid. */
function vintLength(first: number): number {
  for (let n = 1; n <= 8; n++) if (first & (0x80 >> (n - 1))) return n;
  return 0;
}

/** Reads an element size; value is -1 for the reserved "unknown" size. */
function readSize(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  if (at >= bytes.length) return null;
  const length = vintLength(bytes[at]);
  if (length === 0 || at + length > bytes.length) return null;
  let value = bytes[at] & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value: allOnes ? -1 : value, length };
}

/** Element id including its marker bits, as a number. */
function readId(bytes: Uint8Array, at: number): { id: number; length: number } | null {
  if (at >= bytes.length) return null;
  const length = vintLength(bytes[at]);
  if (length === 0 || length > 4 || at + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i];
  return { id, length };
}

/** Parses the cluster starting at `at`; null if its size or Timecode do not parse. */
function readCluster(bytes: Uint8Array, at: number): WebmCluster | null {
  if (!hasBytes(bytes, at, CLUSTER_ID)) return null;
  const size = readSize(bytes, at + 4);
  if (!size || size.value < 0) return null;
  const dataStart = at + 4 + size.length;
  const length = 4 + size.length + size.value;
  const tcId = readId(bytes, dataStart);
  if (!tcId || tcId.id !== TIMECODE_ID) return null;
  const tcSize = readSize(bytes, dataStart + tcId.length);
  if (!tcSize || tcSize.value < 1 || tcSize.value > 8) return null;
  const valueOffset = dataStart + tcId.length + tcSize.length;
  if (valueOffset + tcSize.value > at + length || valueOffset + tcSize.value > bytes.length) return null;
  let timecodeMs = 0;
  for (let i = 0; i < tcSize.value; i++) timecodeMs = timecodeMs * 256 + bytes[valueOffset + i];
  return { offset: at, length, timecodeMs, timecodeValueOffset: valueOffset, timecodeValueLength: tcSize.value };
}

/** Offset of the first Cluster, walking the EBML header, Segment and its children. */
function findInitLength(bytes: Uint8Array): number | null {
  if (!hasBytes(bytes, 0, EBML_ID)) return null;
  const headerSize = readSize(bytes, 4);
  if (!headerSize || headerSize.value < 0) return null;
  let pos = 4 + headerSize.length + headerSize.value;
  if (!hasBytes(bytes, pos, SEGMENT_ID)) return null;
  const segSize = readSize(bytes, pos + 4);
  if (!segSize) return null;
  pos += 4 + segSize.length;
  while (pos < bytes.length) {
    if (hasBytes(bytes, pos, CLUSTER_ID)) return pos;
    const id = readId(bytes, pos);
    if (!id) return null;
    const size = readSize(bytes, pos + id.length);
    if (!size || size.value < 0) return null;
    pos += id.length + size.length + size.value;
  }
  return null;
}

function nextClusterId(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 4 <= bytes.length; i++) if (hasBytes(bytes, i, CLUSTER_ID)) return i;
  return -1;
}

/** Complete clusters only. null when the bytes do not start with an EBML header. */
export function parseWebmAudio(bytes: Uint8Array): ParsedWebmAudio | null {
  if (!hasBytes(bytes, 0, EBML_ID)) return null;
  const initLength = findInitLength(bytes);
  if (initLength === null) return { initLength: bytes.length, clusters: [] };

  const clusters: WebmCluster[] = [];
  let pos = initLength;
  while (pos >= 0 && pos < bytes.length) {
    const c = readCluster(bytes, pos);
    const end = c ? c.offset + c.length : 0;
    const complete = c !== null && end <= bytes.length && (end === bytes.length || hasBytes(bytes, end, CLUSTER_ID));
    if (c && complete) {
      clusters.push(c);
      pos = end;
    } else {
      // Not a clean cluster (partial, or a seek glued two runs together): look for the next one.
      pos = nextClusterId(bytes, pos + 4);
    }
  }
  return { initLength, clusters };
}

/** Init part + the given clusters, timecodes rewritten so the first is 0. Input is not modified. */
export function buildWindowFile(bytes: Uint8Array, parsed: ParsedWebmAudio, clusters: WebmCluster[]): Uint8Array {
  const total = clusters.reduce((n, c) => n + c.length, parsed.initLength);
  const out = new Uint8Array(total);
  out.set(bytes.subarray(0, parsed.initLength), 0);
  const base = clusters.length ? clusters[0].timecodeMs : 0;
  let at = parsed.initLength;
  for (const c of clusters) {
    out.set(bytes.subarray(c.offset, c.offset + c.length), at);
    let value = Math.max(0, c.timecodeMs - base);
    for (let i = c.timecodeValueLength - 1; i >= 0; i--) {
      out[at + (c.timecodeValueOffset - c.offset) + i] = value % 256;
      value = Math.floor(value / 256);
    }
    at += c.length;
  }
  return out;
}
