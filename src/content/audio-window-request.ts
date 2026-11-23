import { AUDIO_WINDOW_MESSAGE, AUDIO_WINDOW_REQUEST_EVENT } from '../utils/youtube-timedtext';

// Asks the page-world bridge for one audio window's file and waits for its
// window.postMessage answer. Only an answer from this window and origin, for
// this request and this video, is accepted; anything else is ignored.

export const WINDOW_FILE_TIMEOUT_MS = 3000;

export interface WindowFile { startMs: number; partial: boolean; file: Uint8Array }

export interface WindowFileEnv {
  /** The window the answer must come from (event.source). */
  self: unknown;
  /** location.origin; the answer's event.origin must equal it. */
  origin: string;
  /** Adds a 'message' listener; returns its removal. */
  listen(handler: (event: { source: unknown; origin: string; data: unknown }) => void): () => void;
  /** Dispatches the request event with this JSON string as detail. */
  dispatch(detail: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newRequestId(): string;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/**
 * undefined: not the answer to this request (keep waiting).
 * null: the answer, but without a usable file.
 * Otherwise the answer's file with the videoId it was made for.
 */
export function parseAudioWindowAnswer(
  data: unknown,
  requestId: string,
  index: number
): (WindowFile & { videoId: string }) | null | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (d.type !== AUDIO_WINDOW_MESSAGE || d.requestId !== requestId || d.index !== index) return undefined;
  if (typeof d.videoId !== 'string' || typeof d.startMs !== 'number' || !Number.isFinite(d.startMs)) return null;
  if (typeof d.partial !== 'boolean' || !isArrayBuffer(d.file) || d.file.byteLength === 0) return null;
  return { videoId: d.videoId, startMs: d.startMs, partial: d.partial, file: new Uint8Array(d.file) };
}

export function requestAudioWindowFile(
  env: WindowFileEnv,
  videoId: string,
  index: number,
  timeoutMs = WINDOW_FILE_TIMEOUT_MS
): Promise<WindowFile | null> {
  return new Promise((resolve) => {
    const requestId = env.newRequestId();
    let finished = false;
    let stop: () => void = () => {};
    let timer: unknown = null;
    const finish = (value: WindowFile | null) => {
      if (finished) return;
      finished = true;
      stop();
      if (timer !== null) env.clearTimer(timer);
      resolve(value);
    };
    stop = env.listen((event) => {
      if (event.source !== env.self || event.origin !== env.origin) return;
      const answer = parseAudioWindowAnswer(event.data, requestId, index);
      if (answer === undefined) return;
      if (!answer || answer.videoId !== videoId) {
        finish(null);
        return;
      }
      finish({ startMs: answer.startMs, partial: answer.partial, file: answer.file });
    });
    timer = env.setTimer(() => finish(null), timeoutMs);
    try {
      env.dispatch(JSON.stringify({ requestId, index, videoId }));
    } catch {
      finish(null);
    }
  });
}

/** The real page: window messages and a CustomEvent on document. */
export function browserWindowFileEnv(): WindowFileEnv {
  return {
    self: window,
    origin: location.origin,
    listen(handler) {
      const listener = (event: MessageEvent) => handler({ source: event.source, origin: event.origin, data: event.data });
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    dispatch(detail) {
      document.dispatchEvent(new CustomEvent(AUDIO_WINDOW_REQUEST_EVENT, { detail }));
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    newRequestId: () =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}
