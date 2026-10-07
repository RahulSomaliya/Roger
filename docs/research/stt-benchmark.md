# Speech-to-text benchmark

**Status:** method and tooling built (M3-T10 to T13); the test set (M3-T16) and the bake-off
(M3-T17) are still to run, so there are no results yet · **Owner:** Rahul · **Written:**
2026-10-07

Which vendor transcribes Roger's calls, and the measured reason for it. A standing test set of our
own calls scores every vendor and model the same way, and the vendor is picked by a rule fixed
before any run was scored. This file keeps what lasts after the M3 plan closes: the vendor log, the
results, the rule, the method, the normaliser's rules, the presets, the vendor facts, how to run
the bench, and the exception that lets us keep the test set. The design reasons are in
[the M3 plan](../plans/M3-live-transcript.md).

Only aggregate numbers go in this file, never a line of transcript or a recording: the test set is
our colleagues' calls.

## Vendor log

One vendor serves every meeting at a time: the preset the API's `STT_PROVIDER` names. Each change
gets a row here on the day it is made. A meeting's own record is its `stt_usage` row, which names
the provider (uploaded to Postgres from M3-T19b on), and the API's `api_started` log line names the
preset, provider, model, price and token lifetime it started with.

| Date | Preset (`STT_PROVIDER`) | Provider | Model | Why |
| --- | --- | --- | --- | --- |
| 2026-10-05 | `deepgram` (with `STT_MODEL=nova-3`; presets came with M3-T1) | `deepgram` | `nova-3` | M1's first vendor, in the walking skeleton. Not measured. |
| 2026-10-06 | `assemblyai` | `assemblyai` | `universal-streaming-english` | Owner decision in M1 (merge a3be3ee): AssemblyAI lists Granola as a customer, live text costs $0.15 per stream-hour billed on open time, and the free hours are generous. Deepgram stays as the second adapter for the bake-off. Not measured yet: the bake-off confirms or replaces it by the rule below. |
| 2026-10-07 | `xai` (available, not serving: AssemblyAI still is) | `xai` | `grok-voice-transcribe-2.0` | Added so Rahul can hear Grok and AssemblyAI on the same audio: set `STT_PROVIDER=xai` and `XAI_API_KEY`, restart the API. Not measured, and not a bake-off run until the open points below are settled. |

### xAI (Grok Voice Transcribe 2.0), added 2026-10-07

Read from docs.x.ai on 2026-10-07: the
[speech-to-text page](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text), the
[models and pricing page](https://docs.x.ai/developers/models), the
[client_secrets reference](https://docs.x.ai/developers/rest-api-reference/inference/voice), the
[voice agent page](https://docs.x.ai/developers/model-capabilities/audio/voice-agent) and the
[security FAQ](https://docs.x.ai/developers/faq/security).

| | xAI |
| --- | --- |
| Live socket | `wss://api.x.ai/v1/stt`, settings in the query: `model` (default `grok-voice-transcribe-2.0`), `sample_rate` (16000), `encoding` (`pcm`, `mulaw`, `alaw`, `opus`), `interim_results`, `endpointing` (ms, default 400), `language`, `format` (needs `language`), `diarize`, `keyterm` (repeated, 100 terms of 50 characters), `smart_turn`, `vad_threshold` |
| What Roger sends | `model`, `encoding=pcm`, `sample_rate`, `interim_results=true`, `language`, `format=true`, one `keyterm` per term. No `diarize`: the mic (Me) and the call audio (Them) stay two streams (house rule 6). `endpointing`, `smart_turn` and `vad_threshold` at xAI's defaults. |
| Token from the API | `POST https://api.x.ai/v1/realtime/client_secrets`, `Authorization: Bearer <key>`, body `{"expires_after": {"seconds": 1..3600}}` (default 600). Returns `{value, expires_at}`. |
| How the desktop authenticates | `Authorization: Bearer <client secret>` on the websocket handshake |
| Messages | Server: `transcript.created` (wait for it before audio), `transcript.partial` (`is_final`, `speech_final`, `words`), `transcript.done` (after `audio.done`), `error`. Client: binary audio, `{"type":"Finalize"}` (capital F in the docs) and `{"type":"audio.done"}`. |
| Partial states | `is_final` false: interim. `is_final` true, `speech_final` false: a chunk of about 3 s locked. Both true: the speaker stopped, "complete stitched utterance". Roger saves a line only at the last. |
| Price per stream-hour | $0.20 streaming ($0.10 REST). Diarization and keyterms add nothing. |
| Billing basis | Not documented. Assumed to be open time, silent or not (the conservative reading, the same as AssemblyAI's): a meeting hour costs $0.40. |
| Limits | No session cap, idle timeout, keep-alive message or sessions-per-minute limit is documented, so Roger's own guards (stall close, silence gate, 4-hour stop) are the only net. |
| Training and retention | "By default, all API requests and responses are stored on our servers (encrypted at rest) for 30 days for auditing purposes in the event of suspected abuse or misuse." xAI "never trains on your API inputs or outputs without your explicit permission." Zero data retention (inputs and outputs never persisted to disk) is a team-level enterprise setting, not a request parameter. |

Open points, for the live-key check before Grok is used on a real call:

1. **Auth (the one that can block it).** xAI documents client secrets for the `/v1/realtime`
   voice-agent socket only (browsers pass `xai-client-secret.<value>` as a websocket subprotocol
   there; a server sends the value as a bearer header). Its speech-to-text page names only the API
   key and says to proxy. Whether `/v1/stt` accepts a minted secret in `Authorization: Bearer` is
   unconfirmed. If it refuses (HTTP 401 or 403 at the handshake, shown as "xAI: rejected with HTTP
   401"), the next step is a relay in the API (the vendor key still never leaves it), which this
   change does not build. Try the websocket subprotocol form too before giving up.
2. **Lines.** That `speech_final`'s text repeats the locked chunks, and that an interim after a
   chunk holds only the new words (`XaiLineAssembler`). If not, a line repeats or loses a chunk.
3. **Finish.** That `Finalize` with nothing buffered is harmless, and that `transcript.done` comes
   after the last `speech_final`. The adapter also saves any interim still held at `done`.
4. **Timing.** What `start` and `duration` of a partial span (read here as the utterance's start
   and length, in seconds from the stream's start), and the unit of a word's `start` and `end`
   (read as seconds).
5. **Billing basis.** Open time or audio sent: read a day's usage in the xAI console against the
   `stt_usage` rows, then correct the price note in `stt_vendors.py`.
6. **Retention.** Roger promises it never trains vendors on calls (decision D3). xAI does not train
   without permission, but it keeps requests 30 days; Rahul decides whether that is acceptable, or
   whether to ask for zero data retention on the team, before any real client call goes through it.

To compare: restart the API with `STT_PROVIDER=xai`, then `make bench ARGS="run"` replays the same
items through Grok exactly as it did for the other vendors (the bench builds the adapter from the
desktop's registry), and `score` and `report --summary` read the run like any other.

## Results

No runs yet. The bake-off (M3-T17) runs once the test set exists (M3-T16).

When it has run, paste here the table that `make bench ARGS="report --summary"` prints (one row per
scored run, its own header included, no transcript text). Below it, write:

- the chosen preset and the reason, step by step through the vendor choice rule;
- run E against the winner's run: term recall and term false alarms with and without the list;
- run F (the gate run, read as below): gated time, money saved, first-word misses, the gate reopens
  and their backlog, the added lag, and whether D5's default stays on;
- the real call (close step 4): the `stt latency` line at Stop (word display p95 for mic and system
  outside and inside gate-reopened sessions, and the longest wait), the `stt meter at stop` line,
  and the cost per meeting hour from `GET /v1/stt-usage/summary`;
- the commit of the AssemblyAI wire fixtures (close step 0), and the date of the two vendor flips
  (close step 5).

Then add the vendor log row, even when the choice is the vendor already in use.

## Vendor choice rule

Decision D4 (OD-13), signed by the owner on 2026-10-06, before any run was scored:

1. Gates: p95 word display latency of 2.0 s or less on both streams (the mic gate counts only items
   with a mic stream), no item failed after its 2 retries, and training opt-out confirmed for that
   vendor. The longest wait is reported, not gated: a systematic stall already moves the p95.
2. Of the configurations that pass, pick the lowest pooled WER (Me after the echo filter).
3. If the runner-up is within 1.0 point, pick the one with better term recall. If that also ties
   (within 5 points), pick the lower cost per meeting hour.
4. Write the result and the reason into this file, and add a row to the vendor log.

Run F (the silence gate) is never part of the choice, and the 2.0 s gate above never applies to it.

### Bake-off configurations

Only `STT_PROVIDER` changes between runs (restart the API after each change). Every preset is one
row in `apps/api/src/roger_api/stt_vendors.py`, and every adapter comes from the desktop's registry.

| Run | `STT_PROVIDER` | Model | Why |
| --- | --- | --- | --- |
| A | `deepgram` | `nova-3` | The second adapter; M1's vendor until 2026-10-06 |
| B (if worth it) | `assemblyai-pro` | `universal-3-6-pro` | AssemblyAI's model for meetings at three times C's price. Run only if C misses a gate, or A or D beats C's pooled WER by more than 1.0 point |
| C | `assemblyai` | `universal-streaming-english` | The vendor since 2026-10-06; English only |
| D (with D1) | `soniox` | `stt-rt-v5` | Cheapest, never trains |
| E | the winner | the winner's | `run --no-keyterms`: measures the jargon list |
| F | the winner | the winner's | `run --gate`: measures the silence gate (savings, first-word misses, latency) |

A whole bake-off is about 4 stream hours, under $3 even at a doubled Deepgram price. Delete
`STT_MODEL` from the API's `.env` first: the API refuses to start and names it while it has a value.

### How the gate run is read

Run F replays the winner with each stream going through the app's `SilenceGate`, closing and
reopening the vendor session as `CaptureSession` does, at the desktop's settings (a 30 s hang-over
and a 1 s pre-roll by default) and with a prefetched token, as `run --gate`. The report reads a
gated run's latency against the latest finished run on the same provider, model and keyterms
without the gate (`baselineFor` in `bench/run/report.ts`), and a first-word miss is one of the
first 5 words of a reference line that starts within [reopen item offset - 1 s, + 3 s). The report
columns are below.

- **Latency, split in two.** The same per-word display latency as every run, once for the words
  carried by sessions the gate reopened and once for all the others. The added lag is the reopened
  words' p95 minus the same words' p95 in the winner's run without the gate. Expected: about the
  pre-roll plus the connect time (about 1 to 1.5 s), because the STT core sends that backlog at 1x
  and never catches up (AssemblyAI takes no audio faster than real time and documents no
  tolerance).
- **What it saved.** Gated time and the money that time would have cost at each session's price.
- **What it cost.** First-word misses: reference words lost in the 2 s after a gate reopen. And the
  pooled WER against the winner's run without the gate.
- **The reopens.** Each one with the backlog it carried at its ready signal (pre-roll plus
  connect), recorded in `run.json`.

Decision D5 (OD-27) turns the gate's default off if run F costs more than 1.0 point of pooled WER,
or adds more than 2.0 s of p95 word display latency to the words of reopened sessions. Before
turning it off for the latency, read each reopen's backlog in `run.json`: a slow connect or a
prefetch that failed is a fault to fix, not a reason to drop the gate. Write the numbers and the
outcome under Results and in the M3 exit check log.

## Method

### The test set

Ten items of 2 to 3 minutes, picked where names and numbers come up: three standups, two
one-to-ones, two calls heard on laptop speakers (echo), two with several remote people, one in a
noisy room. About 25 minutes of call, so about 50 minutes of stream audio. Internal Linkt calls
only, each participant's consent on file (see "Keeping the test set" below).

Items are clipped from the app's local audio backup (M2-T15: kept 7 days by default, so clip within
the week). Every vendor hears the same decoded audio, so the comparison is fair, though absolute
WER may sit a little above what the live stream got. The fallback is a Google Meet recording:
Meet mixes everyone on its server, the owner included, so that item has only a system stream,
every reference line is Them, and it is scored on Them alone.

The reference text is fixed by hand with the least effort: run Deepgram and AssemblyAI over the
items, `bench draft` writes each item's lines in time order with the two runs' disagreements in
braces, `{a's words | b's words}`, and the owner plays `listen.wav` (mic left, system right) from
start to end, resolves every brace, fixes the rest, deletes Me lines that only repeat Them on
speaker items, and saves `reference.txt`. A draft from one vendor would lean the reference toward
it; where two agree the text is almost always right. `bench check` refuses a brace left behind.
Expect about 10 minutes to clip and about 90 minutes to fix.

### Replay

Each item's WAV files go through the adapter the token names, built from the desktop's registry, so
the bench measures the exact code the app runs: 100 ms chunks at 1x, both streams of an item at
once, three items in parallel by default. Live accuracy and lag are what a person sees, batch models
differ from live ones, and AssemblyAI closes a session fed faster than real time (3007).

Every attempt at an item asks the local API for `POST /v1/stt/token` just before its streams open,
and both streams share that token, as at Start in the app. The run is labelled with the first
token's provider and model; a later token naming another stops the run with both names (the API was
restarted mid-run). A failed item is retried up to 2 times, with the desktop's reopen backoff, and
every attempt and its error goes into `run.json`. Every session takes a slot from the bench's own
`SttOpenBudget`, set to the desktop's `sttOpensPerMinute` (4 by default, under AssemblyAI's 5 starts
a minute on a free account), with no meeting limit: `--parallel 3` waits for slots instead of
drawing "Too many concurrent sessions".

`run.json` keeps the provider, model, the adapter's query with the token removed, the jargon list
and whether it was sent, the normaliser and echo-filter versions, the start time, and per item every
attempt with its error, its token request and arrival times, its price and each session's open,
ready, close and billed time. Each stream's events are kept with their arrival times in
`runs/<run-id>/<item-id>/{mic,system}.events.jsonl`. `--no-keyterms` opens the streams with no
list, but the list is still scored for term recall.

### Scoring

Scoring reads the stored events every time, so a new normaliser rescores old runs. Only finished
runs are scored.

- **WER** is (substitutions + deletions + insertions) / reference words, on words after the
  normaliser, which runs on each line or final on its own: joined into one string, a turn ending
  "we need twenty" and the next starting "five people" would read as 25.
- **Me** is scored on the mic stream after M2's `EchoFilter` (version 1, the app's own module) has
  run over the item's replayed mic and system finals, with the route from `item.json`: on for
  `speakers` and `unknown`, off for `headphones`, as in the app. That is the text the user sees. On
  laptop speakers the mic carries all of Them's speech, so a vendor that transcribes that echo
  better would score worse on raw Me. Me on the raw mic is a diagnostic column. With
  `score --no-echo-filter`, the items that need the filter leave Me and the pooled number, and the
  report says so.
- **Them** is scored on the system stream. A Meet-recording item counts in Them only, and stays out
  of Me and the mic latency gate.
- **Pooled WER** sums errors and reference words over items (Me after the filter plus Them), so a
  long item weighs more than a short one. Its 95% interval is a bootstrap over whole items (2,000
  resamples, seed 20261006), so a run scored twice reports the same interval. On 10 clips a
  0.5-point gap is noise, which is why the rule's tie step exists.
- **Term recall** is, over the jargon list's terms counted on normalised text: the sum of
  min(reference count, hypothesis count) over the sum of reference counts. **Term false alarms**
  are the sum of max(0, hypothesis count - reference count): they catch "linked" turning into
  "Linkt" once the list biases the vendor. A term that normalises to no words is listed as
  unscorable.
- **Word latency** uses the app's `LatencyMeter`, the one that logs `stt latency` at Stop. Display
  latency of a word: the arrival of the first event of its stream (interim or final) whose end
  reaches the word's end, minus the time the word's last sample was captured (the replay clock).
  Final latency: the arrival of the final that holds the word, on the same base. The longest wait
  is the largest single-word display latency: a word exists only where someone spoke, so it is the
  longest stall while speech was present. Per stream, p50 and p95, from 50 ms buckets up to 10 s.
- **Cost** is the billed open time of every session the run opened, retries included, at the
  `stream.price_per_hour_usd` of the token it opened with, so the bench prices exactly as the app's
  meter does from the API's one price table. Cost per meeting hour comes from each item's last
  attempt over its audio, counting two streams per meeting hour. An unknown price is reported as
  unknown, never as $0. Until the bench prices a `--no-keyterms` stream at
  `price_per_hour_usd_without_keyterms`, run E's cost errs high by the keyterm surcharge.

`score` writes `reports/<run-id>.json` and `.md` under the bench folder. `report --summary` prints
every scored run as one markdown table of ids, counts, rates, times and money: that table is what
goes into this file.

### Canary

`make stt-canary` speaks a fixed four-sentence script with "Linkt" and "Roger" in it through macOS
`say` (16 kHz PCM16), and sends it at 1x, jargon list included, through whichever vendor the local
API serves. A real vendor fails on a WER above 15% or no final within 10 s; with `fake` it checks
only the final and prints "WER not checked (fake provider)". It exits non-zero on failure, so it
catches a dead key, a wrong model name or a rejected jargon list in a minute. Synthetic speech says
nothing about accuracy on our voices; the test set does that.

## Normaliser, version 1

Both sides, the hand-fixed reference and the vendor's text, go through these rules before any word
is compared (`apps/desktop/bench/core/normalise.ts`, in the order applied). Every run stores the
version, and changing any rule bumps it; stored runs are then scored again.

1. Unicode NFKC, then lowercase.
2. Curly quotes become straight.
3. A comma between digit groups goes: `1,000` becomes `1000`.
4. `$5` becomes `5 dollars`, with a scale word kept by its number (`$5 million` becomes
   `5 million dollars`) and the suffixes `k`, `m`, `b` and `bn` read as scale words (`$5M` is
   `5 million dollars` too). A letter or digit straight after the amount means it is none: `$5s`
   loses only its `$`, by rule 8.
5. `%` becomes `percent`.
6. A point between two letters goes, so a dotted abbreviation is one word (`U.S.` is `us`).
7. Hyphens, dashes and slashes become spaces.
8. Other punctuation and symbols become spaces, except apostrophes inside words (`don't`) and
   points inside numbers (`2.5`).
9. The fillers `um uh er ah hmm mm` are removed.
10. `ok` becomes `okay`, `alright` becomes `all right`, and `gonna`, `wanna` and `gotta` become
    `going to`, `want to` and `got to`.
11. Spelled-out numbers become digits: cardinals with `hundred`, the scales `thousand` to
    `trillion` and `and` (`one hundred and five` is `105`; `a hundred` is `100`), decimals after
    `point` (`two point five` is `2.5`), ordinals with their suffix (`twenty first` is `21st`), and
    a year said in two pairs after `nineteen` or `twenty` (`twenty twenty six` is `2026`). A number
    in digits followed by a scale word is multiplied out (`5 million` is `5000000`), so it reads
    the same as the words.

It is Whisper's English normaliser in idea, small enough to own and test rule by rule, with no
Python dependency.

## Presets

`STT_PROVIDER` names a preset: one vendor and one of its models, one row in `STT_PRESETS`
(`apps/api/src/roger_api/stt_vendors.py`). Every configuration is one `.env` line from every other.
The API refuses to start with an unknown preset, a missing key for the preset's vendor, or a
leftover `STT_MODEL`. The token's `provider` is the vendor, never the preset, so the desktop never
sees presets.

| Preset | Provider | Model | $ per stream-hour, no jargon list | With a list | Per meeting hour, with a list |
| --- | --- | --- | --- | --- | --- |
| `assemblyai` | `assemblyai` | `universal-streaming-english` | 0.15 | 0.19 | 0.38 |
| `assemblyai-pro` | `assemblyai` | `universal-3-6-pro` | 0.45 | 0.45 (keyterms included) | 0.90 |
| `deepgram` | `deepgram` | `nova-3` | 0.462 | 0.54 | 1.08 |
| `fake` | `fake` | `fake` | 0 | 0 | 0 |
| `soniox` (D1, M3-T14 and T15) | `soniox` | `stt-rt-v5` | 0.12 | 0.12 (context terms appear included) | 0.24 |
| `xai` (2026-10-07) | `xai` | `grok-voice-transcribe-2.0` | 0.20 | 0.20 (keyterms free) | 0.40 (open time assumed) |

Prices are list prices read on 2026-10-06 (xAI's on 2026-10-07); each carries its source URL in `stt_vendors.py`. A
meeting opens two streams, so a meeting hour costs twice the stream price. Deepgram's is its
regular price ($0.0077 a minute); at the promotional $0.0048 a meeting hour with a list is $0.73.
`STT_PRICE_PER_HOUR_USD` replaces the base price for every preset, a rate without keyterms (the API
adds the surcharge on top), for a negotiated rate or Deepgram's price with training opted out,
which is not published (decision D3: read it in the Deepgram console and set it for run A). The
Soniox row is optional (decision D1) and exists only once M3-T14 and M3-T15 land.

## Vendor facts (read 2026-10-06)

| | Deepgram | AssemblyAI | Soniox (optional) |
| --- | --- | --- | --- |
| Live socket | `wss://api.deepgram.com/v1/listen` | `wss://streaming.assemblyai.com/v3/ws` | `wss://stt-rt.soniox.com/transcribe-websocket` |
| Token from the API | `POST https://api.deepgram.com/v1/auth/grant`, `Authorization: Token <key>`, body `{"ttl_seconds"}`, returns a JWT | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=1..600`, optional `max_session_duration_seconds=60..10800` (default 10800), `Authorization: <key>` with no prefix. Returns `{token, expires_in_seconds}`. Reusable within the window. | `POST https://api.soniox.com/v1/auth/temporary-api-key`, `Authorization: Bearer <key>`, body `{"usage_type": "transcribe_websocket", "expires_in_seconds": 1..3600}`. Returns `{api_key, expires_at}`. |
| How the desktop authenticates | `Authorization: Bearer <jwt>` | `token=<token>` query parameter | `Authorization: Bearer <temporary key>` header |
| Models | `nova-3` | `universal-3-6-pro` (default), `universal-3-5-pro`, `universal-streaming-english`, `universal-streaming-multilingual` | `stt-rt-v5` |
| Language | `language=en` | `language_codes` (a list) on Universal-3.5 and 3.6 Pro only | not sent |
| Jargon | `keyterm=` repeated, with spaces encoded; 500 tokens at most across all terms | `keyterms_prompt` as a JSON array; at most 100 terms of 50 characters each; can change mid-session (`UpdateConfiguration`) | `context.terms` array; the whole context at most 8,000 tokens |
| Audio | linear16 at 16 kHz | `pcm_s16le` at 16 kHz; chunks of 50 to 1000 ms; never faster than real time, with no tolerance documented (the 3007 close reads "Audio Transmission Rate Exceeded: Received <x> sec. audio in <y> sec") | `pcm_s16le`, with `sample_rate` and `num_channels` in the first JSON message; no rate rule documented |
| Interim and final | `is_final` or `from_finalize` | `Turn` partials, then `end_of_turn`. Pro models format every turn; Universal-Streaming with `format_turns` sends the turn raw, then formatted. U3.6 Pro sends an early partial at about 750 ms, partials on silence, and on long turns a partial about once a second. | tokens with `is_final`; non-final tokens are replaced on every response |
| Stop | `Finalize`, then `CloseStream`; the vendor closes the socket | `{"type": "Terminate"}`, answered by `Termination` after the last turn | `{"type": "finalize"}`, then an empty text frame, answered by `finished: true` |
| Errors | `Error` message; HTTP status at the handshake | Close codes: 1008 auth or account, 3005 server, 3007 chunk size or faster than real time, 3008 session over its maximum, 3009 too many sessions. The close-codes page says an `Error` text frame comes first; the API reference lists no such type. | `error_code`, `error_type`, `error_message`, then a close |
| Session limit | none documented | 3 hours by default | 300 minutes |
| Price per stream-hour | $0.288 now ($0.0048 a minute; regular $0.0077, which is $0.462, the price Roger uses so estimates err high) plus $0.078 for keyterms. The price with `mip_opt_out` is not published. | U3.6 Pro $0.45, keyterms included. Universal-Streaming English $0.15 plus $0.04 for keyterms. Billed on session time, not audio time. | $0.12 |
| Training | Audio joins the Model Improvement Program unless each request sends `mip_opt_out=true`. A Deepgram staff reply (discussion #1292, June 2025) says opting out gives up a 50% discount; the pricing page does not say so. | Opt out under Data Controls in the dashboard, free. Streaming keeps no data once opted out. | Never trains on content. |

### Training opt-out, per vendor

Step 1 of the choice rule needs this confirmed for the vendor chosen. Roger promises it never trains vendors on calls
(decision D3).

| Vendor | How | Confirmed |
| --- | --- | --- |
| AssemblyAI | Data Controls in its dashboard, by the owner, before any real audio | Not yet recorded: the owner writes the date here |
| Deepgram | `mip_opt_out=true` on every websocket URL (`DeepgramSpeechToText.ts`, M3-T4a) | In code since M3-T4a; the opted-out price is still to read |
| Soniox | Never trains on content (its security and privacy page) | Nothing to switch; its docs say so |
| xAI | Never trains on API data without explicit permission; requests are kept 30 days for abuse audit (zero data retention is a team-level enterprise setting) | Nothing to switch; Rahul decides on the 30-day retention (see the vendor log) |

Sources: [Deepgram keyterm](https://developers.deepgram.com/docs/keyterm),
[Deepgram pricing](https://deepgram.com/pricing),
[Deepgram Model Improvement Program](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program),
[Deepgram discussion #1292](https://github.com/orgs/deepgram/discussions/1292),
[AssemblyAI streaming token](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token),
[AssemblyAI streaming API](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api),
[AssemblyAI streaming WebSocket spec](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket),
[AssemblyAI prompting and keyterms](https://assemblyai.com/docs/streaming/universal-3-pro/prompting),
[AssemblyAI model selection](https://assemblyai.com/docs/streaming/universal-3-pro),
[AssemblyAI migration to U3.6 Pro](https://www.assemblyai.com/docs/streaming/migration-guides/universal-to-universal-3-5-pro-streaming),
[AssemblyAI close codes](https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures),
[AssemblyAI pricing](https://www.assemblyai.com/pricing),
[AssemblyAI model training opt-out](https://www.assemblyai.com/docs/faq/how-to-opt-out-of-data-sharing-for-our-model-improvement-program),
[Soniox WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api),
[Soniox temporary keys](https://soniox.com/docs/stt/api-reference/auth/create_temporary_api_key),
[Soniox context](https://soniox.com/docs/stt/concepts/context),
[Soniox pricing](https://soniox.com/pricing),
[Soniox security and privacy](https://soniox.com/docs/security-and-privacy),
[xAI speech-to-text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text),
[xAI models and pricing](https://docs.x.ai/developers/models),
[xAI client_secrets](https://docs.x.ai/developers/rest-api-reference/inference/voice),
[xAI voice agent](https://docs.x.ai/developers/model-capabilities/audio/voice-agent),
[xAI security FAQ](https://docs.x.ai/developers/faq/security).

## Running the bench

Every command goes through `make bench ARGS="<command> [options]"` (`make bench` alone lists them),
which builds `apps/desktop/bench/cli.ts` with Vite and runs it in Node 22.13 or later, outside
Electron. It reads the desktop's settings from the repo-root `.env` (only `ROGER_*` keys; the
vendor keys stay with the API). `run` and `canary` need the API running (`make dev-api`) with the
preset to test, and `ROGER_DESKTOP_API_TOKEN` set; `clip` and `canary` need macOS (`afconvert`,
`fdesetup`, `say`).

| Command | What it does |
| --- | --- |
| `clip --meeting <id> --from <mm:ss> --to <mm:ss> --name <id> [--user-data <dir>] [--person <name>:<consent date> ...] [--kind standup\|one-to-one\|group\|other] [--setup headphones\|speakers\|unknown]` | Cuts the same window from both streams of a meeting in the app's backup: `mic.wav`, `system.wav`, `listen.wav` and `item.json`. `--kind` defaults to `other`, `--setup` to `unknown`, which is scored with the echo filter on |
| `run [--items <id>,<id>] [--no-keyterms] [--gate] [--parallel 3]` | Replays every item (or the ones named) at 1x through the vendor the API's token names (`--parallel` 1 to 10) |
| `draft --runs <a>,<b>` | Writes `reference.draft.txt` for each item with neither a `reference.txt` nor a `reference.draft.txt`, braces where the runs disagree |
| `check` | Lists unresolved braces, unknown speakers, empty items and items with no consent; exits non-zero while any is left |
| `score [--run <id>] [--no-echo-filter]` | Scores one run, or every finished run, into `reports/<run-id>.json` and `.md` |
| `report --summary` | Prints the aggregate table of every scored run, for the Results above |
| `forget --person <name>` or `--meeting <id>` | Deletes every item holding that person or clipped from that meeting, and those items' outputs in every run; aggregate reports stay |
| `canary [--save-wire <dir>]` (also `make stt-canary`) | The synthetic jargon clip through the current vendor; non-zero exit on failure |

Things the commands do not say on their own:

- **Where the data lives.** `ROGER_BENCH_DIR` (`.env.example`, Benchmark section), default
  `~/Roger-bench`, an absolute path or `~/...`. A folder inside any git checkout is refused, through
  symlinks and worktrees too. `clip` creates it with mode 0700 and refuses an existing folder that
  others can open, and refuses to write while FileVault is off. That check reads the startup disk
  only (`fdesetup status`), so a `ROGER_BENCH_DIR` on another volume is not covered: keep it on the
  startup disk.
- **Two path rules differ.** A relative `--save-wire` resolves against the folder `make` ran in. A
  relative `clip --user-data` resolves against `apps/desktop` (where pnpm runs the bench), so give
  that one an absolute path. `--user-data` defaults to `~/Library/Application Support/Roger`, the
  folder the installed app and `make dev-desktop` both use today; the app's `roger started` log
  line prints the folder in use. Once M5-T11 lands, a build run from the checkout keeps its data in
  `Roger Dev` beside it instead, and only then does a meeting recorded that way need
  `--user-data`. Quote a path with spaces inside `ARGS`:
  `make bench ARGS="clip ... --user-data '/Users/me/Library/Application Support/Roger Dev'"`.
- **`draft` never rewrites a draft.** An item that has a `reference.draft.txt` may hold the owner's
  fixes in progress, so it is left alone; delete that item's draft to draft it again.
- **Run ids** are the run's start time in UTC, `YYYYMMDD-HHMMSS`, with `-2` and up on a clash.
- **The wire fixtures.** `make stt-canary ARGS="--save-wire <dir>"` writes `<dir>/<model>.jsonl`:
  every text message the vendor sent, in order, one per line as it arrived. With the fake provider
  there is nothing to save. The AssemblyAI ones go under
  `apps/desktop/src/main/stt/assemblyai/fixtures/` (M3 close step 0); synthetic speech only, so
  they are the one bench output that is committed.

### `item.json`

`clip` writes it; `draft` adds the two runs it drafted from. The fields are the M3 plan's snake_case
names plus `schema_version` (the bench reads only version 1) and `draft_runs`:

```json
{
  "schema_version": 1,
  "id": "standup-1006",
  "origin": "backup",
  "meeting_id": "3f0c2a9e-7d41-4b8a-9a55-0c6f1e2d3b4a",
  "window": { "from_ms": 750000, "to_ms": 900000 },
  "recorded_on": "2026-10-06",
  "kind": "standup",
  "setup": "headphones",
  "streams": ["mic", "system"],
  "gaps": [{ "source": "system", "start_ms": 41000, "end_ms": 43500 }],
  "participants": [{ "name": "Ann Example", "consent_on": "2026-10-06" }],
  "draft_runs": []
}
```

`window` is the stretch in meeting time; `gaps` are stretches with no backup audio, filled with
silence, in item time (0 is the window's start). `participants` lists everyone heard, with the date
each agreed to the item's keeping: `check` reports an item with none, and `forget --person` matches
these names.

### A Meet-recording item, by hand

When the backup has no call to clip, make the item yourself:

1. Create `$ROGER_BENCH_DIR/items/<id>/` (up to 64 letters, digits, `.`, `_` and `-`, starting
   with a letter or digit). If the bench folder is new, make it first with `mkdir -m 700`.
2. Convert the recording's audio:
   `afconvert -f WAVE -d LEI16@16000 -c 1 <recording> $ROGER_BENCH_DIR/items/<id>/system.wav`.
3. Write `item.json` as above with `"origin": "meet-recording"`, `"meeting_id": null`,
   `"streams": ["system"]`, a `window` from 0 to the recording's length (or the stretch you cut),
   `"gaps": []`, and every participant with their consent date.
4. There is no `mic.wav` (`run` refuses a Meet-recording item that has one): every reference line
   is `Them`, the item is scored on Them alone, and the report lists it by origin. `draft`, `check`
   and `forget` treat it like any other item.

## Keeping the test set (decision D2)

An explicit exception to the audio policy (C6, and the roadmap's "audio is kept for a short, fixed
time"), signed by the owner on 2026-10-06 with the Phase 2 plans (OD-11). A benchmark is only useful
if it scores the same audio for months, so the owner chose to keep it, knowingly and reversibly:

- Internal Linkt calls only (standups, one-to-ones), never client calls.
- `item.json` records each participant's name and the date they agreed.
- Clips live only in `ROGER_BENCH_DIR`: mode 0700, on a FileVault disk, never in git, and no Drive
  copy in Phase 2 unless the owner chooses one. Only aggregate numbers are committed.
- `bench forget --person <name>` (or `--meeting <id>`) deletes every item and run output that holds
  them. Deleting a meeting's audio in the app never reaches the bench copies; `forget` does.
- The exception is linked from the roadmap's open decision "Policy on keeping audio" before gate
  2's legal view.
