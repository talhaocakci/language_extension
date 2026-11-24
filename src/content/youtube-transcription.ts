import type { MeaningfulSentence } from '../types/subtitle';
import type { TimedWord } from '../utils/timed-words';
import { MAX_WINDOW_FILE_BYTES, type TranscribeResult, type TranscriptWindow } from '../utils/transcript-api';
import { WINDOW_MS, nextWindowToSend, sentencesFromWindows, type ReadyWindow } from '../utils/transcription-windows';
import type { AudioCaptureState } from '../utils/youtube-timedtext';

// Drives speech-to-text for a YouTube video without captions: which windows of
// the buffered audio to send, what the overlay should say, and which sentences
// exist so far. No DOM here; the injector supplies everything through deps.

export type TranscriptionPhase = 'idle' | 'offer' | 'preparing' | 'ready' | 'unavailable' | 'no_credits' | 'signed_out';

export interface TranscriptionDeps {
  /** The page-world bridge's latest audio state, or null. */
  readState(): AudioCaptureState | null;
  /** The window's file; null when there is none (yet), it belongs to another video, or the bridge did not answer. */
  requestWindowFile(index: number): Promise<{ startMs: number; partial: boolean; file: Uint8Array } | null>;
  fetchStored(videoId: string, format: string): Promise<TranscriptWindow[]>;
  transcribe(req: { videoId: string; format: string; index: number; partial: boolean; startMs: number; file: Uint8Array }): Promise<TranscribeResult>;
  playheadMs(): number;
  now(): number;
}

export const UNAVAILABLE_AFTER_MS = 8000;
export const MAX_IN_FLIGHT = 2;
/** First wait after a busy answer; doubled for each further busy answer for that window, up to BUSY_RETRY_MAX_MS. */
export const BUSY_RETRY_MS = 3000;
export const BUSY_RETRY_MAX_MS = 30_000;
/**
 * Stored-only (the bridge lists no windows): the highest done window is the video's last once it has
 * been done this long.
 */
export const LAST_WINDOW_SETTLE_MS = 20_000;
/** A transcribed sentence that ended more than this before the playhead is not shown any more. */
export const STALE_SENTENCE_MS = 2000;

const AUDIO_FORMAT = 'webm-opus';
/** Mirrors the overlay's lead: a sentence starting this soon after the playhead counts as started. */
const SENTENCE_START_LEAD_MS = 120;

/** Wait before sending a window again after its n-th busy answer in a row (n >= 1). */
export function busyRetryDelayMs(busyCount: number): number {
  return Math.min(BUSY_RETRY_MS * 2 ** Math.max(0, busyCount - 1), BUSY_RETRY_MAX_MS);
}

/**
 * The transcribed sentence the overlay shows at the playhead: the latest one that has started, or null
 * when none has or that one ended more than STALE_SENTENCE_MS before the playhead.
 */
export function pickTranscribedSentence(sentences: MeaningfulSentence[], playheadMs: number): MeaningfulSentence | null {
  if (sentences.length === 0) return null;
  let chosen = sentences[0];
  for (const sentence of sentences) {
    if (sentence.startTime <= playheadMs + SENTENCE_START_LEAD_MS) chosen = sentence;
    else break;
  }
  if (chosen.startTime > playheadMs + SENTENCE_START_LEAD_MS) return null; // nothing has started yet
  return chosen.endTime < playheadMs - STALE_SENTENCE_MS ? null : chosen;
}
/** The video is taken back only when at least this much played without subtitles. */
export const CATCH_UP_MIN_MS = 1500;
/** A playhead change this large between two observations is the learner seeking, not playback. */
export const CATCH_UP_SEEK_JUMP_MS = 4000;

/**
 * Subtitles become ready some seconds after they are asked for, while the video keeps playing (a paused
 * player stops downloading audio). This remembers where the wait began, so the video can be taken back
 * there once the subtitles exist and the learner misses nothing.
 */
export class SubtitleCatchUp {
  private anchorMs: number | null = null;
  private lastMs = 0;

  /**
   * Call on every overlay refresh. Returns the position to seek back to, once, when the wait is over;
   * otherwise null. `covered` says whether the window holding a position has been transcribed.
   */
  observe(phase: TranscriptionPhase, playheadMs: number, covered: (ms: number) => boolean): number | null {
    const jumped = Math.abs(playheadMs - this.lastMs) > CATCH_UP_SEEK_JUMP_MS;
    this.lastMs = playheadMs;
    if (phase === 'preparing') {
      if (this.anchorMs === null || jumped || playheadMs < this.anchorMs) this.anchorMs = playheadMs;
      return null;
    }
    const anchor = this.anchorMs;
    this.anchorMs = null;
    if (phase !== 'ready' || anchor === null || jumped) return null;
    if (playheadMs - anchor < CATCH_UP_MIN_MS) return null;
    if (covered(anchor)) return anchor;
    // The wait began in a window that was never transcribed: go back as far as the subtitles reach.
    const windowStart = Math.floor(playheadMs / WINDOW_MS) * WINDOW_MS;
    return windowStart > anchor && playheadMs - windowStart >= CATCH_UP_MIN_MS && covered(windowStart) ? windowStart : null;
  }

  /** True while a wait is being tracked. */
  waiting(): boolean {
    return this.anchorMs !== null;
  }

  reset(): void {
    this.anchorMs = null;
  }
}

const NO_SENTENCES: MeaningfulSentence[] = [];
type StickyPhase = 'unavailable' | 'no_credits' | 'signed_out';

export class TranscriptionController {
  private videoId = '';
  private generation = 0;
  private state: AudioCaptureState | null = null;
  private accepted = false;
  private acceptedAt = 0;
  private sticky: StickyPhase | null = null;
  private sawWindow = false;
  /** The learner uses the overlay or side panel for this video; nothing is fetched before. */
  private wanted = false;
  /** The overlay is on: only then are window files requested and uploaded. */
  private active = false;
  /** The learner asked for transcription although the video has captions; until reset. */
  private forced = false;
  private stored: Promise<void> | null = null;
  private storedSettled = false;
  private tickingGeneration: number | null = null;

  private words = new Map<number, TimedWord[]>();
  private done = new Set<number>();
  private inFlight = new Set<number>();
  private busyUntil = new Map<number, number>();
  /** Busy answers in a row per window; cleared when it succeeds. */
  private busyCount = new Map<number, number>();
  /** When each done window became done (sent, given up, or received as stored), by deps.now(). */
  private doneAt = new Map<number, number>();
  private lastWindowIndex: number | undefined;
  private detectedLanguage = '';

  private wordsVersion = 0;
  private builtVersion = -1;
  private builtLastWindow: number | undefined;
  private cached: MeaningfulSentence[] = [];
  private emittedPhase: TranscriptionPhase | null = null;
  private emittedSentences: MeaningfulSentence[] | null = null;

  constructor(private readonly deps: TranscriptionDeps, private readonly onChange: () => void) {}

  phase(): TranscriptionPhase {
    const s = this.state;
    if (this.blocked()) return 'idle';
    if (this.sticky) return this.sticky;
    if (!this.accepted) {
      // Stored windows further on do not cover a missing window at the playhead: offer to transcribe it.
      return this.done.has(Math.floor(this.deps.playheadMs() / WINDOW_MS)) ? 'ready' : 'offer';
    }
    return this.coversPlayhead() ? 'ready' : 'preparing';
  }

  sentences(): MeaningfulSentence[] {
    if (this.blocked()) return NO_SENTENCES;
    if (this.builtVersion !== this.wordsVersion || this.builtLastWindow !== this.lastWindowIndex) {
      this.cached = sentencesFromWindows(this.words, `stt|${this.videoId}`, this.lastWindowIndex);
      this.builtVersion = this.wordsVersion;
      this.builtLastWindow = this.lastWindowIndex;
    }
    return this.cached;
  }

  /** Language reported by the backend for this video's windows, or ''. */
  language(): string {
    return this.detectedLanguage;
  }

  /**
   * True when the playhead's window is done or a sentence contains the playhead. Sentences further on do
   * not count: while the playhead's own window is missing, the learner is still waiting for it.
   */
  coversPlayhead(): boolean {
    if (this.blocked()) return false;
    const playhead = this.deps.playheadMs();
    if (this.done.has(Math.floor(playhead / WINDOW_MS))) return true;
    return this.sentences().some((s) => s.startTime <= playhead && playhead <= s.endTime);
  }

  /** True when the window holding this position has been transcribed (or was stored). */
  windowDoneAt(ms: number): boolean {
    return !this.blocked() && this.done.has(Math.floor(ms / WINDOW_MS));
  }

  /**
   * The learner shows interest in this video (overlay enabled, or the side panel asked for subtitles).
   * Until then the phase is idle and nothing is fetched. Once true it stays true until reset.
   */
  setWanted(wanted: boolean): void {
    if (!wanted || this.wanted || !this.videoId) return;
    this.wanted = true;
    this.observe();
    this.emitIfChanged();
  }

  /**
   * The overlay is on (true) or off (false). While inactive no window file is requested and nothing is
   * uploaded; answers already in flight are still taken. reset() makes it inactive.
   */
  setActive(active: boolean): void {
    this.active = active;
  }

  /**
   * After no_credits or signed_out: try uploading again (acceptance stays). Other phases are unchanged.
   */
  retry(): void {
    if (this.sticky !== 'no_credits' && this.sticky !== 'signed_out') return;
    this.sticky = null;
    this.emitIfChanged();
  }

  /** True when the video has captions the learner could replace with a transcription. */
  canReplaceCaptions(): boolean {
    const s = this.state;
    return !!s && this.wanted && s.hasCaptions && !this.forced && s.format === AUDIO_FORMAT;
  }

  /** The learner chose transcription over the video's captions: from now on it is treated as caption-less, and accepted. */
  replaceCaptions(): void {
    if (!this.canReplaceCaptions()) return;
    this.forced = true;
    this.observe();
    this.accept();
    this.emitIfChanged();
  }

  accept(): void {
    if (!this.videoId || !this.wanted || this.accepted) return;
    if (this.state?.hasCaptions && !this.forced) return; // captions are replaced only through replaceCaptions()
    this.accepted = true;
    this.acceptedAt = this.deps.now();
    this.emitIfChanged();
  }

  reset(videoId: string): void {
    this.generation += 1;
    this.videoId = videoId;
    this.state = null;
    this.accepted = false;
    this.acceptedAt = 0;
    this.sticky = null;
    this.sawWindow = false;
    this.wanted = false;
    this.active = false;
    this.forced = false;
    this.stored = null;
    this.storedSettled = false;
    this.words = new Map();
    this.done = new Set();
    this.inFlight = new Set();
    this.busyUntil = new Map();
    this.busyCount = new Map();
    this.doneAt = new Map();
    this.lastWindowIndex = undefined;
    this.detectedLanguage = '';
    this.wordsVersion += 1;
    this.cached = [];
    this.observe();
    this.emitIfChanged();
  }

  async tick(): Promise<void> {
    const generation = this.generation;
    if (this.tickingGeneration === generation) return; // another tick for this video is still awaiting
    this.tickingGeneration = generation;
    try {
      this.observe();
      const s = this.state;
      if (!s || this.blocked()) return;
      // Audio is arriving: a window or a kept cluster stops the unavailable clock for good.
      if (s.windows.length > 0 || typeof s.capturedMs === 'number') this.sawWindow = true;
      this.updateLastWindow();

      if (!this.accepted || this.sticky) return;
      if (this.stored && !this.storedSettled) {
        await this.stored;
        if (generation !== this.generation) return;
      }
      // Runs whatever the format: with no audio format ever detected nothing would end 'preparing'.
      if (!this.sawWindow && !this.coversPlayhead() && this.deps.now() - this.acceptedAt >= UNAVAILABLE_AFTER_MS) {
        this.sticky = 'unavailable';
        return;
      }
      if (s.format !== AUDIO_FORMAT || !this.active) return;
      await this.sendWhileRoom(generation);
    } finally {
      if (this.tickingGeneration === generation) this.tickingGeneration = null;
      if (generation === this.generation) this.emitIfChanged();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Nothing to do for this video: no state yet, not wanted, or it has captions the learner did not replace. */
  private blocked(): boolean {
    return !this.state || !this.wanted || (this.state.hasCaptions && !this.forced);
  }

  /** Reads the bridge state; only a state for this video counts. */
  private observe(): void {
    let raw: AudioCaptureState | null = null;
    try {
      raw = this.deps.readState();
    } catch {
      raw = null;
    }
    if (!raw || !this.videoId || raw.videoId !== this.videoId) return;
    this.state = raw;
    if (this.blocked()) return;
    if (raw.format === 'unsupported' && !this.sticky) this.sticky = 'unavailable';
    if (raw.format === AUDIO_FORMAT && !this.stored) this.stored = this.loadStored(this.generation);
  }

  private async loadStored(generation: number): Promise<void> {
    let windows: TranscriptWindow[] = [];
    try {
      const result = await this.deps.fetchStored(this.videoId, AUDIO_FORMAT);
      windows = Array.isArray(result) ? result : [];
    } catch {
      windows = [];
    }
    if (generation !== this.generation) return;
    this.storedSettled = true;
    for (const w of windows) {
      if (!w || !Number.isInteger(w.index) || w.index < 0 || !Array.isArray(w.words)) continue;
      this.words.set(w.index, w.words);
      this.markDone(w.index);
      if (!this.detectedLanguage && w.language) this.detectedLanguage = w.language;
    }
    if (windows.length > 0) this.wordsVersion += 1;
    this.updateLastWindow();
    this.emitIfChanged();
  }

  private async sendWhileRoom(generation: number): Promise<void> {
    while (this.inFlight.size < MAX_IN_FLIGHT) {
      const s = this.state;
      if (!s || generation !== this.generation || !this.accepted || this.sticky || !this.active) return;
      const now = this.deps.now();
      const blocked = new Set(this.done);
      for (const [index, until] of this.busyUntil) {
        if (until > now) blocked.add(index);
        else this.busyUntil.delete(index);
      }
      const ready: ReadyWindow[] = s.windows.map((w) => ({ ...w, clusterIndexes: [] }));
      const next = nextWindowToSend(ready, blocked, this.inFlight, this.deps.playheadMs());
      if (!next) return;
      const index = next.index;

      this.inFlight.add(index);
      let file: Awaited<ReturnType<TranscriptionDeps['requestWindowFile']>> = null;
      try {
        file = await this.deps.requestWindowFile(index);
      } catch {
        file = null;
      }
      if (generation !== this.generation) return;
      if (!file || !this.accepted || this.sticky || !this.active) {
        this.inFlight.delete(index); // eligible again on a later tick
        return;
      }
      if (file.file.byteLength > MAX_WINDOW_FILE_BYTES) {
        this.inFlight.delete(index);
        this.markDone(index); // treated as failed: no words, never sent
        continue;
      }
      void this.send(generation, {
        videoId: this.videoId,
        format: AUDIO_FORMAT,
        index,
        partial: file.partial,
        startMs: file.startMs,
        file: file.file,
      });
    }
  }

  private async send(generation: number, req: Parameters<TranscriptionDeps['transcribe']>[0]): Promise<void> {
    let result: TranscribeResult;
    try {
      result = await this.deps.transcribe(req);
    } catch {
      result = { ok: false, reason: 'failed' };
    }
    if (!result || typeof result !== 'object') result = { ok: false, reason: 'failed' };
    if (generation !== this.generation) return;

    const { index } = req;
    this.inFlight.delete(index);
    if (result.ok) {
      const words = Array.isArray(result.window?.words) ? result.window.words : [];
      this.words.set(index, words);
      this.wordsVersion += 1;
      this.busyCount.delete(index);
      this.markDone(index);
      if (!this.detectedLanguage && result.window?.language) this.detectedLanguage = result.window.language;
      this.updateLastWindow();
      return this.emitIfChanged();
    }
    const reason = (result as Extract<TranscribeResult, { ok: false }>).reason;
    if (reason === 'busy') {
      const count = (this.busyCount.get(index) ?? 0) + 1;
      this.busyCount.set(index, count);
      this.busyUntil.set(index, this.deps.now() + busyRetryDelayMs(count));
    } else if (reason === 'insufficient_credits') {
      if (!this.sticky) this.sticky = 'no_credits';
    } else if (reason === 'not_signed_in') {
      if (!this.sticky) this.sticky = 'signed_out';
    } else {
      this.markDone(index); // failed: given up, never chosen again
      this.updateLastWindow();
    }
    this.emitIfChanged();
  }

  private markDone(index: number): void {
    this.done.add(index);
    if (!this.doneAt.has(index)) this.doneAt.set(index, this.deps.now());
  }

  /**
   * Which window is the video's last, re-evaluated each time:
   * - the bridge lists windows and its audio reaches the video's end: the highest listed window (its
   *   final sentence shows once that window is done; until then the tail is held back);
   * - the bridge lists no windows (stored windows only, e.g. after a reload): the highest done window,
   *   once it has been done for LAST_WINDOW_SETTLE_MS;
   * - otherwise none.
   */
  private updateLastWindow(): void {
    let next: number | undefined;
    const listed = this.state?.windows ?? [];
    if (listed.length > 0) {
      if (this.state?.endCaptured) next = Math.max(...listed.map((w) => w.index));
    } else if (this.done.size > 0) {
      const highestDone = Math.max(...this.done);
      const doneAt = this.doneAt.get(highestDone) ?? Number.POSITIVE_INFINITY;
      if (this.deps.now() - doneAt >= LAST_WINDOW_SETTLE_MS) next = highestDone;
    }
    this.lastWindowIndex = next; // sentences() rebuilds when this changes; emitIfChanged reports it
  }

  private emitIfChanged(): void {
    const phase = this.phase();
    const sentences = this.sentences();
    if (phase === this.emittedPhase && sentences === this.emittedSentences) return;
    this.emittedPhase = phase;
    this.emittedSentences = sentences;
    try {
      this.onChange();
    } catch {
      // The listener's failure must not break the controller.
    }
  }
}
