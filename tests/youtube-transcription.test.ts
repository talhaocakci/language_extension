import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUSY_RETRY_MS,
  LAST_WINDOW_SETTLE_MS,
  MAX_IN_FLIGHT,
  TranscriptionController,
  UNAVAILABLE_AFTER_MS,
  type TranscriptionDeps,
} from '../src/content/youtube-transcription';
import { parseAudioWindowAnswer, requestAudioWindowFile, type WindowFileEnv } from '../src/content/audio-window-request';
import { AcceptPauseTracker } from '../src/content/transcription-playback';
import { MAX_WINDOW_FILE_BYTES, type TranscribeResult, type TranscriptWindow } from '../src/utils/transcript-api';
import { WINDOW_MS } from '../src/utils/transcription-windows';
import { AUDIO_WINDOW_MESSAGE, type AudioCaptureState } from '../src/utils/youtube-timedtext';

type Answer = TranscriptWindow | 'not_signed_in' | 'insufficient_credits' | 'busy' | 'failed';
type TranscribeRequest = Parameters<TranscriptionDeps['transcribe']>[0];

/** A window whose words start one second into it, 400 ms each. */
function win(index: number, text: string): TranscriptWindow {
  const parts = text.split(/\s+/).filter(Boolean);
  const base = index * WINDOW_MS + 1000;
  return {
    index,
    language: 'de',
    words: parts.map((t, i) => ({ text: t, startMs: base + i * 400, endMs: base + (i + 1) * 400 })),
  };
}

function toResult(answer: Answer): TranscribeResult {
  return typeof answer === 'string'
    ? { ok: false, reason: answer }
    : { ok: true, window: answer, cached: false, creditsCharged: 1 };
}

interface FakeOptions {
  videoId?: string;
  hasCaptions?: boolean;
  format?: AudioCaptureState['format'];
  windows?: number[];
  stored?: TranscriptWindow[];
  playheadMs?: number;
  /** transcribe answers stay pending until release(). */
  hold?: boolean;
  answers?: Answer[];
  clock?: boolean;
  fileBytes?: number;
  /** requestWindowFile answers null this many times first. */
  nullFiles?: number;
  /** requestWindowFile resolves only after a macrotask. */
  slowFiles?: boolean;
  transcribeRejects?: boolean;
  fetchStoredRejects?: boolean;
}

function fake(o: FakeOptions = {}) {
  let now = 1_000_000;
  let playheadMs = o.playheadMs ?? 0;
  let nullFiles = o.nullFiles ?? 0;
  let state: AudioCaptureState | null = {
    videoId: o.videoId ?? 'v1',
    hasCaptions: o.hasCaptions ?? false,
    format: o.format ?? 'webm-opus',
    windows: (o.windows ?? []).map((index) => ({ index, startMs: index * WINDOW_MS, partial: false })),
  };
  const transcribeCalls: TranscribeRequest[] = [];
  const fetchStoredCalls: { videoId: string; format: string }[] = [];
  const fileRequests: number[] = [];
  const held: ((r: TranscribeResult) => void)[] = [];
  let answerIndex = 0;

  const deps: TranscriptionDeps = {
    readState: () => state,
    requestWindowFile: async (index) => {
      fileRequests.push(index);
      if (o.slowFiles) await new Promise((r) => setImmediate(r));
      if (nullFiles > 0) {
        nullFiles -= 1;
        return null;
      }
      const w = state?.windows.find((x) => x.index === index);
      return { startMs: w?.startMs ?? 0, partial: w?.partial ?? false, file: new Uint8Array(o.fileBytes ?? 1000) };
    },
    fetchStored: async (videoId, format) => {
      fetchStoredCalls.push({ videoId, format });
      if (o.fetchStoredRejects) throw new Error('worker gone');
      return o.stored ?? [];
    },
    transcribe: (req) => {
      transcribeCalls.push(req);
      if (o.transcribeRejects) return Promise.reject(new Error('worker gone'));
      if (o.hold) return new Promise<TranscribeResult>((resolve) => held.push(resolve));
      const answer = o.answers?.[answerIndex++] ?? win(req.index, '');
      return Promise.resolve(toResult(answer));
    },
    playheadMs: () => playheadMs,
    now: () => now,
  };

  return {
    deps,
    transcribeCalls,
    fetchStoredCalls,
    fileRequests,
    setState(next: AudioCaptureState | null) { state = next; },
    setWindows(indexes: number[]) {
      if (state) state = { ...state, windows: indexes.map((index) => ({ index, startMs: index * WINDOW_MS, partial: false })) };
    },
    setPlayhead(ms: number) { playheadMs = ms; },
    advance(ms: number) {
      if (!o.clock) throw new Error('clock not enabled');
      now += ms;
    },
    release(answer: Answer) {
      const r = held.shift();
      if (r) r(toResult(answer));
    },
    async settled() {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const texts = (c: TranscriptionController) => c.sentences().map((s) => s.text);

// ── Brief tests ──────────────────────────────────────────────────────────────

test('nothing is uploaded before the learner accepts', async () => {
  const f = fake({ windows: [0, 1] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await c.tick(); await c.tick();
  assert.equal(c.phase(), 'offer'); assert.equal(f.transcribeCalls.length, 0);
  assert.equal(f.fileRequests.length, 0);
});

test('stored windows show at once without acceptance or upload', async () => {
  const f = fake({ stored: [win(0, 'Hallo Welt.')], windows: [] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled();
  assert.equal(c.phase(), 'ready'); assert.deepEqual(texts(c), ['Hallo Welt.']);
  assert.equal(f.transcribeCalls.length, 0);
  assert.deepEqual(f.fetchStoredCalls, [{ videoId: 'v1', format: 'webm-opus' }]);
});

test('after accepting, the window at the playhead is sent first and at most two are in flight', async () => {
  const f = fake({ windows: [0, 1, 2, 3], playheadMs: 65_000, hold: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await c.tick(); await c.tick();
  assert.deepEqual(f.transcribeCalls.map((r) => r.index), [2, 3]);
  assert.equal(MAX_IN_FLIGHT, 2);
  assert.equal(c.phase(), 'preparing');
  assert.equal(f.transcribeCalls[0].format, 'webm-opus');
  assert.equal(f.transcribeCalls[0].videoId, 'v1');
});

test('a stored window is not uploaded again', async () => {
  const f = fake({ stored: [win(0, 'Eins.')], windows: [0, 1] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled(); c.accept(); await c.tick(); await f.settled();
  assert.deepEqual(f.transcribeCalls.map((r) => r.index), [1]);
});

test('a late answer for the previous video is ignored', async () => {
  const f = fake({ windows: [0], hold: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); c.reset('v2'); f.release(win(0, 'Alt.')); await f.settled();
  assert.deepEqual(c.sentences(), []);
});

test('a late answer after resetting the same video is ignored', async () => {
  const f = fake({ windows: [0], hold: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); c.reset('v1'); f.release(win(0, 'Alt.')); await f.settled();
  assert.deepEqual(c.sentences(), []);
  assert.equal(c.phase(), 'offer');
});

test('running out of credits stops uploads and keeps what is shown', async () => {
  const f = fake({ windows: [0, 1, 2], answers: [win(0, 'Eins.'), 'insufficient_credits'] });
  const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 5; i++) { await c.tick(); await f.settled(); }
  assert.equal(c.phase(), 'no_credits'); assert.equal(f.transcribeCalls.length, 2);
  assert.deepEqual(texts(c), ['Eins.']);
});

test('a window with no speech does not keep the overlay preparing', async () => {
  // Clarification: the brief's `lastWindow: 1` option is gone; "Jetzt." ends a sentence anyway.
  const f = fake({ windows: [0, 1], answers: [win(0, ''), win(1, 'Jetzt.')] });
  const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 4; i++) { await c.tick(); await f.settled(); }
  assert.equal(c.phase(), 'ready'); assert.deepEqual(texts(c), ['Jetzt.']);
});

test('a window that keeps failing is given up, not retried forever', async () => {
  const f = fake({ windows: [0], answers: ['failed', 'failed', 'failed'] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 6; i++) { await c.tick(); await f.settled(); }
  assert.equal(f.transcribeCalls.length, 1);
});

test('a busy answer is tried again later, not given up', async () => {
  const f = fake({ windows: [0], answers: ['busy', win(0, 'Jetzt.')], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled(); await c.tick(); await f.settled();
  assert.equal(f.transcribeCalls.length, 1);
  f.advance(BUSY_RETRY_MS + 1); await c.tick(); await f.settled();
  assert.deepEqual(texts(c), ['Jetzt.']);
});

test('an oversized window file is not uploaded', async () => {
  const f = fake({ windows: [0], fileBytes: MAX_WINDOW_FILE_BYTES + 1 }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled(); await c.tick();
  assert.equal(f.transcribeCalls.length, 0);
  assert.equal(f.fileRequests.length, 1);
});

test('no audio after accepting means unavailable', async () => {
  const f = fake({ windows: [], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); f.advance(UNAVAILABLE_AFTER_MS + 1); await c.tick();
  assert.equal(c.phase(), 'unavailable');
});

test('MP4 audio means unavailable at once', async () => {
  const f = fake({ format: 'unsupported' }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick();
  assert.equal(c.phase(), 'unavailable');
});

// ── Clarification tests ──────────────────────────────────────────────────────

test('MP4 audio means unavailable even before accepting', async () => {
  const f = fake({ format: 'unsupported' }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1');
  assert.equal(c.phase(), 'unavailable');
  assert.equal(f.fetchStoredCalls.length, 0);
});

test('a captioned video causes no backend call and stays idle', async () => {
  const f = fake({ hasCaptions: true, windows: [0, 1] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await c.tick(); c.accept(); await c.tick(); await f.settled();
  assert.equal(c.phase(), 'idle');
  assert.deepEqual(c.sentences(), []);
  assert.equal(f.fetchStoredCalls.length, 0);
  assert.equal(f.transcribeCalls.length, 0);
  assert.equal(f.fileRequests.length, 0);
});

test('ticks on a captioned video do not report changes', async () => {
  const f = fake({ hasCaptions: true }); let changes = 0;
  const c = new TranscriptionController(f.deps, () => { changes += 1; });
  c.reset('v1'); const afterReset = changes;
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal(changes, afterReset);
  assert.equal(c.sentences(), c.sentences());
});

test('stored windows are not fetched before the audio format is known', async () => {
  const f = fake({ format: '' }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await c.tick();
  assert.equal(f.fetchStoredCalls.length, 0);
  f.setState({ videoId: 'v1', hasCaptions: false, format: 'webm-opus', windows: [] });
  await c.tick(); await c.tick(); await f.settled();
  assert.equal(f.fetchStoredCalls.length, 1);
});

test('a state for another video is ignored', async () => {
  const f = fake({ videoId: 'old', windows: [0] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled();
  assert.equal(c.phase(), 'idle');
  assert.equal(f.fetchStoredCalls.length, 0);
  assert.equal(f.transcribeCalls.length, 0);
  f.setState({ videoId: 'v1', hasCaptions: false, format: 'webm-opus', windows: [{ index: 0, startMs: 0, partial: false }] });
  await c.tick(); await f.settled();
  assert.equal(f.fetchStoredCalls.length, 1);
  assert.equal(f.transcribeCalls.length, 1);
});

test('a null window file is retried on a later tick', async () => {
  const f = fake({ windows: [0], nullFiles: 1 }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled();
  assert.equal(f.transcribeCalls.length, 0);
  assert.equal(c.phase(), 'preparing');
  await c.tick(); await f.settled();
  assert.deepEqual(f.transcribeCalls.map((r) => r.index), [0]);
});

test('a rejected transcribe counts as failed', async () => {
  const f = fake({ windows: [0], transcribeRejects: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 4; i++) { await c.tick(); await f.settled(); }
  assert.equal(f.transcribeCalls.length, 1);
  assert.equal(c.phase(), 'ready'); // the playhead's window is done (with no words)
});

test('a rejected fetchStored does not break the controller', async () => {
  const f = fake({ windows: [0], fetchStoredRejects: true, answers: [win(0, 'Gut.')] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled();
  assert.equal(c.phase(), 'offer');
  c.accept(); await c.tick(); await f.settled();
  assert.deepEqual(texts(c), ['Gut.']);
});

test('a tick that starts while another is awaiting does not double-send', async () => {
  const f = fake({ windows: [0, 1, 2], hold: true, slowFiles: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept();
  await Promise.all([c.tick(), c.tick(), c.tick()]); await f.settled();
  await Promise.all([c.tick(), c.tick()]); await f.settled();
  const sent = f.transcribeCalls.map((r) => r.index);
  assert.deepEqual(sent, [0, 1]);
});

test('not signed in stops uploads with phase signed_out', async () => {
  const f = fake({ windows: [0, 1, 2], answers: ['not_signed_in'] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled();
  assert.equal(c.phase(), 'signed_out');
  const calls = f.transcribeCalls.length;
  assert.ok(calls >= 1 && calls <= MAX_IN_FLIGHT);
  for (let i = 0; i < 3; i++) { await c.tick(); await f.settled(); }
  assert.equal(f.transcribeCalls.length, calls);
  assert.equal(c.phase(), 'signed_out');
});

test('sentences survive no_credits and still cover the playhead', async () => {
  const f = fake({ windows: [0, 1], answers: [win(0, 'Eins zwei.'), 'insufficient_credits'] });
  const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 3; i++) { await c.tick(); await f.settled(); }
  assert.equal(c.phase(), 'no_credits');
  assert.deepEqual(texts(c), ['Eins zwei.']);
  f.setPlayhead(1200);
  assert.equal(c.coversPlayhead(), true);
  f.setPlayhead(45_000);
  assert.equal(c.coversPlayhead(), false);
  assert.equal(c.phase(), 'no_credits');
});

test('coverage: a sentence starting within 30 s after the playhead counts, a later one does not', async () => {
  const f = fake({ stored: [win(2, 'Später.')] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled();
  f.setPlayhead(61_000 - 30_000); // sentence starts at 61 000
  assert.equal(c.coversPlayhead(), true);
  f.setPlayhead(61_000 - 30_001);
  assert.equal(c.coversPlayhead(), false);
  assert.equal(c.phase(), 'offer');
});

test('busy windows do not block other windows', async () => {
  const f = fake({ windows: [0, 1], answers: ['busy', win(1, 'Zwei.')], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled(); await c.tick(); await f.settled();
  assert.deepEqual(f.transcribeCalls.map((r) => r.index), [0, 1]);
});

test('the unavailable clock restarts on accept and stops once a window is listed', async () => {
  const f = fake({ windows: [], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await c.tick();
  f.advance(UNAVAILABLE_AFTER_MS + 1); await c.tick();
  assert.equal(c.phase(), 'offer'); // not accepted: no clock
  c.accept(); await c.tick();
  assert.equal(c.phase(), 'preparing');
  f.advance(UNAVAILABLE_AFTER_MS - 1000); f.setWindows([5]); await c.tick(); await f.settled();
  f.advance(UNAVAILABLE_AFTER_MS * 3); await c.tick();
  assert.equal(c.phase(), 'preparing'); // window 5 is far from the playhead; nothing covers 0
});

test('the final unfinished sentence appears once the last window is settled', async () => {
  const f = fake({ windows: [0], answers: [win(0, 'Hallo Welt')], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled();
  assert.deepEqual(texts(c), []); // may still continue in a later window
  f.advance(LAST_WINDOW_SETTLE_MS - 1); await c.tick();
  assert.deepEqual(texts(c), []);
  f.advance(2); await c.tick();
  assert.deepEqual(texts(c), ['Hallo Welt']);
});

test('a later window listed in time means the window was not the last', async () => {
  const f = fake({ windows: [0], answers: [win(0, 'Hallo Welt')], clock: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled();
  f.advance(5000); f.setWindows([0, 1]); await c.tick(); await f.settled();
  // Window 0 is no longer a candidate; window 1 (no words) was sent as the highest.
  f.advance(LAST_WINDOW_SETTLE_MS - 5000); await c.tick();
  assert.deepEqual(texts(c), []);
  f.advance(LAST_WINDOW_SETTLE_MS); await c.tick();
  assert.deepEqual(texts(c), ['Hallo Welt']);
  assert.deepEqual(f.transcribeCalls.map((r) => r.index), [0, 1]);
});

test('sentences use the stt track key and keep their array between changes', async () => {
  const f = fake({ stored: [win(0, 'Hallo Welt.')] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled();
  const first = c.sentences();
  assert.equal(c.sentences(), first);
  await c.tick();
  assert.equal(c.sentences(), first);
  assert.ok(first[0].subPortions.length === 2);
  assert.equal(c.language(), 'de');
});

test('onChange fires on reset, stored windows, accept and results', async () => {
  const f = fake({ windows: [0], answers: [win(0, 'Gut.')], stored: [] });
  let changes = 0;
  const c = new TranscriptionController(f.deps, () => { changes += 1; });
  c.reset('v1');
  const afterReset = changes;
  assert.ok(afterReset >= 1);
  await f.settled();
  c.accept();
  assert.ok(changes > afterReset);
  const afterAccept = changes;
  await c.tick(); await f.settled();
  assert.ok(changes > afterAccept);
  const settled = changes;
  await c.tick(); await c.tick();
  assert.equal(changes, settled); // nothing new, no spurious change
});

// ── Window file request ──────────────────────────────────────────────────────

function fakeWindow() {
  const self = {};
  let handler: ((e: { source: unknown; origin: string; data: unknown }) => void) | null = null;
  const dispatched: string[] = [];
  const timers: (() => void)[] = [];
  const env: WindowFileEnv = {
    self,
    origin: 'https://www.youtube.com',
    listen(h) { handler = h; return () => { handler = null; }; },
    dispatch(detail) { dispatched.push(detail); },
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
    newRequestId: () => 'req-1',
  };
  return {
    env, self, dispatched,
    post(source: unknown, origin: string, data: unknown) { handler?.({ source, origin, data }); },
    fireTimers() { timers.splice(0).forEach((t) => t()); },
    get listening() { return handler !== null; },
  };
}

const answer = (over: Record<string, unknown> = {}) => ({
  type: AUDIO_WINDOW_MESSAGE, requestId: 'req-1', index: 3, videoId: 'v1', startMs: 90_000, partial: true,
  file: new Uint8Array([1, 2, 3]).buffer, ...over,
});

test('a window file answer is accepted only from this window, origin, request and video', async () => {
  const w = fakeWindow();
  const p = requestAudioWindowFile(w.env, 'v1', 3);
  assert.deepEqual(JSON.parse(w.dispatched[0]), { requestId: 'req-1', index: 3, videoId: 'v1' });
  w.post({}, w.env.origin, answer());                     // other source
  w.post(w.self, 'https://evil.example', answer());       // other origin
  w.post(w.self, w.env.origin, answer({ requestId: 'x' }));
  w.post(w.self, w.env.origin, answer({ type: 'other' }));
  w.post(w.self, w.env.origin, answer({ index: 4 }));
  assert.equal(w.listening, true);
  w.post(w.self, w.env.origin, answer());
  const got = await p;
  assert.ok(got);
  assert.equal(got.startMs, 90_000);
  assert.equal(got.partial, true);
  assert.deepEqual([...got.file], [1, 2, 3]);
  assert.equal(w.listening, false);
});

test('a window file answer for another video or without a file is no file', async () => {
  const w = fakeWindow();
  const p = requestAudioWindowFile(w.env, 'v1', 3);
  w.post(w.self, w.env.origin, answer({ videoId: 'v2' }));
  assert.equal(await p, null);
  const w2 = fakeWindow();
  const p2 = requestAudioWindowFile(w2.env, 'v1', 3);
  w2.post(w2.self, w2.env.origin, answer({ file: null }));
  assert.equal(await p2, null);
});

test('a window file request times out as no file', async () => {
  const w = fakeWindow();
  const p = requestAudioWindowFile(w.env, 'v1', 3);
  w.fireTimers();
  assert.equal(await p, null);
  assert.equal(w.listening, false);
});

test('parseAudioWindowAnswer ignores unrelated messages', () => {
  assert.equal(parseAudioWindowAnswer(null, 'req-1', 3), undefined);
  assert.equal(parseAudioWindowAnswer({ type: 'x' }, 'req-1', 3), undefined);
  assert.equal(parseAudioWindowAnswer(answer({ startMs: 'a' }), 'req-1', 3), null);
});

// ── Pause / resume bookkeeping ───────────────────────────────────────────────

test('accepting while playing pauses once and resumes on the first ready', () => {
  const t = new AcceptPauseTracker();
  assert.equal(t.onAccept(true, false), true);
  t.onPauseEvent(); // our own pause
  assert.equal(t.onPhase('preparing'), false);
  assert.equal(t.onPhase('ready'), true);
  assert.equal(t.onPhase('ready'), false);
  assert.equal(t.onAccept(true, false), false);
});

test('accepting while paused or by the always setting never pauses', () => {
  const t = new AcceptPauseTracker();
  assert.equal(t.onAccept(false, false), false);
  assert.equal(t.onPhase('ready'), false);
  const t2 = new AcceptPauseTracker();
  assert.equal(t2.onAccept(true, true), false);
  assert.equal(t2.onPhase('ready'), false);
});

test('the learner pressing play while preparing cancels the resume and any later pause', () => {
  const t = new AcceptPauseTracker();
  assert.equal(t.onAccept(true, false), true);
  t.onPauseEvent();
  t.onPlayEvent();
  assert.equal(t.onPhase('ready'), false);
  assert.equal(t.onAccept(true, false), false);
});

test('the learner pausing again themself cancels the resume', () => {
  const t = new AcceptPauseTracker();
  assert.equal(t.onAccept(true, false), true);
  t.onPauseEvent();
  t.onPauseEvent(); // a second pause cannot be ours
  assert.equal(t.onPhase('ready'), false);
});

test('reset forgets the previous video', () => {
  const t = new AcceptPauseTracker();
  t.onAccept(true, false); t.onPauseEvent(); t.onPlayEvent();
  t.reset();
  assert.equal(t.onAccept(true, false), true);
});
