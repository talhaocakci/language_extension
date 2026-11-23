// Synthetic WebM audio stream pieces shared by the WebM tests.

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function filler(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x55);
}

/** EBML header + Segment (unknown size) + a 20-byte Info + a 30-byte Tracks. */
export function init(): Uint8Array {
  return concat(
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x80, 0x00]),
    new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([0x15, 0x49, 0xa9, 0x66, 0x8f]), filler(15),
    new Uint8Array([0x16, 0x54, 0xae, 0x6b, 0x99]), filler(25),
  );
}

/** Cluster with an 8-byte size, Timecode `E7 84 <4 bytes>` and one SimpleBlock of `payloadLen` bytes. */
export function cluster(timecodeMs: number, payloadLen: number): Uint8Array {
  const block = concat(new Uint8Array([0xa3, 0x80 | payloadLen]), filler(payloadLen));
  const body = concat(
    new Uint8Array([
      0xe7, 0x84,
      (timecodeMs >>> 24) & 0xff, (timecodeMs >>> 16) & 0xff, (timecodeMs >>> 8) & 0xff, timecodeMs & 0xff,
    ]),
    block,
  );
  const size = new Uint8Array(8);
  size[0] = 0x01;
  for (let i = 0; i < 7; i++) size[7 - i] = Math.floor(body.length / 2 ** (8 * i)) & 0xff;
  return concat(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), size, body);
}
