// Page-world capture of the audio the YouTube player hands to the browser.
// It wraps MediaSource.addSourceBuffer and SourceBuffer.appendBuffer/abort,
// keeps a copy of the WebM audio bytes and exposes them as 30-second windows.
// The wrappers never change what the player sees: the original is always
// called with the original arguments, after the capture code and outside its
// try/catch, and its return value is passed back untouched.

import { WINDOW_EDGE_TOLERANCE_MS, WINDOW_MS, readyWindows } from '../utils/transcription-windows';
import type { ReadyWindow } from '../utils/transcription-windows';
import { buildWindowFile, parseWebmAudio } from '../utils/webm-audio';

export const MAX_KEPT_BYTES = 8 * 1024 * 1024;

export type AudioFormat = 'webm-opus' | 'unsupported' | '';

export interface AudioCapture {
  /** Ready windows for the bytes kept so far. */
  windows(videoEndMs?: number): ReadyWindow[];
  /** Stand-alone file for a ready window, or null when it is not (or no longer) kept. */
  windowFile(index: number, videoEndMs?: number): Uint8Array | null;
  format(): AudioFormat;
  /** Timecode of the newest kept cluster, or null when none is kept. */
  lastClusterMs(): number | null;
  /** Drop every kept byte (the format stays); called when the video has captions. */
  reset(): void;
  /** While disabled nothing is kept. A new audio buffer keeps the current flag. */
  setEnabled(enabled: boolean): void;
}

export interface AudioCaptureOptions {
  /** Tests only: makes the internal store throw so the wrappers' safety can be checked. */
  breakCapture?: boolean;
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];

function startsWithEbml(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && EBML_ID.every((b, i) => bytes[i] === b);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function windowOf(timecodeMs: number): number {
  return Math.floor((timecodeMs + WINDOW_EDGE_TOLERANCE_MS) / WINDOW_MS);
}

function copyBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return null;
}

interface KeptCluster {
  timecodeMs: number;
  bytes: Uint8Array;
}

class AudioStore {
  private init: Uint8Array | null = null;
  private clusters: KeptCluster[] = [];
  private keptBytes = 0;
  /** Bytes received since the last complete cluster (or the init part being received). */
  private pending: Uint8Array = new Uint8Array(0);
  /** Windows that lost a cluster to the size limit. */
  private lostWindows = new Set<number>();

  reset(): void {
    this.init = null;
    this.clusters = [];
    this.keptBytes = 0;
    this.pending = new Uint8Array(0);
    this.lostWindows = new Set();
  }

  abort(): void {
    this.pending = new Uint8Array(0);
  }

  append(bytes: Uint8Array): void {
    if (this.init && startsWithEbml(bytes)) this.pending = new Uint8Array(0);
    this.pending = concat(this.pending, bytes);

    if (startsWithEbml(this.pending)) {
      const head = parseWebmAudio(this.pending);
      // Nothing after the header yet: the init part may still be arriving.
      if (!head || head.initLength >= this.pending.length) {
        this.limitPending();
        return;
      }
      this.init = this.pending.slice(0, head.initLength);
      this.pending = this.pending.slice(head.initLength);
    }
    if (!this.init) {
      this.pending = new Uint8Array(0);
      return;
    }
    if (this.pending.length === 0) return;

    // Only the not-yet-consumed tail is parsed; the init part makes it a valid stream.
    const combined = concat(this.init, this.pending);
    const parsed = parseWebmAudio(combined);
    if (!parsed || parsed.clusters.length === 0) {
      this.limitPending();
      return;
    }
    let end = 0;
    for (const c of parsed.clusters) {
      this.clusters.push({ timecodeMs: c.timecodeMs, bytes: combined.slice(c.offset, c.offset + c.length) });
      this.keptBytes += c.length;
      end = c.offset + c.length;
    }
    this.pending = combined.slice(end);
    this.dropOldClusters();
  }

  private limitPending(): void {
    if (this.pending.length > MAX_KEPT_BYTES) this.pending = new Uint8Array(0);
  }

  private dropOldClusters(): void {
    let drop = 0;
    while (this.keptBytes > MAX_KEPT_BYTES && drop < this.clusters.length) {
      this.keptBytes -= this.clusters[drop].bytes.length;
      this.lostWindows.add(windowOf(this.clusters[drop].timecodeMs));
      drop++;
    }
    if (drop > 0) this.clusters.splice(0, drop);
  }

  windows(videoEndMs?: number): ReadyWindow[] {
    return readyWindows(this.clusters, videoEndMs).filter((w) => !this.lostWindows.has(w.index));
  }

  windowFile(index: number, videoEndMs?: number): Uint8Array | null {
    const window = this.windows(videoEndMs).find((w) => w.index === index);
    if (!window || !this.init) return null;
    let bytes = this.init;
    for (const i of window.clusterIndexes) bytes = concat(bytes, this.clusters[i].bytes);
    const parsed = parseWebmAudio(bytes);
    if (!parsed || parsed.clusters.length === 0) return null;
    return buildWindowFile(bytes, parsed, parsed.clusters);
  }

  lastClusterMs(): number | null {
    return this.clusters.length ? this.clusters[this.clusters.length - 1].timecodeMs : null;
  }
}

/** Wraps addSourceBuffer / appendBuffer / abort on the given prototypes. */
export function installAudioCapture(
  mediaSourceProto: any,
  sourceBufferProto: any,
  options: AudioCaptureOptions = {}
): AudioCapture {
  const store = new AudioStore();
  let format: AudioFormat = '';
  let enabled = true;
  let audioBuffer: unknown = null;
  let keepAudio = false;

  const originalAdd = mediaSourceProto?.addSourceBuffer;
  if (typeof originalAdd === 'function') {
    mediaSourceProto.addSourceBuffer = function (this: unknown, ...args: any[]) {
      const buffer = originalAdd.apply(this, args);
      try {
        const mime = String(args[0] ?? '').trim().toLowerCase();
        if (mime.startsWith('audio/')) {
          audioBuffer = buffer;
          store.reset();
          keepAudio = mime.startsWith('audio/webm');
          format = keepAudio ? 'webm-opus' : 'unsupported';
        }
      } catch {
        // Capture problems must never reach the player.
      }
      return buffer;
    };
  }

  const originalAppend = sourceBufferProto?.appendBuffer;
  if (typeof originalAppend === 'function') {
    sourceBufferProto.appendBuffer = function (this: unknown, ...args: any[]) {
      try {
        if (this === audioBuffer && keepAudio && enabled) {
          if (options.breakCapture) throw new Error('capture broken');
          const bytes = copyBytes(args[0]);
          if (bytes) store.append(bytes);
        }
      } catch {
        // Capture problems must never reach the player.
      }
      return originalAppend.apply(this, args);
    };
  }

  const originalAbort = sourceBufferProto?.abort;
  if (typeof originalAbort === 'function') {
    sourceBufferProto.abort = function (this: unknown, ...args: any[]) {
      try {
        if (this === audioBuffer) store.abort();
      } catch {
        // Capture problems must never reach the player.
      }
      return originalAbort.apply(this, args);
    };
  }

  return {
    windows: (videoEndMs) => store.windows(videoEndMs),
    windowFile: (index, videoEndMs) => store.windowFile(index, videoEndMs),
    format: () => format,
    lastClusterMs: () => store.lastClusterMs(),
    reset: () => store.reset(),
    setEnabled(value) {
      enabled = value;
      if (!value) store.reset();
    },
  };
}
