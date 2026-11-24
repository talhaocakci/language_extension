import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindowFile, clusterTimecodeAt, parseWebmAudio } from '../src/utils/webm-audio';
import { FIXTURE_DURATION_MS, cluster, concat, durationElement, init } from './webm-fixture';

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

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

test('not WebM', () => {
  assert.equal(parseWebmAudio(new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70])), null);
});

test('a window file starts at time zero and leaves the source untouched', () => {
  const s = concat(init(), cluster(0, 10), cluster(30001, 10), cluster(40001, 10));
  const p = parseWebmAudio(s)!;
  const copy = s.slice();
  const file = buildWindowFile(s, p, p.clusters.slice(1));
  assert.deepEqual(parseWebmAudio(file)!.clusters.map(c => c.timecodeMs), [0, 10000]);
  assert.equal(file.length, p.initLength + p.clusters[1].length + p.clusters[2].length);
  assert.deepEqual(s, copy);
});

test('the whole-video Duration is replaced by a Void of the same length in a window file', () => {
  const s = concat(init(), cluster(0, 10), cluster(30001, 10), cluster(40001, 10));
  const copy = s.slice();
  const p = parseWebmAudio(s)!;
  const duration = durationElement(FIXTURE_DURATION_MS);
  const at = indexOf(s, duration);
  assert.ok(at > 0);
  const file = buildWindowFile(s, p, p.clusters.slice(1));
  assert.equal(indexOf(file, duration), -1);
  assert.equal(indexOf(file, new Uint8Array([0x44, 0x89])), -1);
  assert.deepEqual([...file.subarray(at, at + duration.length)], [0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(file.length, p.initLength + p.clusters[1].length + p.clusters[2].length);
  const parsed = parseWebmAudio(file)!;
  assert.equal(parsed.initLength, p.initLength);
  assert.deepEqual(parsed.clusters.map(c => c.timecodeMs), [0, 10000]);
  assert.deepEqual(s, copy);
});

test('an init without a Duration is passed through unchanged', () => {
  const head = init(false);
  const s = concat(head, cluster(0, 10), cluster(10001, 10));
  const p = parseWebmAudio(s)!;
  assert.equal(p.initLength, head.length);
  const file = buildWindowFile(s, p, p.clusters);
  assert.deepEqual([...file.subarray(0, head.length)], [...head]);
  assert.deepEqual(parseWebmAudio(file)!.clusters.map(c => c.timecodeMs), [0, 10001]);
});

test('the timecode of a cluster is read once its header is present', () => {
  const c = cluster(30001, 100);
  assert.equal(clusterTimecodeAt(c.slice(0, 20)), 30001);
  assert.equal(clusterTimecodeAt(c.slice(0, 15)), null); // Timecode value incomplete
  assert.equal(clusterTimecodeAt(new Uint8Array([0x1f, 0x43, 0xb6])), null);
  assert.equal(clusterTimecodeAt(init()), null);
});
