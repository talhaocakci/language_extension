import type { TimedWord } from './timed-words';

export interface TranscriptWindow { index: number; language: string; words: TimedWord[] }
export type TranscribeResult =
  | { ok: true; window: TranscriptWindow; cached: boolean; creditsCharged: number }
  | { ok: false; reason: 'not_signed_in' | 'insufficient_credits' | 'busy' | 'failed' };

/** Largest window file (bytes) that still fits the backend request limit once base64-encoded. */
export const MAX_WINDOW_FILE_BYTES = 880_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseWords(raw: unknown): TimedWord[] {
  if (!Array.isArray(raw)) return [];
  const words: TimedWord[] = [];
  for (const w of raw) {
    if (!isRecord(w)) continue;
    const { text, startMs, endMs } = w;
    if (typeof text !== 'string') continue;
    if (typeof startMs !== 'number' || typeof endMs !== 'number') continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs < 0 || endMs < 0 || endMs < startMs) continue;
    words.push({ text, startMs, endMs });
  }
  return words;
}

function parseWindow(raw: unknown): TranscriptWindow | null {
  if (!isRecord(raw)) return null;
  const { index, language } = raw;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { index, language: typeof language === 'string' ? language : '', words: parseWords(raw.words) };
}

export function parseWindowsResponse(json: unknown): TranscriptWindow[] {
  if (!isRecord(json) || !Array.isArray(json.windows)) return [];
  const out: TranscriptWindow[] = [];
  for (const w of json.windows) {
    const parsed = parseWindow(w);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isBusyError(json: unknown): boolean {
  return isRecord(json) && (json.error === 'server_busy' || json.error === 'window_busy');
}

export function parseTranscribeResponse(status: number, json: unknown): TranscribeResult {
  if (status === 200) {
    const window = parseWindow(json);
    if (!window || !isRecord(json)) return { ok: false, reason: 'failed' };
    const credits = json.creditsCharged;
    return {
      ok: true,
      window,
      cached: json.cached === true,
      creditsCharged: typeof credits === 'number' && Number.isFinite(credits) ? credits : 0
    };
  }
  if (status === 401) return { ok: false, reason: 'not_signed_in' };
  if (status === 402) return { ok: false, reason: 'insufficient_credits' };
  if (status === 503 && isBusyError(json)) return { ok: false, reason: 'busy' };
  return { ok: false, reason: 'failed' };
}

/** True for transient failures worth one retry (not 200/400/401/402/413, not a busy 503). */
export function shouldRetryTranscribe(status: number, json: unknown): boolean {
  if ([200, 400, 401, 402, 413].includes(status)) return false;
  if (status === 503 && isBusyError(json)) return false;
  return true;
}

/**
 * Whether the service worker sends a window again after the first attempt. status null: no HTTP
 * response (network error). A complete window is safe to send again (the server serves a repeat from
 * its cache); a partial one is transcribed and charged again, so it is retried only when the server
 * certainly did not transcribe it (502 transcription_failed). A lost response, 500 or 503 charge_failed
 * may have transcribed a partial window and are not retried.
 */
export function shouldRetryAttempt(partial: boolean, status: number | null, json: unknown): boolean {
  if (status === null) return !partial;
  if (!shouldRetryTranscribe(status, json)) return false;
  if (!partial) return true;
  return status === 502 && isRecord(json) && json.error === 'transcription_failed';
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}
