# YouTube sentence shaping — design

Date: 2026-11-23
Status: awaiting approval
Repos touched: `language_extension` (this repo), `getfluentfast_backend`

## Intent

On YouTube the learning overlay should show one complete sentence at a time,
with a start and end time that match the audio, whatever kind of captions the
video has. Today auto-generated captions arrive either without punctuation or
cut mid-sentence, and the overlay shows fragments, run-ons, or invented
full stops.

The same cleaned sentences are the input for a later feature: talking about a
watched video with Coach, the way the owner used to discuss a TED talk with a
private tutor. That feature is not part of this design, but this design must
not make it harder.

## What the captions look like today

Observed on 2026-11-23 through the player's own `/api/timedtext?fmt=json3`
responses:

| Kind | Punctuation | Timing | Problem |
| --- | --- | --- | --- |
| Human-written (`kind` absent) | yes | per cue | a sentence can span cues; a cue can hold two sentences |
| New auto-generated (`kind=asr`, segs carry `acAsrConf`) | yes | per cue only, one seg per event, cues overlap | cues are two-line display blocks that break mid-sentence: `"…You know the rules and so do"` / `"I. I feel commitments…"` |
| Classic auto-generated (`kind=asr`, one seg per word with `tOffsetMs`) | none | per word | no sentence boundaries at all |

The classic shape was **not** observed during this investigation (both sampled
videos, German and English, returned the new shape). It is described here from
the owner's report of unpunctuated captions and from the existing code and
tests, which were written against it. The first implementation step is to
capture a real unpunctuated response and confirm its shape; see "Left to the
builder".

Current code: `parseCaptionText` in `src/content/youtube-injector.ts` joins all
segs of an event into one string, discarding `tOffsetMs`.
`groupAndProcessSubtitles` in `src/utils/subtitle-processor.ts` then groups
cues with gap and length heuristics, and for unpunctuated text
(`prettifyAsrGroup`) capitalises and appends full stops by guesswork.

## Goals

- Punctuated captions (human-written and new auto-generated) are re-cut into
  whole sentences in the extension, with no network call and no cost.
- Unpunctuated captions get real punctuation and sentence boundaries from a
  language model, once per video and track, shared by all users.
- The words on screen are exactly the words YouTube supplied. Only
  punctuation and capitalisation may be added.
- Subtitles appear as fast as they do today. Model output improves them when
  it arrives; nothing waits for it.

## Non-goals

- Speech-to-text for videos without captions.
- The "discuss this video with Coach" feature.
- Netflix and Max. Their injector and their use of
  `groupAndProcessSubtitles` stay as they are.
- Correcting misrecognised words in auto-generated captions.

## Anti-goals

- Text that differs from what is spoken because a model rewrote it.
- A blank overlay, or a spinner, while a model runs.
- Model cost that grows with views instead of with distinct videos.
- Charging learner credits for punctuation.

## Approaches considered

**A. Extension heuristics only (today).** No cost, no backend. Cannot find
sentence boundaries when there is no punctuation; the existing 900 lines of
rules are the evidence.

**B. Hybrid (chosen).** Deterministic re-cut when punctuation exists; model
punctuation, cached per video, only when it does not. The model runs only
where rules cannot work, and because words are never changed the timings stay
exact. Cost: two paths to build and test.

**C. Every video through the model.** One path and uniform output, but every
distinct video costs money, and for already punctuated text the gain is small.

The owner chose B.

## Build order

1. Extension only: timed words, path choice and the punctuated path
   (sections 1 to 3). This is useful on its own for every punctuated track.
2. Capture a real unpunctuated auto-caption response from a video the owner
   supplies.
3. Only if step 2 finds one: the unpunctuated path, endpoint, cache and limits
   (sections 4 to 7). If YouTube no longer serves unpunctuated captions, that
   half is not built.

## Design

### 1. Timed words (extension)

A new pure module turns a json3 response into a flat list of
`{ text, startMs, endMs }` words:

- Event with several segs carrying `tOffsetMs`: each seg is a word with its
  real start; its end is the next word's start, or the event end.
- Event with a single seg: split on whitespace and spread the words across the
  event's visible span in proportion to their character length. The visible
  span ends at the earlier of `tStartMs + dDurationMs` and the next event's
  `tStartMs`, because new-style cues overlap.
- Events that only append a newline (`aAppend`) are skipped.
- Non-speech tokens such as `[Music]` are dropped.

Timing accuracy: for the single-seg case a sentence boundary that falls inside
a cue is an estimate and can be off by up to about a second. A boundary that
coincides with a cue edge uses the cue's real time. This is accepted for the
first version; see "Left to the builder" for the check that could remove it.

Languages written without spaces between words (Japanese, Chinese, Thai and
similar) are out of scope for this design and stay on today's heuristic.
Sentence-ending marks include the script-specific ones (`。` `？` `！` `؟`) so
that such tracks are never mistaken for unpunctuated text and sent to the
model.

`parseCaptionText` stops flattening segs for YouTube and hands the events to
this module. The VTT path keeps producing cues and treats each cue as a
single-seg event.

### 2. Choosing the path (extension)

A caption track counts as punctuated when sentence-ending marks (`. ? ! …`)
occur at a plausible density over the whole word list. The exact threshold is
the builder's call, fixed by tests on real fixtures of all three kinds.

### 3. Punctuated path (extension, no network)

Walk the timed words and close a sentence at each sentence-ending mark, with
the guards the current code already has for abbreviations and numbers. A
sentence's start is its first word's start and its end is its last word's end.
A sentence that would be too long to read on screen is split at the best
clause boundary (comma, semicolon, long pause). The output is the existing
`MeaningfulSentence` type so the overlay, the side panel, navigation (Q/W/E)
and saving keep working unchanged.

### 4. Unpunctuated path (extension + backend)

1. Show sentences from today's heuristic at once, exactly as now.
2. Cut the word list into windows of roughly two minutes of speech, placing
   each cut at the longest pause near the target size. Windowing is
   deterministic, so every client produces the same windows for the same
   track.
3. Request punctuation for the window under the playhead first, then forward
   to the end, then backward, a few at a time.
4. When a window returns, rebuild its sentences with the punctuated path
   (section 3) and swap them in. On any failure the heuristic sentences stay.

The sentence the learner is on is never replaced under them: a window's swap
is held back while one of its sentences is on screen with the video paused,
looping, or with an explanation or word popup open, and applied once the
playhead has left that sentence. Sentence ids become deterministic (derived
from track, start time and text) instead of random, so that state keyed by id
survives a rebuild that produces the same sentence.

A viewer who is not signed in stays on the heuristic sentences; no sign-in
prompt is added for this.

### 5. Backend endpoint

`POST /prod/transcripts/punctuate` on `api.getfluentfast.app`, added beside
`/prod/analyze` and `/prod/explain` in
`backend/services/compact_api/extension_routes.py`, with its handler in
`backend/services/extension_llm_api/`. Same Cognito authentication as those
routes.

Request: video id, track (`lang`, `kind`, `tlang`), and the window's words in
order. Response: the same number of tokens in the same order, each the
original word with punctuation and capitalisation applied.

The model is asked to return the window as punctuated text in the track's
language. The server then checks, token by token, that stripping punctuation
and case from the output yields the input words. If not, it retries once and
then answers with an explicit alignment error; it never returns text it could
not align. This check is what enforces "words are never changed".

Model: a small, pinned model behind an environment setting, like the other
workload-specific model settings in the backend.

### 6. Cache

One DynamoDB row per window, keyed by video id, track and a hash of the
window's normalised words, holding the punctuated tokens plus model and prompt
version. Because the key contains the hash of the words that were sent, a
client can only ever create the entry for the text it submitted; it cannot
replace what another client will read. Concurrent requests for the same window
share one model call, following the lease pattern in
`shared/word_sense_cache.py`. Every cache operation fails open.

### 7. Cost and abuse limits

- No learner credits are charged.
- Signed-in users only.
- A cap on words per request and a per-user daily cap on *uncached* windows.
  Cached windows are free and unlimited. Exact numbers are the builder's
  call; the daily cap should allow several hours of new video per day.

## Decisions and who made them

Owner:
- Hybrid approach B.
- Speech-to-text is a separate, later, credit-gated feature for videos with no
  captions.
- The overlay follows the caption track selected in the player, including
  auto-translation (already implemented in the working tree).

Assistant's calls, not yet confirmed by the owner beyond "go with B":
- Punctuation is free, signed-in only, with per-user daily caps.
- Heuristic sentences first, model sentences swapped in per window.
- Model returns text and the server verifies alignment, rather than the model
  returning boundary indexes.
- Cache key includes a hash of the submitted words.
- The punctuated path replaces the heuristic for YouTube only.
- Auto-translated tracks go through the same two paths as any other track.
- The backend half is built only after a real unpunctuated track is captured.
- Estimated in-cue sentence times (up to about a second off) are acceptable.
- Languages without spaces stay on today's heuristic.
- The sentence in use is not swapped; sentence ids become deterministic.

## Left to the builder

- When the unpunctuated capture is made (build order step 2), confirm the
  classic shape above. If it has no per-word offsets, section 1's proportional
  spread applies to it too and nothing else changes.
- Check whether another caption format (`fmt=srv3`, `fmt=vtt`) carries
  per-word times for new-style auto-generated tracks. If one does, use it and
  the timing estimate in section 1 goes away.
- The per-user daily cap needs a counter; the existing extension routes have
  none. Where it is stored is the builder's call.
- The punctuated/unpunctuated threshold, the maximum on-screen sentence
  length, window size, request concurrency, and the cap numbers.
- How `subPortions` is filled for rebuilt sentences so that
  `computeActiveWordIndex` keeps working.
- Prompt wording and the choice of model.
- Table name and Terraform, following
  `backend/terraform/compact/word_sense_pages_table.tf`.
- Making the side panel (`src/panel/index.tsx`), which today regroups raw cues
  itself, show the same sentences as the overlay.

## Testing

- Unit tests with trimmed real json3 fixtures for each of the three caption
  kinds: timed-word extraction, path choice, sentence re-cut, windowing.
- The mid-sentence cue break above (`"…and so do"` / `"I. I feel…"`) as a
  named regression case.
- Backend: alignment check accepts punctuation and case changes and rejects
  any added, dropped or altered word; cache hit performs no model call.
- Manual: one video of each kind in Chrome, checking that sentence start and
  end match the audio when stepping with Q/W/E.
