import assert from 'node:assert/strict';
import test from 'node:test';
import { installAudioCapture } from '../src/content/youtube-audio-capture';
import { parseWebmAudio } from '../src/utils/webm-audio';
import { cluster, concat, init } from './webm-fixture';

function setup(options: { breakCapture?: boolean } = {}) {
  const appended: any[] = [];
  const sourceBufferProto = {
    appendBuffer(data: any) { appended.push(data); return undefined; },
    abort() { return undefined; },
  };
  const mediaSourceProto = {
    addSourceBuffer(_mime: string) { return Object.create(sourceBufferProto); },
  };
  const capture = installAudioCapture(mediaSourceProto, sourceBufferProto, options);
  const ms = Object.create(mediaSourceProto);
  return { ms, capture, appended };
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
  const { ms, appended } = setup({ breakCapture: true });
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

test('a disabled capture keeps nothing until it is enabled again', () => {
  const { ms, capture } = setup();
  const audio = ms.addSourceBuffer(OPUS);
  capture.setEnabled(false);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
  assert.deepEqual(capture.windows(), []);
  capture.setEnabled(true);
  audio.appendBuffer(concat(init(), cluster(0, 50), cluster(30001, 50)));
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
