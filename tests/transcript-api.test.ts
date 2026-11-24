import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bytesToBase64,
  parseTranscribeResponse,
  parseWindowsResponse,
  shouldRetryAttempt,
  shouldRetryTranscribe
} from '../src/utils/transcript-api';

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

test('retry only for transient failures', () => {
  assert.equal(shouldRetryTranscribe(500, {}), true);
  assert.equal(shouldRetryTranscribe(502, null), true);
  assert.equal(shouldRetryTranscribe(503, { error: 'charge_failed' }), true);
  assert.equal(shouldRetryTranscribe(503, { error: 'server_busy' }), false);
  assert.equal(shouldRetryTranscribe(503, { error: 'window_busy' }), false);
  for (const s of [200, 400, 401, 402, 413]) assert.equal(shouldRetryTranscribe(s, {}), false);
});

test('a lost response is retried for a complete window only', () => {
  assert.equal(shouldRetryAttempt(false, null, null), true);
  assert.equal(shouldRetryAttempt(true, null, null), false);
});

test('a partial window is retried only when the server certainly did not transcribe it', () => {
  assert.equal(shouldRetryAttempt(true, 502, { error: 'transcription_failed' }), true);
  assert.equal(shouldRetryAttempt(true, 500, { error: 'internal_error' }), false);
  assert.equal(shouldRetryAttempt(true, 503, { error: 'charge_failed' }), false);
  assert.equal(shouldRetryAttempt(true, 502, null), false);
  assert.equal(shouldRetryAttempt(true, 504, {}), false);
  for (const s of [200, 400, 401, 402, 413]) assert.equal(shouldRetryAttempt(true, s, {}), false);
  assert.equal(shouldRetryAttempt(true, 503, { error: 'server_busy' }), false);
});

test('a complete window keeps the transient-failure retry', () => {
  assert.equal(shouldRetryAttempt(false, 500, { error: 'internal_error' }), true);
  assert.equal(shouldRetryAttempt(false, 503, { error: 'charge_failed' }), true);
  assert.equal(shouldRetryAttempt(false, 502, { error: 'transcription_failed' }), true);
  assert.equal(shouldRetryAttempt(false, 503, { error: 'window_busy' }), false);
  for (const s of [200, 400, 401, 402, 413]) assert.equal(shouldRetryAttempt(false, s, {}), false);
});
