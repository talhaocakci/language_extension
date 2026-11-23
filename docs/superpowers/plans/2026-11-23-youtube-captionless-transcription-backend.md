# YouTube caption-less transcription — backend half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two signed-in routes on the compact API that turn a 30-second audio window of a YouTube video into punctuated, timed words, store them once per video, and charge credits only to the learner whose upload caused a transcription.

**Architecture:** Pure helpers (validation, punctuation alignment) and a DynamoDB-backed window cache with a lease live in `backend/packages/shared/`; an orchestration function takes its transcriber, cache and ledger as arguments so it is tested without AWS or OpenAI; two thin FastAPI routes call it.

**Tech Stack:** Python 3.11 (image) / 3.12 (local venv), FastAPI, boto3 DynamoDB, the existing `shared.openai_client.transcribe_audio`, pytest.

**Spec:** `docs/superpowers/specs/2026-11-23-youtube-captionless-transcription-design.md` (in the `language_extension` repo).

**Repo:** all paths below are in `/Users/talhaocakci/Projects/getfluentfast_backend`. Work on a new branch there; do not push, do not run `terraform apply`, do not deploy.

**Run tests with:** `PYTHONPATH=backend/packages:backend/services .venv-local-api/bin/python -m pytest -q <files>` from the repo root.

## Global Constraints

- Request and response shapes are the "Backend contract" section of `docs/superpowers/plans/2026-11-23-youtube-captionless-transcription-extension.md` (extension repo). Field names are camelCase on the wire exactly as written there.
- Signed-in users only (`parse_user_from_headers`, as `/prod/analyze`). Guests are already refused for `/prod/*` by `restrict_guest_access`; keep it that way.
- The server never fetches anything from YouTube and never stores audio.
- `format` must be exactly `webm-opus`; `videoId` must match `^[A-Za-z0-9_-]{11}$`; `index` is an integer 0 to 2879; `startMs` is an integer with `index*30000 - 100 <= startMs < (index+1)*30000`.
- Raw request body for `/transcribe` at most 2 000 000 bytes, else `413 {"error":"audio_too_large"}`. Decoded audio must be at least 256 bytes and begin with the EBML magic `1A 45 DF A3`, else `400 {"error":"invalid_audio"}`.
- Speech-to-text: `transcribe_audio(..., filename="audio.webm", model=<env VIDEO_TRANSCRIPT_STT_MODEL, default "whisper-1">, transcript_policy="verbatim", raise_on_error=True)`. Only `whisper*` models return word times; any other configured model is a startup-time `ValueError`.
- Price: `usd_to_credits(estimate_transcription_cost_usd(duration_sec, model) * tutor_session_cost_markup())`, the rule `/conversation/snap-transcription` already uses, with `duration_sec` as reported by the service. Minimum 1 credit for a successful transcription.
- Balance is checked before the service is called; the deduction is made after success with `transact_deduct_turn_credits(user, session_id=f"yt-stt-{videoId}", turn_id=<see Task 3>, …)`. A failed transcription is not charged. Stored windows cost nothing.
- A window is stored only when `partial` is false and the reported duration is at most 40 seconds.
- Every cache operation fails open: on a cache error the request proceeds as "not stored" and the result is returned unstored.
- New table `language-prod-video-transcripts` (covered by the runtime role's `language-prod-*` grant).
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

- The service returns punctuated text and bare timed words that do not line up one to one ("z.B." vs "z", "B"; numbers written as digits). The aligner must still return every text token with a plausible time, never drop or reorder text.
- Two learners upload the same window at the same moment: one transcription, one charge.
- A learner with too few credits: refused before any call to the service.
- The service fails or times out: no charge, no stored row, lease released.
- A client lies about `partial` or sends a long file under one window index: it pays for the measured duration and the result is not stored.

---

### Task 1: Request validation and punctuation alignment

**Files:**
- Create: `backend/packages/shared/video_transcripts.py`
- Test: `backend/packages/shared/tests/test_video_transcripts.py`

**Interfaces:**
- Produces:
  ```python
  WINDOW_MS = 30_000
  MAX_STORED_DURATION_SEC = 40.0
  @dataclass(frozen=True)
  class WindowRequest: video_id: str; format: str; index: int; partial: bool; start_ms: int; audio_base64: str
  class TranscriptRequestError(Exception):  # .status: int, .code: str
  def parse_windows_request(body: dict) -> tuple[str, str]            # (video_id, format)
  def parse_window_request(body: dict) -> WindowRequest               # raises TranscriptRequestError(400|413, code)
  def align_words(text: str, timed: list[dict], start_ms: int) -> list[dict]
  ```
  `timed` items are `{"word": str, "start": float, "end": float}` in seconds from the file's start. `align_words` returns `[{"text", "startMs", "endMs"}]`, one per whitespace token of `text`, in order, times shifted by `start_ms`.

Alignment: normalise both sides (NFKC, casefold, strip everything that is not a letter or digit). Walk the text tokens; for each, consume timed words while the concatenation of their normalised forms is a prefix of the token's normalised form; a full match takes the first consumed word's start and the last one's end. A token that matches nothing (digits versus spelled-out numbers, or an empty normalised form) takes the gap between its matched neighbours, split evenly among consecutive unmatched tokens, and does not consume timed words beyond a look-ahead of 3. Times are clamped so they never decrease and `endMs >= startMs`. Empty `text` returns `[]`; empty `timed` with non-empty `text` spreads the tokens evenly over `[start_ms, start_ms + WINDOW_MS)`.

- [ ] **Step 1: Write the failing tests**

```python
def w(word, start, end): return {"word": word, "start": start, "end": end}

def test_punctuation_and_case_come_from_the_text_times_from_the_words():
    out = align_words("Hallo, Welt. Wie geht's?",
                      [w("hallo", 0.0, 0.4), w("welt", 0.5, 0.9), w("wie", 1.2, 1.4), w("geht's", 1.4, 1.9)], 30_000)
    assert [x["text"] for x in out] == ["Hallo,", "Welt.", "Wie", "geht's?"]
    assert (out[0]["startMs"], out[0]["endMs"]) == (30_000, 30_400)
    assert (out[3]["startMs"], out[3]["endMs"]) == (31_400, 31_900)

def test_one_text_token_can_span_several_timed_words():
    out = align_words("Das ist z.B. gut.", [w("das", 0, .2), w("ist", .2, .4), w("z", .5, .6), w("b", .6, .7), w("gut", .8, 1.0)], 0)
    assert [x["text"] for x in out] == ["Das", "ist", "z.B.", "gut."]
    assert (out[2]["startMs"], out[2]["endMs"]) == (500, 700)
    assert out[3]["startMs"] == 800

def test_a_token_the_words_do_not_contain_gets_the_gap_between_its_neighbours():
    out = align_words("Im Jahr 1999 kam er.", [w("im", 0, .2), w("jahr", .2, .5), w("neunzehnhundertneunundneunzig", .6, 2.0), w("kam", 2.1, 2.3), w("er", 2.3, 2.5)], 0)
    assert [x["text"] for x in out] == ["Im", "Jahr", "1999", "kam", "er."]
    assert 500 <= out[2]["startMs"] <= out[2]["endMs"] <= 2100
    assert out[3]["startMs"] == 2100

def test_times_never_run_backwards_and_no_text_is_lost():
    out = align_words("a b c d", [w("a", 1.0, 1.2), w("x", 0.2, 0.3), w("d", 3.0, 3.1)], 0)
    assert [x["text"] for x in out] == ["a", "b", "c", "d"]
    starts = [x["startMs"] for x in out]
    assert starts == sorted(starts) and all(x["endMs"] >= x["startMs"] for x in out)

def test_no_text_no_words_and_text_without_times():
    assert align_words("", [w("a", 0, 1)], 0) == []
    out = align_words("eins zwei drei", [], 60_000)
    assert [x["startMs"] for x in out] == [60_000, 70_000, 80_000]

VALID = {"videoId": "UN0x-KXc_XI", "format": "webm-opus", "index": 3, "partial": True, "startMs": 100_001,
         "audioBase64": base64.b64encode(b"\x1a\x45\xdf\xa3" + b"\0" * 300).decode()}

def test_a_valid_request_parses():
    r = parse_window_request(VALID)
    assert (r.video_id, r.index, r.partial, r.start_ms) == ("UN0x-KXc_XI", 3, True, 100_001)

@pytest.mark.parametrize("change,code", [
    ({"videoId": "../etc"}, "invalid_video_id"), ({"format": "mp4-aac"}, "unsupported_format"),
    ({"index": -1}, "invalid_index"), ({"index": 2880}, "invalid_index"), ({"index": "3"}, "invalid_index"),
    ({"startMs": 89_000}, "invalid_start"), ({"startMs": 120_000}, "invalid_start"),
    ({"partial": "yes"}, "invalid_partial"),
    ({"audioBase64": "!!!"}, "invalid_audio"),
    ({"audioBase64": base64.b64encode(b"ftyp" + b"\0" * 300).decode()}, "invalid_audio"),
    ({"audioBase64": base64.b64encode(b"\x1a\x45\xdf\xa3").decode()}, "invalid_audio"),
])
def test_bad_requests_are_refused(change, code):
    with pytest.raises(TranscriptRequestError) as e: parse_window_request({**VALID, **change})
    assert (e.value.status, e.value.code) == (400, code)

def test_windows_request():
    assert parse_windows_request({"videoId": "UN0x-KXc_XI", "format": "webm-opus"}) == ("UN0x-KXc_XI", "webm-opus")
    with pytest.raises(TranscriptRequestError): parse_windows_request({"videoId": "x", "format": "webm-opus"})
```

- [ ] **Step 2: Run the test file** — expected: FAIL, module not found.
- [ ] **Step 3: Implement the module.**
- [ ] **Step 4: Run it** — expected: all pass.
- [ ] **Step 5: Commit** — `Validate transcript window requests and align punctuation to timed words`.

### Task 2: Window cache with lease, and its table

**Files:**
- Create: `backend/packages/shared/video_transcript_cache.py`
- Modify: `backend/packages/shared/table_names.py` (add `VIDEO_TRANSCRIPTS_TABLE = os.environ.get("VIDEO_TRANSCRIPTS_TABLE") or f"language-{ENVIRONMENT}-video-transcripts"`, beside `WORD_SENSE_PAGES_TABLE`)
- Create: `backend/terraform/compact/video_transcripts_table.tf`
- Test: `backend/packages/shared/tests/test_video_transcript_cache.py`

**Interfaces:**
- Produces:
  ```python
  LEASE_SECONDS = 90; WAIT_SECONDS = 25; POLL_SECONDS = 1
  class MemoryVideoTranscriptStore: ...            # for tests
  class DynamoVideoTranscriptStore:                # __init__(self, table)
  class VideoTranscriptCache:
      def __init__(self, store, *, clock=time.time, sleep=time.sleep, wait_seconds: int = WAIT_SECONDS)
      def windows(self, video_id: str, fmt: str) -> list[dict]          # [{"index","language","words"}], by index; [] on error
      def get(self, video_id: str, fmt: str, index: int) -> dict | None
      def put(self, video_id: str, fmt: str, index: int, *, words: list[dict], language: str, model: str, uploader: str, duration_sec: float) -> None
      def acquire(self, video_id: str, fmt: str, index: int, owner: str) -> bool   # True on cache error
      def release(self, video_id: str, fmt: str, index: int, owner: str) -> None
      def wait(self, video_id: str, fmt: str, index: int) -> dict | None           # polls get() up to wait_seconds
  def default_cache() -> VideoTranscriptCache | None   # process singleton on VIDEO_TRANSCRIPTS_TABLE; None if it cannot be built
  ```

Table: hash key `video_key` (S) = `f"{video_id}#{fmt}"`, range key `row` (S) = `f"window#{index:04d}"` or `f"lease#{index:04d}"`; TTL attribute `expires_at`, set only on lease rows; `PAY_PER_REQUEST`, deletion protection, point-in-time recovery and encryption on; tags `Owner = "content"`, `DataClass = "generated-cache"`. Copy the shape of `backend/terraform/compact/word_sense_pages_table.tf`. `windows()` is one `Query` on the hash key with `begins_with(row, "window#")`, following pagination. Lease acquire/release use the same conditional expressions as `DynamoWordSenseStore.acquire/release` (`backend/packages/shared/word_sense_cache.py` L199–219). Words are stored as a JSON string attribute. Follow that module's fail-open and logging pattern (`logger.warning("video_transcript_cache_<op>_failed", exc_info=True)`).

- [ ] **Step 1: Write the failing tests** (against `MemoryVideoTranscriptStore`, plus one store that raises on every call)

```python
WORDS = [{"text": "Hallo.", "startMs": 0, "endMs": 400}]
def cache(store=None, **kw): return VideoTranscriptCache(store or MemoryVideoTranscriptStore(), **kw)

def test_stored_windows_come_back_in_order_for_their_video_and_format_only():
    c = cache()
    c.put("vidAAAAAAAA", "webm-opus", 2, words=WORDS, language="de", model="whisper-1", uploader="u1", duration_sec=30.0)
    c.put("vidAAAAAAAA", "webm-opus", 0, words=WORDS, language="de", model="whisper-1", uploader="u1", duration_sec=30.0)
    c.put("vidBBBBBBBB", "webm-opus", 1, words=WORDS, language="de", model="whisper-1", uploader="u1", duration_sec=30.0)
    assert [x["index"] for x in c.windows("vidAAAAAAAA", "webm-opus")] == [0, 2]
    assert c.windows("vidAAAAAAAA", "webm-opus")[0] == {"index": 0, "language": "de", "words": WORDS}
    assert c.get("vidAAAAAAAA", "webm-opus", 1) is None

def test_a_lease_is_not_listed_as_a_window():
    c = cache(); assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "a")
    assert c.windows("vidAAAAAAAA", "webm-opus") == []

def test_only_one_owner_holds_a_lease_until_it_is_released_or_expires():
    now = [1000.0]; c = cache(clock=lambda: now[0])
    assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "a") is True
    assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "b") is False
    assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "a") is True
    c.release("vidAAAAAAAA", "webm-opus", 0, "b"); assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "b") is False
    c.release("vidAAAAAAAA", "webm-opus", 0, "a"); assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "b") is True
    now[0] += LEASE_SECONDS + 1; assert c.acquire("vidAAAAAAAA", "webm-opus", 0, "c") is True

def test_waiting_returns_the_window_once_the_other_request_stored_it():
    store = MemoryVideoTranscriptStore(); polls = []
    def sleep(_): 
        polls.append(1)
        if len(polls) == 2: cache(store).put("vidAAAAAAAA", "webm-opus", 0, words=WORDS, language="de", model="m", uploader="u", duration_sec=30.0)
    now = [0.0]
    c = cache(store, clock=lambda: now[0], sleep=lambda s: (sleep(s), now.__setitem__(0, now[0] + s)))
    assert c.wait("vidAAAAAAAA", "webm-opus", 0)["words"] == WORDS and len(polls) == 2

def test_waiting_gives_up():
    now = [0.0]; c = cache(clock=lambda: now[0], sleep=lambda s: now.__setitem__(0, now[0] + s), wait_seconds=3)
    assert c.wait("vidAAAAAAAA", "webm-opus", 0) is None

def test_a_broken_store_never_raises():
    c = cache(BrokenStore())
    assert c.windows("v", "f") == [] and c.get("v", "f", 0) is None and c.acquire("v", "f", 0, "a") is True
    c.put("v", "f", 0, words=WORDS, language="de", model="m", uploader="u", duration_sec=1.0); c.release("v", "f", 0, "a")
```

- [ ] **Step 2: Run the test file** — expected: FAIL.
- [ ] **Step 3: Implement both stores, the cache, `default_cache`, the table name and the Terraform file.**
- [ ] **Step 4: Run it** — expected: 6 pass. Run `backend/packages/shared/tests/test_word_sense_cache.py` — expected: unchanged, all pass. `terraform fmt -check backend/terraform/compact/video_transcripts_table.tf` if `terraform` is installed; otherwise say so in the report.
- [ ] **Step 5: Commit** — `Add a shared cache for video transcript windows`.

### Task 3: Transcribe-or-serve with credits

**Files:**
- Create: `backend/services/extension_llm_api/transcripts.py`
- Test: `backend/services/extension_llm_api/tests/test_transcripts.py` (create the `tests` package)

**Interfaces:**
- Consumes: `WindowRequest`, `align_words`, `MAX_STORED_DURATION_SEC`; `VideoTranscriptCache`; `shared.openai_client.transcribe_audio`; `shared.openai_pricing.estimate_transcription_cost_usd`, `usd_to_credits`; `tutor_session_cost_markup` (import it from where `tier3_routes.py` imports it); `shared.user_financial_client.get_balance`, `transact_deduct_turn_credits`.
- Produces:
  ```python
  @dataclass(frozen=True)
  class Transcription: text: str; words: list[dict]; duration_sec: float; language: str
  Transcriber = Callable[[str, Optional[str]], Transcription]          # (audio_base64, language) -> result; raises on failure
  class Ledger(Protocol):
      def balance(self, user_id: str) -> int: ...
      def charge(self, user_id: str, *, video_id: str, charge_id: str, credits: int, metadata: dict) -> tuple[bool, str | None]: ...
  def stt_model() -> str                                               # env VIDEO_TRANSCRIPT_STT_MODEL, default "whisper-1"; ValueError unless it starts with "whisper"
  def price_credits(duration_sec: float, model: str) -> int
  def default_transcriber(audio_base64: str, language: str | None) -> Transcription
  class DefaultLedger: ...                                             # wraps get_balance / transact_deduct_turn_credits
  def list_windows(video_id: str, fmt: str, *, cache) -> dict          # {"windows": [...]}
  def transcribe_window(user_id: str, req: WindowRequest, *, cache, transcriber: Transcriber, ledger: Ledger, model: str) -> tuple[int, dict]
  ```

`transcribe_window` order, returning `(status, body)`:
1. `cache.get` → `200 {index, language, words, cached: True, creditsCharged: 0}` (also for a `partial` request whose full window is stored).
2. `ledger.balance(user) < price_credits(30, model)` → `402 {"error": "insufficient_credits"}`.
3. Not partial: `cache.acquire(..., owner=<uuid4>)`; if refused, `cache.wait` → hit: as step 1; miss: `503 {"error": "window_busy"}`.
4. Language hint: the `language` of any stored window of this video (`cache.windows`), else `None`.
5. `transcriber(req.audio_base64, language)`; on any exception → release the lease, `502 {"error": "transcription_failed"}`, no charge.
6. `words = align_words(result.text, result.words, req.start_ms)`.
7. `credits = max(1, price_credits(result.duration_sec, model))`; `ledger.charge(user, video_id=…, charge_id=…, credits=…, metadata={"operation": "video_transcription", "model", "duration_sec", "index", "partial"})`. `charge_id` is `f"{fmt}-{index}"` for a full window and `f"{fmt}-{index}-p{start_ms}"` for a partial one. Charge refused → release the lease, `402`, nothing stored, words not returned.
8. Store when `not req.partial and result.duration_sec <= MAX_STORED_DURATION_SEC`; release the lease.
9. `200 {index, language, words, cached: False, creditsCharged: credits}`.

`default_transcriber` calls `transcribe_audio(audio_base64, "audio.webm", language=language, transcript_policy="verbatim", model=stt_model(), raise_on_error=True)` and builds `Transcription` from its `(text, meta)`: `duration_sec` and `detected_language` from `meta`, timed words from `meta["stt_words"]`. Read `backend/packages/shared/openai_client.py` from L1057 to the end of `transcribe_audio` to see the exact shape of `stt_words` and adapt it to `{"word","start","end"}`; if `stt_words` carries no times, stop and report it (status BLOCKED) rather than inventing them. `DefaultLedger.charge` maps to `transact_deduct_turn_credits(user_id, session_id=f"yt-stt-{video_id}", turn_id=charge_id, credits=credits, summary="Video transcription", metadata=metadata)` and returns `(ok, err)`.

- [ ] **Step 1: Write the failing tests** (fakes: `FakeLedger(balance)` recording charges and optionally refusing; a transcriber returning a fixed `Transcription` and counting calls; `VideoTranscriptCache(MemoryVideoTranscriptStore())`)

```python
T = Transcription(text="Hallo Welt.", words=[{"word": "hallo", "start": 0.0, "end": 0.4}, {"word": "welt", "start": 0.5, "end": 0.9}], duration_sec=30.0, language="de")
def req(index=1, partial=False, start_ms=None): return WindowRequest("UN0x-KXc_XI", "webm-opus", index, partial, index * 30_000 if start_ms is None else start_ms, "AAAA")

def test_first_upload_is_transcribed_charged_and_stored():
    c, led, tr = mem_cache(), FakeLedger(1000), counting(T)
    status, body = transcribe_window("u1", req(), cache=c, transcriber=tr, ledger=led, model="whisper-1")
    assert status == 200 and body["cached"] is False and body["creditsCharged"] == price_credits(30.0, "whisper-1") >= 1
    assert body["words"][0] == {"text": "Hallo", "startMs": 30_000, "endMs": 30_400} and body["language"] == "de"
    assert led.charges == [("u1", "UN0x-KXc_XI", "webm-opus-1", body["creditsCharged"])]
    assert c.get("UN0x-KXc_XI", "webm-opus", 1)["words"] == body["words"]

def test_a_stored_window_is_free_and_does_not_call_the_service_even_with_no_credits():
    c, tr = mem_cache(), counting(T)
    transcribe_window("u1", req(), cache=c, transcriber=tr, ledger=FakeLedger(1000), model="whisper-1")
    led2 = FakeLedger(0)
    status, body = transcribe_window("u2", req(), cache=c, transcriber=tr, ledger=led2, model="whisper-1")
    assert (status, body["cached"], body["creditsCharged"], tr.calls, led2.charges) == (200, True, 0, 1, [])

def test_too_few_credits_is_refused_before_the_service_is_called():
    tr = counting(T)
    status, body = transcribe_window("u1", req(), cache=mem_cache(), transcriber=tr, ledger=FakeLedger(0), model="whisper-1")
    assert (status, body, tr.calls) == (402, {"error": "insufficient_credits"}, 0)

def test_a_failed_transcription_is_not_charged_not_stored_and_frees_the_lease():
    c, led = mem_cache(), FakeLedger(1000)
    status, body = transcribe_window("u1", req(), cache=c, transcriber=raising(), ledger=led, model="whisper-1")
    assert (status, body["error"], led.charges) == (502, "transcription_failed", [])
    assert c.get("UN0x-KXc_XI", "webm-opus", 1) is None and c.acquire("UN0x-KXc_XI", "webm-opus", 1, "other") is True

def test_a_partial_window_is_charged_and_not_stored():
    c, led = mem_cache(), FakeLedger(1000)
    status, body = transcribe_window("u1", req(index=3, partial=True, start_ms=100_001), cache=c, transcriber=counting(T), ledger=led, model="whisper-1")
    assert status == 200 and body["words"][0]["startMs"] == 100_001
    assert led.charges[0][2] == "webm-opus-3-p100001" and c.get("UN0x-KXc_XI", "webm-opus", 3) is None

def test_an_overlong_file_is_charged_for_its_length_and_not_stored():
    c, led = mem_cache(), FakeLedger(100_000)
    long = dataclasses.replace(T, duration_sec=120.0)
    status, body = transcribe_window("u1", req(), cache=c, transcriber=counting(long), ledger=led, model="whisper-1")
    assert status == 200 and body["creditsCharged"] == price_credits(120.0, "whisper-1") and c.get("UN0x-KXc_XI", "webm-opus", 1) is None

def test_a_second_uploader_waits_for_the_first_and_is_not_charged():
    c = mem_cache(sleep_stores=("UN0x-KXc_XI", "webm-opus", 1))   # the cache's sleep stores the window, as the first uploader would
    assert c.acquire("UN0x-KXc_XI", "webm-opus", 1, "first") is True
    led, tr = FakeLedger(1000), counting(T)
    status, body = transcribe_window("u2", req(), cache=c, transcriber=tr, ledger=led, model="whisper-1")
    assert (status, body["cached"], tr.calls, led.charges) == (200, True, 0, [])

def test_a_window_still_busy_after_waiting_is_a_retryable_error():
    c = mem_cache(wait_seconds=0); c.acquire("UN0x-KXc_XI", "webm-opus", 1, "first")
    status, body = transcribe_window("u2", req(), cache=c, transcriber=counting(T), ledger=FakeLedger(1000), model="whisper-1")
    assert (status, body) == (503, {"error": "window_busy"})

def test_a_refused_charge_returns_no_words_and_stores_nothing():
    c = mem_cache()
    status, body = transcribe_window("u1", req(), cache=c, transcriber=counting(T), ledger=FakeLedger(1000, refuse="insufficient_credits"), model="whisper-1")
    assert status == 402 and "words" not in body and c.get("UN0x-KXc_XI", "webm-opus", 1) is None

def test_later_windows_reuse_the_language_found_earlier():
    c, tr = mem_cache(), counting(T)
    transcribe_window("u1", req(index=0), cache=c, transcriber=tr, ledger=FakeLedger(1000), model="whisper-1")
    transcribe_window("u1", req(index=1), cache=c, transcriber=tr, ledger=FakeLedger(1000), model="whisper-1")
    assert tr.languages == [None, "de"]

def test_a_broken_cache_still_transcribes_and_charges_once():
    led, tr = FakeLedger(1000), counting(T)
    status, body = transcribe_window("u1", req(), cache=VideoTranscriptCache(BrokenStore()), transcriber=tr, ledger=led, model="whisper-1")
    assert (status, body["cached"], tr.calls, len(led.charges)) == (200, False, 1, 1)

def test_only_whisper_models_are_accepted(monkeypatch):
    monkeypatch.setenv("VIDEO_TRANSCRIPT_STT_MODEL", "gpt-4o-transcribe")
    with pytest.raises(ValueError): stt_model()

def test_listing(): 
    c = mem_cache(); transcribe_window("u1", req(index=0), cache=c, transcriber=counting(T), ledger=FakeLedger(1000), model="whisper-1")
    assert [x["index"] for x in list_windows("UN0x-KXc_XI", "webm-opus", cache=c)["windows"]] == [0]
```

- [ ] **Step 2: Run the test file** — expected: FAIL.
- [ ] **Step 3: Implement the module.**
- [ ] **Step 4: Run it** — expected: 13 pass.
- [ ] **Step 5: Commit** — `Transcribe video windows once and charge the uploader`.

### Task 4: Routes

**Files:**
- Modify: `backend/services/compact_api/extension_routes.py` (two new route functions; leave `extension_proxy` as it is)
- Modify: `backend/services/compact_api/tests/test_route_coverage.py` (add both paths to the unauthenticated-401 list at L38–41)
- Test: `backend/services/compact_api/tests/test_transcript_routes.py`

**Interfaces:**
- Consumes: `parse_windows_request`, `parse_window_request`, `TranscriptRequestError`; `list_windows`, `transcribe_window`, `default_transcriber`, `DefaultLedger`, `stt_model`; `default_cache`; `parse_user_from_headers`, `cors_headers`.
- Produces: `POST|OPTIONS /prod/transcripts/windows` and `POST|OPTIONS /prod/transcripts/transcribe`, with CORS headers on every response as `extension_proxy` does.

Each route: `OPTIONS` → 200; no user → `401 {"error": "Unauthorized"}`; read `await request.body()`; for `/transcribe`, more than 2 000 000 bytes → `413 {"error": "audio_too_large"}` before parsing; invalid JSON → `400 {"error": "Invalid JSON body"}`; `TranscriptRequestError` → its status and `{"error": code}`; then `await asyncio.to_thread(...)` with `user.sub`. When `default_cache()` is `None`, use a `VideoTranscriptCache` over a store that always misses, so the request still works unstored. Module-level seams `_transcriber`, `_ledger`, `_cache` (functions returning the defaults) let the test replace them.

- [ ] **Step 1: Write the failing tests** (build `FastAPI()` with `extension_routes.router`, `TestClient`; monkeypatch `parse_user_from_headers` in `extension_routes` to return a user with `sub="u1"` or `None`; monkeypatch the three seams with Task 3's fakes)

```python
def test_unauthenticated_calls_are_refused(client_no_user):
    for path in ("/prod/transcripts/windows", "/prod/transcripts/transcribe"):
        assert client_no_user.post(path, json={}).status_code == 401

def test_listing_and_transcribing_round_trip(client):
    body = {"videoId": "UN0x-KXc_XI", "format": "webm-opus", "index": 0, "partial": False, "startMs": 0, "audioBase64": VALID_AUDIO}
    first = client.post("/prod/transcripts/transcribe", json=body)
    assert first.status_code == 200 and first.json()["cached"] is False and first.json()["creditsCharged"] >= 1
    assert client.post("/prod/transcripts/transcribe", json=body).json()["cached"] is True
    listed = client.post("/prod/transcripts/windows", json={"videoId": "UN0x-KXc_XI", "format": "webm-opus"})
    assert [w["index"] for w in listed.json()["windows"]] == [0]

def test_bad_input_statuses(client):
    assert client.post("/prod/transcripts/transcribe", content=b"{").status_code == 400
    assert client.post("/prod/transcripts/transcribe", json={"videoId": "bad"}).json() == {"error": "invalid_video_id"}
    assert client.post("/prod/transcripts/transcribe", content=b'{"audioBase64":"' + b"A" * 2_000_001 + b'"}').status_code == 413

def test_insufficient_credits_is_402(client_no_credits):
    r = client_no_credits.post("/prod/transcripts/transcribe", json=VALID_BODY)
    assert (r.status_code, r.json()) == (402, {"error": "insufficient_credits"})

def test_cors_preflight(client):
    assert client.options("/prod/transcripts/transcribe", headers={"origin": "chrome-extension://abc"}).status_code == 200
```

- [ ] **Step 2: Run the new test file** — expected: FAIL (404s).
- [ ] **Step 3: Implement the routes; extend the coverage list.**
- [ ] **Step 4: Run** the new file (5 pass), `backend/services/compact_api/tests/test_route_coverage.py`, and Tasks 1 to 3's files. Then the build-time smoke check: `AWS_EC2_METADATA_DISABLED=true PYTHONPATH=backend/packages:backend/services .venv-local-api/bin/python -c "import compact_api.main"`.
- [ ] **Step 5: Commit** — `Serve video transcript windows to the extension`.

## Not in this plan (the owner's actions)

- `terraform apply` for the new table and deploying the compact API.
- One real call after deploy with a window captured from `https://www.youtube.com/watch?v=UN0x-KXc_XI`, to see the German text quality and that the returned times start at the window's `startMs`. This is the spike item that was skipped; if the times come back offset by the window's position, the fix is in `default_transcriber` (subtract the first word's file offset), not in the extension.
- A privacy-policy line about audio being sent for transcription.
