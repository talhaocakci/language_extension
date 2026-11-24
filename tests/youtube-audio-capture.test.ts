import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_KEPT_BYTES, decideAudioSync, installAudioCapture, isLiveVideo } from '../src/content/youtube-audio-capture';
import type { AudioCaptureOptions } from '../src/content/youtube-audio-capture';
import { parseWebmAudio } from '../src/utils/webm-audio';
import { cluster, concat, init } from './webm-fixture';

function setup(options: AudioCaptureOptions = {}) {
  const appended: any[] = [];
  const calls = { add: [] as any[][], abort: 0 };
  const behaviour = { throwOnAppend: null as Error | null };
  const sourceBufferProto: any = {
    appendBuffer(data: any) {
      appended.push(data);
      if (behaviour.throwOnAppend) {
        const error = behaviour.throwOnAppend;
        behaviour.throwOnAppend = null;
        throw error;
      }
      return undefined;
    },
    abort() { calls.abort++; return 'aborted'; },
    changeType(_mime: string) { return undefined; },
  };
  const mediaSourceProto: any = {
    addSourceBuffer(...args: any[]) { calls.add.push(args); return Object.create(sourceBufferProto); },
  };
  const capture = installAudioCapture(mediaSourceProto, sourceBufferProto, options);
  const ms = Object.create(mediaSourceProto);
  return { ms, capture, appended, calls, behaviour, options, sourceBufferProto, mediaSourceProto };
}

const OPUS = 'audio/webm; codecs="opus"';

test('audio bytes are kept and windows become ready', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
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
  const { ms, appended } = setup({ breakCapture: { appendBuffer: true } });
  const audio = ms.addSourceBuffer(OPUS);
  const bytes = new Uint8Array([1, 2, 3]);
  audio.appendBuffer(bytes);
  assert.equal(appended.length, 1);
  assert.equal(appended[0], bytes);
});

test('an abort keeps finished clusters and discards the unfinished one', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 20)));
  audio.abort();
  audio.appendBuffer(concat(cluster(90001, 50), cluster(100001, 50), cluster(110001, 50), cluster(120001, 50)));
  assert.deepEqual(capture.windows().map(w => [w.index, w.partial]), [[0, true], [3, false]]);
});

test('MP4 audio is reported as unsupported and nothing is kept', () => {
  const { ms, capture } = setup();
  ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"').appendBuffer(new Uint8Array(100));
  assert.equal(capture.format(), 'unsupported');
  assert.deepEqual(capture.windows(), []);
});

test('a new audio buffer starts over', () => {
  const { ms, capture } = setup();
  ms.addSourceBuffer(OPUS).appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  ms.addSourceBuffer(OPUS);
  assert.deepEqual(capture.windows(), []);
});

test('old clusters are dropped past the size limit, the init part stays', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(init());
  for (let i = 0; i < 12; i++) audio.appendBuffer(cluster(i * 10000, 1024 * 1024));
  assert.equal(capture.windowFile(0), null);
  assert.ok(capture.windows().length > 0);
  assert.equal(parseWebmAudio(capture.windowFile(capture.windows()[0].index)!)!.initLength, init().length);
});

test('typed array views are copied exactly and the original argument is passed on', () => {
  const { ms, capture, appended } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  const stream = concat(init(), cluster(0, 50), cluster(10001, 50), cluster(30001, 50));
  const backing = new Uint8Array(stream.length + 10);
  backing.set(stream, 5);
  const view = new Uint8Array(backing.buffer, 5, stream.length);
  audio.appendBuffer(view);
  assert.equal(appended[0], view);
  backing.fill(0);
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10001]);
});

test('a new audio buffer keeps again after a captioned video, even if the init arrives at once', () => {
  const { ms, capture } = setup();
  capture.setEnabled(false);
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(init());
  audio.appendBuffer(concat(cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows().map(w => w.index), [0]);
});

test('while disabled nothing is kept, and the init is not needed again after enabling', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(init());
  capture.setEnabled(false);
  audio.appendBuffer(concat(cluster(0, 50), cluster(10001, 50)));
  assert.deepEqual(capture.windows(), []);
  capture.setEnabled(true);
  audio.appendBuffer(concat(cluster(60001, 50), cluster(70001, 50), cluster(90001, 50), cluster(100001, 50)));
  assert.deepEqual(capture.windows().map(w => w.index), [2]);
  assert.deepEqual(parseWebmAudio(capture.windowFile(2)!)!.clusters.map(c => c.timecodeMs), [0, 10000]);
});

test('reset keeps the init part but drops clusters', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  capture.reset();
  assert.deepEqual(capture.windows(), []);
  audio.appendBuffer(concat(cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows().map(w => w.index), [0]);
});

test('a re-sent init part replaces the kept one and drops the unfinished cluster', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 20)));
  audio.appendBuffer(concat(init(), cluster(60001, 50), cluster(70001, 50), cluster(90001, 50)));
  assert.deepEqual(capture.windows().map(w => w.index), [0, 2]);
});

test('addSourceBuffer and abort return what the original returned', () => {
  const mediaSourceProto = { addSourceBuffer() { return 'buffer'; } };
  const sourceBufferProto = { appendBuffer() { return 7; }, abort() { return 'aborted'; } };
  installAudioCapture(mediaSourceProto, sourceBufferProto);
  assert.equal(mediaSourceProto.addSourceBuffer(), 'buffer');
  assert.equal(sourceBufferProto.appendBuffer(), 7);
  assert.equal(sourceBufferProto.abort(), 'aborted');
});

test('when the original append throws, nothing is kept and a retried chunk is not duplicated', () => {
  const { ms, capture, behaviour } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 30)));
  const rest = concat(cluster(10001, 50).slice(30), cluster(20001, 50), cluster(30001, 50));
  const error = new Error('QuotaExceededError');
  behaviour.throwOnAppend = error;
  assert.throws(() => audio.appendBuffer(rest), (e: unknown) => e === error);
  audio.appendBuffer(rest);
  audio.appendBuffer(concat(cluster(40001, 50), cluster(60001, 50)));
  const w0 = capture.windows().find(w => w.index === 0)!;
  assert.ok(w0);
  const times = parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs);
  assert.equal(new Set(times).size, times.length);
});

test('junk before a cluster in the pending bytes is skipped', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50)));
  audio.appendBuffer(concat(new Uint8Array([9, 9, 9, 9, 9]), cluster(10001, 50), cluster(30001, 50)));
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10001]);
});

test('a backward seek without abort or init does not glue the half cluster to the next run', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 20)));
  audio.appendBuffer(concat(cluster(0, 50), cluster(10001, 50), cluster(20001, 50), cluster(30001, 50), cluster(40001, 50)));
  const w0 = capture.windows().find(w => w.index === 0)!;
  assert.equal(w0.partial, false);
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10001, 20001]);
});

test('installing twice does not stack wrappers', () => {
  const { sourceBufferProto, mediaSourceProto, capture, appended } = setup();
  assert.equal(installAudioCapture(mediaSourceProto, sourceBufferProto), capture);
  const audio = Object.create(mediaSourceProto).addSourceBuffer(OPUS);
  audio.appendBuffer(new Uint8Array([1]));
  assert.equal(appended.length, 1);
});

test('changeType to another container stops keeping, to webm keeps going', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  audio.changeType('audio/mp4; codecs="mp4a.40.2"');
  assert.equal(capture.format(), 'unsupported');
  assert.deepEqual(capture.windows(), []);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows(), []);
  audio.changeType(OPUS);
  assert.equal(capture.format(), 'webm-opus');
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows().map(w => w.index), [0]);
});

test('a window is listed again after eviction when all its clusters are kept', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(init());
  audio.appendBuffer(cluster(0, 1024 * 1024));
  audio.appendBuffer(concat(cluster(10000, 50), cluster(20000, 50), cluster(30000, 50), cluster(40000, 50)));
  assert.equal(capture.windows()[0].index, 0);
  audio.appendBuffer(cluster(0, MAX_KEPT_BYTES - 1024 * 1024));
  const w0 = capture.windows().find(w => w.index === 0)!;
  assert.equal(w0.partial, false);
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10000, 20000]);
});

test('capture errors in addSourceBuffer and abort do not change the original call', () => {
  const { ms, calls, options } = setup({ breakCapture: { addSourceBuffer: true } });
  const args = [OPUS];
  const buffer = ms.addSourceBuffer(...args);
  assert.equal(calls.add.length, 1);
  assert.equal(calls.add[0][0], OPUS);
  assert.ok(buffer);
  options.breakCapture = { abort: true };
  const audio = ms.addSourceBuffer(OPUS);
  assert.equal(audio.abort(), 'aborted');
  assert.equal(calls.abort, 1);
});

test('generation counts new audio buffers', () => {
  const { ms, capture } = setup();
  assert.equal(capture.generation(), 0);
  ms.addSourceBuffer(OPUS);
  ms.addSourceBuffer('video/webm; codecs="vp09"');
  ms.addSourceBuffer(OPUS);
  assert.equal(capture.generation(), 2);
});

test('while disabled with the init known, appends are not copied unless they start with an init', () => {
  const { ms, capture, appended } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50)));
  capture.setEnabled(false);
  const media = concat(cluster(10001, 50), cluster(20001, 50));
  const realSlice = Uint8Array.prototype.slice;
  let copied = 0;
  Uint8Array.prototype.slice = function (this: Uint8Array, ...a: any[]) { copied++; return realSlice.apply(this, a as any); };
  try {
    audio.appendBuffer(media);
  } finally {
    Uint8Array.prototype.slice = realSlice;
  }
  assert.equal(appended[appended.length - 1], media);
  assert.equal(copied, 0);
  assert.deepEqual(capture.windows(), []);
});

const A = { videoId: 'A', generation: 1 };
const noCaptions = { responseVideoId: 'B', captionTrackCount: 0 };

test('navigation to a new video with a new audio buffer does not reset', () => {
  const d = decideAudioSync(A, { videoId: 'B', generation: 2, ...noCaptions });
  assert.deepEqual(d, { resetCapture: false, setEnabled: true, known: true, hasCaptions: false, live: false });
});

test('navigation to a new video on the same audio buffer resets', () => {
  assert.equal(decideAudioSync(A, { videoId: 'B', generation: 1, ...noCaptions }).resetCapture, true);
});

test('a stale player response for the previous video changes nothing and is not published', () => {
  const d = decideAudioSync(A, { videoId: 'B', generation: 2, responseVideoId: 'A', captionTrackCount: 3 });
  assert.deepEqual(d, { resetCapture: false, setEnabled: null, known: false, hasCaptions: false, live: false });
  assert.equal(decideAudioSync(null, { videoId: 'B', generation: 0, responseVideoId: null, captionTrackCount: 0 }).setEnabled, null);
});

test('a captioned video disables and resets, a captionless one enables', () => {
  const same = { videoId: 'B', generation: 2 };
  const captioned = decideAudioSync(same, { ...same, responseVideoId: 'B', captionTrackCount: 2 });
  assert.deepEqual(captioned, { resetCapture: true, setEnabled: false, known: true, hasCaptions: true, live: false });
  const plain = decideAudioSync(same, { ...same, ...noCaptions });
  assert.deepEqual(plain, { resetCapture: false, setEnabled: true, known: true, hasCaptions: false, live: false });
});

test('a live video disables and resets the capture', () => {
  const same = { videoId: 'B', generation: 2 };
  const d = decideAudioSync(same, { ...same, ...noCaptions, live: true });
  assert.deepEqual(d, { resetCapture: true, setEnabled: false, known: true, hasCaptions: false, live: true });
});

test('isLiveVideo: live now, or live content without a duration', () => {
  assert.equal(isLiveVideo({ isLive: true, lengthSeconds: '0' }), true);
  assert.equal(isLiveVideo({ isLive: true, isLiveContent: true, lengthSeconds: '3600' }), true);
  assert.equal(isLiveVideo({ isLiveContent: true, lengthSeconds: '0' }), true);
  assert.equal(isLiveVideo({ isLiveContent: true }), true);
  assert.equal(isLiveVideo({ isLiveContent: true, lengthSeconds: '5400' }), false); // a finished stream's replay
  assert.equal(isLiveVideo({ isLiveContent: false, lengthSeconds: '0' }), false);
  assert.equal(isLiveVideo({ lengthSeconds: '120' }), false);
  assert.equal(isLiveVideo(null), false);
  assert.equal(isLiveVideo('x'), false);
});

test('a cluster still arriving makes the window before it ready, without being part of it', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50), cluster(20001, 50), cluster(30001, 50).slice(0, 10)));
  assert.equal(capture.pendingClusterMs(), null); // the Timecode is not in yet
  assert.deepEqual(capture.windows(), []);
  audio.appendBuffer(cluster(30001, 50).slice(10, 30));
  assert.equal(capture.pendingClusterMs(), 30001);
  assert.equal(capture.lastClusterMs(), 20001);
  assert.deepEqual(capture.windows().map(w => [w.index, w.partial, w.clusterIndexes]), [[0, false, [0, 1, 2]]]);
  assert.deepEqual(parseWebmAudio(capture.windowFile(0)!)!.clusters.map(c => c.timecodeMs), [0, 10001, 20001]);
  audio.abort();
  assert.equal(capture.pendingClusterMs(), null);
});

test('a cluster arriving after a gap makes the window partial', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50), cluster(20001, 50), cluster(40001, 50).slice(0, 30)));
  assert.deepEqual(capture.windows().map(w => [w.index, w.partial]), [[0, true]]);
});

test('no pending cluster while disabled', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(10001, 50).slice(0, 30)));
  assert.equal(capture.pendingClusterMs(), 10001);
  capture.setEnabled(false);
  assert.equal(capture.pendingClusterMs(), null);
});
