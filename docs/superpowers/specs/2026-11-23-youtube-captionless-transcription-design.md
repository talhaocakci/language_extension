# YouTube videos without captions: read-ahead transcription — design

Date: 2026-11-23
Status: awaiting approval
Repos touched: `language_extension` (this repo), `getfluentfast_backend`
Builds on: branch `youtube-sentence-shaping`
(`docs/superpowers/specs/2026-11-23-youtube-sentence-shaping-design.md`)

## Intent

Some YouTube videos have no caption track at all, not even an auto-generated
one. The owner's example is an audiobook chapter
(`https://www.youtube.com/watch?v=UN0x-KXc_XI`, 3 minutes, German): the player
reports no caption tracks and the CC button says captions are unavailable. On
such a video the extension has nothing to show.

For a learner with enough credits, the extension should turn the speech into
text itself, so the learning overlay works on these videos the way it does on
captioned ones. The text must be ready before the learner reaches it in the
video, and our server must not download or process video.

The resulting text is also the input for the later "talk about this video with
Coach" feature. That feature is not part of this design.

## What was observed (2026-11-23, the video above, Chrome)

- The player response has no `captions` block.
- `streamingData` offers audio only through SABR (`serverAbrStreamingUrl`).
  No audio format carries a `url`; the one muxed format carries a
  `signatureCipher`. The player fetches media with `fetch` POSTs to
  `videoplayback`. There is no audio file a browser can simply download.
- Replacing `SourceBuffer.prototype.appendBuffer` in the page world sees every
  piece of media the player hands to the browser. Two buffers received WebM
  clusters (first bytes `1f 43 b6 75`): one video, one audio.
- After 6 seconds of normal playback the player had buffered 36 seconds. After
  a seek, 31 seconds were buffered within 5 seconds.

Spike results, same day, same video (page-world wrappers installed by hand,
video reloaded through the player):

- The audio buffer is `audio/webm; codecs="opus"`. The bytes handed to
  `appendBuffer` are arbitrary slices of one continuous WebM stream, so
  cluster boundaries are found by parsing the concatenated bytes, not per
  append. The stream is a 259-byte init part followed by clusters of exactly
  10 seconds, each with a known size and a timecode in milliseconds
  (0, 10001, 20001, …). `timestampOffset` stayed 0.
- The init part plus clusters 3 to 5 (30 s to 60 s, 369 KB) decoded in the
  browser (`decodeAudioData`) to 29.99 seconds of 48 kHz stereo audio with
  signal in it. A 30-second window is therefore three clusters and a valid
  file on its own.
- The buffer ran ahead of the playhead by 15 s at 5 s into playback, 42 s at
  30 s and 74 s at 60 s, growing steadily.

Still not verified: that a speech-to-text service returns good German text
with word times for such a window, and whether it reports times from the
window's start or from the timecode inside the file. This needs an API key
and is the one remaining spike item.

## Goals

- On a caption-less YouTube video, a signed-in learner who agrees to spend
  credits gets whole sentences in the overlay, timed to the audio, ahead of
  the playhead.
- The learner keeps watching normally: no muting, no jumping around, no
  second player.
- Our server only relays small audio pieces to the speech-to-text service and
  stores the resulting words. It never fetches anything from YouTube.
- A video is transcribed once. Later viewers get the stored words without
  uploading audio and without paying.

## Non-goals

- Videos that have captions of any kind. They stay on the caption paths.
- Netflix and Max.
- Transcribing a whole video before the learner starts watching.
- Recording the tab's audio output (the existing
  `src/experiments/netflix-audio/` experiment). It can only produce text after
  the words were spoken.
- The Coach conversation feature.
- Translating the transcript.

## Anti-goals

- Credits spent without the learner having agreed for that video.
- Credits spent on parts of a video the learner never got near.
- Audio leaving the browser for a video that has captions, or for a learner
  who has not agreed.
- A learner charged for text another learner already paid to produce.
- The player misbehaving on videos where this feature is not in use.

## Approaches

**A. Read ahead (chosen).** Capture the audio the player buffers ahead of the
playhead during normal viewing, send it in windows to speech-to-text, and
build sentences before the playhead arrives. Short wait at the start and after
a seek. Text exists only for the parts the learner watched or nearly reached.

**B. Prepare the whole video first.** Mute the player and drive it through the
video to collect all audio, then let the learner watch. Complete text up
front, but a wait of roughly a sixth of the video's length, a visibly
hijacked player, and credits spent on videos abandoned early.

**C. Record the tab's audio while it plays.** Certain to work, and already
half-built for Netflix, but text arrives 10 to 20 seconds after the words. The
owner ruled this out: subtitles must be ready before watching.

**D. Server downloads the audio.** Complete text quickly, but it is exactly
the server load the owner wants to avoid, and YouTube blocks data-centre
addresses.

The owner chose A.

## Build order

1. **Spike, throwaway.** In the page world on the example video: keep the
   audio init segment and captured pieces, assemble a window, send it to the
   speech-to-text service by hand, and confirm usable German text with word
   times comes back. Establish how each piece's media time is read. Measure
   how far ahead the player buffers over several minutes. The spike passes
   when: the returned text is the spoken German with at most occasional wrong
   words, and carries word times; piece times can be read for the container
   observed on the example video (WebM audio) on every piece; and during
   steady playback the buffer stays at least 20 seconds ahead of the
   playhead. If any of the three fails, stop and return to the owner; do not
   build the rest on a guess. Steps 2 and 3 are planned only after the spike.
2. Backend: endpoint, cache, credit charge (sections 4 to 6).
3. Extension: capture, windows, overlay states (sections 1 to 3 and 7).

## Design

### 1. When the feature applies (extension)

Only when all of these hold: the page is a YouTube watch page; the player
reports no caption tracks for the current video; the learner has the overlay
or side panel in use; the learner is signed in.

The overlay then shows that this video has no captions and offers to
transcribe it, saying that it uses credits. Nothing is captured for upload and
nothing is charged until the learner accepts. Acceptance is per video. A
setting, off by default, lets the learner accept once for all videos.

### 2. Capturing the audio (extension, page world)

`src/content/youtube-player-bridge.ts` already runs in the page world at
`document_start`. It gains a capture part that wraps
`MediaSource.prototype.addSourceBuffer` (to learn which buffer is audio and
its container) and `SourceBuffer.prototype.appendBuffer`.

Rules for the wrappers:

- They always call the original with the original arguments, and a failure
  inside the wrapper never reaches the player.
- They keep the audio init segment for the current video, because it arrives
  before the learner can accept.
- They keep audio pieces only for a video with no caption tracks, within a
  size limit, and drop everything when the video changes.
- Captured bytes stay in the page until the content script asks for a window
  after the learner accepted.

Pieces already buffered before the learner accepted are needed (they are the
opening of the video), which is why a bounded amount is kept before
acceptance. Kept bytes that are never requested are discarded with the video.

### 3. Windows (extension)

The video timeline is divided into fixed windows of 30 seconds, numbered from
zero. A captured piece belongs to the window its start time falls in. A window
is ready to send when a piece belonging to the next window has been captured,
or the video's end has been reached.

For each window, in order of nearness to the playhead:

1. Ask the backend whether the window is stored. On opening a video the
   extension asks once for all stored windows of that video; a video someone
   else already watched in full yields its entire text immediately.
2. If not stored and the learner accepted, upload the window's audio (the init
   segment followed by its pieces).
3. Turn the returned words into sentences with the modules from the sentence
   shaping branch (`TimedWord` list into `sentencesFromTimedWords`).

Sentences are built over the words of all contiguous windows received so far,
so a sentence that crosses a window edge is whole once both windows are in.
The last, unfinished sentence of the newest window is held back until the next
window arrives or the video ends. Sentence ids stay deterministic, so
rebuilding does not disturb a sentence the learner is on.

Only windows near the playhead are requested: those the player has buffered.
The extension never seeks or changes playback speed to obtain audio.

A window is complete when its captured pieces cover it from its start to its
end without a gap. After a seek, or when the learner accepts late, the first
window is usually covered only from somewhere in the middle. Such a partial
window is still uploaded, so text starts where the audio starts, but it is
marked partial: the server transcribes and charges it and does not store it
for others. If the learner accepts late, the part of the video already
dropped from the kept audio simply has no text; the overlay says the text
starts from the current position. The extension does not seek back for it.

The transcript is made in whatever language is spoken. The learner's language
settings do not gate the feature; the per-video offer is where the learner
decides.

### 4. Backend endpoint

Two routes beside `/prod/analyze` and `/prod/explain` in
`backend/services/compact_api/extension_routes.py`, same Cognito
authentication, handlers in `backend/services/extension_llm_api/`:

- `POST /prod/transcripts/windows`: video id and audio format in, all stored
  windows for that video out. No audio, no charge.
- `POST /prod/transcripts/transcribe`: video id, audio format, window number,
  window start time, container type and the audio bytes in. Words out, each
  with text (punctuation and capitalisation included), start and end time on
  the video's timeline. If the window is already stored, the stored words are
  returned and the upload is ignored.

The speech-to-text service must return per-word times and punctuated text.
The backend already uses OpenAI transcription for Coach
(`tier3_realtime/tier3_routes.py`, with `estimate_transcription_cost_usd`) and
holds a Deepgram key. Which service and model to use is settled in the spike
on German quality and on whether word times and punctuation come together;
the choice sits behind an environment setting. The language is detected on
the first window of a video and fixed for the rest.

Limits per request: one window, a maximum byte size and a maximum duration a
little above 30 seconds. The server measures the audio's duration itself and
charges on that, not on what the client claims.

### 5. Cache

One DynamoDB row per window, keyed by video id, audio format and window
number, holding the words, the detected language, service and model, and the
id of the user whose upload produced it. Concurrent uploads of the same window
share one transcription, following the lease pattern in
`shared/word_sense_cache.py`. Cache failures fail open to "not stored".

The audio format is part of the key because window contents differ slightly
between formats (pieces do not start at the same instants). Almost all Chrome
desktop viewers get the same format, so sharing still works in practice.

Audio is not stored. It is held in memory for the transcription call and
dropped.

### 6. Credits

- A learner is charged only for a window their upload caused to be
  transcribed, in proportion to the measured audio duration.
- Stored windows are free to everyone.
- Before the first upload for a video the extension shows the price per
  minute. If credits run out, uploads stop, the overlay says so, and already
  received sentences stay.
- A failed transcription is not charged.
- Charges are whole credits per window, as a new transaction type of its own
  in the ledger, which today only has whole-credit deductions. The balance is
  checked before the service is called and the deduction is made after a
  successful transcription. A learner can therefore overspend by at most the
  windows in flight, which is kept to one or two.
- When two learners upload the same window at once, the second waits on the
  lease and receives the stored words free; only the first is charged.
- The charge goes through the existing ledger
  (`shared/user_financial_client.py`). The price per minute in credits is the
  owner's to set; see "Open for the owner".

### 7. What the learner sees

- No captions, not accepted: a notice with the offer.
- Accepted, first window not back yet: a "preparing subtitles" state. The
  video is paused by the extension until the first sentences arrive, then
  resumed, because the owner wants text ready before watching. If the learner
  presses play themself, the extension does not pause again.
- Normal viewing: sentences as on any captioned video; Q/W/E, explanations
  and saving work unchanged.
- After a seek to a part with no text: the same preparing state.
- Playhead catches up with the text (slow network or service): the overlay
  shows the preparing state for that stretch; the video is not paused again.
- Capture yields nothing within a few seconds of acceptance (YouTube changed
  how it plays media): the overlay says transcription is not available for
  this video. Nothing is charged.

## Risks

- **It depends on player internals.** YouTube can change how it feeds media to
  the browser at any time; the feature then stops working until adapted. The
  failure is visible and harmless (last bullet above).
- **Terms and store policy.** Sending a video's audio to a third-party
  service, and storing text derived from it, is very likely outside what
  YouTube's terms allow, and the Chrome Web Store reviews extensions that
  touch YouTube media. The owner should weigh this before release. The
  privacy policy needs a line about audio being sent for transcription.
- **Shared cache trusts the first uploader.** The server cannot check that
  uploaded audio really belongs to the video id given. A malicious signed-in
  user could store wrong text for a video. Rows record the uploader so abuse
  can be traced and removed. The alternative, a cache per user, removes the
  risk and also removes sharing.
- **Music and noise.** Speech-to-text services invent text over music or
  silence. Windows with no confident speech should produce no sentences;
  how that is detected is left to the builder.

## Decisions and who made them

Owner:
- Speech-to-text is for videos with no captions, for learners with enough
  credits, without loading our server.
- Text must be ready before the learner watches that part.
- Approach A, read ahead.

Assistant's calls, not yet confirmed by the owner:
- Acceptance is asked per video, with a setting to accept always.
- The video is paused until the first sentences arrive.
- Windows are 30 seconds on a fixed grid.
- The cache is shared between users and keyed by video, audio format and
  window; the uploader is recorded.
- Only the learner whose upload caused a transcription pays; stored text is
  free.
- Audio is never stored on the server.
- No fallback to tab recording is built now.
- Partial windows are charged and not shared; a late acceptance leaves the
  already-passed part without text.
- Whole credits per window, deducted after success, balance checked before.
- The spoken language is transcribed whatever the learner's settings are.
- The spike's pass thresholds in "Build order".
- Nothing is built past the spike if the spike fails.

## Open for the owner

- How many whole credits one 30-second window costs. For scale: the
  transcription model the backend uses today costs about 0.006 US dollars per
  minute of audio.
- Whether the terms and store-policy risk is acceptable for a public release,
  or whether this ships first to a limited group.

## Left to the builder

- Reading each captured piece's media time (WebM cluster timecode, or the
  fragment decode time for MP4 audio), and handling both containers or only
  the one observed.
- Passing bytes from the page world to the content script and on to the
  service worker without copying them more than needed.
- The size limit for audio kept before acceptance.
- Service, model and prompt; using the previous window's last words as
  context for the next.
- If the chosen service returns word times without punctuation, aligning its
  punctuated text to its timed words on the server.
- Detecting windows without speech.
- Table name and Terraform, following
  `backend/terraform/compact/word_sense_pages_table.tf`.
- Request size limits, retry policy, and how many windows may be in flight.
- Making the side panel show the same sentences as the overlay for these
  videos.

## Testing

- Unit: window assignment from piece times; "window ready" rule; sentence
  building across a window edge; held-back last sentence; a real captured
  init segment and pieces from the example video as fixtures for the time
  reader.
- Backend: stored window returns without calling the service and without a
  charge; charge uses measured duration; failed transcription is not charged;
  two concurrent uploads of one window cause one transcription and one
  charge; insufficient credits is refused before the service is called.
- Wrapper safety: a wrapper that throws internally still appends to the
  player's buffer.
- Manual, in Chrome with the built extension: the example video from start,
  with a seek, and to the end; a captioned video, confirming nothing is kept
  or uploaded; a second account opening the same video and getting text at
  once without a charge.
