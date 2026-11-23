# YouTube caption-less transcription — extension half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a YouTube video with no caption track, capture the audio the player buffers ahead, send it in 30-second windows to the backend, and show the returned words as whole sentences in the overlay.

**Architecture:** The page-world bridge wraps `MediaSource`/`SourceBuffer` and keeps the audio bytes; pure modules parse the WebM stream into clusters, group clusters into fixed windows and build a stand-alone file per window. The content script asks the bridge for window files, the service worker posts them to the backend, and returned words go through the existing `sentencesFromTimedWords`.

**Tech Stack:** TypeScript, Chrome MV3 (page-world content script, isolated content script, service worker), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-youtube-captionless-transcription-design.md`

**Depends on:** branch `youtube-sentence-shaping` (`src/utils/timed-words.ts`, `src/utils/sentence-builder.ts`, `src/content/youtube-player-bridge.ts`). The backend half is a separate plan in `getfluentfast_backend`; Tasks 1 to 3 here need no backend, Tasks 4 and 5 are tested against the contract below and tried for real only once the backend is deployed.

## Global Constraints

- Applies only on YouTube watch pages where the player reports no caption tracks. Captioned videos, Netflix and Max behave exactly as before.
- No audio leaves the page world, and nothing is uploaded, until the learner accepted for that video (or the "always" setting is on). The learner must be signed in.
- The wrappers always call the original method with the original arguments; an exception inside a wrapper never reaches the player.
- The extension never seeks, mutes or changes playback speed to obtain audio.
- Windows are 30 000 ms on a fixed grid from 0; window `k` covers `[k*30000, (k+1)*30000)`.
- Audio format string sent to the backend: `webm-opus`. Any other container (the buffer's mime is not `audio/webm`) means "transcription not available for this video".
- Kept audio is dropped when the video changes. Before acceptance at most 8 MB is kept (oldest clusters dropped first, init part always kept).
- At most 2 uploads in flight.
- Tooling: `node` and `npm` are not on PATH on the owner's machine; test scripts follow the existing `test:*` pattern in `package.json` (`tsc … --outDir /tmp/… && node --test …`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.

## Backend contract (defined here, implemented by the backend plan)

Both `POST`, JSON, `Authorization: Bearer <id token>`, base `https://api.getfluentfast.app/prod`.

- `/transcripts/windows` — request `{ videoId, format }`; response `200 { windows: [{ index, language, words: [{ text, startMs, endMs }] }] }`. Word times are on the video's timeline.
- `/transcripts/transcribe` — request `{ videoId, format, index, partial, startMs, audioBase64 }` where `startMs` is the video time of the first cluster in the file and the file's own timecodes start at 0; response `200 { index, language, words, cached, creditsCharged }` (`language` is an ISO-639-1 code or `""`); `401` not signed in; `402 { error: "insufficient_credits" }`; `503 { error: "server_busy" }` or `503 { error: "window_busy" }` mean "try this window again later" and are not failures; `400` and `413` are permanent failures for that window and are not retried; any other status (`500`, `502`, `503 charge_failed`) may be retried once. The raw request body may be at most 1 200 000 bytes, so a window file larger than 880 000 bytes is not uploaded and counts as a permanent failure for that window. The backend refuses an upload unless the balance covers roughly twice a window's price.

## Review Focus

- A seek: bytes after it do not continue the bytes before it. The parser must not glue them into one cluster, and the window after the seek is partial.
- A cluster only half received must never be put in a file.
- A window whose audio is music or silence returns no words; the overlay must not sit in "preparing" forever for it.
- The learner opens another video while uploads are in flight; late responses must not add sentences to the new video.
- Credits run out mid-video: uploads stop, shown sentences stay, no retry loop.

---

### Task 1: WebM audio stream parser and window file builder

**Files:**
- Create: `src/utils/webm-audio.ts`
- Test: `tests/webm-audio.test.ts`
- Modify: `package.json` (add `test:webm-audio`, same pattern as `test:timed-words`)

**Interfaces:**
- Produces:
  ```ts
  export interface WebmCluster { offset: number; length: number; timecodeMs: number;
    timecodeValueOffset: number; timecodeValueLength: number }
  export interface ParsedWebmAudio { initLength: number; clusters: WebmCluster[] }
  /** Complete clusters only. null when the bytes do not start with an EBML header. */
  export function parseWebmAudio(bytes: Uint8Array): ParsedWebmAudio | null;
  /** Init part + the given clusters, timecodes rewritten so the first is 0. Input is not modified. */
  export function buildWindowFile(bytes: Uint8Array, parsed: ParsedWebmAudio, clusters: WebmCluster[]): Uint8Array;
  ```

Observed stream (spec, "Spike results"): EBML header `1A45DFA3`, Segment `18538067` with unknown size, then SeekHead/Info/Tracks, then Clusters `1F43B675` each with a known size whose first child is Timecode `E7` (unsigned, milliseconds). `initLength` is the offset of the first cluster. Walk elements by id and size; a cluster is complete when `offset + length <= bytes.length`. If the bytes at the expected next position are not a cluster id (a seek joined two runs), scan forward for the next `1F43B675` whose size and Timecode parse, and continue from there.

- [ ] **Step 1: Write the failing tests**

Test helpers build a synthetic stream: `init()` = header + Segment(unknown size) + a 20-byte Info + a 30-byte Tracks; `cluster(tcMs, payloadLen)` = id + 8-byte size + `E7 84 <4-byte tc>` + a `A3` SimpleBlock of `payloadLen` filler bytes.

```ts
test('finds complete clusters and the init length', () => {
  const s = concat(init(), cluster(0, 100), cluster(10001, 80));
  const p = parseWebmAudio(s)!;
  assert.equal(p.initLength, init().length);
  assert.deepEqual(p.clusters.map(c => c.timecodeMs), [0, 10001]);
  assert.equal(p.clusters[1].offset, init().length + cluster(0, 100).length);
});
test('a half-received cluster is left out', () => {
  const s = concat(init(), cluster(0, 100), cluster(10001, 80).slice(0, 40));
  assert.deepEqual(parseWebmAudio(s)!.clusters.map(c => c.timecodeMs), [0]);
});
test('bytes after a seek are picked up at the next cluster', () => {
  const s = concat(init(), cluster(0, 100).slice(0, 50), cluster(90001, 60), cluster(100001, 60));
  assert.deepEqual(parseWebmAudio(s)!.clusters.map(c => c.timecodeMs), [90001, 100001]);
});
test('not WebM', () => { assert.equal(parseWebmAudio(new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70])), null); });
test('a window file starts at time zero and leaves the source untouched', () => {
  const s = concat(init(), cluster(0, 10), cluster(30001, 10), cluster(40001, 10));
  const p = parseWebmAudio(s)!; const copy = s.slice();
  const file = buildWindowFile(s, p, p.clusters.slice(1));
  assert.deepEqual(parseWebmAudio(file)!.clusters.map(c => c.timecodeMs), [0, 10000]);
  assert.equal(file.length, p.initLength + p.clusters[1].length + p.clusters[2].length);
  assert.deepEqual(s, copy);
});
```

- [ ] **Step 2: Run `npm run test:webm-audio`** — expected: FAIL, module not found.
- [ ] **Step 3: Implement `parseWebmAudio` and `buildWindowFile`.**
- [ ] **Step 4: Run `npm run test:webm-audio`** — expected: 5 pass.
- [ ] **Step 5: Commit** — `Parse captured WebM audio into clusters and window files`.

### Task 2: Windows and sentences across windows

**Files:**
- Create: `src/utils/transcription-windows.ts`
- Test: `tests/transcription-windows.test.ts`
- Modify: `package.json` (add `test:transcription-windows`, compiling it with `sentence-builder.ts`, `timed-words.ts`, `src/types/subtitle.ts`)

**Interfaces:**
- Consumes: `TimedWord` (`timed-words.ts`), `sentencesFromTimedWords(words, trackKey)` (`sentence-builder.ts`), `MeaningfulSentence`.
- Produces:
  ```ts
  export const WINDOW_MS = 30_000;
  export const WINDOW_EDGE_TOLERANCE_MS = 100;
  export interface ClusterTime { timecodeMs: number }
  export interface ReadyWindow { index: number; startMs: number; partial: boolean; clusterIndexes: number[] }
  /** Windows that can be sent now. videoEndMs: pass when the stream's end has been captured. */
  export function readyWindows(clusters: ClusterTime[], videoEndMs?: number): ReadyWindow[];
  /** Which window to send next: nearest at or after the playhead, not stored, not in flight. */
  export function nextWindowToSend(ready: ReadyWindow[], done: Set<number>, inFlight: Set<number>, playheadMs: number): ReadyWindow | null;
  /** Sentences over contiguous windows. The last, unfinished sentence of a run is held back unless final. */
  export function sentencesFromWindows(words: Map<number, TimedWord[]>, trackKey: string, lastWindowIndex?: number): MeaningfulSentence[];
  ```

Rules: a cluster belongs to window `floor((timecodeMs + WINDOW_EDGE_TOLERANCE_MS) / WINDOW_MS)`. A window is ready when a later cluster belonging to a higher window exists, or `videoEndMs` is given and it is the last window with clusters. `partial` is true when its first cluster starts more than the tolerance after the window start, or its clusters are not consecutive in the input (a gap larger than twice the median cluster spacing). `startMs` is the first cluster's timecode. In `sentencesFromWindows`, a run is a set of consecutive window indexes; words of a run are concatenated in order and passed to `sentencesFromTimedWords`; when that returns null (the service returned text without punctuation) the run's words are cut into sentences of `MAX_SENTENCE_WORDS` words each, with ids from `sentenceId`. The final sentence of a run is dropped when its last word does not end with a sentence mark and the run's last window is not `lastWindowIndex`.

- [ ] **Step 1: Write the failing tests**

```ts
const tc = (...ms: number[]) => ms.map(timecodeMs => ({ timecodeMs }));
test('a window is ready once a cluster of the next window exists', () => {
  assert.deepEqual(readyWindows(tc(0, 10001, 20001)), []);
  assert.deepEqual(readyWindows(tc(0, 10001, 20001, 30001)),
    [{ index: 0, startMs: 0, partial: false, clusterIndexes: [0, 1, 2] }]);
});
test('the last window is ready when the end was captured', () => {
  assert.deepEqual(readyWindows(tc(0, 10001), 18_000).map(w => w.index), [0]);
});
test('a window entered by a seek is partial and starts where its audio starts', () => {
  const [w] = readyWindows(tc(100001, 110001, 120001));
  assert.deepEqual([w.index, w.startMs, w.partial], [3, 100001, true]);
});
test('a hole inside a window makes it partial', () => {
  assert.equal(readyWindows(tc(0, 20001, 30001))[0].partial, true);
});
test('the window at the playhead goes first, stored and in-flight ones are skipped', () => {
  const ready = readyWindows(tc(0, 10001, 20001, 30001, 40001, 50001, 60001, 70001, 80001, 90001));
  assert.equal(nextWindowToSend(ready, new Set(), new Set(), 35_000)!.index, 1);
  assert.equal(nextWindowToSend(ready, new Set([1]), new Set([2]), 35_000)!.index, 0);
  assert.equal(nextWindowToSend(ready, new Set([0, 1, 2]), new Set(), 0), null);
});
test('a sentence crossing a window edge is whole once both windows are in', () => {
  const w0 = words('Das ist der Anfang. Und hier', 0, 30_000);
  const w1 = words('geht es weiter. Ende.', 30_000, 60_000);
  assert.deepEqual(sentencesFromWindows(new Map([[0, w0]]), 'k').map(s => s.text), ['Das ist der Anfang.']);
  assert.deepEqual(sentencesFromWindows(new Map([[0, w0], [1, w1]]), 'k', 1).map(s => s.text),
    ['Das ist der Anfang.', 'Und hier geht es weiter.', 'Ende.']);
});
test('windows that are not neighbours do not share a sentence', () => {
  const out = sentencesFromWindows(new Map([[0, words('Eins zwei', 0, 30_000)], [3, words('drei. Vier.', 90_000, 120_000)]]), 'k', 3);
  assert.deepEqual(out.map(s => s.text), ['drei.', 'Vier.']);
});
test('a window without words yields nothing and does not block its neighbours', () => {
  const out = sentencesFromWindows(new Map([[0, words('Hallo.', 0, 30_000)], [1, []], [2, words('Welt.', 60_000, 90_000)]]), 'k', 2);
  assert.deepEqual(out.map(s => s.text), ['Hallo.', 'Welt.']);
});
```

`words(text, startMs, endMs)` is a test helper spreading the words evenly over the span.

- [ ] **Step 2: Run `npm run test:transcription-windows`** — expected: FAIL, module not found.
- [ ] **Step 3: Implement the three functions.**
- [ ] **Step 4: Run it again** — expected: 8 pass. Run `npm run test:sentence-builder` — expected: still 14 pass.
- [ ] **Step 5: Commit** — `Group captured audio into windows and build sentences across them`.

### Task 3: Capture in the page world

**Files:**
- Create: `src/content/youtube-audio-capture.ts`
- Modify: `src/content/youtube-player-bridge.ts` (install capture, publish state, answer requests)
- Modify: `src/utils/youtube-timedtext.ts` (shared constants only)
- Test: `tests/youtube-audio-capture.test.ts`; `package.json` (add `test:youtube-audio-capture`)

**Interfaces:**
- Consumes: `parseWebmAudio`, `buildWindowFile`, `readyWindows`.
- Produces, in `youtube-timedtext.ts`:
  ```ts
  export const AUDIO_STATE_ATTRIBUTE = 'data-gff-audio-state';
  export const AUDIO_WINDOW_REQUEST_EVENT = 'gff-audio-window-request'; // detail: JSON string { requestId, index }
  export const AUDIO_WINDOW_MESSAGE = 'gff-audio-window';               // window.postMessage type
  export interface AudioCaptureState { videoId: string; hasCaptions: boolean; format: 'webm-opus' | 'unsupported' | '';
    windows: { index: number; startMs: number; partial: boolean }[] }
  export function parseAudioCaptureState(raw: string | null): AudioCaptureState | null;
  ```
- Produces, in `youtube-audio-capture.ts`:
  ```ts
  export const MAX_KEPT_BYTES = 8 * 1024 * 1024;
  export interface AudioCapture {
    /** Ready windows for the bytes kept so far. */
    windows(videoEndMs?: number): ReadyWindow[];
    /** Stand-alone file for a ready window, or null when it is no longer kept. */
    windowFile(index: number): Uint8Array | null;
    format(): 'webm-opus' | 'unsupported' | '';
    /** Drop everything; called when the video changes or the video has captions. */
    reset(): void;
  }
  /** Wraps addSourceBuffer / appendBuffer / abort on the given prototypes. */
  export function installAudioCapture(mediaSourceProto: any, sourceBufferProto: any): AudioCapture;
  ```

Behaviour: `addSourceBuffer(mime)` records which buffer is audio; a new audio buffer resets the kept bytes (a new video or a reloaded player). `appendBuffer` copies the bytes of the audio buffer onto the kept stream when the mime starts with `audio/webm`; any other audio mime sets format `unsupported` and keeps nothing. `abort()` on the audio buffer ends the current run: bytes of an unfinished cluster are discarded so the next append is not glued to them. When kept bytes exceed `MAX_KEPT_BYTES`, whole clusters are dropped from the front; the init part stays. Every wrapper body is inside `try/catch` and the original is called after it, outside the `try`.

The bridge, once a second with its existing publisher: reads `hasCaptions` from `player.getPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length`; calls `capture.reset()` when `hasCaptions` is true or the video id changed; writes `AudioCaptureState` as JSON to `AUDIO_STATE_ATTRIBUTE` (windows listed only when `hasCaptions` is false). `videoEndMs` is `player.getDuration() * 1000` when the kept clusters reach within 11 s of it. On `AUDIO_WINDOW_REQUEST_EVENT` it answers with `window.postMessage({ type: AUDIO_WINDOW_MESSAGE, requestId, index, startMs, partial, file: ArrayBuffer | null }, location.origin, [file])`.

- [ ] **Step 1: Write the failing tests** (fake prototypes: plain objects with `addSourceBuffer` returning a fake buffer whose prototype holds `appendBuffer`/`abort` that record calls; streams from Task 1's helpers moved to `tests/webm-fixture.ts`)

```ts
test('audio bytes are kept and windows become ready', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const stream = concat(init(), cluster(0, 50), cluster(10001, 50), cluster(20001, 50), cluster(30001, 50));
  audio.appendBuffer(stream.slice(0, 70)); audio.appendBuffer(stream.slice(70));
  assert.equal(capture.format(), 'webm-opus');
  assert.deepEqual(capture.windows().map(w => w.index), [0]);
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10001, 20001]);
});
test('video bytes are not kept', () => {
  const { ms, capture } = setup();
  ms.addSourceBuffer('video/webm; codecs="vp09"').appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows(), []);
});
test('the player still receives every append when the capture throws', () => {
  const { ms, appended } = setup({ breakCapture: true });
  const audio = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const bytes = new Uint8Array([1, 2, 3]);
  audio.appendBuffer(bytes);
  assert.deepEqual(appended, [bytes]);
});
test('an abort keeps finished clusters and discards the unfinished one', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer('audio/webm; codecs="opus"');
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 20)));
  audio.abort();
  audio.appendBuffer(concat(cluster(90001, 50), cluster(100001, 50), cluster(110001, 50), cluster(120001, 50)));
  assert.deepEqual(capture.windows().map(w => [w.index, w.partial]), [[0, false], [3, false]]);
});
test('MP4 audio is reported as unsupported and nothing is kept', () => {
  const { ms, capture } = setup();
  ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"').appendBuffer(new Uint8Array(100));
  assert.equal(capture.format(), 'unsupported');
});
test('a new audio buffer starts over', () => {
  const { ms, capture } = setup();
  ms.addSourceBuffer('audio/webm; codecs="opus"').appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  ms.addSourceBuffer('audio/webm; codecs="opus"');
  assert.deepEqual(capture.windows(), []);
});
test('old clusters are dropped past the size limit, the init part stays', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer('audio/webm; codecs="opus"');
  audio.appendBuffer(init());
  for (let i = 0; i < 12; i++) audio.appendBuffer(cluster(i * 10000, 1024 * 1024));
  assert.equal(capture.windowFile(0), null);
  assert.ok(capture.windows().length > 0);
  assert.equal(parseWebmAudio(capture.windowFile(capture.windows()[0].index)!)!.initLength, init().length);
});
```

In the third test `breakCapture` makes the capture's internal store throw on write. In the fourth, window 0 is ready because a later window's cluster exists, and window 3 starts exactly on its edge.

- [ ] **Step 2: Run `npm run test:youtube-audio-capture`** — expected: FAIL, module not found.
- [ ] **Step 3: Implement `installAudioCapture`; add the constants and `parseAudioCaptureState`; wire the bridge** (install at module load, before the existing interval).
- [ ] **Step 4: Run the new tests (7 pass), `npm run test:youtube-timedtext` (15 pass), `npm run type-check`, `npm run build`.**
- [ ] **Step 5: Manual check in Chrome** with the built extension on `https://www.youtube.com/watch?v=UN0x-KXc_XI`: in DevTools, `document.documentElement.getAttribute('data-gff-audio-state')` shows `hasCaptions:false`, `format:"webm-opus"` and a growing window list while playing; after dragging the seek bar to 1:40 a window with `partial:true` appears; on a captioned video the list stays empty; playback is normal on both. Record what was seen in the task report. If a seek does not produce an `abort` and windows after the seek are missing or wrong, report it as a finding instead of guessing a fix.
- [ ] **Step 6: Commit** — `Capture buffered YouTube audio in the page world`.

### Task 4: Service worker: backend calls

**Files:**
- Create: `src/utils/transcript-api.ts`
- Modify: `src/background/service-worker.ts` (two message handlers, beside `OVERLAY_CALL_LLM`)
- Test: `tests/transcript-api.test.ts`; `package.json` (add `test:transcript-api`)

**Interfaces:**
- Consumes: `getValidIdToken()` and `API_BASE_URL` in the service worker; `TimedWord`.
- Produces:
  ```ts
  export interface TranscriptWindow { index: number; language: string; words: TimedWord[] }
  export type TranscribeResult =
    | { ok: true; window: TranscriptWindow; cached: boolean; creditsCharged: number }
    | { ok: false; reason: 'not_signed_in' | 'insufficient_credits' | 'busy' | 'failed' };
  export const MAX_WINDOW_FILE_BYTES = 880_000;
  export function parseWindowsResponse(json: unknown): TranscriptWindow[];
  export function parseTranscribeResponse(status: number, json: unknown): TranscribeResult;
  export function bytesToBase64(bytes: Uint8Array): string;
  ```
- Messages: `TRANSCRIPT_WINDOWS { videoId, format }` → `{ success, windows }`; `TRANSCRIBE_WINDOW { videoId, format, index, partial, startMs, audioBase64 }` → `TranscribeResult`. `503` with error `server_busy` or `window_busy` → `busy`, no retry in the worker. `400`/`413` → `failed`, no retry. Any other non-2xx except 401/402 is retried once after 1 s, then `failed`.

Parsers drop malformed words (non-string text, non-finite or negative times, `endMs < startMs`) and malformed windows rather than throwing.

- [ ] **Step 1: Write the failing tests**

```ts
test('stored windows are read and junk is dropped', () => {
  const out = parseWindowsResponse({ windows: [
    { index: 0, language: 'de', words: [{ text: 'Hallo.', startMs: 0, endMs: 400 }, { text: 5, startMs: 1, endMs: 2 }] },
    { index: 'x', words: [] }, null] });
  assert.deepEqual(out, [{ index: 0, language: 'de', words: [{ text: 'Hallo.', startMs: 0, endMs: 400 }] }]);
  assert.deepEqual(parseWindowsResponse(null), []);
});
test('transcribe outcomes', () => {
  const body = { index: 2, language: 'de', words: [], cached: true, creditsCharged: 0 };
  assert.deepEqual(parseTranscribeResponse(200, body), { ok: true, window: { index: 2, language: 'de', words: [] }, cached: true, creditsCharged: 0 });
  assert.deepEqual(parseTranscribeResponse(402, { error: 'insufficient_credits' }), { ok: false, reason: 'insufficient_credits' });
  assert.deepEqual(parseTranscribeResponse(401, {}), { ok: false, reason: 'not_signed_in' });
  assert.deepEqual(parseTranscribeResponse(500, {}), { ok: false, reason: 'failed' });
  assert.deepEqual(parseTranscribeResponse(503, { error: 'server_busy' }), { ok: false, reason: 'busy' });
  assert.deepEqual(parseTranscribeResponse(503, { error: 'window_busy' }), { ok: false, reason: 'busy' });
  assert.deepEqual(parseTranscribeResponse(503, { error: 'charge_failed' }), { ok: false, reason: 'failed' });
  assert.deepEqual(parseTranscribeResponse(200, { index: 'x' }), { ok: false, reason: 'failed' });
});
test('base64 of binary bytes', () => {
  assert.equal(bytesToBase64(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0xff])), 'GkXfo/8=');
  assert.equal(bytesToBase64(new Uint8Array(200_000).fill(255)).length, 266_668);
});
```

- [ ] **Step 2: Run `npm run test:transcript-api`** — expected: FAIL.
- [ ] **Step 3: Implement the module and the two handlers.**
- [ ] **Step 4: Run the tests (3 pass), `npm run type-check`.**
- [ ] **Step 5: Commit** — `Add transcript window requests to the service worker`.

### Task 5: Overlay: offer, read ahead, show sentences

**Files:**
- Create: `src/content/youtube-transcription.ts` (controller; no DOM except reading the bridge attribute and the message listener)
- Modify: `src/content/youtube-injector.ts` (use the controller when the video has no captions; overlay states; offer button)
- Modify: the preferences type and popup settings (find `GET_PREFERENCES` / `SET_PREFERENCES` users) to add `alwaysTranscribeCaptionless: boolean`, default `false`
- Test: `tests/youtube-transcription.test.ts`; `package.json` (add `test:youtube-transcription`)

**Interfaces:**
- Consumes: `AudioCaptureState`, `nextWindowToSend`, `sentencesFromWindows`, `TranscribeResult`, `TranscriptWindow`.
- Produces:
  ```ts
  export type TranscriptionPhase = 'idle' | 'offer' | 'preparing' | 'ready' | 'unavailable' | 'no_credits' | 'signed_out';
  export interface TranscriptionDeps {
    readState(): AudioCaptureState | null;
    requestWindowFile(index: number): Promise<{ startMs: number; partial: boolean; file: Uint8Array } | null>;
    fetchStored(videoId: string, format: string): Promise<TranscriptWindow[]>;
    transcribe(req: { videoId: string; format: string; index: number; partial: boolean; startMs: number; file: Uint8Array }): Promise<TranscribeResult>;
    playheadMs(): number;
    now(): number;
  }
  export class TranscriptionController {
    constructor(deps: TranscriptionDeps, onChange: () => void);
    phase(): TranscriptionPhase;
    sentences(): MeaningfulSentence[];
    /** True when sentences exist that cover the playhead or start after it within 30 s. */
    coversPlayhead(): boolean;
    accept(): void;            // the learner agreed for this video
    tick(): Promise<void>;     // called from the injector's existing 1200 ms interval
    reset(videoId: string): void;
  }
  export const UNAVAILABLE_AFTER_MS = 8000;
  export const MAX_IN_FLIGHT = 2;
  export const BUSY_RETRY_MS = 3000;
  ```

Controller rules: `reset` clears everything and fetches stored windows once for the new video; stored windows count as done and produce sentences without acceptance. With no captions and not accepted, phase is `offer` (or `ready` when stored windows already cover the playhead). After `accept`: phase `preparing` until `coversPlayhead()`; each `tick` sends `nextWindowToSend` while fewer than `MAX_IN_FLIGHT` are in flight. A response for a video id other than the current one is ignored. A `failed` window is marked done-with-no-words so it cannot be chosen forever. A `busy` window is not marked done; it becomes eligible again `BUSY_RETRY_MS` (3000) after the answer, by `deps.now()`. A window file over `MAX_WINDOW_FILE_BYTES` is treated as `failed` without calling `transcribe`. `insufficient_credits` → phase `no_credits`, no further uploads for this video, sentences kept. `not_signed_in` → `signed_out`. Format `unsupported`, or no window ready `UNAVAILABLE_AFTER_MS` after acceptance while the video is playing → `unavailable`. The track key passed to `sentencesFromWindows` is `` `stt|${videoId}` ``; the last window index is known once the bridge reported `videoEndMs`-ready last window.

Injector wiring: in `ensureCaptionsForCurrentVideo`, when the bridge state says `hasCaptions: false`, skip caption loading and drive the controller instead; `shapedSentences` and the overlay's sentence list come from `controller.sentences()`; `GET_SUBTITLES` returns them as `sentences` so the side panel shows the same. Overlay text per phase (English, matching existing overlay copy style): offer — "This video has no captions. Transcribe it? Uses credits." with a "Transcribe" button and the price line when the backend contract later supplies one; preparing — "Preparing subtitles…"; unavailable — "Transcription is not available for this video."; no_credits — "Not enough credits to continue transcribing."; signed_out — the existing sign-in prompt. On `accept` the injector pauses the video once if it is playing and resumes it on the first change to `ready`; if the learner presses play in between, it does not pause again. With `alwaysTranscribeCaptionless` on, `accept()` is called automatically on `reset`.

- [ ] **Step 1: Write the failing tests** (fake deps with scripted states and responses)

```ts
test('nothing is uploaded before the learner accepts', async () => {
  const f = fake({ windows: [0, 1] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await c.tick(); await c.tick();
  assert.equal(c.phase(), 'offer'); assert.equal(f.transcribeCalls.length, 0);
});
test('stored windows show at once without acceptance or upload', async () => {
  const f = fake({ stored: [win(0, 'Hallo Welt.')], windows: [] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled();
  assert.equal(c.phase(), 'ready'); assert.deepEqual(c.sentences().map(s => s.text), ['Hallo Welt.']);
  assert.equal(f.transcribeCalls.length, 0);
});
test('after accepting, the window at the playhead is sent first and at most two are in flight', async () => {
  const f = fake({ windows: [0, 1, 2, 3], playheadMs: 65_000, hold: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await c.tick(); await c.tick();
  assert.deepEqual(f.transcribeCalls.map(r => r.index), [2, 3]);
  assert.equal(c.phase(), 'preparing');
});
test('a stored window is not uploaded again', async () => {
  const f = fake({ stored: [win(0, 'Eins.')], windows: [0, 1] }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); await f.settled(); c.accept(); await c.tick(); await f.settled();
  assert.deepEqual(f.transcribeCalls.map(r => r.index), [1]);
});
test('a late answer for the previous video is ignored', async () => {
  const f = fake({ windows: [0], hold: true }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); c.reset('v2'); f.release(win(0, 'Alt.')); await f.settled();
  assert.deepEqual(c.sentences(), []);
});
test('running out of credits stops uploads and keeps what is shown', async () => {
  const f = fake({ windows: [0, 1, 2], answers: [win(0, 'Eins.'), 'insufficient_credits'] });
  const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 5; i++) { await c.tick(); await f.settled(); }
  assert.equal(c.phase(), 'no_credits'); assert.equal(f.transcribeCalls.length, 2);
  assert.deepEqual(c.sentences().map(s => s.text), ['Eins.']);
});
test('a window with no speech does not keep the overlay preparing', async () => {
  const f = fake({ windows: [0, 1], answers: [win(0, ''), win(1, 'Jetzt.')], lastWindow: 1 });
  const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); for (let i = 0; i < 4; i++) { await c.tick(); await f.settled(); }
  assert.equal(c.phase(), 'ready'); assert.deepEqual(c.sentences().map(s => s.text), ['Jetzt.']);
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
  assert.deepEqual(c.sentences().map(s => s.text), ['Jetzt.']);
});
test('an oversized window file is not uploaded', async () => {
  const f = fake({ windows: [0], fileBytes: MAX_WINDOW_FILE_BYTES + 1 }); const c = new TranscriptionController(f.deps, () => {});
  c.reset('v1'); c.accept(); await c.tick(); await f.settled(); await c.tick();
  assert.equal(f.transcribeCalls.length, 0);
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
```

(The retry-once for `failed` lives in the service worker, Task 4; the controller sees one final answer per window.)

- [ ] **Step 2: Run `npm run test:youtube-transcription`** — expected: FAIL.
- [ ] **Step 3: Implement `TranscriptionController`.**
- [ ] **Step 4: Run it** — expected: 12 pass.
- [ ] **Step 5: Wire the injector, the overlay states and the setting.**
- [ ] **Step 6: Run every `test:*` script, `npm run type-check`, `npm run build`.** Expected: all pass; earlier suites keep their counts (7/14/6/15/2/6/4).
- [ ] **Step 7: Manual test in Chrome** (needs the deployed backend; if it is not deployed, stop after Step 6 and say so in the report): the example video from the start (offer → accept → paused, "Preparing subtitles…" → sentences, video resumes; Q/W/E work); seek to 1:40 (preparing, then sentences); play to the end (last sentence appears); reload the page (sentences at once, no offer, no upload in the Network tab); a captioned video (no offer, captions path as before, `data-gff-audio-state` has no windows); a Netflix title unchanged.
- [ ] **Step 8: Commit** — `Transcribe caption-less YouTube videos ahead of the playhead`.
