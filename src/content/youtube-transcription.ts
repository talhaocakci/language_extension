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
export const BUSY_RETRY_MS = 3000;
/** The highest done window is the video's last once nothing higher is listed this long after it was done. */
export const LAST_WINDOW_SETTLE_MS = 20_000;
/** A sentence starting this soon after the playhead counts as covering it. */
export const COVER_AHEAD_MS = 30_000;

const AUDIO_FORMAT = 'webm-opus';
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
  private stored: Promise<void> | null = null;
  private storedSettled = false;
  private tickingGeneration: number | null = null;

  private words = new Map<number, TimedWord[]>();
  private done = new Set<number>();
  private inFlight = new Set<number>();
  private busyUntil = new Map<number, number>();
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
    if (!s || s.hasCaptions || !this.wanted) return 'idle';
    if (this.sticky) return this.sticky;
    if (this.coversPlayhead()) return 'ready';
    return this.accepted ? 'preparing' : 'offer';
  }

  sentences(): MeaningfulSentence[] {
    if (!this.state || this.state.hasCaptions || !this.wanted) return NO_SENTENCES;
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

  /** True when a sentence contains the playhead or starts within 30 s after it, or the playhead's window is done. */
  coversPlayhead(): boolean {
    if (!this.state || this.state.hasCaptions || !this.wanted) return false;
    const playhead = this.deps.playheadMs();
    if (this.done.has(Math.floor(playhead / WINDOW_MS))) return true;
    return this.sentences().some((s) =>
      (s.startTime <= playhead && playhead <= s.endTime) ||
      (s.startTime > playhead && s.startTime - playhead <= COVER_AHEAD_MS)
    );
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

  accept(): void {
    if (!this.videoId || !this.wanted || this.accepted) return;
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
    this.stored = null;
    this.storedSettled = false;
    this.words = new Map();
    this.done = new Set();
    this.inFlight = new Set();
    this.busyUntil = new Map();
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
      if (!s || s.hasCaptions || !this.wanted) return;
      if (s.windows.length > 0) this.sawWindow = true;
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
      if (s.format !== AUDIO_FORMAT) return;
      await this.sendWhileRoom(generation);
    } finally {
      if (this.tickingGeneration === generation) this.tickingGeneration = null;
      if (generation === this.generation) this.emitIfChanged();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

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
    if (raw.hasCaptions || !this.wanted) return;
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
      if (!s || generation !== this.generation || !this.accepted || this.sticky) return;
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
      if (!file || !this.accepted || this.sticky) {
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
      this.markDone(index);
      if (!this.detectedLanguage && result.window?.language) this.detectedLanguage = result.window.language;
      this.updateLastWindow();
      return this.emitIfChanged();
    }
    const reason = (result as Extract<TranscribeResult, { ok: false }>).reason;
    if (reason === 'busy') {
      this.busyUntil.set(index, this.deps.now() + BUSY_RETRY_MS);
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
   * The bridge lists the final window only once the player has buffered to the end. Re-evaluated each time:
   * H = the highest done window; it is the last when nothing above H is listed and H has been done for
   * LAST_WINDOW_SETTLE_MS. A higher window listed or done later withdraws it again.
   */
  private updateLastWindow(): void {
    let next: number | undefined;
    if (this.done.size > 0) {
      const highestDone = Math.max(...this.done);
      const listed = this.state?.windows ?? [];
      const higherListed = listed.some((w) => w.index > highestDone);
      const doneAt = this.doneAt.get(highestDone) ?? Number.POSITIVE_INFINITY;
      if (!higherListed && this.deps.now() - doneAt >= LAST_WINDOW_SETTLE_MS) next = highestDone;
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
