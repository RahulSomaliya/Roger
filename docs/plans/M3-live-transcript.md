# M3. Live transcript

**Phase:** 2 · **Status:** draft · **Owner:** Rahul · **Plan written:** 2026-10-06 · **Closed:** -

## Goal

Live text you can trust while the call runs, and a measured reason for the vendor behind it. Words
show within about 2 seconds under Me and Them. They show grey while they may still change, then the
final line replaces them. Names like Linkt come out spelled right, because every stream carries the
workspace's jargon list. A standing test set of our own calls scores every vendor and model the same
way. The vendor is picked on those numbers, and switching it is one line in the API's `.env`. What
the live text costs is tracked per meeting hour, and a source's session closes while nobody speaks.

## Done when

The exit check from `docs/roadmap.md`, word for word:

- [ ] Done when: the error rate of the chosen vendor is written down, and swapping vendor is one
  config change.

The milestone's other two promises are checked on the same day:

- [ ] Text shows within about 2 seconds, labelled Me and Them. Measured per word: p95 display
  latency of 2.0 s or less for both streams, in the bake-off and in the app log of one real call.
  The longest single-word wait is written down next to it. Words carried by a session the silence
  gate reopened are counted apart: they run about the pre-roll plus the connect time later by
  design (T20, D5), and their p95 is written down beside the gated number.
- [ ] The jargon list works. On the test set, the chosen vendor's term recall is higher with the
  list than without it, and its term false alarms are written down next to it.

M3 has two states, because the test set needs about 10 recorded internal calls that do not exist
yet:

- **Code complete** (possible today): T1 to T13, T18, T19a, T19b and T20 merged (T14 and T15 too
  with D1), and `make check` green on `phase-2`. Everything runs against the fake provider and the
  fixtures.
- **Closed:** T16 and T17 done once enough calls are recorded through M2's backup and fixed by
  hand. Only then is the milestone done.

How the close is run (M3-T17):

0. With a key, run `make bench ARGS="canary --save-wire <dir>"` once with
   `STT_PROVIDER=assemblyai` and, if run B is in the bake-off, once with `assemblyai-pro`. Commit
   the recorded JSON (synthetic voice, nothing private) under
   `apps/desktop/src/main/stt/assemblyai/fixtures/`. `make check` must stay green on it (T5's
   message tests run on these files).
1. Delete `STT_MODEL` from the API `.env` (after T1 the API refuses to start and names it if it is
   left). Rebuild and install the app once with the M3 adapters (`make install-desktop`). From
   then on no desktop rebuild is allowed until step 5.
2. For each configuration in the bake-off table, change only `STT_PROVIDER` in the API `.env`,
   restart the API, and run `make bench ARGS="run"`. Then run the winner once more with
   `--no-keyterms`, and once with `--gate` (T20's silence gate in the replay). `make bench
   ARGS="score"` scores every run.
3. Apply the vendor choice rule below. Write pooled WER, Me WER (after the echo filter), Them WER,
   term recall, term false alarms, word display latency, longest wait and cost per meeting hour
   into `docs/research/stt-benchmark.md` and into the exit check log here, plus what the gate run
   saved and what it cost in WER and latency.
4. Set `STT_PROVIDER=<winner>`. That is the only line that changes. Restart the API and hold a real
   call of at least 10 minutes from the installed Roger.app, with call audio coming through M2's
   Swift helper and the cost guards (the silence gate included) at their defaults. The
   `stt latency` log line at Stop must show a word display p95 of 2000 ms or less for mic and for
   system over the words outside gate-reopened sessions; write the gate-reopened words' p95 next to
   it (expected: about the pre-roll plus the connect time above the other). Record the
   `stt meter at stop` line (connected time, cost, time closed for silence, gate reopens) and
   the call's cost per meeting hour from T19a's summary. Take a screenshot with an interim line and
   both labels on screen.
5. Set `STT_PROVIDER=<runner-up>`, restart the API, press Start: the same installed app now
   transcribes with the other configuration. Set it back. This is the "one config change" proof.

## In scope

M3 starts from what `m1-assemblyai` landed on `phase-2` on 2026-10-06 (merge a3be3ee):
AssemblyAI Universal-Streaming English as the vendor (API issuer, desktop protocol, price per
stream-hour in `/v1/stt/token`), Deepgram as the second adapter, one websocket lifecycle in
`stt/core/` that every vendor runs on, a vendor registry on each side (`stt/registry.ts`,
`stt_vendors.py`), a conformance suite every registered vendor must pass, and the cost guards
(`costGuards.ts`, `SttOpenBudget`, `lifecycle.ts`, the meter and local `stt_usage`). Every task
below extends that code; none re-builds it. A vendor is one protocol file, one issuer, one line in
each registry and one conformance entry (the checklist "Add a speech-to-text vendor" in
`apps/desktop/README.md`).

- Presets on the API registry. `STT_PROVIDER` names a preset: a vendor plus a model, one row each
  in `stt_vendors.py`. Every bake-off configuration is one line from every other. The API refuses
  to start with an unknown preset, a missing key, or the retired `STT_MODEL`.
- Universal-3.6 Pro as an optional bake-off preset (`assemblyai-pro`), run only if it is worth its
  three times higher price (see the bake-off table).
- A jargon list per workspace in Postgres, edited in the app, delivered with every STT token. It is
  sent as Deepgram `keyterm` and AssemblyAI `keyterms_prompt`. A list the vendor rejects never
  stops a call: the capture session reopens that source once without it, through the open budget,
  and says so.
- Deepgram requests opt out of model training (`mip_opt_out=true`).
- Pacing in the shared core: a vendor that declares real-time pacing (AssemblyAI) is never sent
  audio faster than real time, whoever sends it. This closes the cost work's open issue: the reopen
  flush of up to 3 s of held audio is sent at once today and may draw a 3007 close.
- STT usage per meeting uploaded to Postgres, and cost per meeting hour from it (the roadmap's cost
  risk: "Track cost per meeting hour from M3"), built on the local `stt_usage` table and the price
  the API already returns.
- Silence-gated streaming: a source's vendor session closes during long silence and reopens when
  speech returns, with a pre-roll so the first words are kept (the owner's cost ask of
  2026-10-06; M1 named it as the next guard).
- A live transcript component: interims in time order, finals replace them, echo lines hidden by
  M2 are hidden here too, and scrolling follows live until you scroll up. A pure, tested model sits
  behind it.
- Word display latency measured in main (p50 and p95 per stream, plus the longest wait, logged at
  Stop) and in the benchmark, with the same code.
- Benchmark tooling in `apps/desktop/bench`. It exports clips from M2's audio backup, drafts a text
  to fix from two vendors, checks the fixed text, and replays WAV files through the real adapters
  at real time. It scores word error rate with versioned normalisation, a Me/Them breakdown after
  M2's echo filter, term recall, bootstrap intervals and cost per meeting hour. A synthetic-voice
  canary rounds it off. A `forget` command removes a person's items.
- A test set of 10 items from our own calls, fixed by hand. The bake-off. The choice written down.
- Optional, decision D1: Soniox real-time as a third vendor, through the same registries and
  conformance suite.

## Out of scope

- The app shell, sidebar, Home and meeting page layout: M4-S1 to M4-S4b ("SHELL", M4 D6). M3
  ships components for it to mount and builds no shell. The transcript panel the M4 plan asks the
  shell for is M3's `LiveTranscript` (M3-T7). M3-T9 mounts it through its own slot file; the shell
  does not build a second one.
- Audio backup, reconnect and replay, silence warning, echo removal, permission screen, and the
  Swift system-audio helper: M2. The control that shows hidden echo lines is M2-T20's; M3-T7 only
  renders what it asks for.
- Names for the people inside Them, vendor diarization: M9.
- A second, batch pass over the audio backup: M12. It reuses this test set.
- Attendee names from the invite added to one meeting's keyterms: M5 or M9. The token request can
  take a meeting id later.
- A scheduled canary in CI with vendor secrets: M6, once the API is deployed.
- Budget alerts on speech-to-text cost: later. M3 tracks cost per meeting hour (T19a, T19b) and
  writes it down; an alert on top of it is a later task.
- Reconnect, gap records and replay from the backup: M2 (M2-T6, T15, T16), on top of the landed
  reopen.
- Languages other than English, and a per-meeting language choice.

## Design

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| Vendors and where they plug in | AssemblyAI Universal-Streaming English is the vendor (owner decision 2026-10-06, landed with `m1-assemblyai`); Deepgram nova-3 is the second adapter; Soniox the optional third (D1). Each vendor is an `SttProtocol` in `stt/<vendor>/` that `stt/core/SttConnection` runs, one line in `stt/registry.ts`, one entry in `stt/testing/conformanceVendors.ts`, and on the API one `SttTokenIssuer` plus one `STT_VENDORS` entry in `stt_vendors.py`. Anything M3 adds to how vendors connect (keyterms, their rejection, pacing, the wire tap, Soniox's opening message) is a field on `SttProtocol` or `SttStreamSettings` that the core applies, with a conformance case; no adapter opens, times or retries a socket (CLAUDE.md, architecture rule 9) | One adapter class per vendor with its own socket (M1's first shape); Speechmatics, OpenAI realtime | The owner's ask of 2026-10-06: changing provider must be easy, and every open second is billed. The conformance suite fails a registered vendor that leaks a socket on any path, so a new vendor cannot ship without the careful lifecycle. Two MIT clients to learn from: openwhispr `src/helpers/assemblyAiStreaming.js` and anarlog `crates/owhisper-client/src/adapter/assemblyai/live.rs`. |
| Third vendor | Soniox `stt-rt-v5`, as optional tasks T14 and T15 (decision D1): one protocol file, one issuer, a line in each registry and one conformance entry | Stop at two vendors with three configurations | Its docs are the only ones that say it never trains on customer content. It also has the lowest live price ($0.12 per hour). Its replies come as single tokens, not lines, so its adapter is the most work, and it goes last. |
| How the API names the vendor and model | `STT_PROVIDER` names a preset in `stt_vendors.py` (`STT_PRESETS`, beside the landed `STT_VENDORS`): `fake`, `assemblyai` (universal-streaming-english, today's meaning), `assemblyai-pro` (universal-3-6-pro, run B), `deepgram` (nova-3), and `soniox` (stt-rt-v5) with D1. A preset is a vendor (an `STT_VENDORS` key) and a model; another model is another preset row. Its price comes from the vendor's landed price table. The landed optional `STT_MODEL` is retired: a non-blank value refuses startup and names it (blank still counts as unset). The token response's `provider` stays the vendor id (`assemblyai` for both AssemblyAI presets), so the desktop's registry never sees presets. The landed TTL rule stays: `STT_TOKEN_TTL_SECONDS` above the vendor's limit refuses startup, and the default 30 s is under every limit | `STT_PROVIDER` plus the landed `STT_MODEL`; one model setting per vendor (`DEEPGRAM_MODEL`, ...) | With `STT_MODEL`, moving to or from run B takes two lines and a leftover value stops the API (the landed cross-vendor check), so the exit check's flip could fail. With presets every configuration is one line from every other; `test_every_bakeoff_config_differs_from_every_other_by_one_line` checks it. Model settings per vendor would be a second way to pick a model. The presets stay strict because AssemblyAI ignores unknown query parameters and quietly runs another model (openwhispr `assemblyAiStreaming.js:461-475`). |
| Audio format in the token | `stream.encoding` stays the app's own name, `linear16`, for every vendor. Each protocol translates it to the vendor's term (`pcm_s16le` for AssemblyAI, landed; Soniox the same) and refuses any other value. | The API returns each vendor's own term | The desktop's `streamSettingsMismatch` (`main/stt/streamSettings.ts`, checked by `CaptureService` at Start and at every reopen) refuses unless the encoding is `linear16`. A vendor term would fail Start, and passing `linear16` through would send AssemblyAI a value it does not know. One canonical name keeps the check to one rule. |
| AssemblyAI credential | Landed: `AssemblyAiSttTokenIssuer` calls `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=<ttl>&max_session_duration_seconds=10800` with `Authorization: <key>`; the desktop puts the token in the `token` query parameter; one token opens both streams. | Send audio through the API | House rule 3. The docs say the token is not single-use inside its window. The session cap is a token parameter, asked for explicitly so a vendor default can never lengthen a billed session (cost guard G6). |
| When AssemblyAI text is final | Landed for Universal-Streaming with `format_turns=true`: a raw `end_of_turn` is held for its formatted copy of the same `turn_order`, which replaces it and is saved; the held turn is saved as it is when the next turn starts, after 2 s (`formattedTurnWaitMs`), or when the stream ends; a formatted copy after that is ignored; the `turn_order` record lives in the stream, so a reopened session starts fresh. T5 adds the Pro models: a `Turn` with `end_of_turn` is final (formatting is always on). Stop sends `Terminate` after the padded tail and waits for `Termination` (landed); no `ForceEndpoint` | The first `end_of_turn`; wait for the formatted copy only | Taking the first `end_of_turn` stores every line twice (openwhispr `assemblyAiStreaming.js:483-530`). Waiting only for the formatted copy loses the turn if the next partial replaces it first; anarlog (`assemblyai/live.rs:241`) treats `turn_is_formatted \|\| end_of_turn` as final for this reason. The migration guide says to drop `format_turns` and check `end_of_turn` alone on the Pro models. `Termination` already flushes the last turn. |
| AssemblyAI errors | Landed: the close code decides, with the vendor's reason text when it sends one and a meaning per code otherwise (1008, 3005 to 3009); an `Error` text frame's text is added when one comes first; a session-limit refusal adds "wait a minute" advice. | Treat `Error` as the fatal signal | The two doc pages disagree, so the close frame, which both document, is the authority. |
| AssemblyAI stream settings | Landed: `speech_model`, `sample_rate=16000`, `encoding=pcm_s16le`, `format_turns=true` on `universal-streaming-*` only, `inactivity_timeout` from `costGuards.sttVendorIdleTimeoutMs`. T5 adds `keyterms_prompt` (a JSON array) and `language_codes=["en"]` from `STT_LANGUAGE` on `universal-3-*-pro` only. No `speaker_labels` (Me and Them come from the streams; diarization is M9). `run.json` stores each stream's query, token removed, through the core's wire tap. | Mirror every Deepgram parameter; no language hint | Only the parameters the docs list for each model. U3.6 Pro switches between languages by itself; without the hint, accented English can come back partly in another language or script. The migration guide says to pass `language_codes`. Storing the query makes the bake-off repeatable. |
| Audio framing and pacing | Framing is the protocol's: `SttProtocolSession.encodeAudio` regroups PCM, and AssemblyAI's uses the landed `AudioFrameSizer` (every frame 50 to 1000 ms; the tail padded at finish), which T18 moves to `stt/core/` so any protocol can reuse it. Pacing is the core's (T18): a protocol declares `audioPacing: 'realtime' \| 'none'`; for `realtime` (AssemblyAI), `SttConnection` never lets the audio sent run ahead of real time (monotonic, not the wall clock) since the ready signal by more than one frame, queues the rest and sends it as time allows, and `close()` drains that queue before the finish sequence inside the same hard close timeout. Deepgram, Soniox and fake declare `none`. Every caller gets it: Start, the G2 and G3 reopens with their 3 s of held audio, M2-T6's offline reopen, M2-T16's re-run and T20's pre-roll | An `AudioFramer` that each adapter calls (this plan's first draft); pacing in `CaptureSession` | AssemblyAI closes with 3007 on frames under 50 ms or over 1000 ms, or audio faster than real time. Today a reopen sends its held audio at once right after `Begin`, which can draw that close (M1 risk table). In the core no new caller can bypass it. A Node pipe keeps no write boundaries, so M2's helper's writes can arrive split or merged after a stall or a wake (openwhispr `assemblyAiStreaming.js:601-615` hit this); the frame sizer covers that. In normal flow the pacer never waits; it holds only a backlog, and the lag a backlog adds (at most the held audio) lasts until that session closes: T6b's latency meter shows it and the bake-off measures it with the gate on. The pacer never catches up above 1x: AssemblyAI documents no tolerance for audio faster than real time (Vendor facts), so a bounded catch-up rate waits for a vendor that documents one. |
| Reconnect | Landed (G2, G3): a failed or paused source reopens with its next chunk, a fresh token and at most `sttReopenBufferMs` (3 s) of held audio, every open through `SttOpenBudget`; T18 paces that held audio. No vendor gets an inline replay, so `SpeechToText.inlineReplay` (this plan's first draft) is not added: M2-T6 records the rest of the window as a gap and M2-T16 re-runs it from the backup after Stop. | Replay at 1x on the same session; a second short session for the backlog | At 1x behind live audio, a 30 s backlog never drains, so the rest of the call would run about 30 s late. A second session doubles cost and code for a rare event. One rule for every vendor keeps the registry the only place a vendor differs. |
| Jargon list storage | Postgres `vocabulary_terms`, one row per term per workspace. `GET` and `PUT /v1/vocabulary`; `PUT` replaces the whole list. | A desktop setting; a JSON column on `workspaces` | The team shares it from M6, and the permission rules apply (C5). One row per term is easy to audit. A whole-list `PUT` is idempotent and matches how the editor saves. |
| Jargon list delivery | `stream.keyterms` in the `POST /v1/stt/token` response. When the list is not empty, `stream.price_per_hour_usd` includes the vendor's keyterm surcharge (Universal-Streaming English +$0.04 an hour, Deepgram +$0.078; the Pro model includes it), from a surcharge per model beside the landed prices in `stt_vendors.py`. As built (T3), `stream.price_per_hour_usd_without_keyterms` is the same stream's price with no surcharge, for a stream opened with no list (T4b's reopen, the bench's `--no-keyterms`); `STT_PRICE_PER_HOUR_USD` is a rate without keyterms, and the surcharge is added to it | A separate fetch at Start | One request at Start, and a term added mid-week reaches the next Start without a restart (a reopen's fresh token carries it too). The roadmap asked for it here. Without the surcharge the meter would under-count every meeting with a list. |
| Jargon list limits | At most 100 terms, each 1 to 50 characters after trimming, at most 800 characters in all, no control characters. Duplicates that differ only in case are dropped and the first spelling wins. Adapters cut a longer list with a warning instead of failing the call. | Per-vendor limits | The strictest vendor sets the bar. AssemblyAI allows 100 terms of up to 50 characters. Deepgram allows 500 tokens across all keyterms and rejects the whole request beyond that. 800 characters is only an estimate of 500 tokens, so the next row backs it up. |
| A rejected jargon list | If a connect is refused while keyterms are non-empty (Deepgram: HTTP 400 at the handshake; AssemblyAI: a close before `Begin` with any code except 1008 and 3009; a 1006 drop, which has no close frame, is a network error the core never asks the protocol about), the protocol says so (`SttProtocol.keytermsRejected`, T4a for Deepgram, T5 for AssemblyAI) and the core rejects with `SttConnectError.keytermsRejected`, its socket closed; the adapter never retries. `CaptureSession` reopens that source once without keyterms, through `SttOpenBudget` like any open (T4b), keeps the list off that source for the rest of the meeting, logs the term count, and raises a quiet `keyterms_rejected` capture warning, "Jargon list rejected by <vendor>, transcribing without it". If the retry also fails, both reasons are in the error. The vocabulary editor refuses to save when its `GET` failed, so an empty editor never `PUT`s over the real list. | Fail Start with an error that names the list; retry inside the adapter (this plan's first draft) | A meeting with no transcript breaks the product's core promise. A call without the list loses a few names, not the meeting. A retry inside the adapter would open a billed socket that the open budget never saw (house rule 9). |
| Vendor keyterm syntax | Deepgram: one `keyterm=` parameter per term (openwhispr `deepgramStreaming.js:163-168`, anarlog `adapter/deepgram/keywords.rs`). AssemblyAI: `keyterms_prompt=<JSON array>` (anarlog `assemblyai/live.rs:60-63`). Soniox: `context.terms`. | - | Each vendor's docs, linked in the vendor table below. |
| Model training | Every Deepgram URL carries `mip_opt_out=true`. AssemblyAI is opted out in its dashboard by the owner before any real audio is sent. Soniox does not train. T4a merges before any audio goes to Deepgram (bake-off run A, the two-vendor draft). | Vendor defaults | The roadmap promises we never train on calls. Deepgram puts pay-as-you-go audio in its Model Improvement Program unless each request opts out, and today's Deepgram protocol sends no opt-out. The app's own calls, M2's exit check included, go to AssemblyAI since 2026-10-06. |
| Live transcript model | A pure reducer in the renderer. Finals are kept sorted by `start_ms`, then mic before system, then id (the API's order), using insertion rather than a full sort. Each source has one interim, replaced whole on each update. A final of the same source clears it once the final reaches into it. An interim older than that source's last final is dropped. Main never sends a blank interim and says nothing on the transcript channels when a stream fails or Stop is pressed, so the capture status ends interims too: a source's when its stream is not `open`, every one at `stopping` or `idle` (T7, as built). `segmentChanged({segmentId, change, text})` handles M2's `transcript:segment-changed` event: `hidden` hides a line and keeps it in state, `trimmed` replaces its text, `unhidden` shows it again. A change for an id not yet seen is held until the line comes. A `showHidden` prop shows hidden lines again, marked as echo. Renders are batched to one per animation frame. | M1's sort-on-render list with both interims pinned at the bottom | Interims belong in time order next to the other person's lines. Replacing partials whole per channel and batching updates is anarlog's pattern (`apps/desktop/src/store/zustand/listener/transcript.ts`, `src/stt/transcript-delta-coalescing.ts`). Insertion keeps a 2-hour call cheap. M2-T14 hides echo lines after they were sent through `onSegment`, so without the action the live panel would keep showing the doubled lines M2 removes. |
| Citations into the transcript | M4-T21 owns `renderer/src/transcript/transcriptNavigator.ts` (`CitationNavigatorProvider`, `useCitationNavigator`, `useRegisterTranscript` and `reveal(segmentIds)`). `LiveTranscript` renders `data-segment-id` on every final line and registers its scroll container and `pauseFollow` through `useRegisterTranscript`; it does not implement reveal. M4's chips call the navigator. | Each plan defines its own context; T7 implements reveal | One owner, one type, one reveal that pauses live follow first. M4-T21's contract commit lands in wave 0, before T7. |
| Scrolling | Follow live while the reader is at the bottom. Scrolling up pauses it and shows "Jump to live". | Always scroll | People read back during a call; a view that jumps loses their place. |
| How latency is measured | Per word. Display latency: the first event of that stream (interim or final) whose `endMs` reaches the word's end, minus the clock time when the word's last sample was captured. Final latency: the arrival of the final that holds the word, on the same base. Longest wait: the largest single-word display latency. A word only exists where someone spoke, so this is the longest stall while speech was present. Capture times come from M2-T5's `AudioTimeline` in the app and from the replay clock in the bench. `LatencyMeter` keeps fixed 50 ms buckets up to 10 s plus an overflow bucket, and a cursor over a short list of event end points that is pruned at each final, so memory stays flat. It is shared by the app and the bench, and logged at Stop as `stt latency`. | Event lag (an event's arrival minus the capture time of the audio it ends on); renderer paint timing | Event lag cannot see stalls. If a vendor sends nothing for 4 s and then a partial covering audio up to 0.5 s ago, that event scores 0.5 s, though the user waited about 4 s for those words. U3.6 Pro sends continuous partials only about once a second on long turns (migration guide). Main holds both clocks; IPC and React add a few milliseconds. |
| Which vendor made a meeting's text | A dated vendor log in `docs/research/stt-benchmark.md`, the API's `api_started` log line (it names the provider, model and price today; T1 adds the preset and the token TTL), and each meeting's uploaded `stt_usage` row, which names the provider (T19a). One vendor is active at a time. | `stt_provider` and `stt_model` columns on meetings | Columns would touch the meetings API, the local store and the uploader, which M2, M4 and M5 also edit this week. The usage row already carries the provider. M12 can add columns when it compares passes. |
| STT usage and cost per meeting hour (T19a, T19b) | The landed local `stt_usage` row per meeting (provider, sessions opened, connected and audio ms, dropped chunks, estimated cost at the API's price, per source as JSON, stop reason) is uploaded by a small `SttUsageUploader` beside `TranscriptUploader`: one idempotent `PUT /v1/stt-usage/meetings/{meeting_id}` per changed row. Local migration 6 adds `synced_at` (every save clears it, so a row saved again after its upload is sent again) and `gated_ms` (T20 fills it). Postgres keeps one row per workspace and meeting (Alembic `0005`), with no foreign key to `meetings`: a lineless meeting is deleted but its sessions were billed. `GET /v1/stt-usage/summary?since=` returns meetings, stream hours, meeting hours (from the meetings' start and end where they exist), estimated cost, cost per meeting hour, and the time and money the silence gate saved. The bake-off prices each run from the price in its token responses, so the app and the bench use the one price table | Recompute cost in the API from connected time; a cost column on `meetings` | The desktop already meters what the vendor bills (open time, priced per session at its open), so a second computation would drift. No foreign key for the same reason as locally. The summary is the number the roadmap asks M3 to track. |
| Silence-gated streaming (T20) | Per source, a pure `SilenceGate` reads each 100 ms chunk's level (`rmsInt16` from `shared/pcm.ts`, on the PCM the renderer and the helper already send) against a running noise floor. Speech is a chunk more than 9 dB above the floor (the 10th percentile of the last 30 s) or louder than -40 dBFS. After `sttSilenceCloseMs` (30 s, the hang-over) with no speech chunk, `CaptureSession` closes that source's session through the normal close (finish sequence, last lines saved): state `paused` with pause cause `silence` on its `SourceLink` (next row), message "silent for 30 s; reopens when someone speaks". While it is closed, chunks keep filling a pre-roll ring of `sttSilencePreRollMs` (1 s), and a token is prefetched at the close and refreshed 10 s before its `expires_in` while any source is gated (one token serves both sources, as at Start); a failed prefetch is logged and tried again at the next refresh. The first speech chunk reopens the session as G2 does, with the prefetched token when it has 5 s or more left (else a fetch at the onset, as today), sending the pre-roll and the audio that arrives while connecting as held audio, paced by the core (T18); the stream's time zero is the pre-roll's first chunk, so offsets stay meeting-relative (through M2-T5's `AudioTimeline`). For a gate reopen the hold bound is the pre-roll plus `sttReopenBufferMs`, and the pre-roll never counts as dropped, so the landed `hold()` (newest `sttReopenBufferMs` only) never cuts the pre-roll's start or logs "audio dropped while reconnecting" on a normal reopen. Gate reopens never spend the meeting's allowance (`sttOpensPerMeeting`, kept for Start and for stall and failure reopens): each takes a slot in `SttOpenBudget`'s per-minute window only (M2-T4's minute-only acquire) and one of the gate's own `sttSilenceReopensPerMeeting` (120, counted in `CaptureSession`, so a crash resume starts it again). Once those are used, the gate is off for the rest of that meeting: one `info` log line, sessions stay open through silence until Stop, and the status says so (`SttMeterStatus.silenceGate` `spent`). The gate never closes a session that opened less than 60 s ago (at most one gate reopen per source per minute). A gated window is a capture event with its peak level, never a gap: nothing was said. When a gated source's speech reopen fails or waits on the per-minute window, the gap (M2-T6) starts at the speech onset (the pre-roll's first chunk), not at the watermark, so M2-T16 never re-runs a silence the vendor would bill. The meter adds optional `gatedMs` and `estimatedSavedUsd` (the gated time at the session's price; missing reads as 0, so the `SttMeter` values in M2-T20a's tests and shots and M4-S3's preview fixtures stay valid) per source and meeting: status line, `stt meter` logs, `stt_usage.gated_ms`. `stt latency` at Stop scores words carried by gate-reopened sessions in their own `LatencyMeter` per source, logged beside the rest. Settings in `costGuards.ts`, whole seconds and counts like every guard: `sttSilenceCloseSeconds` (0 turns the gate off), `sttSilencePreRollSeconds` (1 to 3) with the cross-field check that it plus `sttReopenBufferSeconds` is at most 10 (every held second becomes lag on that session, T18), `sttSilenceReopensPerMeeting`. On by default (D5; OD-27 in the build order) | Keep every session open while chunks flow (M1); a vendor-side voice detector; a neural VAD; gate reopens inside `sttOpensPerMeeting` with a reserve (this plan's first draft); a higher `sttOpensPerMeeting` | AssemblyAI bills every second a session is open, silent or not, so a muted mic or an hour of listening costs as much as talking, and call audio that is exact zeros (a waiting room) costs the same. Energy on 16 kHz PCM is cheap, vendor-free and testable on fixtures. A wrong "speech" only keeps a session open (money); a wrong "silence" loses words, so the threshold leans to speech and the hang-over is long. The pre-roll keeps a soft first syllable the energy test missed; 1 s, not 2, because the core sends held audio at 1x (T18), so every held second is lag on that session until it next closes, and a prefetched token takes the API round trip out of the connect. Inside the 30-open meeting allowance with a reserve of 10, Start's 2 left the gate 18 reopens for both sources: a stop-and-start meeting spent them in 10 to 40 minutes and then billed silence until Stop, and M2-T16's re-runs had nothing left; raising `sttOpensPerMeeting` would loosen the guard against a vendor that keeps failing. A gate cycle bills no more than the session it replaces (it stays open at least 60 s), so its own allowance bounds token fetches and handshakes, not open time. |
| The silence gate and the stall pause | Two signals on one close-and-reopen path. Stall (landed G2, `CaptureService.checkAudioFlow`): no chunk at all for `sttStallCloseMs`, a broken capture path; it reopens on the next chunk of any level, holding at most 3 s, and M2-T11 warns about it loudly. Silence (T20, in `CaptureSession.pushAudio`): chunks keep arriving and none is speech for the hang-over; it reopens only on a speech chunk, with the pre-roll, and warns about nothing. A gated source whose chunks then stop goes `stalled` as before; its session is already closed. Both use `paused` with their own message, and a per-source pause cause on `SourceLink` (`stall` or `silence`) decides what reopens it: the landed `paused` branch of `pushAudio` reopens on any chunk, which under the gate would reopen on the next silent chunk, so T20 makes it reopen on any chunk only for `stall` and on a speech chunk only for `silence`. The cause outlives a suspend: after M2-T6's `resumeStreams()` (back online) and M2-T18's wake, a source that was gated is `paused` with cause `silence` again and reopens only on speech; only a source that was open reopens with its next chunk. The no-speech stop (15 minutes without a final line, G5) still ends a recording where both sources stay gated, and the 4-hour cap still applies. `describeStream` tells them apart by health: `paused` with health `active` (chunks arriving) is the gate, "closed while silent, reopens on speech"; the landed "paused, no audio" stays for a stall | One rule for both; one `paused` state with no cause | Stall means the path is broken; silence means nobody speaks. Sharing the state and the reopen keeps the UI, the budget and the conformance-proven close path the same for both. Without the cause, every offline flip or wake would reopen both gated sessions on silence, spending two opens and billing at least 60 s of silence (the gate's minimum) each time. |
| Benchmark code | TypeScript in `apps/desktop/bench`, reusing the app's adapters. Built with Vite, already a dev dependency, and run with Node 22.13 or later (`node:sqlite` with no flag). | Python in `apps/api`; `tsx` as the runner | It measures the exact adapter code the app runs. Python would need a websocket client the API does not declare (C2). `tsx` passes the dependency bar (114.7M downloads in the week to 2026-10-04, 4.23.15 published 2026-09-20, no advisories), but it would save only a 15-line build config. |
| Benchmark replay | Stream the WAV files through the adapters, built from the registry, at real time: 100 ms chunks, 1x, both streams of an item at once, three items in parallel. `--gate` runs each stream through T20's `SilenceGate` the way `CaptureSession` does, closing and reopening the vendor session, so the gate's savings and its cost in words and latency are measured on the test set. | Vendors' batch APIs; faster than real time | Live accuracy and lag are what the person sees, and batch models differ from live ones. AssemblyAI closes a session that is fed faster than real time (close code 3007). |
| Benchmark credentials | Each item asks the local API for `POST /v1/stt/token` just before its streams open (both streams share that token), and again for every retry. The run is labelled from the first response. A later response that names another provider or model stops the run with both names (the API was restarted mid-run). A failed item is retried up to 2 times. Every attempt and its error goes into `run.json`. Every session the bench opens takes a slot from its own `SttOpenBudget` (the app's class) set to the vendor's sessions-per-minute limit, with a per-meeting limit no run reaches (a run is not a meeting), so `--parallel 3` (six opens at once) waits instead of drawing AssemblyAI's "Too many concurrent sessions" on a free account (5 starts a minute) | Vendor keys in the benchmark's env; one token per run | House rule 3 holds for tools too, and every run tests the real token path and jargon list (pattern: openwhispr `.github/workflows/stt-canary.yml`). A run takes about 10 minutes at `--parallel 3`. A Deepgram grant only works at the handshake, and the default TTL is 30 s. An AssemblyAI token lasts at most 600 s. One token per run would fail every later item and disqualify a vendor over a tooling bug. Same rule as M2-T6: a fresh token for each attempt. |
| Where test data lives | `ROGER_BENCH_DIR`, default `~/Roger-bench`, mode 0700, on a FileVault disk. The CLI refuses a path inside the git checkout, and `clip` refuses when `fdesetup status` is not On. Only aggregate numbers are committed. | `apps/desktop/bench/data` behind `.gitignore` | These are recordings of real people (D2). One wrong `git add` would publish them. Reports follow openwhispr `docs/orukeet-benchmarks.md`, which keeps transcript text out of its outputs. |
| Scoring | WER = (substitutions + deletions + insertions) / reference words, after the normaliser. Me is scored on the mic stream after M2's `EchoFilter` (M2-T14a, pure and vendor-free) has run over the item's replayed mic and system finals, with the route from `item.json` (`speakers`: on; `headphones`: off, as in the app). That is the text the user sees. Raw-mic Me WER is reported as a diagnostic column. Them is scored on the system stream. A system-only item (`origin: meet-recording`) has every reference line labelled Them, is scored on the system stream only, and is left out of Me WER and the mic latency gate. Items are pooled by summing errors and words. A 95% bootstrap interval is computed over items, with a fixed seed. | Me on the raw mic stream; the mean of per-item WER | On laptop speakers the mic carries all of Them's speech. A vendor that transcribes that echo better would get more insertions and a higher Me WER, and two speaker items could flip the choice. Pooling weights long items properly. The interval stops a 0.5-point gap on 10 clips from picking the vendor. If M2-T14 is late, speaker items are left out of the D4 pooled number and the report says so. |
| Normaliser | Version 1 rules, applied to both sides and listed in the research doc. Unicode NFKC, then lowercase. Curly quotes become straight. Punctuation is removed, except apostrophes inside words and points inside numbers. Hyphens and slashes become spaces. The fillers `um uh er ah hmm mm` are removed. `ok` becomes `okay`, `alright` becomes `all right`, `gonna`, `wanna` and `gotta` become `going to`, `want to` and `got to`. Spelled-out numbers become digits (`twenty five` to `25`, `two point five` to `2.5`, `first` to `1st`). `1,000` becomes `1000`, `%` becomes `percent`, `$5` becomes `5 dollars`. Every run stores the version. Changing a rule bumps it, and stored runs are scored again. | Whisper's English normaliser | The same idea, small enough to own and test rule by rule, with no Python dependency. |
| Term metrics | For each jargon term, counted case-insensitively on normalised text: recall = sum of min(reference count, hypothesis count) / sum of reference counts. False alarms = sum of max(0, hypothesis count - reference count). | WER only | WER weighs "Linkt" the same as "the", but names are what people notice. False alarms catch "linked" turning into "Linkt". |
| Fixing text by hand | `bench draft` aligns two vendors' runs word by word and writes one draft per item, with disagreements marked `{deepgram words \| assemblyai words}`. The owner listens to the whole clip in `listen.wav` (mic on the left, system on the right), resolves every brace and fixes the rest. On speaker items, Me lines that only repeat Them are deleted. `bench check` refuses a reference with a brace left in it. | Fix one vendor's text | Where two vendors agree, the text is almost always right, so attention goes where it is needed. A draft from one candidate biases the reference toward it. `item.json` records which runs made the draft. |
| Canary | `bench canary` makes a fixed script with jargon in it using macOS `say` (`--data-format=LEI16@16000`) and runs it through whichever vendor the API serves. Real vendors fail on WER above 15% or no final within 10 s. With `provider=fake` it checks only that a final arrives within 10 s and prints "WER not checked (fake provider)". `--save-wire <dir>` writes the vendor's raw messages, for T5's fixtures. | A committed recording | It catches a dead key, a wrong model name or a rejected jargon list in a minute, with nothing private in the repo. The fake adapter emits level lines with no words, so a WER rule against it would always fail. Synthetic speech says nothing about accuracy on our voices. |

### Decisions for the owner (one sign-off)

Every other call above is made. These five are the owner's.

| Id | Question | Recommendation | Alternative | Why |
| --- | --- | --- | --- | --- |
| D1 | A third vendor? | Yes: Soniox `stt-rt-v5`, built last as T14 and T15, and dropped if the day runs out | Two vendors (runs A and C, and B if it is run) | It is the only vendor whose docs say it never trains on content, and the cheapest ($0.24 per meeting hour, against $0.38 for run C, $0.90 for run B and $0.73 to $1.08 for Deepgram before any opt-out uplift). The done-when is met without it. |
| D2 | Keep a standing test set of colleagues' audio, as an exception to the audio policy? | Yes, as an explicit exception the owner signs. C6 and the roadmap ("audio is kept for a short, fixed time") otherwise apply. Internal Linkt calls only (standups, one-to-ones). `item.json` records each participant's name and consent date. Clips live only in `~/Roger-bench`: mode 0700, on a FileVault disk, never in git, and no Drive copy in Phase 2 unless the owner chooses one. `bench forget --person <name>` (or `--meeting <id>`) deletes every item and run output that holds them. Deleting a meeting's audio in the app does not reach bench copies; `forget` does. The exception is linked from the roadmap's open decision "Policy on keeping audio" before gate 2's legal view. | Keep clips for 7 days like the backup and re-clip for each bake-off; include client calls with their consent | A benchmark is only useful if it scores the same audio for months. Keeping it is a policy choice the owner should make knowingly, not one the plan makes quietly. Per-person consent and `forget` keep it reversible. A dataset we keep for years should not hold client calls. |
| D3 | Opt Deepgram out of training even if it costs more? | Yes, on every request (`mip_opt_out=true`). Confirm the opted-out price in the Deepgram console, and compare costs at that price. | Stay in Deepgram's program for the discount | The roadmap promises we never train on calls. A Deepgram staff reply says opting out gives up a 50% discount. |
| D4 | How the vendor is chosen | The vendor choice rule below, signed before any run is scored | Decide after seeing the numbers | A rule fixed in advance keeps the choice honest on a small test set. |
| D5 | Silence-gated streaming on by default? | Yes: a 30 s hang-over, a 1 s pre-roll, a token prefetched while the source is closed, and the gate's own allowance of 120 reopens per meeting (`sttSilenceReopensPerMeeting`, counted in the per-minute window with every other open; past it the gate is off for the rest of that meeting) (T20). The cost you accept: AssemblyAI takes no audio faster than real time and documents no tolerance, so the words of a session the gate reopened show about the pre-roll plus the connect time later (about 1 to 1.5 s with the prefetched token) until that source is quiet for 30 s again. If bake-off run F shows it costs more than 1.0 point of pooled WER, or adds more than 2.0 s of p95 word display latency to the words of reopened sessions (against the same words without the gate), its default becomes off and the numbers go in the exit check log | Off by default, on per Mac in `config.json` | The owner's ask of 2026-10-06 is to be very conservative about cost, and every open second is billed. The risks are a lost first word and the extra lag after a silence, which run F measures. Judged by the 2.0 s gate on all words, the gate would fail by design (its backlog becomes lag) and the default would always flip to off; the added-lag rule catches a slow connect or a pacing fault instead. |

### Vendor facts (read 2026-10-06)

| | Deepgram | AssemblyAI | Soniox (optional) |
| --- | --- | --- | --- |
| Live socket | `wss://api.deepgram.com/v1/listen` | `wss://streaming.assemblyai.com/v3/ws` | `wss://stt-rt.soniox.com/transcribe-websocket` |
| Token from the API | `POST https://api.deepgram.com/v1/auth/grant`, `Authorization: Token <key>`, body `{"ttl_seconds"}`, returns a JWT (built in M1) | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=1..600`, optional `max_session_duration_seconds=60..10800` (default 10800), `Authorization: <key>` with no prefix. Returns `{token, expires_in_seconds}`. Reusable within the window. | `POST https://api.soniox.com/v1/auth/temporary-api-key`, `Authorization: Bearer <key>`, body `{"usage_type": "transcribe_websocket", "expires_in_seconds": 1..3600}`. Returns `{api_key, expires_at}`. |
| How the desktop authenticates | `Authorization: Bearer <jwt>` | `token=<token>` query parameter | `Authorization: Bearer <temporary key>` header |
| Models | `nova-3` | `universal-3-6-pro` (default), `universal-3-5-pro`, `universal-streaming-english`, `universal-streaming-multilingual` | `stt-rt-v5` |
| Language | `language=en` | `language_codes` (a list) on Universal-3.5 and 3.6 Pro only | not sent in M3 |
| Jargon | `keyterm=` repeated, with spaces encoded; 500 tokens at most across all terms | `keyterms_prompt` as a JSON array; at most 100 terms of 50 characters each; can change mid-session (`UpdateConfiguration`) | `context.terms` array; the whole context at most 8,000 tokens |
| Audio | linear16 at 16 kHz | `pcm_s16le` at 16 kHz; chunks of 50 to 1000 ms; never faster than real time, with no tolerance documented: the API reference says to pace chunks at about real time, and the 3007 close reads "Audio Transmission Rate Exceeded: Received <x> sec. audio in <y> sec". `session_heartbeat=true` makes the server send a `Heartbeat` every 5 s with `realtime_factor` (audio received over wall time) | `pcm_s16le`, with `sample_rate` and `num_channels` in the first JSON message; no rate rule documented |
| Interim and final | `is_final` or `from_finalize` | `Turn` partials, then `end_of_turn`. Pro models format every turn; Universal-Streaming with `format_turns` sends the turn raw, then formatted. U3.6 Pro sends an early partial at about 750 ms, partials on silence, and on long turns a partial about once a second. | tokens with `is_final`; non-final tokens are replaced on every response |
| Stop | `Finalize`, then `CloseStream`; the vendor closes the socket | `{"type": "Terminate"}`, answered by `Termination` after the last turn (`ForceEndpoint` also exists; Roger does not need it) | `{"type": "finalize"}`, then an empty text frame, answered by `finished: true` |
| Errors | `Error` message; HTTP status at the handshake | Close codes: 1008 auth or account, 3005 server, 3007 chunk size or faster than real time, 3008 session over its maximum, 3009 too many sessions. The close-codes page says an `Error` text frame comes first; the API reference lists no such type. | `error_code`, `error_type`, `error_message`, then a close |
| Session limit | none documented | 3 hours by default | 300 minutes |
| Price per stream hour | $0.288 now ($0.0048 per minute; regular $0.0077, which is $0.462, the price `stt_vendors.py` uses so estimates err high) plus $0.078 for keyterms ($0.0013 per minute). The price with `mip_opt_out` is not published. | U3.6 Pro $0.45, keyterms included. Universal-Streaming English $0.15 plus $0.04 for keyterms (both in `stt_vendors.py`). Billed on session time, not audio time. | $0.12 |
| Training | Audio joins the Model Improvement Program unless each request sends `mip_opt_out=true`. A Deepgram staff reply (GitHub discussion #1292, June 2025) says opting out gives up a 50% discount; the pricing page does not say so. | Opt out under Data Controls in the dashboard, free. Streaming keeps no data once opted out. | Never trains on content. |

A meeting has two streams, so cost per meeting hour is twice the stream price.

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
[Soniox security and privacy](https://soniox.com/docs/security-and-privacy).

### Data flow

```
desktop main                                              api
Start ─ POST /v1/stt/token ──────────────────────────────▶ STT_PRESETS[STT_PROVIDER] (stt_vendors.py)
      ◀─ {provider, access_token,                          ─▶ STT_VENDORS[vendor].issuer ─▶ vendor token
          stream{model, encoding: linear16, keyterms,      ◀─ vocabulary_terms
                 price_per_hour_usd}}
createSpeechToText(provider) ─▶ stt/registry.ts ─▶ AssemblyAI | Deepgram | Soniox (optional) | Fake
      each an SttProtocol run by stt/core SttConnection (framing, pacing, keep-alive, ping, close)
CaptureSession: SilenceGate per source (T20) ─▶ SttOpenBudget ─▶ openStream; audio ─▶ stream
               LatencyMeter per word (capture times from M2's AudioTimeline)
               events ─▶ SQLite (finals) ─▶ M2 EchoFilter ─▶ "segment changed"
               renderer: useLiveTranscript ─▶ liveTranscriptModel reducer ─▶ LiveTranscript
CaptureService meter ─▶ stt_usage (local) ─▶ SttUsageUploader ─▶ PUT /v1/stt-usage/meetings/{id}
                                                               ─▶ stt_usage (Postgres) ─▶ summary
```

### API contract changes (`docs/api-contract.md`, same commit as the code)

- `GET /v1/vocabulary` returns `200 {"terms": ["Linkt", "Roger"]}`, sorted ignoring case.
- `PUT /v1/vocabulary` with body `{"terms": [...]}` replaces the list and returns
  `200 {"terms": [...]}` as stored. Breaking a limit is a `422 validation_error`. Duplicates are
  dropped, not refused.
- `POST /v1/stt/token`: `provider` stays the vendor, `"assemblyai" | "deepgram" | "fake"` (plus
  `"soniox"` with D1); two presets can share a vendor (T1 lists the presets in the token section).
  `stream.model` is the preset's model. `stream.encoding` is always `linear16`, the app's audio
  format; protocols translate it. `expires_in` is the TTL. `stream.price_per_hour_usd` (landed)
  now includes the keyterm surcharge when the list is not empty (T3). New
  `stream.keyterms: string[]` carries the caller's workspace list, `[]` when empty, and the fake
  provider gets it too. The desktop reads a missing `keyterms` as `[]`, so an older API keeps
  working.
- New section "STT usage" (T19a): `PUT /v1/stt-usage/meetings/{meeting_id}` with
  `{provider, sessions_opened, connected_ms, audio_sent_ms, dropped_chunks, gated_ms,
  estimated_cost_usd, by_source, stop_reason}` upserts the meeting's row and returns `200` with it
  (idempotent; no meeting row needed). `stop_reason` is null or free text of 1 to 64 characters,
  not a list: the desktop's stop reasons change across releases.
  `GET /v1/stt-usage/summary?since=<ISO date>` returns `{meetings, stream_hours, meeting_hours,
  estimated_cost_usd, cost_per_meeting_hour, gated_hours, estimated_saved_usd}`; unknown prices
  are counted and named, never summed as zero.

### Database

```sql
vocabulary_terms (id uuid pk, workspace_id uuid fk not null, term text not null
                  check (char_length(term) between 1 and 50), created_at timestamptz default now())
                 unique index (workspace_id, lower(term))

stt_usage (workspace_id uuid fk not null, meeting_id uuid not null,   -- no fk to meetings
           provider text not null, sessions_opened int, connected_ms bigint, audio_sent_ms bigint,
           dropped_chunks int, gated_ms bigint default 0, estimated_cost_usd numeric null,
           by_source jsonb, stop_reason text null, updated_at timestamptz,
           primary key (workspace_id, meeting_id))
```

Alembic `0002` (vocabulary, T2) and `0005` (usage, T19a), fixed in `phase-2-build-order.md`.

Desktop SQLite: keyterms arrive with each token and are not cached. Local migration 6 (T19b) adds
`stt_usage.synced_at` and `stt_usage.gated_ms` (3 is the landed `stt_usage`, 4 is M2-T3's and 5 is
M5-T5's).

### Benchmark: the standing test set

**Item format.** Every tool reads and writes this layout, through `bench/core/events.ts` (T10) for
the run files. Nothing in it is ever committed.

```
$ROGER_BENCH_DIR/                (mode 0700)
  items/<item-id>/
    item.json             id, origin (backup | meet-recording), meeting_id or null,
                          window {from_ms, to_ms}, recorded_on, kind (standup | one-to-one |
                          group | other), setup (headphones | speakers | unknown), streams present,
                          gaps, participants [{name, consent_on}], runs used for the draft
    mic.wav, system.wav   16 kHz mono PCM16; mic.wav is missing on a meet-recording item
    listen.wav            stereo, mic left, system right; only for listening, never scored
    reference.draft.txt   from `bench draft`
    reference.txt         fixed by hand: "[mm:ss] Me: text" or "[mm:ss] Them: text" per line
  runs/<run-id>/run.json  provider, model, adapter query (token removed), keyterms on or off,
                          keyterm list, normaliser and echo-filter versions, start time, and per
                          item: attempts with their errors, token fetch times
  runs/<run-id>/<item-id>/{mic,system}.events.jsonl   every SttEvent with its arrival time
  reports/<run-id>.json, reports/<run-id>.md
```

**Where recordings come from.** M2's local audio backup (M2-T15; C6: local only, kept 7 days by
default). It stores each stream in chunks of 60 s or less under `userData/audio/<meeting>`, turned
into AAC m4a at 48 kbps (WAV when that step failed), placed in time by M2-T5's runs. The contract
with M2-T15, stated in both plans: `bench clip` opens `<userData>/roger.sqlite` read-only with
`node:sqlite` (the app writes it in WAL mode at the same time) and reads `audio_files` rows for the
meeting where `deleted_at` is null, ordered by `start_ms`. `--user-data` defaults to
`~/Library/Application Support/Roger`, the installed app's `userData` (its `roger started` log line
prints it). A missing database is an error that names the path and the flag.
`bench clip --meeting <id> --from 12:30 --to 15:00 --name standup-1006` cuts the same window from
both streams. It decodes the chunks with macOS `afconvert` (no new dependency), lays them out by
`start_ms`, fills gaps with silence, and lists the gaps in `item.json`. Every vendor hears the same
decoded audio, so the comparison is fair, though absolute WER may sit slightly above what the live
stream got. T12's tests use the backup fixture M2-T15 commits.

Fallback when the backup is late: a Google Meet recording from Drive, converted with
`afconvert -f WAVE -d LEI16@16000 -c 1`, makes an item with `origin: meet-recording`. Meet mixes
everyone on the server, the owner included, so the reference labels every line Them, and the item
is scored on the system stream only (see Scoring). The report lists these items by origin.

**What the 10 items are.** Two to three minutes each, picked where names and numbers come up:
three standups, two one-to-ones, two calls on laptop speakers (echo), two with several remote
people, one in a noisy room. About 25 minutes of call, so about 50 minutes of stream audio. Each
item must be clipped within the backup's retention window.

**Fixing the text, with the least effort.** (1) Clip the items. (2) Run Deepgram and AssemblyAI over
them. (3) `bench draft --runs <a>,<b>` writes `reference.draft.txt`: Me and Them lines in time
order, with the two vendors' disagreements in braces. (4) Play `listen.wav` from start to end,
resolve each brace, fix anything else, delete Me lines that only echo Them, and save as
`reference.txt`. (5) `bench check`. Expect about 10 minutes to clip and about 90 minutes to fix (3
to 4 times real time).

**Commands** (all through `make bench ARGS="..."`, which builds `bench/cli.ts` with Vite and runs it
with Node; settings come from the same `.env` as the desktop):

| Command | What it does |
| --- | --- |
| `clip --meeting <id> --from <mm:ss> --to <mm:ss> --name <id> [--user-data <dir>] [--person <name>:<consent date> ...] [--kind <kind>] [--setup headphones\|speakers\|unknown]` | Cuts both sources from the backup; writes the WAV files, `listen.wav` and `item.json` (`--kind` defaults to `other`, `--setup` to `unknown`, which scores Me with the echo filter on) |
| `run [--items <ids>] [--no-keyterms] [--gate] [--parallel 3]` | A fresh token per item, replays each item at 1x through the registry's adapter for the token's provider (every open through the bench's `SttOpenBudget`), retries a failed item up to 2 times, stores every event; `--gate` applies T20's `SilenceGate` |
| `draft --runs <a>,<b>` | Writes `reference.draft.txt` for items with neither a `reference.txt` nor a `reference.draft.txt` (a draft may hold the owner's fixes in progress: delete one to draft that item again) |
| `check` | Lists unresolved braces with line numbers, unknown speakers, empty items, and items with no participant consent |
| `score [--run <id>]` | WER (Me after the echo filter, raw mic as a diagnostic), Them WER, term recall and false alarms, word latency, intervals, cost; writes JSON and markdown reports |
| `report --summary` | Prints the aggregate table for `docs/research/stt-benchmark.md`, with no transcript text |
| `forget --person <name>` or `--meeting <id>` | Deletes every item holding that person or meeting, and those items' run outputs; aggregate reports stay |
| `canary [--save-wire <dir>]` (also `make stt-canary`) | Synthetic jargon clip through the current vendor; non-zero exit on failure |

**Report columns, per configuration:** pooled WER with its 95% interval, Me WER (after the echo
filter), Me WER on the raw mic (diagnostic), Them WER, term recall, term false alarms, word display
latency p50 and p95 per stream, final latency p50 and p95, longest wait, items retried, items failed
after retries, items left out and why, stream hours, cost per meeting hour (connected time at the
`stream.price_per_hour_usd` of each item's token, so the bench prices exactly as the app does from
the one table in `stt_vendors.py`, where every price carries its source URL and the date it was
read), and for `--gate` runs the gated time, the money saved, the first-word misses (reference
words lost in the 2 s after a gate reopen), the gate reopens with the backlog each carried at its
ready signal (pre-roll plus connect), and the word display latency p95 of the words carried by
reopened sessions next to the same words' p95 in the winner's run without the gate.

**Bake-off configurations.** Only `STT_PROVIDER` changes between runs; every preset is one row in
`stt_vendors.py`, every adapter comes from the desktop registry.

| Run | `STT_PROVIDER` | Model | Why |
| --- | --- | --- | --- |
| A | `deepgram` | `nova-3` | The second adapter; M1's vendor until 2026-10-06 |
| B (if worth it) | `assemblyai-pro` | `universal-3-6-pro` | AssemblyAI's model for meetings, three times C's price. Run only if C misses a gate, or A or D beats C's pooled WER by more than 1.0 point |
| C | `assemblyai` | `universal-streaming-english` | The vendor since 2026-10-06 (M1); English only |
| D (with D1) | `soniox` | `stt-rt-v5` | Cheapest, never trains |
| E | the winner | the winner's | `--no-keyterms`: measures the jargon list |
| F | the winner | the winner's | `--gate`: measures T20's silence gate (savings, first-word misses, latency); never part of the vendor choice |

**Run F's latency measure.** The same per-word display latency as every run (T6a's meter), split
in two: the words carried by sessions the gate reopened, and all the others. The replay knows
which sessions it reopened and records each one's backlog at the ready signal in `run.json`. The
added lag is the reopened words' p95 minus the same words' p95 in the winner's run without the
gate. Expected: about the pre-roll plus the connect time (about 1 to 1.5 s with the prefetched
token and the 1 s pre-roll), because the core sends that backlog at 1x and never catches up (T18;
AssemblyAI documents no tolerance). D5 turns the default off when the added lag is over 2.0 s;
the 2.0 s gate of the vendor choice is never applied to run F.

A whole bake-off is about 4 stream hours, under $3 even at a doubled Deepgram price.

**Vendor choice rule (decision D4, fixed before any result is seen)**

1. Gates: p95 word display latency of 2.0 s or less on both streams (the mic gate counts only
   items with a mic stream), no item failed after its 2 retries, and training opt-out confirmed for
   that vendor. The longest wait is reported, not gated: a systematic stall already moves the p95.
2. Of the configurations that pass, pick the lowest pooled WER (Me after the echo filter).
3. If the runner-up is within 1.0 point, pick the one with better term recall. If that also ties
   (within 5 points), pick the lower cost per meeting hour.
4. Write the result and the reason into `docs/research/stt-benchmark.md`, and add a row to its
   vendor log (date, preset, provider, model, why).

## Work items

Each task owns the files listed and brings its own tests (failing test first). SHELL is the shared
app-shell task. M2-T5 (audio timeline), M2-T6 (liveness, offline and gap records on the landed
reopen), M2-T10 (system audio through the helper), M2-T11 (capture warnings), M2-T14a and T14b
(echo filter), M2-T15 (audio backup) and M2-T16 (gap re-run) are in
`M2-capture-you-can-trust.md`. Paths are under `apps/api/src/roger_api`, `apps/api/tests` and
`apps/desktop/src` unless shown in full.

| Id | Task | App | Owns | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| M3-T1 | Presets on the STT registry (builds on the landed `stt_vendors.py`, issuers and price table; rewrites none of them) | api | `stt_vendors.py` (`STT_PRESETS`: preset id to vendor and model, `fake`, `assemblyai`, `assemblyai-pro`, `deepgram`, with a `Literal` preset type beside it; `SttProvider` in `domain.py` stays the vendor ids; `open_stt_token_issuer` looks the issuer up by the resolved vendor, not by `STT_VENDORS[settings.stt_provider]` (line 114 today), or `STT_PROVIDER=assemblyai-pro` fails at startup with a `KeyError`), `config.py` (STT fields: `STT_PROVIDER` is a preset id, the vendor and model resolved from it, so `stt_vendor` and `stt_vendor_key` key on the vendor, a non-blank `STT_MODEL` refused by name, the landed key, TTL and price checks kept), `schemas/stt.py` (`from_settings`: the vendor as `provider`, the preset's model and price), `app.py` (preset and TTL added to `api_started`), `tests/test_stt_providers.py`, the STT cases of `tests/test_config.py` (the landed `STT_MODEL` cases become preset cases), the three `stt_model="nova-2"` cases of `tests/test_stt_token.py` (`test_stream_settings_come_from_config`, `test_stream_price_is_the_override_when_set`, `test_unknown_stream_price_is_null`; the last needs a preset whose model has no list price, patched in the test), which fail once `STT_MODEL` is refused, `.env.example` (STT section: `STT_MODEL` removed, the presets listed), the STT settings in `apps/api/README.md`, the contract's token `provider` line and preset list | - | S |
| M3-T2 | Workspace jargon list | api | `db/models_vocabulary.py` (`VocabularyTerm`), `migrations/versions/0002_vocabulary_terms.py` (revision `0002`, down `0001`; P2-F2's stub), `services/vocabulary.py`, `schemas/vocabulary.py`, `routers/vocabulary.py` (P2-F2 already includes it in `app.py`), `tests/test_vocabulary.py`, contract Vocabulary section and its Database line, the route check in `tests/test_http_plumbing.py` (read from the contract's headings; `phase-2-build-order.md` section 3.1). The one-head test is P2-F2's | P2-F2 | M |
| M3-T3 | Keyterms in the STT token response | api | `routers/stt.py` (takes `PrincipalDep`, one query, limit 100), the `keyterms` field in `schemas/stt.py`, the keyterm surcharge per model in `stt_vendors.py` (added to `price_per_hour_usd` when the list is not empty; as built, a required `keyterm_surcharge_per_hour_usd` on every `SttVendor`, and `stream.price_per_hour_usd_without_keyterms` beside it), the keyterm tests in `tests/test_stt_token.py`, contract token section | T1, T2 | S |
| M3-T4a | Keyterms through the STT core; Deepgram `keyterm`, `mip_opt_out` and the rejected-list signal | desktop | `main/stt/SpeechToText.ts` (`keyterms` on `SttStreamSettings`, optional so the landed settings literals in tests stay valid, missing meaning none; `keytermsRejected` on `SttConnectError`; no `inlineReplay`, no `warning` event), `main/stt/keyterms.ts` (the shared cap) and test, `main/stt/core/SttProtocol.ts` (`keytermsRejected(failure)`, optional because AssemblyAI's protocol is T5's; a conformance case fails a vendor that declares it without its entry's `keyterms`, or the reverse) and `core/SttConnection.ts` (sets the flag on a connect refused while keyterms are non-empty, socket closed; never retries), `main/stt/deepgram/DeepgramSpeechToText.ts` and test (`buildListenUrl` with one `keyterm` per term and always `mip_opt_out=true`; HTTP 400 with keyterms is `keytermsRejected`), the keyterm-refusal case in `stt/conformance.test.ts` with Deepgram's entry in `stt/testing/conformanceVendors.ts` (exactly one handshake, no socket left open), `main/stt/fake/FakeSpeechToText.ts` (takes and ignores keyterms), `main/api/ApiClient.ts` (token type, missing means `[]`) and test, and in `main/capture/CaptureService.ts` only the fake-settings literal (`keyterms: []`) and the `keyterms` line in `resolveStt`; one line in `apps/desktop/README.md` "Add a speech-to-text vendor" (map keyterms and say when they are rejected) | P2-F1, T18 (file order in `stt/core`) | M |
| M3-T4b | A rejected jargon list in the capture session | desktop | `main/capture/CaptureSession.ts` (a connect rejected with `keytermsRejected` reopens that source once without keyterms, through `SttOpenBudget`, keeps the list off it for the meeting, logs at warn and calls `onWarning`; that source's session is metered at `stream.price_per_hour_usd_without_keyterms`, or `price_per_hour_usd` when an older API omits it, which errs high), `main/capture/CaptureService.ts` (`onWarning` becomes a quiet `keyterms_rejected` capture warning) and their tests | T4a, M2-T5, M2-T6, M2-T11, T6b and M5-T5 (file order) | S |
| M3-T5 | AssemblyAI: Pro model, keyterms, wire fixtures (extends the landed protocol; framing, held turns, close codes and Terminate stay as they are) | desktop | `main/stt/assemblyai/*` and tests (`buildStreamingUrl`: `keyterms_prompt`, and `language_codes=["en"]` on `universal-3-*-pro`; `messages.ts`: a Pro `end_of_turn` is final; `keytermsRejected` for a close before `Begin` other than 1008 and 3009, with the matching `keyterms` refusal in its conformance entry; a 1006 drop never reaches it; a warning when `Begin.configuration.model` differs from the model asked for), `main/stt/assemblyai/fixtures/` (the API reference's examples now, recorded wire JSON at close step 0), AssemblyAI's keyterm-refusal entry in `stt/testing/conformanceVendors.ts`, the core's wire tap (`wireTap` in `core/WebSocketSpeechToText.ts`, called from `core/SttConnection.ts` with every message both ways and the query without the token; only the bench passes it) with a conformance case that it never sees the token, `main/stt/streamSettings.ts` (a comment: the encoding is the app's own name) and one case in its test | T4a, T18 | M |
| M3-T6a | Word latency meter | desktop | `main/stt/LatencyMeter.ts` and test (the pure meter, which T11 needs) | - | S |
| M3-T6b | Latency hook | desktop | `main/capture/CaptureSession.ts` (one call per event, `stt latency` log at close) and test | T6a, M2-T5, M2-T6 (merges after it in wave 4) | S |
| M3-T7 | Live transcript panel: model and component | desktop | `renderer/src/transcript/liveTranscriptModel.ts` and test (including `segmentChanged` and `showHidden`; not `liveTranscript.ts`: the Mac's disk ignores case, and beside `LiveTranscript.tsx` that name broke the import), `LiveTranscript.tsx` (each final line carries `data-segment-id`; registers its scroll container and `pauseFollow` through M4-T21's `useRegisterTranscript`; no reveal of its own; props `meetingId`, `storedLines`, `showHidden` and `live`, true while this meeting records), `useLiveTranscript.ts` (subscribes to segment, interim and `transcript:segment-changed` events itself, and to the capture status, which ends a source's interim when its stream is not open and every interim at `stopping` or `idle`; takes a meeting's stored lines and `showHidden` as props, so past meetings use the same panel), `transcript.css` (theme tokens only) | M2-T2 (the `transcript:segment-changed` contract), M4-T21a | M |
| M3-T8 | Jargon list editor | desktop | `shared/vocabulary.ts` (limits shared with main) and test, `shared/ipc/vocabulary.ts` (`vocabulary:get`, `vocabulary:set`) with its bridge in `preload/bridges/` and fake in `preview/fakes/`, `main/vocabulary/vocabularyIpc.ts` (handlers and payload validation) and test, `main/api/vocabularyClient.ts` (two methods) and test, `[slot M3-T8]` in `main/index.ts`, `renderer/src/settings/vocabularyEditor.ts` (load state; save refused after a failed load) and test, `renderer/src/settings/VocabularySettings.tsx` | T2, T4a | M |
| M3-T9 | Mount the transcript and the editor; retire M1's view | desktop | `renderer/src/app/slots/m3-transcript.ts` (the meeting page's transcript region and the Settings section; replaces the `TranscriptView` entry M4-S4 seeded), `renderer/src/state/useCapture.ts` (drops its segment and interim state; keeps M5-T5's `start(request)`), deletes `renderer/src/components/TranscriptView.tsx`; and, because M4-S4's sidebar keys its re-list on the newest line in `useCapture`'s segments, `app/RecentMeetings.tsx` and `meeting/recentMeetingsKey.ts` (a new input for that key, with its tests; the key's doc says what it must catch) | T7, T8, M4-S1, M4-S4, M4-S4b, M5-T5 (file order) | S |
| M3-T10 | Benchmark scoring core | desktop | `apps/desktop/bench/core/{wav,normalise,align,wer,terms,reference,bootstrap,events}.ts` and tests (`events.ts`: the `events.jsonl` and `run.json` schema with its reader and writer, shared by T11 and T12). P2-F3 already includes `bench/**` in `tsconfig.node.json`, ESLint and Vitest, and sets `engines.node` to `>=22.13.0` (`node:sqlite` with no flag) | P2-F3 | M |
| M3-T11 | Benchmark runner, report and canary | desktop | `apps/desktop/bench/cli.ts`, `bench/vite.config.ts`, `bench/run/*` (as built: adapters from the registry, `STT_VENDORS`, with the guard options `createSpeechToText` passes plus the wire tap, which `createSpeechToText` cannot pass; every open through a bench `SttOpenBudget`; `args.ts` parses `run --gate` and routes `clip`, `draft`, `check` and `forget` to M3-T12's `DATASET_COMMANDS`), `bench/report/{report,echo}.ts` (`echo.ts` runs M2's `EchoFilter` over replayed finals; cost from each token's `price_per_hour_usd`, no price table of its own), `bench/canary.ts`, their tests (P2-F3 added the `bench` script) | T10, T4a, T6a, M2-T14a (the pure `EchoFilter`) | M |
| M3-T12 | Test-set tools: clip, draft, check, forget, listen file | desktop | `apps/desktop/bench/dataset/{backup,item,clip,draft,check,forget,commands}.ts` and tests (`commands.ts` exports `DATASET_COMMANDS` for the CLI) (`backup.ts`: the read-only `node:sqlite` reader; FileVault and mode 0700 checks) | T10, M2-T3 (the backup fixture) | M |
| M3-T13 | Docs | repo | `CLAUDE.md` (commands; failure-log lines go through the controller; P2-F3 added the `bench` and `stt-canary` targets), `docs/research/stt-benchmark.md` (method, normaliser v1, choice rule, D2's exception, vendor facts, the presets, how the gate run is read, vendor log, results table), `.env.example` (`ROGER_BENCH_DIR`) | T1, T11, T12 | S |
| M3-T14 | Soniox token issuer and registry entry (optional, D1) | api | `services/stt_tokens.py` (one `SttTokenIssuer`), `stt_vendors.py` (one `STT_VENDORS` entry with its list price and source, one `soniox` preset), `domain.py` (`soniox` in `SttProvider`), `config.py` (`SONIOX_API_KEY` and its case in `stt_vendor_key`), `.env.example` (the key line in the STT section), the Soniox lines in `apps/api/README.md`, `tests/test_stt_token_soniox.py`, the contract's provider line and Soniox's row of its preset price table (with and without a jargon list); in the same three files, the `STT_PRICE_PER_HOUR_USD` wording T3 made false (`phase-2-build-order.md`, section 10). Soniox's `STT_VENDORS` entry needs T3's required `keyterm_surcharge_per_hour_usd`, with its source | T1, T3 (file order in `stt_vendors.py`) | S |
| M3-T15 | Soniox protocol (optional, D1) | desktop | `main/stt/soniox/{messages,SonioxSpeechToText}.ts` and tests (an `SttProtocol` with `audioPacing: 'none'`, framed by the core's `AudioFrameSizer`), one line in `main/stt/registry.ts`, one entry in `stt/testing/conformanceVendors.ts`, and, for the config message Soniox needs before any audio, an optional opening-messages hook in `stt/core/{SttProtocol,SttConnection}.ts` with its conformance case, the Soniox note under "Speech-to-text vendors" in `apps/desktop/README.md` | T4a, T5, T14, T18, M2-T6 (file order in `stt/core`) | M |
| M3-T16 | Build the test set | owner | `$ROGER_BENCH_DIR/items/*` (outside git) | T1, T5, T11, T12, T13, M2-T15 | M (about 2 hours of owner time) |
| M3-T17 | Wire fixtures, bake-off, vendor choice, exit check | owner and agent | `main/stt/assemblyai/fixtures/*.jsonl` (step 0), results in `docs/research/stt-benchmark.md` and the log below; the API `.env` | T3, T5, T6b, T9, T16, T19a, T19b, T20, M2-T5, M2-T10 (T14 and T15 with D1) | S |
| M3-T18 | Pacing and framing in the STT core (closes the cost work's open issue: the reopen flush is not paced) | desktop | `main/stt/core/AudioPacer.ts` and test (pure: audio sent never ahead of real time (monotonic, not the wall clock) since ready by more than one frame, on an injected clock), `audioPacing: 'realtime' \| 'none'` on `core/SttProtocol.ts` and the paced queue in `core/SttConnection.ts` (drained before the finish sequence, inside the hard close timeout), `main/stt/core/AudioFrameSizer.ts` and its test (moved unchanged from `stt/assemblyai/`), AssemblyAI's import and `audioPacing: 'realtime'` in `AssemblyAiSpeechToText.ts`, Deepgram's `none` in `DeepgramSpeechToText.ts`, and a conformance case for every vendor (a 3 s burst right after ready goes out no faster than real time under `realtime`, at once under `none`; nothing stays queued after close); one line in `apps/desktop/README.md` "Add a speech-to-text vendor" (declare `audioPacing`). The comments pacing makes false, and only those lines: in `main/capture/CaptureSession.ts` the `hold()` doc ("sent all at once when the stream opens") and the pacing comment at the held-audio flush in `attach()` (Notes for the builders), in `main/costGuards.ts` the `sttReopenBufferMs` `why` ("Kept short: it is sent at once"), and the README "Cost guards" row "Reopen buffer" that repeats it; the new text says held audio is paced at 1x and adds its own length of lag to that session. Nobody else edits those lines in wave 0 | - | M |
| M3-T19a | STT usage in Postgres and cost per meeting hour | api | `db/models_stt_usage.py` (P2-F2's stub), `migrations/versions/0005_stt_usage.py` (revision `0005`, down `0004`; P2-F2's stub), `services/stt_usage.py`, `schemas/stt_usage.py`, `routers/stt_usage.py` (P2-F2's stub, already included in `app.py`): the idempotent `PUT` per meeting and `GET .../summary`, `tests/test_stt_usage.py`, the contract's "STT usage" section and its Database line. `stop_reason` is bounded free text (null or 1 to 64 characters), never a fixed list: local rows hold M1-era `page-reloaded` (M2-T12 drops it from `StopReason`) and `start-failed`, and M2-T17b adds `call-ended` in wave 7, so an enum would refuse those rows with a 422 forever | P2-F2 | M |
| M3-T19b | Upload STT usage from the Mac | desktop | `main/upload/SttUsageUploader.ts` and test (sends rows whose `synced_at` is null every 30 s and after Stop, backs off on failure, never blocks or waits on `TranscriptUploader`; a `422` is a rejected row, not a failure: logged at warn with the meeting id and the API's message and marked synced, so it is never retried until a later save changes it), `main/api/sttUsageClient.ts` (on P2-F1's `http.ts`) and test, local migration 6 (`stt_usage.synced_at`, `stt_usage.gated_ms`) with `listSttUsageToUpload` and `markSttUsageSynced` in `store/{TranscriptStore,SqliteTranscriptStore,InMemoryTranscriptStore}.ts` (`saveSttUsage` clears `synced_at`; `MeetingSttUsage` gains an optional `gatedMs`, 0 until T20), the M3-T19b runtime slot in `capture/createCaptureRuntime.ts` | T19a, M2-T4 (the slot), M5-T5 (file order in `store/*`) | M |
| M3-T20 | Silence-gated streaming | desktop | `main/capture/SilenceGate.ts` and test (pure: chunk level with `rmsInt16`, the noise floor, the hang-over, the pre-roll ring), `main/capture/CaptureSession.ts` (close on the gate through the normal close; a pause cause per source on `SourceLink`, `stall` or `silence`, so the `paused` branch of `pushAudio` reopens a gated source only on a speech chunk, and `resumeStreams()` and the wake keep a gated source gated; the token prefetched at the close and refreshed before its TTL; reopen on speech with the pre-roll as held audio under the bound pre-roll plus `sttReopenBufferMs`, the pre-roll never counted as dropped; every gate reopen through M2-T4's minute-only acquire on `SttOpenBudget` plus the gate's own per-meeting count, and the gate off for the meeting once that is spent; the 60 s minimum; no gap for a gated window, and a failure or budget gap on a gated source starting at the speech onset, in M2-T6's one gap-start function; `gatedMs` per source; capture events; a second `LatencyMeter` per source for words of gate-reopened sessions, logged with T6b's `stt latency`), `main/capture/CaptureService.ts` (the meter's `gatedMs`, `estimatedSavedUsd` and `silenceGate`, saved as `stt_usage.gated_ms`; the token's expiry in the credentials it hands the session), `main/costGuards.ts` and test (`sttSilenceCloseSeconds`, `sttSilencePreRollSeconds`, `sttSilenceReopensPerMeeting`, the pre-roll plus reopen buffer check), `shared/capture.ts` (optional `SttMeter.gatedMs` and `estimatedSavedUsd`, optional `SttMeterStatus.silenceGate` (`on`, `off`, `spent`), so no `SttMeter` value built by another task's tests, shots or fixtures breaks; the `paused` doc comment covers silence), `renderer/src/format.ts` and test ("saved about $0.03 in silence" on the meter line; "silence gate off for this meeting" in `meterDetails` when spent; `paused` with health `active` reads "closed while silent, reopens on speech"), the gate rows of the "Cost guards" table in `apps/desktop/README.md` and their `ROGER_*` lines in `.env.example` (`costGuards.test.ts` fails without both), the rule 9 phrase in `CLAUDE.md` ("a silent one after the stall window" also covers a source the gate closes, which reopens only on speech), `bench/run/replay.ts` (`--gate`, with the prefetched token, and each reopen's backlog in `run.json`; T11 already parses `--gate` and passes it to the replay, which refuses `gate: true` until this task replaces the refusal), the gate settings' path from `bench/cli.ts` through `RunDeps` in `bench/run/run.ts` to the replay, and the `--gate` columns of `bench/report/report.ts` (first-word misses, gate reopens and backlog, the reopened words' latency against the run without the gate) | T4b, T6b, T11, T18, T19b, M2-T4 (the minute-only acquire), M2-T5, M2-T6, M2-T20a, M5-T5 (file order) | M |

Waves for parallel worktrees are in `phase-2-build-order.md`, which wins where this plan differs:
T6a and T18 in wave 0; T1, T2, T4a and T10 in wave 1; T3, T5, T7, T8, T11 and T12 in wave 2; T13,
T14 and T19a in wave 3; T6b in wave 4 (after M2-T6); T4b, T9, T15 and T19b in wave 5; T20 in wave
6. Then T16 and T17 (owner).

Ordering for the controller: merge T4a before any call or bench run that goes to Deepgram (run A,
the two-vendor draft), or that audio goes to Deepgram without `mip_opt_out`. M2's exit-check calls
run on AssemblyAI, opted out in its dashboard, so they no longer wait for T4a.

- [x] M3-T1 · [x] M3-T2 · [x] M3-T3 · [x] M3-T4a · [ ] M3-T4b · [x] M3-T5 · [x] M3-T6a · [ ] M3-T6b
- [x] M3-T7 · [x] M3-T8 · [ ] M3-T9
- [x] M3-T10 · [x] M3-T11 · [x] M3-T12 · [ ] M3-T13 · [ ] M3-T14 · [ ] M3-T15 · [ ] M3-T16 · [ ] M3-T17 · [x] M3-T18
- [ ] M3-T19a · [ ] M3-T19b · [ ] M3-T20

Notes for the builders:

- House rule 9 (CLAUDE.md): an adapter only describes its protocol; `SttConnection` opens, times,
  keeps alive, paces and closes every socket, and every open acquires from `SttOpenBudget` right
  before `openStream`: `CaptureSession`'s opens, M2-T16's re-run and the bench (its own budget).
  M2-T4 rewords the rule and the `SttOpenBudget` doc comment to name those callers in wave 2, with
  the minute-only acquire that the re-run and T20's gate reopens use; T20 adds the gate to the
  rule's "no audio, no session" sentence. A vendor change that needs the socket to do something
  new adds a field to `SttProtocol`, applies it in the core, and adds a conformance case. No
  adapter retries a connect.
- Never log an AssemblyAI socket URL: the temporary token is in it (the core already logs host,
  label and model only). `run.json` stores the query with the token removed; the wire tap is given
  that query, never the URL.
- Landed and kept: the AssemblyAI protocol resolves on `Begin` within the core's one 10 s connect
  deadline; a close before `Begin` is an `SttConnectError` with the code's meaning; no keep-alive
  (audio, silence included, flows while the source is open, and `inactivity_timeout` is the
  vendor-side net); stop sends `Terminate` after the padded tail, waits for `Termination`, and the
  core terminates after 5 s. A final's times come from its first and last word; its confidence is
  the mean word confidence.
- T18 puts this comment in `stt/core/SttConnection.ts` at the paced queue and in
  `CaptureSession.ts` where held audio is flushed (`attach()`, a line T18 owns in wave 0 with the
  `hold()` doc): AssemblyAI takes no audio faster than real time (3007), so held audio is paced
  and adds its own length of lag to that session; the window beyond the held audio becomes a gap
  for M2-T16's re-run, never an inline replay.
- Pacing lives in the core (T18), where no caller can skip it. Write that where someone would add
  a shortcut: a raw `socket.send(pcm)` closes the session with 3007 the first time a flush or a
  pipe read sends more than real time.
- `stream.encoding` is the app's canonical `linear16`. Translate it inside the protocol; never ask
  the API for a vendor term. Say this in `streamSettings.ts` too.
- Alembic: the revisions are `0002` (T2, down `0001`) and `0005` (T19a, down `0004`), fixed in
  `phase-2-build-order.md` (M4 is `0003`, M5 is `0004`). Fill the stubs P2-F2 made; never
  re-point them.
- `stt/core/*` and the conformance suite are edited by T18 (wave 0), T4a (1), T5 (2), M2-T6 (4,
  ping liveness) and T15 (5), one per wave; each adds its own conformance case and keeps every
  other one green. `CaptureSession.ts` is edited by T18 (wave 0, two comments only), M2-T5, then
  M2-T6 and T6b (wave 4, in that order), then T4b, then T20; keep each edit in its own block.
- `costGuards.test.ts` fails when a guard is missing from the README's "Cost guards" table or from
  `.env.example`; T20 adds its three settings to all three places in one commit.
- T20 reopens a gated source with the minute-only acquire and its own count, never the meeting's
  allowance (`sttOpensPerMeeting`), which Start, stall and failure reopens need. Put that in a
  comment at the gate's reopen and point at `SttOpenBudget`'s doc comment: a gate reopen through
  the plain `acquire()` spends a failing vendor's allowance in a stop-and-start meeting and leaves
  M2-T16 nothing.
- `bench/core/wav.ts` only reads and writes 16 kHz mono PCM16 files. If M2-T15's
  `src/main/backup/wav.ts` has landed, import its header code instead of writing a second copy.

## Tests

| What | Test |
| --- | --- |
| `STT_PROVIDER` alone picks the preset's vendor, model and price; every bake-off configuration loads from one base env (every key set) by changing only `STT_PROVIDER`, each returning its own model; an unknown preset, a missing key and a non-blank leftover `STT_MODEL` are refused at startup by name (a blank one is unset); every preset's vendor is in `STT_VENDORS` and the desktop's registry ids match; a TTL over the vendor maximum is still refused (landed); `stream.encoding` is `linear16` for every preset; switching only `STT_PROVIDER` changes the token response | `apps/api/tests/test_stt_providers.py`: `test_stt_provider_alone_picks_the_preset_vendor_and_model`, `test_every_bakeoff_config_differs_from_every_other_by_one_line`, `test_unknown_preset_is_refused_at_startup`, `test_retired_stt_model_is_refused_by_name`, `test_missing_key_for_the_chosen_vendor_is_refused`, `test_every_preset_names_a_registered_vendor`, `test_stream_encoding_is_linear16_for_every_preset`, `test_switching_stt_provider_changes_the_token_response`, `test_issuer_opens_for_every_preset` (`assemblyai-pro` builds the AssemblyAI issuer, no `KeyError`); the landed `tests/test_config.py` TTL and price cases stay |
| AssemblyAI token request (landed): exact URL, query with the TTL and `max_session_duration_seconds=10800`, raw key header; failures raise `SttProviderError`; the key never reaches a log line. Stream settings and price from a preset: the preset's model and sample rate, the price override, and null for a model with no list price | `apps/api/tests/test_stt_token.py` (the landed `test_assemblyai_*` cases unchanged; T1 rewrites the three `stt_model="nova-2"` cases as preset cases, and T3 adds its keyterm cases in wave 2) |
| Jargon list: PUT replaces the whole list, GET sorts ignoring case, duplicates keep the first spelling, every limit is a 422, PUT is idempotent, another workspace's rows are never read or deleted, bearer token required | `apps/api/tests/test_vocabulary.py`: `test_put_replaces_the_whole_list`, `test_get_sorts_ignoring_case`, `test_duplicates_keep_the_first_spelling`, `test_limits_are_validation_errors` (101 terms, 51 characters, 801 in all, blank, control character), `test_put_is_idempotent`, `test_other_workspace_terms_are_never_read_or_deleted`, `test_vocabulary_needs_the_bearer_token` |
| Migrations form one chain | `apps/api/tests/test_migrations.py`: `test_alembic_has_one_head` (plus the existing models-match test) |
| Token carries the caller's keyterms, `[]` when none, never another workspace's; the price includes the keyterm surcharge only when the list is not empty, and none for the Pro model | `apps/api/tests/test_stt_token.py`: `test_token_carries_the_workspace_keyterms`, `test_token_keyterms_empty_when_no_list`, `test_token_never_carries_another_workspace_terms`, `test_keyterm_surcharge_only_with_a_list` |
| Usage upsert is idempotent and keeps one row per workspace and meeting; it needs no meeting row; another workspace's rows are never read or overwritten; `stop_reason` takes any short text (`page-reloaded`, `start-failed`, `call-ended`) and refuses only a blank or over-long one; the summary sums cost, stream hours, meeting hours and gated hours, and names meetings with an unknown price instead of counting them as zero; bearer token required | `apps/api/tests/test_stt_usage.py` |
| Deepgram URL: one `keyterm` per term with spaces encoded, always `mip_opt_out=true`, no `keyterm` without a list, an over-long list cut with a warning. An HTTP 400 at connect with keyterms rejects with `keytermsRejected` and no second handshake; without keyterms it is a plain connect error | `apps/desktop/src/main/stt/deepgram/DeepgramSpeechToText.test.ts`, `src/main/stt/keyterms.test.ts` |
| Every registered vendor: a connect refused for its keyterms is reported as `keytermsRejected`, with exactly one handshake and no socket left open | `apps/desktop/src/main/stt/conformance.test.ts` |
| A source whose connect is rejected for its keyterms reopens once without them through `SttOpenBudget`, raises the quiet `keyterms_rejected` warning, and later reopens of that source carry no keyterms; a failing retry reports both reasons; nothing retries when the list is empty | `apps/desktop/src/main/capture/CaptureSession.test.ts`, `CaptureService.test.ts` |
| A token response without `keyterms` reads as an empty list | `apps/desktop/src/main/api/ApiClient.test.ts` |
| An `assemblyai` token response with `stream.encoding` `linear16` passes the mismatch check | `apps/desktop/src/main/stt/streamSettings.test.ts` |
| AssemblyAI messages, run on the fixture files: a Pro `end_of_turn` is final with word timings. On Universal-Streaming (landed tests kept), a raw `end_of_turn` is held; its formatted copy replaces it; it is saved as it is when the next turn arrives, after 2 s (fake timers) or at `Termination`; a formatted copy after that is ignored. A repeated `turn_order` is ignored within one stream, and a new stream starts its own set. An `Error` frame before a close adds its text, and a close with no `Error` frame is enough. Unknown types are ignored; malformed input is `invalid`, never a throw. | `apps/desktop/src/main/stt/assemblyai/messages.test.ts`, `AssemblyAiSpeechToText.test.ts` |
| AssemblyAI stream against a local websocket server: URL per model (keyterms JSON, `language_codes=["en"]` on the Pro models only, plus the landed token, rate, `encoding=pcm_s16le`, model, `format_turns` on Universal-Streaming only, `inactivity_timeout`); 1008 or 3009 before `Begin` is a plain connect error, any other close frame before `Begin` with keyterms is `keytermsRejected` (a 1006 drop is a plain connect error, `SttConnection.test.ts`); model mismatch warns; the token appears in no log line | `apps/desktop/src/main/stt/assemblyai/AssemblyAiSpeechToText.test.ts` |
| Pacing on a manual clock: live 100 ms chunks are never held; a 3 s backlog right after ready goes out at 1x; audio sent never runs ahead of real time (monotonic, not the wall clock) since ready by more than one frame; close drains the queue before the finish sequence and the hard timeout still bounds it; a `none` protocol sends a backlog at once. The frame sizer's landed cases run from `stt/core/` | `apps/desktop/src/main/stt/core/AudioPacer.test.ts`, `core/SttConnection.test.ts`, `core/AudioFrameSizer.test.ts`, `src/main/stt/conformance.test.ts` |
| The wire tap sees every message both ways and the query without the token, never the URL | `apps/desktop/src/main/stt/conformance.test.ts` |
| Each provider name picks its registered adapter; an unknown one (and `constructor`) is refused (landed); every registered network vendor has a conformance entry (landed) | `apps/desktop/src/main/stt/createSpeechToText.test.ts`, `conformance.test.ts` |
| Word latency: a word's display latency is the first covering event's arrival minus the word's capture time (via `AudioTimeline`); a 4 s stall followed by a partial covering the stalled words reports about 4 s, not 0.5 s; final latency; p50 and p95 are right; the longest wait is the largest word latency; the bucket count is fixed and the end-point list stays bounded over 2 hours of synthetic events; the session logs `stt latency` per stream at close | `apps/desktop/src/main/stt/LatencyMeter.test.ts`, `src/main/capture/CaptureSession.test.ts` |
| Live transcript: a final replaces its own source's interim; the other source's interim survives; a stale interim is dropped; lines sort by start, mic before system, then id; a re-sent final is ignored; a new meeting clears all (hidden ids too); following live pauses when scrolled up (reveal is tested in M4-T21's `transcriptNavigator.test.ts`). `segmentChanged` `hidden` after display hides the line; before display (a held line) it hides the line when it arrives; `trimmed` replaces the text; `unhidden` shows it; `showHidden` on shows them marked, off hides them again | `apps/desktop/src/renderer/src/transcript/liveTranscriptModel.test.ts` |
| Jargon limits match the API's; IPC rejects non-string lists and oversized payloads; GET and PUT request shapes; the editor refuses to save after a failed load | `apps/desktop/src/shared/vocabulary.test.ts`, `src/main/ipc-validation.test.ts`, `src/main/api/ApiClient.test.ts`, `src/renderer/src/settings/vocabularyEditor.test.ts` |
| Transcript and editor in the real app: light and dark themes, empty state, a 500-line call with interims, a hidden echo line toggled, "Jump to live", saving the list, an API error | Browser check with screenshots and a QA gallery (house handover norm), T9 |
| Each normaliser rule; WER with known substitutions, deletions and insertions; empty reference; Me and Them split; pooling; seeded bootstrap; term recall and false alarms; reference parser; WAV read refuses non-16 kHz, stereo and non-PCM16 with a clear message; WAV write round-trips; `events.jsonl` and `run.json` round-trip | `apps/desktop/bench/core/*.test.ts` |
| Replay paces 100 ms chunks at 1x (fake timers); both streams of an item run at once; events keep arrival times; each item fetches its own token, so the 4th round of a `--parallel 3` run uses a new one; opens wait for the bench's `SttOpenBudget`, so a 5-a-minute limit is never exceeded; a provider or model change mid-run stops it with both names; one injected 3009 is retried and recorded in `run.json`; an item failing three times is failed; `run.json` holds the adapter query without the token; `--no-keyterms` empties the list; a bench dir inside any git checkout is refused; the fake adapter end to end yields a report; the summary has no transcript text; cost comes from each token's price, and an unknown price is reported as unknown | `apps/desktop/bench/run/*.test.ts`, `bench/report/report.test.ts` |
| `--gate` replay: a silent stretch past the hang-over closes the item's session and the next speech reopens it with the pre-roll and a prefetched token; each reopen's backlog is in `run.json`; gated time, savings, first-word misses, gate reopens and the reopened words' latency against the run without the gate are reported | `apps/desktop/bench/run/replay.test.ts`, `bench/report/report.test.ts` |
| Echo-aware scoring: a fixture with Them's words echoed on the mic does not raise Me WER after the filter, while the raw-mic column shows the insertions; a headphones item is not filtered; a meet-recording item is left out of Me WER and the mic latency gate; without the filter, speaker items are left out of the pooled number and the report says so | `apps/desktop/bench/report/echo.test.ts` |
| Canary: with `provider=fake` only a final within 10 s is checked and "WER not checked (fake provider)" is printed; with a real provider, WER above 15% or no final in 10 s fails; `--save-wire` writes the raw messages | `apps/desktop/bench/canary.test.ts` |
| Clip reads M2-T15's fixture through read-only `node:sqlite`, skips rows with `deleted_at`, cuts exact sample windows and fills the gap with silence; a missing database names the path and `--user-data`; it refuses when FileVault is off (injected) and creates the bench dir with mode 0700. Draft marks only disagreements and puts Me and Them in time order; check reports braces with line numbers and items with no consent; `listen.wav` is mic left, system right; `forget --person` removes that person's items and their run outputs and keeps the others | `apps/desktop/bench/dataset/*.test.ts` |
| Local migration 6 on a database at schema 5 keeps every `stt_usage` row (`synced_at` null, `gated_ms` 0); a save clears `synced_at`; the uploader sends each changed row once, marks it synced, backs off on failure, and a row saved again after its upload is sent again; a `422` is logged once and the row is not sent again until a later save; it never waits on the transcript uploader | `apps/desktop/src/main/store/SqliteTranscriptStore.test.ts`, `src/main/upload/SttUsageUploader.test.ts`, `src/main/api/sttUsageClient.test.ts` |
| Silence gate on a manual clock: 30 s of near-zero chunks closes the source's session through the normal close (last lines saved) and leaves it `paused` with the silence message and cause; further silent chunks never reopen it, and the next speech chunk reopens it with the prefetched token (no API call at the onset), the pre-roll sent first and its first line dated at meeting time; with a 2 s pre-roll a 1.5 s connect keeps the whole pre-roll and logs no "audio dropped while reconnecting"; the token is refreshed before its TTL while gated, and a failed prefetch falls back to a fetch at the onset; a stall (no chunks) still takes G2's path and reopens on any chunk; a gated source stays gated across an offline flip (`resumeStreams()`) and a wake, and reopens only on speech; a gate reopen takes a per-minute slot and never the meeting's allowance, so the meeting's `sttOpensPerMeeting` is untouched after 30 gate cycles; when the gate's own reopens are spent, one log line, the status reads `silenceGate` `spent`, and the sessions stay open through silence; no close within 60 s of an open; a plain gated window writes no gap row, and a speech reopen that fails or waits on the per-minute window writes a gap that starts at the speech onset, so M2-T16 never re-runs a gated window; a quiet room's noise floor never counts as speech, a soft voice 9 dB over it does; `gatedMs` and `estimatedSavedUsd` reach the status, the `stt meter` log and `stt_usage.gated_ms`, and an `SttMeter` without them still formats; words of gate-reopened sessions are logged in their own `stt latency` figures; `sttSilenceCloseSeconds` 0 turns it off; each setting validated (a pre-roll plus reopen buffer over 10 s is refused) and listed in the README and `.env.example`; `paused` with health `active` reads "closed while silent, reopens on speech" | `apps/desktop/src/main/capture/SilenceGate.test.ts`, `CaptureSession.test.ts`, `CaptureService.test.ts`, `src/main/costGuards.test.ts`, `src/renderer/src/format.test.ts` |
| Exit check: wire fixtures recorded; chosen vendor's WER written down; one-line vendor switch; word display latency on a real call with the gate on; cost per meeting hour from the usage summary | Exit check log below (T17) |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| No test set today: no calls recorded yet, or M2's backup not merged | `bench clip` finds no meeting | M3 reports "code complete" without it. Meet recordings make system-only items (scored on Them only), or a few 3-minute internal calls are recorded on purpose. The close can come a day later without blocking M4 or M5. |
| Backup deleted before clipping (7-day retention) | `clip` reports missing audio | Clip within the week. T16 lists the meetings to clip as soon as they are recorded. |
| The reference leans toward the vendor it was drafted from | One vendor scores oddly well on the items it drafted | Two-vendor braces, a full listen-through, the drafting runs recorded per item. Runs C and D never draft, so they act as a check. |
| 10 clips are too few to separate vendors | Bootstrap intervals overlap | The tie rule (within 1.0 point: term recall, then cost). The set is standing, so items can be added later. |
| Echo on speaker items rewards the vendor that transcribes it best | Raw-mic Me WER far above filtered Me WER | Me is scored after M2's echo filter, the text the user sees. Without the filter, speaker items leave the pooled number. |
| A tooling failure disqualifies a vendor (expired token, a 3009, a network blip) | Failed items in `run.json` | A fresh token per item and 2 retries; the gate reads "no item failed after retries". |
| The jargon list over-biases ("linked" becomes "Linkt") | Term false alarms | Drop or respell the term. Run E measures the list's net effect. |
| A vendor rejects the jargon list at connect | "Jargon list rejected" warning | One reopen without the list, through the open budget, so the call keeps its transcript. Fix the list, then run the canary. |
| AssemblyAI stores each line twice, or loses a raw turn | Doubled or missing lines in the local store | The pending-final rule in Design, with tests on recorded wire JSON. |
| AssemblyAI's wire format differs from its docs (the two error pages already disagree) | Message tests fail on the recorded fixtures | Close step 0 records real JSON per model before the bake-off; the adapter is fixed against it. |
| AssemblyAI quietly runs another model | `Begin.configuration.model` differs | The presets in `stt_vendors.py`; the protocol's warning. |
| AssemblyAI closes with 3007 (frame size, or faster than real time); today the reopen flush of up to 3 s of held audio is not paced (the M1 cost work's open issue) | Close code 3007 in the log, right after a reopen | The landed frame sizer keeps every frame 50 to 1000 ms; T18 paces every send in the core, so no flush, pre-roll or re-run is sent faster than real time. Until T18 lands, `sttReopenBufferSeconds` can be lowered to 1. The protocol names 3007 in its error. |
| Paced held audio adds lag: a reopened or un-gated session runs up to its held audio (3 s, or the gate's pre-roll plus the connect time) behind live for as long as it stays open | `stt latency` p95 over 2 s after reopens; the reopened words' figures in the bake-off's gate run | The lag ends when that session next closes; AssemblyAI documents no tolerance to catch up above 1x. The gate keeps it small: a 1 s pre-roll and a prefetched token (connect without the API round trip). If run F adds more than 2.0 s, check the backlog per reopen in `run.json` (a slow connect, a prefetch that failed) before turning the default off; the vendor choice itself runs without the gate. |
| The silence gate loses first words or real soft speech | First-word misses in the gate run; lines missing after a quiet stretch | The threshold leans to speech (a wrong "speech" only costs money), a 1 s pre-roll (up to 3 s by setting), a 30 s hang-over; the run measures it; `sttSilenceCloseSeconds=0` turns it off (D5 records the default). |
| The gate spends the open budget that failures need | "opens spent" errors in long calls; M2-T16 re-runs refused | Gate reopens count in the per-minute window and their own 120 per meeting, never in `sttOpensPerMeeting`; M2-T16's re-runs count in the minute only too; no gate close within 60 s of an open. Past its own count the gate is off for that meeting and says so. |
| The API is down when someone speaks after a silence | A gate reopen that fails at its token fetch | The token is prefetched at the close and refreshed while gated, so the onset needs no API call while the API was up during the silence; otherwise the reopen goes through G3's retry and the window from the onset is a gap M2-T16 re-runs. |
| A long reconnect on AssemblyAI leaves text missing until Stop | A gap row for the window | M2-T16 re-runs the gap at Stop. The live view shows the reconnect state meanwhile. |
| The temporary token leaks into logs (AssemblyAI puts it in the URL) | A token in a log file | URLs are never logged (the core logs host, label and model); `run.json` and the wire tap get the query without it; a test checks it. |
| Opting out costs double at Deepgram | The owner's price check | Cost per meeting hour uses the opted-out price (`STT_PRICE_PER_HOUR_USD` overrides the table for the run). It may change the choice. |
| Audio reaches Deepgram without `mip_opt_out` | A Deepgram run before T4a merged | T4a merges in wave 1, before any bench run on Deepgram. The app's calls go to AssemblyAI, opted out in its dashboard before M1's real call. |
| Usage never reaches Postgres, or is counted twice | The summary's meeting count differs from the meetings with `stt_usage` rows on the Mac | One row per workspace and meeting, upserted (idempotent); a local save clears `synced_at` so the latest totals are sent again. |
| Keeping colleagues' audio goes beyond the audio policy | Owner or legal review | D2 makes it an explicit, signed exception, with consent per person, FileVault, mode 0700 and `forget`. |
| System audio still broken after a restart (today's bug) | "No system audio" in the app | M2 and the Swift helper (C1). The bake-off runs on clips and does not need it; close step 4 waits for M2-T10. |
| Parallel worktrees edit shared files (`CaptureSession.ts`, `CaptureService.ts`, `SpeechToText.ts`, `stt/core/*`, the conformance suite, `stt_vendors.py`, `costGuards.ts`, `ipc.ts`, `ApiClient.ts`, `models.py`, `schemas/stt.py`, the Alembic head, `api-contract.md`, `Makefile`, `package.json`) | Merge conflicts; two Alembic heads | One writer per wave from section 3.1 of `phase-2-build-order.md`; small additive edits in their own blocks; the one-head test; fixed `down_revision`s. T3 waits for T1 because both edit `schemas/stt.py`, `stt_vendors.py` and `tests/test_stt_token.py`. |
| Long calls hit session limits: AssemblyAI at 3 hours (3008), Soniox at 300 minutes | A stream closes mid-call | Landed: the session reopens after 2 s through the open budget (G3); M2-T6 records the gap and M2-T16 re-runs it. A recording stops at 4 hours anyway. |

## Dependencies on other Phase 2 plans

| Needs | From | Used by | If it is late |
| --- | --- | --- | --- |
| Shell: the meeting route and page frame with a transcript region, a Settings section slot, theme tokens, the meeting page passing a meeting's stored lines and the `showHidden` state to `LiveTranscript`, and the Chrome preview with a fake `window.roger` | M4-S1 (routes, Settings slot), M4-S2 (tokens), M4-S3 (preview), M4-S4 and S4b (meeting page, stored lines) | T9 | They land in waves 1 to 3, before T9 (wave 5); no mount in M1's window. |
| M2-T3 and M2-T15: the `audio_files` schema and a committed fixture (a small `roger.sqlite` plus two short m4a and WAV chunks with a gap between them, made by M2-T3 in wave 1), and backup chunks per meeting and stream written by M2-T15 (read as stated under "Where recordings come from") | M2 | T12 `clip`, T16 | T12 uses the fixture from wave 2; real clips wait for T15 and recorded calls. Meet recordings make system-only items. |
| M2-T5: `AudioTimeline` mapping vendor time to the clock time a sample was captured | M2 | T6b, T17 step 4 | T6's meter merges alone; the bench's latency numbers do not need it. |
| M2-T6: ping liveness in the core, offline handling, gap rows and the watermark, on top of the landed reopen (no wrapper, no replay); M2-T16: the gap re-run from the backup | M2 | T4b, T6b and T20 (file order in `CaptureSession.ts`), T15 (file order in `stt/core`) | Until they land, the landed reopen holds: a failed session reopens with 3 s of held audio and the rest of the window is lost from the live text. |
| M2-T20a: the capture status UI that replaces M1's `StatusPanel` and keeps its meter line | M2 | T20 (the savings wording in `format.ts`) | T20 waits for it (wave 6 after wave 5). |
| M2-T4: session event listeners and a runtime slot for the usage uploader; `SttOpenBudget`'s minute-only acquire and the budget injected from `createCaptureRuntime.ts` | M2 | T19b, T20 (gate reopens) | Both wait for it (waves 5 and 6 after wave 2). |
| M2-T6: one function that decides where a gap starts, and the `paused` reopen decision kept in `pushAudio` | M2 | T20 (a gated source's gap starts at the speech onset; a gated source stays gated after `resumeStreams()`) | T20 waits for it (wave 6 after wave 4). |
| M2-T10: call audio through the Swift helper, which survives an app restart | M2 (C1) | T17 step 4 | Steps 0 to 3 go ahead; step 4 waits. |
| M2-T11: capture warnings (`CaptureWarning`) | M2 | T4b | The rejected-list warning is a warn log line; the canary catches a rejected list. |
| M2-T14a: a pure, vendor-free `EchoFilter` that plain Node can import (wave 0); M2-T2: the `transcript:segment-changed` contract (wave 1), which M2-T14b emits | M2 | T11 `score`, T7 | Both land before T7 and T11 start. |

Cross-plan edits (applied on 2026-10-06 with `phase-2-build-order.md`; kept here so both sides say
the same):

1. **M2-T6** (rewritten after `m1-assemblyai` landed): no `ResilientSttStream` and no
   `inlineReplay`. M2-T6 adds ping liveness to the shared core, offline handling, gap rows and the
   watermark on top of the landed reopen; every reconnect window beyond the held audio becomes a
   gap for M2-T16. The comment from "Notes for the builders" goes at the paced queue in
   `SttConnection.ts` and at the held-audio flush in `CaptureSession.ts`.
2. **M2-T2, M2-T14b and M2-T20:** the IPC event is `transcript:segment-changed` (key
   `TranscriptSegmentChanged`, preload `onTranscriptSegmentChanged`), with the payload
   `{ meetingId, segmentId, source, change: 'hidden' | 'trimmed' | 'unhidden', reason: 'echo',
   echoOf, text }`. It replaces the earlier `segment-hidden` name, so a trimmed line updates too.
   M3-T7 renders the hidden state and the effect of the toggle. M2-T20 owns only the control, a `showHidden` boolean that
   the meeting page passes to `LiveTranscript`. `EchoFilter` stays free of Electron imports so the
   bench can load it.
3. **M2-T3 and M2-T15:** the `audio_files` contract above; M2-T3 commits the fixture under
   `apps/desktop/test/fixtures/backup/`.
4. **M4:** the transcript panel is M3-T7's `LiveTranscript`, mounted by M3-T9. The citation
   navigator is M4-T21's (`transcriptNavigator.ts`); `LiveTranscript` registers with it and M4's
   chips call it.
5. **SHELL scope** (M4 D6, M5 D4): the transcript panel is not SHELL's to build.
6. **Roadmap:** the open decision "Policy on keeping audio" links to D2's exception.
7. **Merge order:** M3-T4a merges before any Deepgram bench run. M2's exit-check calls run on
   AssemblyAI (opted out in its dashboard) and no longer wait for it.
8. **M2-T16 and the bench:** every vendor session outside a live recording (a gap re-run, a bench
   item) takes a slot from an `SttOpenBudget` first; the re-run's usage is added to the meeting's
   `stt_usage` row. The re-run uses the shared budget (M2-T4 builds it in `createCaptureRuntime.ts`
   and injects it) through the minute-only acquire, so it never draws on a live meeting's allowance;
   the bench uses its own budget with no meeting limit.
9. **M2-T20a and T20:** the capture status UI keeps the landed meter line; T20 adds the silence
   savings to it in `format.ts` (wave 6, after M2-T20a in wave 5). The new `SttMeter` fields are
   optional, so M2-T20a's tests and shots and M4-S3's fixtures need no edit.
10. **M2-T23 and M2-T4:** a resumed meeting adds to its saved `stt_usage` row, so T19b uploads one
    honest total per meeting. Its open allowance starts afresh: the saved `sessions_opened` also
    counts gate reopens and re-runs, which count in the minute only, so seeding from it could
    refuse the resume's own Start, and a relaunch happens once per meeting (M2 D7).
11. **M2-T6, M2-T18 and T20:** a gated window is never a gap; a failure or budget gap on a gated
    source starts at the speech onset; a gated source stays gated across `resumeStreams()` and the
    wake. M2-T6 keeps the gap start in one function and the reopen decision in `pushAudio`, so T20
    changes one place each.

## Exit check log

Filled in when the check runs. Record per configuration: date, preset, provider and model, pooled
WER with interval, Me (filtered and raw) and Them WER, term recall and false alarms, word display
and final latency p95, longest wait, retried and failed items, cost per meeting hour. Then the
chosen vendor and why, the real-call `stt latency` line (the figures outside and inside
gate-reopened sessions), the screenshot link, the wire fixtures' commit, and the two vendor flips.

## Review

Engineer: pending.
