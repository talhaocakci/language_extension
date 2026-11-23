import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectTimedtextUrls,
  getTimedtextLanguage,
  parsePlayerTrackState,
  pickTimedtextUrl,
  playerTrackKey
} from '../src/utils/youtube-timedtext';

const base = 'https://www.youtube.com/api/timedtext';
const original = `${base}?v=abc&lang=de&fmt=json3&pot=TOKEN`;
const translated = `${base}?v=abc&lang=de&fmt=json3&pot=TOKEN&tlang=tr`;
const asr = `${base}?v=abc&lang=de&kind=asr&fmt=json3&pot=TOKEN`;
const otherVideo = `${base}?v=zzz&lang=en&fmt=json3&pot=TOKEN`;
const unsigned = `${base}?v=abc&lang=de`;

test('a later translated request does not replace the original-language track', () => {
  assert.equal(pickTimedtextUrl([translated, original, translated], 'abc'), original);
});

test('requests for another video are ignored', () => {
  assert.equal(pickTimedtextUrl([otherVideo], 'abc'), null);
  assert.equal(pickTimedtextUrl([otherVideo, original], 'abc'), original);
});

test('URLs without a player token are ignored because YouTube answers them with an empty body', () => {
  assert.equal(pickTimedtextUrl([unsigned], 'abc'), null);
});

test('a human-written track wins over the auto-generated one', () => {
  assert.equal(pickTimedtextUrl([asr, original, asr], 'abc'), original);
  assert.equal(pickTimedtextUrl([asr], 'abc'), asr);
});

test('a translated track is used only when nothing else was requested', () => {
  assert.equal(pickTimedtextUrl([translated], 'abc'), translated);
});

test('the most recent matching request wins', () => {
  const newer = `${original}&expire=2`;
  assert.equal(pickTimedtextUrl([original, newer], 'abc'), newer);
});

test('the language is the spoken language unless only a translation is available', () => {
  assert.equal(getTimedtextLanguage(original), 'de');
  assert.equal(getTimedtextLanguage(translated), 'tr');
  assert.equal(getTimedtextLanguage('not a url'), '');
});

test('timedtext URLs are collected from mixed resource names', () => {
  assert.deepEqual(
    collectTimedtextUrls(['https://www.youtube.com/watch?v=abc', original, 'https://i.ytimg.com/x.jpg', asr]),
    [original, asr]
  );
});

test('the track shown in the player wins over whatever else was requested', () => {
  const picked = pickTimedtextUrl([original, translated], 'abc', { lang: 'de', kind: '', tlang: 'en' });
  const params = new URL(picked || '').searchParams;
  assert.equal(params.get('lang'), 'de');
  assert.equal(params.get('tlang'), 'en');
  assert.equal(params.get('kind'), null);
  assert.equal(params.get('pot'), 'TOKEN');
});

test('a translated request can be turned back into the track the player shows', () => {
  const picked = pickTimedtextUrl([translated], 'abc', { lang: 'en', kind: 'asr', tlang: '' });
  const params = new URL(picked || '').searchParams;
  assert.equal(params.get('lang'), 'en');
  assert.equal(params.get('kind'), 'asr');
  assert.equal(params.get('tlang'), null);
});

test('a player track cannot be served without a token for that video', () => {
  assert.equal(pickTimedtextUrl([otherVideo, unsigned], 'abc', { lang: 'de', kind: '', tlang: '' }), null);
});

test('player track state round-trips and rejects junk', () => {
  const state = { videoId: 'abc', lang: 'de', kind: 'asr', tlang: 'en' };
  assert.deepEqual(parsePlayerTrackState(JSON.stringify(state)), state);
  assert.equal(parsePlayerTrackState(''), null);
  assert.equal(parsePlayerTrackState('{"videoId":"abc"}'), null);
  assert.equal(parsePlayerTrackState('not json'), null);
  assert.notEqual(
    playerTrackKey(state),
    playerTrackKey({ ...state, tlang: '' })
  );
});
