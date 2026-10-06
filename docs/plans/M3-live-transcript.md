# M3. Live transcript

**Phase:** 2 · **Status:** draft · **Owner:** Rahul · **Plan written:** 2026-10-06 · **Closed:** -

## Goal

Live text you can trust while the call runs, and a measured reason for the vendor behind it. Words
show within about 2 seconds under Me and Them. They show grey while they may still change, then the
final line replaces them. Names like Linkt come out spelled right, because every stream carries the
workspace's jargon list. A standing test set of our own calls scores every vendor and model the same
way. The vendor is picked on those numbers, and switching it is one line in the API's `.env`.

## Done when

The exit check from `docs/roadmap.md`, word for word:

- [ ] Done when: the error rate of the chosen vendor is written down, and swapping vendor is one
  config change.

The milestone's other two promises are checked on the same day:

- [ ] Text shows within about 2 seconds, labelled Me and Them. Measured per word: p95 display
  latency of 2.0 s or less for both streams, in the bake-off and in the app log of one real call.
  The longest single-word wait is written down next to it.
- [ ] The jargon list works. On the test set, the chosen vendor's term recall is higher with the
  list than without it, and its term false alarms are written down next to it.

M3 has two states, because the test set needs about 10 recorded internal calls that do not exist
yet:

- **Code complete** (possible today): T1 to T13 and T18 merged (T14 and T15 too with D1), and
  `make check` green on `phase-2`. Everything runs against the fake provider and the fixtures.
- **Closed:** T16 and T17 done once enough calls are recorded through M2's backup and fixed by
  hand. Only then is the milestone done.

How the close is run (M3-T17):

0. With a key, run `make bench ARGS="canary --save-wire <dir>"` once with
   `STT_PROVIDER=assemblyai` and once with `assemblyai-streaming`. Commit the recorded JSON
   (synthetic voice, nothing private) under `apps/desktop/src/main/stt/assemblyai/fixtures/`.
   `make check` must stay green on it (T5's message tests run on these files).
1. Delete `STT_MODEL` from the API `.env` (the API refuses to start and names it if it is left).
   Rebuild and install the app once with the M3 adapters (`make install-desktop`). From then on no
   desktop rebuild is allowed until step 5.
2. For each configuration in the bake-off table, change only `STT_PROVIDER` in the API `.env`,
   restart the API, and run `make bench ARGS="run"`. Then run the winner once more with
   `--no-keyterms`. `make bench ARGS="score"` scores every run.
3. Apply the vendor choice rule below. Write pooled WER, Me WER (after the echo filter), Them WER,
   term recall, term false alarms, word display latency, longest wait and cost per meeting hour
   into `docs/research/stt-benchmark.md` and into the exit check log here.
4. Set `STT_PROVIDER=<winner>`. That is the only line that changes. Restart the API and hold a real
   call of at least 10 minutes from the installed Roger.app, with call audio coming through M2's
   Swift helper. The `stt latency` log line at Stop must show a word display p95 of 2000 ms or less
   for mic and for system. Take a screenshot with an interim line and both labels on screen.
5. Set `STT_PROVIDER=<runner-up>`, restart the API, press Start: the same installed app now
   transcribes with the other configuration. Set it back. This is the "one config change" proof.

## In scope

- AssemblyAI Universal-Streaming (v3) as a second vendor: an adapter on the desktop behind
  `SpeechToText`, and a temporary token minted by the API. The key never reaches the app.
- Presets on the API. `STT_PROVIDER` picks a preset: a vendor plus a model, read from that vendor's
  own model setting with a default. Every bake-off configuration is one line from every other. The
  API refuses to start with a model off the preset's list, a missing key, or the retired
  `STT_MODEL`.
- A jargon list per workspace in Postgres, edited in the app, delivered with every STT token. It is
  sent as Deepgram `keyterm` and AssemblyAI `keyterms_prompt`. A list the vendor rejects never
  stops a call: the stream reconnects without it and says so.
- Deepgram requests opt out of model training (`mip_opt_out=true`).
- An audio framer that sends AssemblyAI exactly 100 ms frames, never faster than real time.
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
- Optional, decision D1: Soniox real-time as a third vendor.

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
- Budget alerts on speech-to-text cost: later. M3 writes the price per meeting hour down.
- Languages other than English, and a per-meeting language choice.

## Design

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| Second vendor | AssemblyAI Universal-Streaming v3. Default model `universal-3-6-pro`. Since 2026-10-06 (owner decision, branch `m1-assemblyai`, landed before Phase 2) AssemblyAI Universal-Streaming English is already M1's vendor, with a token issuer, an adapter, a parser and `AudioFrameSizer`; M3-T1, T5 and T18 extend that code rather than write it fresh. | Speechmatics, OpenAI realtime | The roadmap named it. It has temporary tokens, keyterms, built-in formatting on the Pro model and published prices. Two MIT clients exist to learn from: openwhispr `src/helpers/assemblyAiStreaming.js` and anarlog `crates/owhisper-client/src/adapter/assemblyai/live.rs`. |
| Third vendor | Soniox `stt-rt-v5`, as optional tasks T14 and T15 (decision D1) | Stop at two vendors with three configurations | Its docs are the only ones that say it never trains on customer content. It also has the lowest live price ($0.12 per hour). Its replies come as single tokens, not lines, so its adapter is the most work, and it goes last. |
| How the API names the vendor and model | `STT_PROVIDER` names a preset: `fake`, `deepgram`, `assemblyai` (Universal-3.6 Pro), `assemblyai-streaming` (Universal-Streaming English), and `soniox` with D1. Each preset reads its own model setting, with a default: `DEEPGRAM_MODEL=nova-3`, `ASSEMBLYAI_MODEL=universal-3-6-pro`, `ASSEMBLYAI_STREAMING_MODEL=universal-streaming-english`, `SONIOX_MODEL=stt-rt-v5`. Each is checked against its preset's list. The shared `STT_MODEL` is retired: if it is set, the API refuses to start and names it. The token response's `provider` is the vendor (`assemblyai` for both AssemblyAI presets), so the desktop never sees presets. | `STT_PROVIDER` plus one shared `STT_MODEL` | Today's `.env.example` ships `STT_MODEL=nova-3`. A shared setting would stop the API under AssemblyAI, and moving to or from run C would take two lines, so the exit check would fail. With presets, every bake-off configuration is one line from every other; `test_every_bakeoff_config_differs_from_every_other_by_one_line` checks it. The lists stay strict because AssemblyAI ignores unknown query parameters and quietly runs another model (openwhispr `assemblyAiStreaming.js:461-475`). |
| Audio format in the token | `stream.encoding` stays the app's own name, `linear16`, for every vendor. Each adapter translates it to the vendor's term (`pcm_s16le` for AssemblyAI and Soniox) and refuses any other value. | The API returns each vendor's own term | The desktop's `streamSettingsMismatch` (`main/stt/streamSettings.ts`, called at `CaptureService.ts:210`) refuses Start unless the encoding is `linear16`. A vendor term would fail Start, and passing `linear16` through would send AssemblyAI a value it does not know. One canonical name keeps the check to one rule. |
| AssemblyAI credential | The API calls `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=<ttl>&max_session_duration_seconds=10800` with `Authorization: <key>`. The desktop puts the token in the `token` query parameter. `STT_TOKEN_TTL_SECONDS` is clamped to the vendor's maximum (AssemblyAI 600, Deepgram and Soniox 3600), and the clamp is logged once at startup. | Send audio through the API; refuse a TTL over the maximum | House rule 3. The docs say the token is not single-use inside its window, so one token opens both streams, as Deepgram's grant does. Refusing to start would make a vendor switch two lines. |
| When AssemblyAI text is final | Universal-3.5 and 3.6 Pro: a `Turn` with `end_of_turn` is final (formatting is always on). Universal-Streaming with `format_turns=true`: a raw `end_of_turn` becomes a pending final, shown as that stream's interim. The formatted copy of the same `turn_order` replaces it in place and is saved. If no formatted copy has come, the pending turn is saved as it is when a higher `turn_order` arrives, after 3 s, or at `Termination`. A formatted copy after that is ignored (counted in a debug log). The saved `turn_order` set lives in the stream object, so it starts fresh with each session after a reconnect. `close()` sends `ForceEndpoint`, then `Terminate`. | The first `end_of_turn`; wait for the formatted copy only | Taking the first `end_of_turn` stores every line twice (openwhispr `assemblyAiStreaming.js:483-530`). Waiting only for the formatted copy loses the turn if the next partial replaces it first; anarlog (`assemblyai/live.rs:241`) treats `turn_is_formatted \|\| end_of_turn` as final for this reason. The migration guide says to drop `format_turns` and check `end_of_turn` alone on the Pro models. |
| AssemblyAI errors | The close code decides. The close-codes page says an `Error` text frame (`error_code`, `error`) comes just before the close; when it does, its text is added to the error. Nothing waits for it, because the API reference lists no `Error` type. | Treat `Error` as the fatal signal | The two doc pages disagree, so the close frame, which both document, is the authority. The critic asked to drop the `Error` case; it stays as an optional extra because the close-codes page documents it. |
| AssemblyAI stream settings | `sample_rate=16000`, `encoding=pcm_s16le`, `speech_model`, `keyterms_prompt` (a JSON array), `language_codes=["en"]` from `STT_LANGUAGE` on `universal-3-*-pro` only, and `format_turns=true` on `universal-streaming-*` only. No `speaker_labels` (Me and Them come from the streams; diarization is M9). `run.json` stores each adapter's query, token removed. | Mirror every Deepgram parameter; no language hint | Only the parameters the docs list for each model. U3.6 Pro switches between languages by itself; without the hint, accented English can come back partly in another language or script. The migration guide says to pass `language_codes`. Storing the query makes the bake-off repeatable. |
| Audio framing and pacing | Every byte to AssemblyAI goes through `AudioFramer` (T18). It sends exactly 100 ms frames (3,200 bytes) and never lets the total audio sent run ahead of the wall time since `Begin`. It pads the last part to 100 ms at close. Soniox uses the framer without pacing. | Forward chunks as they come | AssemblyAI closes with 3007 on chunks under 50 ms or over 1000 ms, or when audio comes faster than real time. A Node pipe keeps no write boundaries, so M2's helper's 3,200-byte writes can arrive split or merged after a stall or a wake (openwhispr `assemblyAiStreaming.js:601-615` hit this). In normal flow the pacer never waits: M1 drops audio from before the stream opens, and live audio comes no faster than it is captured. It holds only a backlog, which is why AssemblyAI takes no inline replay (next row). Soniox documents no rate rule. |
| Reconnect to AssemblyAI | `SpeechToText.inlineReplay` is true for Deepgram, Soniox and fake, and false for AssemblyAI. M2-T6's `ResilientSttStream` replays nothing to an adapter with false. Live audio goes out at once, and the window from the last final to the reconnect becomes a gap, which M2-T16 re-runs at Stop. | Replay at 1x on the same session; a second short session for the backlog | At 1x behind live audio, a 30 s backlog never drains, so the rest of the call would run about 30 s late. A second session doubles cost and code for a rare event. |
| Jargon list storage | Postgres `vocabulary_terms`, one row per term per workspace. `GET` and `PUT /v1/vocabulary`; `PUT` replaces the whole list. | A desktop setting; a JSON column on `workspaces` | The team shares it from M6, and the permission rules apply (C5). One row per term is easy to audit. A whole-list `PUT` is idempotent and matches how the editor saves. |
| Jargon list delivery | `stream.keyterms` in the `POST /v1/stt/token` response | A separate fetch at Start | One request at Start, and a term added mid-week reaches the next Start without a restart. The roadmap asked for it here. |
| Jargon list limits | At most 100 terms, each 1 to 50 characters after trimming, at most 800 characters in all, no control characters. Duplicates that differ only in case are dropped and the first spelling wins. Adapters cut a longer list with a warning instead of failing the call. | Per-vendor limits | The strictest vendor sets the bar. AssemblyAI allows 100 terms of up to 50 characters. Deepgram allows 500 tokens across all keyterms and rejects the whole request beyond that. 800 characters is only an estimate of 500 tokens, so the next row backs it up. |
| A rejected jargon list | If a connect is refused while keyterms are non-empty (Deepgram: HTTP 400 at the handshake; AssemblyAI: a close before `Begin` with any code except 1008 and 3009), the adapter reconnects once without keyterms. The stream then emits a `warning` event, "Jargon list rejected by <vendor>, transcribing without it", held for its first listener, and logs the term count. After M2-T11 lands, it shows as a quiet capture warning. If the retry also fails, both reasons are in the error. The vocabulary editor refuses to save when its `GET` failed, so an empty editor never `PUT`s over the real list. | Fail Start with an error that names the list | A meeting with no transcript breaks the product's core promise. A call without the list loses a few names, not the meeting. |
| Vendor keyterm syntax | Deepgram: one `keyterm=` parameter per term (openwhispr `deepgramStreaming.js:163-168`, anarlog `adapter/deepgram/keywords.rs`). AssemblyAI: `keyterms_prompt=<JSON array>` (anarlog `assemblyai/live.rs:60-63`). Soniox: `context.terms`. | - | Each vendor's docs, linked in the vendor table below. |
| Model training | Every Deepgram URL carries `mip_opt_out=true`. AssemblyAI is opted out in its dashboard by the owner before any real audio is sent. Soniox does not train. T4a merges, and the app is reinstalled, before any M2 exit-check call. | Vendor defaults | The roadmap promises we never train on calls. Deepgram puts pay-as-you-go audio in its Model Improvement Program unless each request opts out. M1's installed app sends no opt-out, so M2's 10 exit calls would go in. |
| Live transcript model | A pure reducer in the renderer. Finals are kept sorted by `start_ms`, then mic before system, then id (the API's order), using insertion rather than a full sort. Each source has one interim, replaced whole on each update. A final of the same source clears it once the final reaches it. An interim older than that source's last final is dropped. `segmentChanged({segmentId, change, text})` handles M2's `transcript:segment-changed` event: `hidden` hides a line and keeps it in state, `trimmed` replaces its text, `unhidden` shows it again. A change for an id not yet seen is held until the line comes. A `showHidden` prop shows hidden lines again, marked as echo. Renders are batched to one per animation frame. | M1's sort-on-render list with both interims pinned at the bottom | Interims belong in time order next to the other person's lines. Replacing partials whole per channel and batching updates is anarlog's pattern (`apps/desktop/src/store/zustand/listener/transcript.ts`, `src/stt/transcript-delta-coalescing.ts`). Insertion keeps a 2-hour call cheap. M2-T14 hides echo lines after they were sent through `onSegment`, so without the action the live panel would keep showing the doubled lines M2 removes. |
| Citations into the transcript | M4-T21 owns `renderer/src/transcript/transcriptNavigator.ts` (`CitationNavigatorProvider`, `useCitationNavigator`, `useRegisterTranscript` and `reveal(segmentIds)`). `LiveTranscript` renders `data-segment-id` on every final line and registers its scroll container and `pauseFollow` through `useRegisterTranscript`; it does not implement reveal. M4's chips call the navigator. | Each plan defines its own context; T7 implements reveal | One owner, one type, one reveal that pauses live follow first. M4-T21's contract commit lands in wave 0, before T7. |
| Scrolling | Follow live while the reader is at the bottom. Scrolling up pauses it and shows "Jump to live". | Always scroll | People read back during a call; a view that jumps loses their place. |
| How latency is measured | Per word. Display latency: the first event of that stream (interim or final) whose `endMs` reaches the word's end, minus the clock time when the word's last sample was captured. Final latency: the arrival of the final that holds the word, on the same base. Longest wait: the largest single-word display latency. A word only exists where someone spoke, so this is the longest stall while speech was present. Capture times come from M2-T5's `AudioTimeline` in the app and from the replay clock in the bench. `LatencyMeter` keeps fixed 50 ms buckets up to 10 s plus an overflow bucket, and a cursor over a short list of event end points that is pruned at each final, so memory stays flat. It is shared by the app and the bench, and logged at Stop as `stt latency`. | Event lag (an event's arrival minus the capture time of the audio it ends on); renderer paint timing | Event lag cannot see stalls. If a vendor sends nothing for 4 s and then a partial covering audio up to 0.5 s ago, that event scores 0.5 s, though the user waited about 4 s for those words. U3.6 Pro sends continuous partials only about once a second on long turns (migration guide). Main holds both clocks; IPC and React add a few milliseconds. |
| Which vendor made a meeting's text | A dated vendor log in `docs/research/stt-benchmark.md`, plus the API's `api_started` log line, which names the provider today (T1 adds the preset, the model and the token TTL). One vendor is active at a time. | `stt_provider` and `stt_model` columns on meetings | Columns would touch the meetings API, the local store and the uploader, which M2, M4 and M5 also edit this week. Until M6 brings several configurations, the date is enough. M12 can add the columns when it compares passes. |
| Benchmark code | TypeScript in `apps/desktop/bench`, reusing the app's adapters. Built with Vite, already a dev dependency, and run with Node 22.13 or later (`node:sqlite` with no flag). | Python in `apps/api`; `tsx` as the runner | It measures the exact adapter code the app runs. Python would need a websocket client the API does not declare (C2). `tsx` passes the dependency bar (114.7M downloads in the week to 2026-10-04, 4.23.15 published 2026-09-20, no advisories), but it would save only a 15-line build config. |
| Benchmark replay | Stream the WAV files through the adapters at real time: 100 ms chunks, 1x, both streams of an item at once, three items in parallel. | Vendors' batch APIs; faster than real time | Live accuracy and lag are what the person sees, and batch models differ from live ones. AssemblyAI closes a session that is fed faster than real time (close code 3007). |
| Benchmark credentials | Each item asks the local API for `POST /v1/stt/token` just before its streams open (both streams share that token), and again for every retry. The run is labelled from the first response. A later response that names another provider or model stops the run with both names (the API was restarted mid-run). A failed item is retried up to 2 times. Every attempt and its error goes into `run.json`. | Vendor keys in the benchmark's env; one token per run | House rule 3 holds for tools too, and every run tests the real token path and jargon list (pattern: openwhispr `.github/workflows/stt-canary.yml`). A run takes about 10 minutes at `--parallel 3`. A Deepgram grant only works at the handshake, and the default TTL is 30 s. An AssemblyAI token lasts at most 600 s. One token per run would fail every later item and disqualify a vendor over a tooling bug. Same rule as M2-T6: a fresh token for each attempt. |
| Where test data lives | `ROGER_BENCH_DIR`, default `~/Roger-bench`, mode 0700, on a FileVault disk. The CLI refuses a path inside the git checkout, and `clip` refuses when `fdesetup status` is not On. Only aggregate numbers are committed. | `apps/desktop/bench/data` behind `.gitignore` | These are recordings of real people (D2). One wrong `git add` would publish them. Reports follow openwhispr `docs/orukeet-benchmarks.md`, which keeps transcript text out of its outputs. |
| Scoring | WER = (substitutions + deletions + insertions) / reference words, after the normaliser. Me is scored on the mic stream after M2's `EchoFilter` (M2-T14a, pure and vendor-free) has run over the item's replayed mic and system finals, with the route from `item.json` (`speakers`: on; `headphones`: off, as in the app). That is the text the user sees. Raw-mic Me WER is reported as a diagnostic column. Them is scored on the system stream. A system-only item (`origin: meet-recording`) has every reference line labelled Them, is scored on the system stream only, and is left out of Me WER and the mic latency gate. Items are pooled by summing errors and words. A 95% bootstrap interval is computed over items, with a fixed seed. | Me on the raw mic stream; the mean of per-item WER | On laptop speakers the mic carries all of Them's speech. A vendor that transcribes that echo better would get more insertions and a higher Me WER, and two speaker items could flip the choice. Pooling weights long items properly. The interval stops a 0.5-point gap on 10 clips from picking the vendor. If M2-T14 is late, speaker items are left out of the D4 pooled number and the report says so. |
| Normaliser | Version 1 rules, applied to both sides and listed in the research doc. Unicode NFKC, then lowercase. Curly quotes become straight. Punctuation is removed, except apostrophes inside words and points inside numbers. Hyphens and slashes become spaces. The fillers `um uh er ah hmm mm` are removed. `ok` becomes `okay`, `alright` becomes `all right`, `gonna`, `wanna` and `gotta` become `going to`, `want to` and `got to`. Spelled-out numbers become digits (`twenty five` to `25`, `two point five` to `2.5`, `first` to `1st`). `1,000` becomes `1000`, `%` becomes `percent`, `$5` becomes `5 dollars`. Every run stores the version. Changing a rule bumps it, and stored runs are scored again. | Whisper's English normaliser | The same idea, small enough to own and test rule by rule, with no Python dependency. |
| Term metrics | For each jargon term, counted case-insensitively on normalised text: recall = sum of min(reference count, hypothesis count) / sum of reference counts. False alarms = sum of max(0, hypothesis count - reference count). | WER only | WER weighs "Linkt" the same as "the", but names are what people notice. False alarms catch "linked" turning into "Linkt". |
| Fixing text by hand | `bench draft` aligns two vendors' runs word by word and writes one draft per item, with disagreements marked `{deepgram words \| assemblyai words}`. The owner listens to the whole clip in `listen.wav` (mic on the left, system on the right), resolves every brace and fixes the rest. On speaker items, Me lines that only repeat Them are deleted. `bench check` refuses a reference with a brace left in it. | Fix one vendor's text | Where two vendors agree, the text is almost always right, so attention goes where it is needed. A draft from one candidate biases the reference toward it. `item.json` records which runs made the draft. |
| Canary | `bench canary` makes a fixed script with jargon in it using macOS `say` (`--data-format=LEI16@16000`) and runs it through whichever vendor the API serves. Real vendors fail on WER above 15% or no final within 10 s. With `provider=fake` it checks only that a final arrives within 10 s and prints "WER not checked (fake provider)". `--save-wire <dir>` writes the vendor's raw messages, for T5's fixtures. | A committed recording | It catches a dead key, a wrong model name or a rejected jargon list in a minute, with nothing private in the repo. The fake adapter emits level lines with no words, so a WER rule against it would always fail. Synthetic speech says nothing about accuracy on our voices. |

### Decisions for the owner (one sign-off)

Every other call above is made. These four are the owner's.

| Id | Question | Recommendation | Alternative | Why |
| --- | --- | --- | --- | --- |
| D1 | A third vendor? | Yes: Soniox `stt-rt-v5`, built last as T14 and T15, and dropped if the day runs out | Two vendors, three configurations (runs A, B, C) | It is the only vendor whose docs say it never trains on content, and the cheapest ($0.24 per meeting hour, against $0.38 for run C, $0.90 for run B and $0.73 to $1.08 for Deepgram before any opt-out uplift). The done-when is met without it. |
| D2 | Keep a standing test set of colleagues' audio, as an exception to the audio policy? | Yes, as an explicit exception the owner signs. C6 and the roadmap ("audio is kept for a short, fixed time") otherwise apply. Internal Linkt calls only (standups, one-to-ones). `item.json` records each participant's name and consent date. Clips live only in `~/Roger-bench`: mode 0700, on a FileVault disk, never in git, and no Drive copy in Phase 2 unless the owner chooses one. `bench forget --person <name>` (or `--meeting <id>`) deletes every item and run output that holds them. Deleting a meeting's audio in the app does not reach bench copies; `forget` does. The exception is linked from the roadmap's open decision "Policy on keeping audio" before gate 2's legal view. | Keep clips for 7 days like the backup and re-clip for each bake-off; include client calls with their consent | A benchmark is only useful if it scores the same audio for months. Keeping it is a policy choice the owner should make knowingly, not one the plan makes quietly. Per-person consent and `forget` keep it reversible. A dataset we keep for years should not hold client calls. |
| D3 | Opt Deepgram out of training even if it costs more? | Yes, on every request (`mip_opt_out=true`). Confirm the opted-out price in the Deepgram console, and compare costs at that price. | Stay in Deepgram's program for the discount | The roadmap promises we never train on calls. A Deepgram staff reply says opting out gives up a 50% discount. |
| D4 | How the vendor is chosen | The vendor choice rule below, signed before any run is scored | Decide after seeing the numbers | A rule fixed in advance keeps the choice honest on a small test set. |

### Vendor facts (read 2026-10-06)

| | Deepgram | AssemblyAI | Soniox (optional) |
| --- | --- | --- | --- |
| Live socket | `wss://api.deepgram.com/v1/listen` | `wss://streaming.assemblyai.com/v3/ws` | `wss://stt-rt.soniox.com/transcribe-websocket` |
| Token from the API | `POST https://api.deepgram.com/v1/auth/grant`, `Authorization: Token <key>`, body `{"ttl_seconds"}`, returns a JWT (built in M1) | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=1..600`, optional `max_session_duration_seconds=60..10800` (default 10800), `Authorization: <key>` with no prefix. Returns `{token, expires_in_seconds}`. Reusable within the window. | `POST https://api.soniox.com/v1/auth/temporary-api-key`, `Authorization: Bearer <key>`, body `{"usage_type": "transcribe_websocket", "expires_in_seconds": 1..3600}`. Returns `{api_key, expires_at}`. |
| How the desktop authenticates | `Authorization: Bearer <jwt>` | `token=<token>` query parameter | `Authorization: Bearer <temporary key>` header |
| Models | `nova-3` | `universal-3-6-pro` (default), `universal-3-5-pro`, `universal-streaming-english`, `universal-streaming-multilingual` | `stt-rt-v5` |
| Language | `language=en` | `language_codes` (a list) on Universal-3.5 and 3.6 Pro only | not sent in M3 |
| Jargon | `keyterm=` repeated, with spaces encoded; 500 tokens at most across all terms | `keyterms_prompt` as a JSON array; at most 100 terms of 50 characters each; can change mid-session (`UpdateConfiguration`) | `context.terms` array; the whole context at most 8,000 tokens |
| Audio | linear16 at 16 kHz | `pcm_s16le` at 16 kHz; chunks of 50 to 1000 ms; never faster than real time | `pcm_s16le`, with `sample_rate` and `num_channels` in the first JSON message; no rate rule documented |
| Interim and final | `is_final` or `from_finalize` | `Turn` partials, then `end_of_turn`. Pro models format every turn; Universal-Streaming with `format_turns` sends the turn raw, then formatted. U3.6 Pro sends an early partial at about 750 ms, partials on silence, and on long turns a partial about once a second. | tokens with `is_final`; non-final tokens are replaced on every response |
| Stop | `Finalize`, then `CloseStream` | `{"type": "ForceEndpoint"}`, then `{"type": "Terminate"}`, answered by `Termination` | `{"type": "finalize"}`, then an empty text frame, answered by `finished: true` |
| Errors | `Error` message; HTTP status at the handshake | Close codes: 1008 auth or account, 3005 server, 3007 chunk size or faster than real time, 3008 session over its maximum, 3009 too many sessions. The close-codes page says an `Error` text frame comes first; the API reference lists no such type. | `error_code`, `error_type`, `error_message`, then a close |
| Session limit | none documented | 3 hours by default | 300 minutes |
| Price per stream hour | $0.288 now ($0.0048 per minute; regular $0.0077, which is $0.462) plus $0.078 for keyterms ($0.0013 per minute). The price with `mip_opt_out` is not published. | U3.6 Pro $0.45, keyterms included. Universal-Streaming English $0.15 plus $0.04 for keyterms. Billed on session time, not audio time. | $0.12 |
| Training | Audio joins the Model Improvement Program unless each request sends `mip_opt_out=true`. A Deepgram staff reply (GitHub discussion #1292, June 2025) says opting out gives up a 50% discount; the pricing page does not say so. | Opt out under Data Controls in the dashboard, free. Streaming keeps no data once opted out. | Never trains on content. |

A meeting has two streams, so cost per meeting hour is twice the stream price.

Sources: [Deepgram keyterm](https://developers.deepgram.com/docs/keyterm),
[Deepgram pricing](https://deepgram.com/pricing),
[Deepgram Model Improvement Program](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program),
[Deepgram discussion #1292](https://github.com/orgs/deepgram/discussions/1292),
[AssemblyAI streaming token](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token),
[AssemblyAI streaming API](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api),
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
Start ─ POST /v1/stt/token ──────────────────────────────▶ preset for STT_PROVIDER ─▶ vendor token
      ◀─ {provider, access_token, stream{model, encoding: linear16, keyterms}} ◀─ vocabulary_terms
createSpeechToText(provider) ─▶ Deepgram | AssemblyAI (AudioFramer) | Soniox (optional) | Fake
CaptureSession: audio ─▶ adapter;  LatencyMeter per word (capture times from M2's AudioTimeline)
               events ─▶ SQLite (finals) ─▶ M2 EchoFilter ─▶ "segment changed"
               renderer: useLiveTranscript ─▶ liveTranscript reducer ─▶ LiveTranscript
```

### API contract changes (`docs/api-contract.md`, same commit as the code)

- `GET /v1/vocabulary` returns `200 {"terms": ["Linkt", "Roger"]}`, sorted ignoring case.
- `PUT /v1/vocabulary` with body `{"terms": [...]}` replaces the list and returns
  `200 {"terms": [...]}` as stored. Breaking a limit is a `422 validation_error`. Duplicates are
  dropped, not refused.
- `POST /v1/stt/token`: `provider` is the vendor, `"deepgram" | "assemblyai" | "fake"` (plus
  `"soniox"` with D1); two presets can share a vendor. `stream.model` is the preset's resolved
  model. `stream.encoding` is always `linear16`, the app's audio format; adapters translate it.
  `expires_in` is the clamped TTL. New `stream.keyterms: string[]` carries the caller's workspace
  list, `[]` when empty, and the fake provider gets it too. The desktop reads a missing `keyterms`
  as `[]`, so an older API keeps working.

### Database

```sql
vocabulary_terms (id uuid pk, workspace_id uuid fk not null, term text not null
                  check (char_length(term) between 1 and 50), created_at timestamptz default now())
                 unique index (workspace_id, lower(term))
```

No desktop SQLite change: keyterms arrive with each token and are not cached.

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
| `clip --meeting <id> --from <mm:ss> --to <mm:ss> --name <id> [--user-data <dir>] [--person <name>:<consent date> ...]` | Cuts both sources from the backup; writes the WAV files, `listen.wav` and `item.json` |
| `run [--items <ids>] [--no-keyterms] [--parallel 3]` | A fresh token per item, replays each item at 1x through the adapter for the token's provider, retries a failed item up to 2 times, stores every event |
| `draft --runs <a>,<b>` | Writes `reference.draft.txt` for items without a `reference.txt` |
| `check` | Lists unresolved braces with line numbers, unknown speakers, empty items, and items with no participant consent |
| `score [--run <id>]` | WER (Me after the echo filter, raw mic as a diagnostic), Them WER, term recall and false alarms, word latency, intervals, cost; writes JSON and markdown reports |
| `report --summary` | Prints the aggregate table for `docs/research/stt-benchmark.md`, with no transcript text |
| `forget --person <name>` or `--meeting <id>` | Deletes every item holding that person or meeting, and those items' run outputs; aggregate reports stay |
| `canary [--save-wire <dir>]` (also `make stt-canary`) | Synthetic jargon clip through the current vendor; non-zero exit on failure |

**Report columns, per configuration:** pooled WER with its 95% interval, Me WER (after the echo
filter), Me WER on the raw mic (diagnostic), Them WER, term recall, term false alarms, word display
latency p50 and p95 per stream, final latency p50 and p95, longest wait, items retried, items failed
after retries, items left out and why, stream hours, cost per meeting hour (from
`bench/report/prices.ts`, where every price row carries its source URL and the date it was read).

**Bake-off configurations.** Only `STT_PROVIDER` changes between runs; each preset's model setting
keeps its default.

| Run | `STT_PROVIDER` | Model | Why |
| --- | --- | --- | --- |
| A | `deepgram` | `nova-3` | M1's vendor until 2026-10-06 |
| B | `assemblyai` | `universal-3-6-pro` | AssemblyAI's model for meetings |
| C | `assemblyai-streaming` | `universal-streaming-english` | 2.4 times cheaper than B, English only; M1's vendor since 2026-10-06 |
| D (with D1) | `soniox` | `stt-rt-v5` | Cheapest, never trains |
| E | the winner | the winner's | `--no-keyterms`: measures the jargon list |

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
app-shell task. M2-T5 (audio timeline), M2-T6 (reconnect), M2-T10 (system audio through the helper),
M2-T11 (capture warnings), M2-T14a and T14b (echo filter) and M2-T15 (audio backup) are in
`M2-capture-you-can-trust.md`. Paths are under `apps/api/src/roger_api`, `apps/api/tests` and
`apps/desktop/src` unless shown in full.

| Id | Task | App | Owns | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| M3-T1 | Presets, vendor models and the AssemblyAI token issuer (extends the issuer from `m1-assemblyai`) | api | `config.py` (presets, per-vendor model settings with defaults and lists, `STT_MODEL` refused by name, key checks, TTL clamped per vendor with a log line), `schemas/stt.py` (`SttStreamSettings.from_settings`: resolved model, vendor as `provider`, encoding unchanged), `services/stt_tokens.py` (`AssemblyAiSttTokenIssuer`, clamped TTL for every issuer), `app.py` (preset, model and TTL on `api_started`), `tests/test_stt_providers.py`, `tests/test_stt_token_assemblyai.py`, the two tests that read `stt_model` today (`tests/test_config.py:81`, `tests/test_stt_token.py:133`), the `.env.example` API section (`ASSEMBLYAI_API_KEY`; `STT_MODEL` removed; the four model settings commented out with their defaults), contract `provider` values | - | M |
| M3-T2 | Workspace jargon list | api | `db/models_vocabulary.py` (`VocabularyTerm`), `migrations/versions/0002_vocabulary_terms.py` (revision `0002`, down `0001`; P2-F2's stub), `services/vocabulary.py`, `schemas/vocabulary.py`, `routers/vocabulary.py` (P2-F2 already includes it in `app.py`), `tests/test_vocabulary.py`, contract Vocabulary section and its Database line. The one-head test is P2-F2's | P2-F2 | M |
| M3-T3 | Keyterms in the STT token response | api | `routers/stt.py` (takes `PrincipalDep`, one query, limit 100), the `keyterms` field in `schemas/stt.py`, the keyterm tests in `tests/test_stt_token.py`, contract token section | T1, T2 | S |
| M3-T4a | Keyterms through the STT adapters; Deepgram `keyterm`, `mip_opt_out` and the rejected-list retry | desktop | `main/stt/SpeechToText.ts` (`keyterms` on `SttStreamSettings`; `inlineReplay` on `SpeechToText`; a `warning` event that is held for the first listener), `main/stt/keyterms.ts` (the shared cap) and test, `main/stt/deepgram/DeepgramSpeechToText.ts` and test (`buildListenUrl`, the connect error text, one retry without keyterms), `main/stt/fake/FakeSpeechToText.ts` (`inlineReplay`), `main/api/ApiClient.ts` (token type, missing means `[]`) and test, the one fake-settings literal in `main/capture/CaptureService.ts` (`keyterms: []`) | P2-F1 | M |
| M3-T4b | Keyterm warnings in the capture session | desktop | `main/capture/CaptureSession.ts` (`case 'warning'`: log at warn and call `onWarning`), `main/capture/CaptureService.ts` (`onWarning` becomes a quiet `keyterms_rejected` capture warning) and their tests | T4a, M2-T5, M2-T11, T6b and M5-T5 (file order) | S |
| M3-T5 | AssemblyAI adapter (extends M1's Universal-Streaming adapter: Pro models, pending finals, keyterms, the rejected-list retry, and `AudioFramer` in place of `AudioFrameSizer`, which it deletes) | desktop | `main/stt/assemblyai/messages.ts` and test, `main/stt/assemblyai/fixtures/` (the API reference's examples now, recorded wire JSON at close step 0), `main/stt/assemblyai/AssemblyAiSpeechToText.ts` and test (URL per model, framer, pending finals, `ForceEndpoint` then `Terminate`, rejected-list retry, `inlineReplay = false`, a `wireTap` option only the bench passes), `main/stt/streamSettings.ts` (a comment: the encoding is the app's own name) and one case in its test, `main/stt/createSpeechToText.ts` and `createSpeechToText.test.ts` (from M1) | T4a, T18 | M |
| M3-T6a | Word latency meter | desktop | `main/stt/LatencyMeter.ts` and test (the pure meter, which T11 needs) | - | S |
| M3-T6b | Latency hook | desktop | `main/capture/CaptureSession.ts` (one call per event, `stt latency` log at close) and test | T6a, M2-T5 | S |
| M3-T7 | Live transcript panel: model and component | desktop | `renderer/src/transcript/liveTranscript.ts` and test (including `segmentChanged` and `showHidden`), `LiveTranscript.tsx` (each final line carries `data-segment-id`; registers its scroll container and `pauseFollow` through M4-T21's `useRegisterTranscript`; no reveal of its own), `useLiveTranscript.ts` (subscribes to segment, interim and `transcript:segment-changed` events itself; takes a meeting's stored lines and `showHidden` as props, so past meetings use the same panel), `transcript.css` (theme tokens only) | M2-T2 (the `transcript:segment-changed` contract), M4-T21a | M |
| M3-T8 | Jargon list editor | desktop | `shared/vocabulary.ts` (limits shared with main) and test, `shared/ipc/vocabulary.ts` (`vocabulary:get`, `vocabulary:set`) with its bridge in `preload/bridges/` and fake in `preview/fakes/`, `main/vocabulary/vocabularyIpc.ts` (handlers and payload validation) and test, `main/api/vocabularyClient.ts` (two methods) and test, `[slot M3-T8]` in `main/index.ts`, `renderer/src/settings/vocabularyEditor.ts` (load state; save refused after a failed load) and test, `renderer/src/settings/VocabularySettings.tsx` | T2, T4a | M |
| M3-T9 | Mount the transcript and the editor; retire M1's view | desktop | `renderer/src/app/slots/m3-transcript.ts` (the meeting page's transcript region and the Settings section; replaces the `TranscriptView` entry M4-S4 seeded), `renderer/src/state/useCapture.ts` (drops its segment and interim state; keeps M5-T5's `start(request)`), deletes `renderer/src/components/TranscriptView.tsx` | T7, T8, M4-S1, M4-S4, M4-S4b, M5-T5 (file order) | S |
| M3-T10 | Benchmark scoring core | desktop | `apps/desktop/bench/core/{wav,normalise,align,wer,terms,reference,bootstrap,events}.ts` and tests (`events.ts`: the `events.jsonl` and `run.json` schema with its reader and writer, shared by T11 and T12). P2-F3 already includes `bench/**` in `tsconfig.node.json`, ESLint and Vitest, and sets `engines.node` to `>=22.13.0` (`node:sqlite` with no flag) | P2-F3 | M |
| M3-T11 | Benchmark runner, report and canary | desktop | `apps/desktop/bench/cli.ts`, `bench/vite.config.ts`, `bench/run/{replay,credentials}.ts`, `bench/report/{report,prices,echo}.ts` (`echo.ts` runs M2's `EchoFilter` over replayed finals), `bench/canary.ts`, their tests (P2-F3 added the `bench` script) | T10, T4a, T6a, M2-T14a (the pure `EchoFilter`) | M |
| M3-T12 | Test-set tools: clip, draft, check, forget, listen file | desktop | `apps/desktop/bench/dataset/{backup,clip,draft,check,forget}.ts` and tests (`backup.ts`: the read-only `node:sqlite` reader; FileVault and mode 0700 checks) | T10, M2-T3 (the backup fixture) | M |
| M3-T13 | Docs | repo | `CLAUDE.md` (commands; failure-log lines go through the controller; P2-F3 added the `bench` and `stt-canary` targets), `docs/research/stt-benchmark.md` (method, normaliser v1, choice rule, D2's exception, vendor facts, vendor log, results table), `.env.example` (`ROGER_BENCH_DIR`) | T1, T11, T12 | S |
| M3-T14 | Soniox temporary key issuer (optional, D1) | api | `services/stt_tokens.py` (one class), `config.py` (one preset and its model setting), `tests/test_stt_token_soniox.py`, contract | T1 | S |
| M3-T15 | Soniox adapter (optional, D1) | desktop | `main/stt/soniox/{messages,SonioxSpeechToText}.ts` and tests, `main/stt/createSpeechToText.ts` (one case) | T4a, T5, T18, M2-T6 (file order) | M |
| M3-T16 | Build the test set | owner | `$ROGER_BENCH_DIR/items/*` (outside git) | T1, T5, T11, T12, T13, M2-T15 | M (about 2 hours of owner time) |
| M3-T17 | Wire fixtures, bake-off, vendor choice, exit check | owner and agent | `main/stt/assemblyai/fixtures/*.jsonl` (step 0), results in `docs/research/stt-benchmark.md` and the log below; the API `.env` | T3, T5, T6b, T9, T16, M2-T5, M2-T10 (T14 and T15 with D1) | S |
| M3-T18 | Audio framer and pacer | desktop | `main/stt/AudioFramer.ts` and test (exact frames, pacing against an injected clock, padding at close) | - | S |

Waves for parallel worktrees are in `phase-2-build-order.md`, which wins where this plan differs:
T6a and T18 in wave 0; T1, T2, T4a and T10 in wave 1; T3, T5, T7, T8, T11 and T12 in wave 2; T13
and T14 in wave 3; T6b in wave 4; T4b, T9 and T15 in wave 5. Then T16 and T17 (owner).

Ordering for the controller: merge T4a and reinstall the app (`make install-desktop`) before any M2
exit-check call, or those calls go to Deepgram without `mip_opt_out`.

- [ ] M3-T1 · [ ] M3-T2 · [ ] M3-T3 · [ ] M3-T4a · [ ] M3-T4b · [ ] M3-T5 · [ ] M3-T6a · [ ] M3-T6b
- [ ] M3-T7 · [ ] M3-T8 · [ ] M3-T9
- [ ] M3-T10 · [ ] M3-T11 · [ ] M3-T12 · [ ] M3-T13 · [ ] M3-T14 · [ ] M3-T15 · [ ] M3-T16 · [ ] M3-T17 · [ ] M3-T18

Notes for the builders:

- Never log an AssemblyAI socket URL: the temporary token is in it. Log the host and the model.
  `run.json` stores the query with the token removed.
- The AssemblyAI adapter resolves `openStream` on `Begin` (10 s timeout). A close before `Begin`
  is a `SttConnectError` that carries the code; 1008 reads "AssemblyAI refused the token". If
  `Begin.configuration.model` differs from the model asked for, log a warning.
- The AssemblyAI adapter sends no keep-alive: audio, silence included, flows the whole call.
  `close()` sends `ForceEndpoint` and `Terminate`, waits for `Termination` and then the socket
  close, and terminates after 5 s. A final's times come from its first and last word; its confidence
  is the mean word confidence.
- Put the same comment in `AssemblyAiSpeechToText.ts` and in M2's `ResilientSttStream.ts`:
  AssemblyAI takes no inline replay (`inlineReplay = false`). The pacer would drip a backlog at 1x
  behind live audio, so the call would run late for the rest of the session. The window becomes a
  gap for M2-T16's re-run.
- `AudioFramer` must sit between every caller and the AssemblyAI socket, including the first audio
  after `Begin`. Write it where someone would add a shortcut: a raw `socket.send(pcm)` closes the
  session with 3007 the first time a pipe read merges past 1 s.
- `stream.encoding` is the app's canonical `linear16`. Translate it inside the adapter; never ask
  the API for a vendor term. Say this in `streamSettings.ts` too.
- Alembic: the revision is `0002` with `down_revision = "0001"`, fixed in `phase-2-build-order.md`
  (M4 is `0003`, M5 is `0004`). Fill the stub P2-F2 made; never re-point it.
- `DeepgramSpeechToText.ts` is also edited by M2-T6 (ping liveness). T4a touches only
  `buildListenUrl`, the connect error text and the one retry without keyterms, and lands first
  (wave 1; M2-T6 is wave 4). `CaptureSession.ts` is edited by M2-T5, then T6b, then T4b, one per
  wave; keep each edit in its own block.
- The AssemblyAI adapter answers the same liveness check M2-T6 adds to the Deepgram stream, so
  `ResilientSttStream` can wrap it unchanged.
- `bench/core/wav.ts` only reads and writes 16 kHz mono PCM16 files. If M2-T15's
  `src/main/backup/wav.ts` has landed, import its header code instead of writing a second copy.

## Tests

| What | Test |
| --- | --- |
| `STT_PROVIDER` alone picks the preset's vendor and default model; every bake-off configuration loads from one base env (every key set) by changing only `STT_PROVIDER`, each returning its own model; a model off the preset's list, a missing key and a leftover `STT_MODEL` are refused at startup by name; a TTL over the vendor maximum is clamped and logged; `stream.encoding` is `linear16` for every preset; switching only `STT_PROVIDER` changes the token response | `apps/api/tests/test_stt_providers.py`: `test_stt_provider_alone_picks_the_preset_vendor_and_model`, `test_every_bakeoff_config_differs_from_every_other_by_one_line`, `test_model_off_the_preset_list_is_refused_at_startup`, `test_retired_stt_model_is_refused_by_name`, `test_missing_key_for_the_chosen_vendor_is_refused`, `test_ttl_over_the_vendor_maximum_is_clamped_and_logged`, `test_stream_encoding_is_linear16_for_every_preset`, `test_switching_stt_provider_changes_the_token_response` |
| AssemblyAI token request is exact (URL, query with the clamped TTL, raw key header); 401, 503, unreadable body, non-JSON and unreachable all raise `SttProviderError`; the key never reaches a log line | `apps/api/tests/test_stt_token_assemblyai.py`: `test_assemblyai_token_request_is_exact`, `test_assemblyai_failures_raise_provider_error`, `test_assemblyai_key_never_logged` |
| Jargon list: PUT replaces the whole list, GET sorts ignoring case, duplicates keep the first spelling, every limit is a 422, PUT is idempotent, another workspace's rows are never read or deleted, bearer token required | `apps/api/tests/test_vocabulary.py`: `test_put_replaces_the_whole_list`, `test_get_sorts_ignoring_case`, `test_duplicates_keep_the_first_spelling`, `test_limits_are_validation_errors` (101 terms, 51 characters, 801 in all, blank, control character), `test_put_is_idempotent`, `test_other_workspace_terms_are_never_read_or_deleted`, `test_vocabulary_needs_the_bearer_token` |
| Migrations form one chain | `apps/api/tests/test_migrations.py`: `test_alembic_has_one_head` (plus the existing models-match test) |
| Token carries the caller's keyterms, `[]` when none, never another workspace's | `apps/api/tests/test_stt_token.py`: `test_token_carries_the_workspace_keyterms`, `test_token_keyterms_empty_when_no_list`, `test_token_never_carries_another_workspace_terms` |
| Deepgram URL: one `keyterm` per term with spaces encoded, always `mip_opt_out=true`, no `keyterm` without a list, an over-long list cut with a warning. An HTTP 400 at connect with keyterms reconnects once without them and emits the `warning` event with the term count in the log; a failing retry rejects with both reasons; no retry when the list is empty; the warning reaches a listener that subscribes after open | `apps/desktop/src/main/stt/deepgram/DeepgramSpeechToText.test.ts`, `src/main/stt/keyterms.test.ts` |
| A token response without `keyterms` reads as an empty list | `apps/desktop/src/main/api/ApiClient.test.ts` |
| An `assemblyai` token response with `stream.encoding` `linear16` passes the mismatch check | `apps/desktop/src/main/stt/streamSettings.test.ts` |
| AssemblyAI messages, run on the fixture files: a Pro `end_of_turn` is final with word timings. On Universal-Streaming, a raw `end_of_turn` is pending and shown as interim; its formatted copy replaces it in place; it is saved as it is when a higher `turn_order` arrives, after 3 s (fake timers) or at `Termination`; a formatted copy after that is ignored. A repeated `turn_order` is ignored within one stream, and a new stream starts its own set. An `Error` frame before a close adds its text, and a close with no `Error` frame is enough. Unknown types are ignored; malformed input is `invalid`, never a throw. | `apps/desktop/src/main/stt/assemblyai/messages.test.ts` |
| AssemblyAI stream against a local websocket server: URL per model (token, rate, `encoding=pcm_s16le` from `linear16`, another encoding refused, model, keyterms JSON, `language_codes=["en"]` on the Pro models only, `format_turns` on Universal-Streaming only); opens on `Begin`; 1008 before `Begin` rejects with the code and no retry; another close before `Begin` with keyterms retries once without them and warns; times out; every frame sent is 3,200 bytes; stop sends `ForceEndpoint` then `Terminate` and waits for `Termination`; a pending last turn is saved at `Termination`; model mismatch warns; `inlineReplay` is false; the token appears in no log line | `apps/desktop/src/main/stt/assemblyai/AssemblyAiSpeechToText.test.ts` |
| Framer: 10 ms inputs come out as 100 ms frames; a 1.5 s input becomes 15 frames; a 3 s burst after a 3 s stall goes out at once in 100 ms frames; a 3 s backlog at `Begin` is paced at 1x; close pads the remainder to 100 ms; without pacing (Soniox) a backlog goes out at once | `apps/desktop/src/main/stt/AudioFramer.test.ts` |
| Each provider name picks its adapter; an unknown one is refused | `apps/desktop/src/main/stt/createSpeechToText.test.ts` |
| Word latency: a word's display latency is the first covering event's arrival minus the word's capture time (via `AudioTimeline`); a 4 s stall followed by a partial covering the stalled words reports about 4 s, not 0.5 s; final latency; p50 and p95 are right; the longest wait is the largest word latency; the bucket count is fixed and the end-point list stays bounded over 2 hours of synthetic events; the session logs `stt latency` per stream at close | `apps/desktop/src/main/stt/LatencyMeter.test.ts`, `src/main/capture/CaptureSession.test.ts` |
| Live transcript: a final replaces its own source's interim; the other source's interim survives; a stale interim is dropped; lines sort by start, mic before system, then id; a re-sent final is ignored; a new meeting clears all (hidden ids too); following live pauses when scrolled up (reveal is tested in M4-T21's `transcriptNavigator.test.ts`). `segmentChanged` `hidden` after display hides the line; before display (a held line) it hides the line when it arrives; `trimmed` replaces the text; `unhidden` shows it; `showHidden` on shows them marked, off hides them again | `apps/desktop/src/renderer/src/transcript/liveTranscript.test.ts` |
| Jargon limits match the API's; IPC rejects non-string lists and oversized payloads; GET and PUT request shapes; the editor refuses to save after a failed load | `apps/desktop/src/shared/vocabulary.test.ts`, `src/main/ipc-validation.test.ts`, `src/main/api/ApiClient.test.ts`, `src/renderer/src/settings/vocabularyEditor.test.ts` |
| Transcript and editor in the real app: light and dark themes, empty state, a 500-line call with interims, a hidden echo line toggled, "Jump to live", saving the list, an API error | Browser check with screenshots and a QA gallery (house handover norm), T9 |
| Each normaliser rule; WER with known substitutions, deletions and insertions; empty reference; Me and Them split; pooling; seeded bootstrap; term recall and false alarms; reference parser; WAV read refuses non-16 kHz, stereo and non-PCM16 with a clear message; WAV write round-trips; `events.jsonl` and `run.json` round-trip | `apps/desktop/bench/core/*.test.ts` |
| Replay paces 100 ms chunks at 1x (fake timers); both streams of an item run at once; events keep arrival times; each item fetches its own token, so the 4th round of a `--parallel 3` run uses a new one; a provider or model change mid-run stops it with both names; one injected 3009 is retried and recorded in `run.json`; an item failing three times is failed; `run.json` holds the adapter query without the token; `--no-keyterms` empties the list; a bench dir inside the repo is refused; the fake adapter end to end yields a report; the summary has no transcript text; every price row has a source and a date | `apps/desktop/bench/run/*.test.ts`, `bench/report/report.test.ts` |
| Echo-aware scoring: a fixture with Them's words echoed on the mic does not raise Me WER after the filter, while the raw-mic column shows the insertions; a headphones item is not filtered; a meet-recording item is left out of Me WER and the mic latency gate; without the filter, speaker items are left out of the pooled number and the report says so | `apps/desktop/bench/report/echo.test.ts` |
| Canary: with `provider=fake` only a final within 10 s is checked and "WER not checked (fake provider)" is printed; with a real provider, WER above 15% or no final in 10 s fails; `--save-wire` writes the raw messages | `apps/desktop/bench/canary.test.ts` |
| Clip reads M2-T15's fixture through read-only `node:sqlite`, skips rows with `deleted_at`, cuts exact sample windows and fills the gap with silence; a missing database names the path and `--user-data`; it refuses when FileVault is off (injected) and creates the bench dir with mode 0700. Draft marks only disagreements and puts Me and Them in time order; check reports braces with line numbers and items with no consent; `listen.wav` is mic left, system right; `forget --person` removes that person's items and their run outputs and keeps the others | `apps/desktop/bench/dataset/*.test.ts` |
| Exit check: wire fixtures recorded; chosen vendor's WER written down; one-line vendor switch; word display latency on a real call | Exit check log below (T17) |

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
| A vendor rejects the jargon list at connect | "Jargon list rejected" warning | One reconnect without the list, so the call keeps its transcript. Fix the list, then run the canary. |
| AssemblyAI stores each line twice, or loses a raw turn | Doubled or missing lines in the local store | The pending-final rule in Design, with tests on recorded wire JSON. |
| AssemblyAI's wire format differs from its docs (the two error pages already disagree) | Message tests fail on the recorded fixtures | Close step 0 records real JSON per model before the bake-off; the adapter is fixed against it. |
| AssemblyAI quietly runs another model | `Begin.configuration.model` differs | The preset's model list; the adapter's warning. |
| AssemblyAI closes with 3007 (chunk size, or faster than real time) | Close code 3007 in the log | `AudioFramer` sends only 100 ms frames, paced. No inline replay to AssemblyAI. The adapter names 3007 in its error. |
| A long reconnect on AssemblyAI leaves text missing until Stop | A gap row for the window | M2-T16 re-runs the gap at Stop. The live view shows the reconnect state meanwhile. |
| The temporary token leaks into logs (AssemblyAI puts it in the URL) | A token in a log file | URLs are never logged; `run.json` strips it; a test checks it. |
| Opting out costs double at Deepgram | The owner's price check | Cost per meeting hour uses the opted-out price. It may change the choice. |
| M2's exit calls train Deepgram's models | M1's installed app has no `mip_opt_out` | The controller merges T4a (wave 1) and reinstalls before M2's exit check. AssemblyAI, M1's vendor since 2026-10-06, is opted out in its dashboard before M1's real call. |
| Keeping colleagues' audio goes beyond the audio policy | Owner or legal review | D2 makes it an explicit, signed exception, with consent per person, FileVault, mode 0700 and `forget`. |
| System audio still broken after a restart (today's bug) | "No system audio" in the app | M2 and the Swift helper (C1). The bake-off runs on clips and does not need it; close step 4 waits for M2-T10. |
| Parallel worktrees edit shared files (`CaptureSession.ts`, `CaptureService.ts`, `SpeechToText.ts`, `ipc.ts`, `ApiClient.ts`, `models.py`, `schemas/stt.py`, the Alembic head, `api-contract.md`, `Makefile`, `package.json`) | Merge conflicts; two Alembic heads | Small additive edits in their own blocks, the one-head test, `down_revision` set at merge. T3 waits for T1 because both edit `schemas/stt.py`. |
| Long calls hit session limits: AssemblyAI at 3 hours (3008), Soniox at 300 minutes | A stream closes mid-call | M2's reconnect opens a new session. Until then the failure is shown, as in M1. |

## Dependencies on other Phase 2 plans

| Needs | From | Used by | If it is late |
| --- | --- | --- | --- |
| Shell: the meeting route and page frame with a transcript region, a Settings section slot, theme tokens, the meeting page passing a meeting's stored lines and the `showHidden` state to `LiveTranscript`, and the Chrome preview with a fake `window.roger` | M4-S1 (routes, Settings slot), M4-S2 (tokens), M4-S3 (preview), M4-S4 and S4b (meeting page, stored lines) | T9 | They land in waves 1 to 3, before T9 (wave 5); no mount in M1's window. |
| M2-T3 and M2-T15: the `audio_files` schema and a committed fixture (a small `roger.sqlite` plus two short m4a and WAV chunks with a gap between them, made by M2-T3 in wave 1), and backup chunks per meeting and stream written by M2-T15 (read as stated under "Where recordings come from") | M2 | T12 `clip`, T16 | T12 uses the fixture from wave 2; real clips wait for T15 and recorded calls. Meet recordings make system-only items. |
| M2-T5: `AudioTimeline` mapping vendor time to the clock time a sample was captured | M2 | T6b, T17 step 4 | T6's meter merges alone; the bench's latency numbers do not need it. |
| M2-T6: `ResilientSttStream` (fresh token per attempt, ping liveness, up to 30 s replay) reads `SpeechToText.inlineReplay` and replays nothing when it is false | M2 | T5 at runtime | Until it lands, M1's behaviour holds: a dropped stream fails visibly. |
| M2-T10: call audio through the Swift helper, which survives an app restart | M2 (C1) | T17 step 4 | Steps 0 to 3 go ahead; step 4 waits. |
| M2-T11: capture warnings (`CaptureWarning`) | M2 | T4b | The rejected-list warning is a warn log line; the canary catches a rejected list. |
| M2-T14a: a pure, vendor-free `EchoFilter` that plain Node can import (wave 0); M2-T2: the `transcript:segment-changed` contract (wave 1), which M2-T14b emits | M2 | T11 `score`, T7 | Both land before T7 and T11 start. |

Cross-plan edits (applied on 2026-10-06 with `phase-2-build-order.md`; kept here so both sides say
the same):

1. **M2-T6:** `ResilientSttStream` reads `SpeechToText.inlineReplay` (added by M3-T4a). When it is
   false (AssemblyAI), it sends live audio at once and records the buffered window as a gap for
   M2-T16. Add the comment from "Notes for the builders" to `ResilientSttStream.ts`.
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
7. **Merge order:** M3-T4a merges, and the app is reinstalled, before any M2 exit-check call.

## Exit check log

Filled in when the check runs. Record per configuration: date, preset, provider and model, pooled
WER with interval, Me (filtered and raw) and Them WER, term recall and false alarms, word display
and final latency p95, longest wait, retried and failed items, cost per meeting hour. Then the
chosen vendor and why, the real-call `stt latency` line, the screenshot link, the wire fixtures'
commit, and the two vendor flips.

## Review

Engineer: pending.
