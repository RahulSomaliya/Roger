# Roger: Milestone Roadmap

Oct 5, 2026 · @Rahul

## The goal

A Mac meeting-notes app the Linkt team uses every day instead of Granola. It matches Granola on the basics and beats it in a few places.

- It records calls with no bot joining the meeting.
- It turns your rough notes plus the transcript into clean notes.
- It lets Claude, or any AI tool, pull the full transcript of any team call.
- It knows who said what, by name.

Delivery model: each milestone is a written plan, built with coding agents, reviewed by an engineer, and closed by a check on a real call.

## The bar: what Granola does today

Granola is a wide product. The table shows what we must match, taken from its own help pages on October 5, 2026.

| Area | What Granola does today |
| --- | --- |
| Capture | No bot. It runs on your computer and listens to system audio plus your mic. Mac, Windows, iPhone, Android. It never saves audio. ([transcription](https://docs.granola.ai/help-center/taking-notes/transcription)) |
| Transcript | Live. "Me" comes from the mic, "Them" from system audio. Custom jargon list. Many languages. |
| Speaker names | "Speaker tags" for Meet, Zoom and Teams. It reads the active speaker's name from the meeting app, through macOS Accessibility or a Chrome extension. ([speaker tags](https://docs.granola.ai/help-center/taking-notes/speaker-attribution)) |
| Notes | You type rough notes. AI rewrites them using the transcript. Templates per meeting type. |
| Around the call | Google and Outlook calendar sync, meeting notifications, pre-meeting briefs, follow-up email drafts. |
| Ask | Chat across meetings and folders. Saved prompts called recipes. |
| Team | Workspaces, spaces, folders, sharing controls, user groups, a people and companies list. |
| Connect | Slack, Notion, Zapier, HubSpot, Attio, Affinity. A REST API, webhooks, CSV export. ([docs index](https://docs.granola.ai/llms.txt)) |
| MCP | Six tools, with full transcripts on paid plans. ([MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp)) |
| Admin | SSO, SCIM, transcript auto-delete, a "Granola is on" notice for other people on the call. |
| Price | $0, $14 or $35 per user per month. ([pricing, read Sept 24, 2026](https://justinmckelvey.com/blog/granola-pricing)) |

Three gaps matter most to us. All three come from Granola's own pages or its live MCP tool text.

1. **The MCP pushes AI tools toward summaries.** A full-transcript tool exists. But the tool text tells the AI to prefer Granola's own chat tool for open questions. The list tool only offers this week, last week, or the last 30 days. There is no keyword search over transcripts.
2. **MCP access is one person at a time.** Each connection acts as one user in one workspace. There is no API key or service account for MCP, so a project cannot have its own MCP access. Granola's separate REST API does have keys, but that is not MCP.
3. **Speaker names are fragile.** They only work live, on three meeting apps. They are never added to older transcripts. They fail when people share a room device or talk over each other.

## What users complain about

Six complaints come up again and again, for Granola and for its rivals. The roadmap answers each one.

| Complaint | What it looks like | How the roadmap answers it |
| --- | --- | --- |
| Silent failure | The app looks live but captures nothing. With no audio saved, the meeting is gone. This is the sharpest complaint about Granola. | M2 keeps a local audio backup for a few days, and shows a loud warning when it hears nothing. |
| No way to check the text | Names and numbers come out wrong, and there is no audio to check them against. | The audio backup from M2. Click-to-hear in M12. From M4, every AI line links to the transcript lines behind it. |
| Wrong speaker in group calls | Two people collapse into Them, so action items land on the wrong person. | M9 gives live names from the meeting app. M13 adds voice memory. |
| Hidden transcription | Other people on the call do not know. Granola, Otter and Fireflies each face class-action suits over this. No court has ruled yet. | The notice to others is on by default from M5. Voice memory is limited to team members who opt in. |
| Notes go nowhere | Action items are captured but never reach the tools people work in. | M10 sends action items to Slack and exports everything. Our MCP lets agents push the rest. |
| Training on your calls | Granola uses anonymized data to improve its models by default on its two cheaper plans. | We never train on calls, and we pick vendors that do not either. |

Sources: [anarlog's roundup of Granola complaints](https://anarlog.so/blog/granola-ai-complaints/), a competitor's write-up that links to Granola's own docs, and a law firm's summary of the lawsuits: [Barnes & Thornburg, Aug 12, 2026](https://btlaw.com/en/insights/alerts/2026/what-the-granola-class-action-means-for-companies-building-and-deploying-conversation-capture-tools).

## Prior art: anarlog

[anarlog](https://github.com/fastrepl/anarlog) is the closest open-source reference. We study it and do not fork it. It is an open-source Granola clone, MIT licensed, with about 9,000 GitHub stars and 8,500 commits. It was called Hyprnote before. It is built with Tauri, Rust, React and TypeScript, and keeps data in a local SQLite file.

Its free app already does a lot: on-device transcription, saved recordings with a player, your own AI keys, notes, templates, chat, and a local API, CLI, MCP and webhooks. Its paid plan is $14 per person per month and adds cloud transcription, sync, sharing and shared workspaces. ([anarlog pricing](https://anarlog.so/), read Oct 5, 2026)

How we use it:

- As a reference for the hard parts: audio capture, echo, speaker labels, and its MCP tools.
- As a model for an agent-driven repo. It has a `CLAUDE.md`, an `AGENTS.md`, agent skills and end-to-end tests.

Why we build instead of fork:

- anarlog is local-first and single-user. Our product is team-first, with a cloud store as the source of truth.
- It is Rust and Tauri. Our stack is TypeScript and Python.
- The team features we need most are its paid cloud side, not the free local app.
- 8,500 commits is a large codebase to take over and keep in sync.

## Where we win

We aim to beat Granola in four places. Each one answers a gap above.

1. **Transcript-first MCP.** The AI can search every call and get back exact quotes, with speaker and time. It can pull a full transcript, or just minutes 10 to 20, from any date. Our tool text tells the AI to use the real words, not a summary.
2. **Access for projects and agents.** A project gets its own key. That key sees only that project's calls. So Claude Code in a client repo reads only that client's meetings.
3. **Speaker names that stick.** Live names from the meeting app, like Granola. Plus voice memory: fix a name once, and it fills the whole call, old calls, and future calls.
4. **Your data, your rules.** Transcripts live in our own database. We can keep audio for a short time to re-run it with a better model. Granola cannot, because it never saves audio.

**Cost is not a differentiator.** Live speech-to-text costs about $0.15 to $0.46 per audio hour, per stream ([AssemblyAI price guide, Sept 30, 2026](https://www.assemblyai.com/blog/speech-to-text-api-pricing)). We send two streams, mic and call audio. So a person with 20 meeting hours a month costs roughly $6 to $18, before AI notes and hosting. Granola Business is $14 a seat. That is about even. We only save money against the $35 plan, or for people with few calls.

**Against anarlog the edge is smaller.** Its free app already keeps audio, runs on your own keys, and has a local MCP. So wins 1 and 4 are not new there. Our edge is the team part: one shared store, team-wide search, and keys scoped to a project. Not yet verified: whether anarlog's paid plan offers a team-wide MCP. Verify before M7.

## Stack choices

Every pick favors the team's existing skills and the simplest thing that works. Each one can be swapped later.

| Part | Pick | Why |
| --- | --- | --- |
| Desktop app | Electron, React, TypeScript | Matches the team's React and TypeScript skills. Coding agents handle it well. |
| Call audio | Electron's built-in system audio capture first. A small Swift helper only if that proves flaky. | Electron 39 and up uses Apple's Core Audio tap on macOS 14.2 and up. It needs one Info.plist key. Which macOS permission prompts it shows is something M1 must test. It has open bugs, so the helper is plan B. ([Electron docs](https://www.electronjs.org/docs/latest/api/desktop-capturer), [open bug](https://github.com/electron/electron/issues/52738)) |
| Speech-to-text | One cloud vendor, hidden behind our own small interface. Choose it with a test on our own calls in M3. | Prices and models change often. The interface lets us swap vendors with a config change. |
| Vendor keys | The backend hands the app a short-lived token. The real key never ships in the app. | Granola once exposed a vendor key through a client build. ([their post-mortem](https://docs.granola.ai/help-center/policies/security-reports/post-mortem-assembly-ai-api-key-exposure)) |
| Backend | FastAPI and Postgres | Matches the team's Python skills. Postgres does keyword search and meaning search (pgvector) in one place. |
| AI notes | LiteLLM through OpenRouter | One interface to many model providers. Swapping models is a config change. |
| Notes editor | TipTap | The common rich-text editor for React. |
| MCP | A remote MCP server inside the same FastAPI app. Streamable HTTP plus OAuth. | The same standard Granola uses, so it works in Claude and Claude Code. |
| Local safety | A small SQLite file on the Mac holds the transcript as it arrives. Postgres is the source of truth. | A crash or bad wifi must never lose a call. |
| Many teams later | Every table row has a `workspace_id` from day one. | Cheap now. Painful to add later. |

Two open-source Granola clones already exist: [anarlog](https://github.com/fastrepl/anarlog) and [Meetily](https://github.com/Zackriya-Solutions/meetily), both MIT licensed. Both are local, single-user apps. The anarlog section above says how we use them.

## Milestones

Seventeen milestones in five phases. Each phase ends at a gate, and the next phase waits until the gate passes. The plan is revised at every gate.

After phase 4 the app matches Granola for Linkt's daily use on Mac, and beats it in the four places above. Windows, phones, CRM sync and enterprise admin are phase 5, and only if Linkt decides to sell.

&#91;embedded content: roadmap · 5 phases, 4 gates\]

Read it left to right. Each diamond is a gate, and the phase after it waits until the gate passes.

Each milestone closes with an exit check that runs on a real call.

### Phase 1: Prove it

**M0. Setup.**

- One repo, two apps: the desktop app and the API.
- A `CLAUDE.md` with the house rules, and one plan template that every milestone reuses.
- The one-page v1 spec.
- Done when: one command runs tests and lint for both apps.

**M1. Walking skeleton.**

- An Electron app with one Start and Stop button.
- It captures the mic and the call audio as two streams.
- It sends both to speech-to-text and saves the text through the API into Postgres, all running locally.
- One MCP tool: get the full transcript of a call.
- Scope is end to end, not polish. Every risky part is exercised once.
- Done when: after a real 30-minute Meet call, Claude quotes a line from it through MCP.

**Gate 1: a real call goes in, and its full transcript comes out through MCP.**

### Phase 2: Daily driver

Goal: the app is reliable enough for one person to run every call on it.

**M2. Capture you can trust.**

- A permission setup screen with clear errors. A loud warning when it hears no audio.
- It survives AirPods connecting mid-call, a 2-hour call, sleep and wake, and a crash. Text is saved as it arrives. A local audio backup of each call is kept for a few days, so a failed transcript can be re-run.
- Echo fix: on laptop speakers the mic also hears the other people. Remove the doubled lines.
- It notices a call starting and offers to take notes. It stops by itself when the call ends.
- Done when: 10 real calls in a row with no lost or doubled text, and cutting the audio mid-call triggers the warning within 10 seconds.

**M3. Live transcript.**

- Text shows within about 2 seconds, labelled Me and Them.
- A jargon list for names like Linkt.
- Build a test set: 10 short recordings of our own calls, with our real accents and jargon, and hand-fixed text. Score two or three vendors on it, then pick one.
- This test set becomes the standing accuracy benchmark for every later model change.
- Done when: the error rate of the chosen vendor is written down, and swapping vendor is one config change.

**M4. Notes and AI.**

- A notepad beside the live transcript.
- After the call, AI turns your rough notes plus the transcript into clean notes. Every AI line links to the transcript lines behind it.
- Templates for standup, client call and 1:1.
- Chat with one meeting.
- Done when: notes from 5 real calls each need under 2 minutes of fixing.

**M5. Calendar.**

- Google Calendar sign-in. Today's meetings on the home screen.
- A notification just before each meeting. One click starts the note.
- Title and attendee names come from the invite. The notice to other people is on by default: the app reminds the user before each call and offers a one-click message for the chat.
- Done when: 20 calls in a row are started from the notification.

**Gate 2: one person runs 20 calls in a row on this app, with Granola closed.**

### Phase 3: Team switch

Goal: the Linkt team can cancel Granola.

**M6. Cloud and login.**

- Deploy the API and Postgres. Google sign-in. Workspaces and members.
- The desktop app saves locally first, then uploads. It works offline.
- The backend hands out short-lived speech-to-text tokens.
- A simple web page to read a note, so share links work.
- Done when: two people on two Macs each see their own calls, and automated tests prove neither can read the other's private ones.

**M7. MCP and API.**

- Remote MCP with OAuth sign-in. Tools: list meetings for any dates, search, get notes, get transcript (full or a slice), list folders.
- A REST API with the same powers.
- Done when: Claude and Claude Code both connect, and a test agent answers 10 questions about past calls with correct quotes.

**M8. Search and chat.**

- Keyword search plus meaning search across every call the user may see. Results are quotes with speaker, time and a link.
- Chat across calls and folders, with sources.
- Done when: on 20 questions with known answers, the right call is in the top 3 at least 18 times.

**M9. Speaker names, version 1.**

- Attendee names from the calendar invite.
- A Chrome extension reads who is speaking in Google Meet. This is the method Granola uses. The same extension posts the transcription notice in the Meet chat.
- The speech vendor splits Them into Speaker 1, 2, 3. We match those to names with the Meet signal.
- Click a name to fix it. The fix applies to the whole call.
- Done when: on 5 Meet calls with three or more people, at least 90% of lines carry the right name.

**M10. Sharing.**

- Folders and a team space. Private by default. Share a note by link or with people.
- Send notes and action items to Slack. Export everything, transcripts included.
- App, API, search and MCP all obey the same permission rules.
- Done when: a permission test suite passes on all four paths.

**M11. Ship-ready.**

- A signed and notarized Mac build with auto-update.
- First-run setup in under 3 minutes.
- Crash reports, and a clear light that shows it is listening.
- Import old notes from Granola.
- Notice settings that an admin can lock on for the whole team.
- Done when: a teammate installs it alone and records a call with no help.

**Gate 3: three to five Linkt people each run 20 calls on it beside Granola, then choose it.**

### Phase 4: Beat Granola

**M12. Second pass.**

- After the call, re-run the audio backup from M2 with the best non-live model.
- The better transcript replaces the live one.
- Click a quote to hear it.
- Done when: the second pass beats the live pass on our test set, and audio deletes itself on schedule.

**M13. Voice memory.**

- Save a voice print only for team members who opt in. Never for guests. Fireflies is being sued over voice prints of people who never agreed.
- Names fill in with no Meet signal: Zoom, in-person, phone.
- Old transcripts get names too.
- Done when: a known teammate is named correctly on a call with the Chrome extension off.

**M14. Project keys.**

- MCP and API keys scoped to a folder or project.
- Service accounts for agents.
- A webhook fires when a note is ready.
- Done when: tests prove a key for project A cannot read project B, and an agent pulls a transcript right after a call ends.

**Gate 4: go or no-go on selling to outside customers.**

### Phase 5: Sell-ready (only if we sell)

**M15. Many customers.** Billing, admin screens, SSO, an audit log, data export and delete, and a security review.

**M16. More platforms.** Windows, a phone app, Zoom and Teams speaker names, CRM sync, and on-device transcription.

These two get scoped only after gate 4.

## Risks

The biggest risk is audio capture, which is why it comes first. The rest are listed with the step that lowers each one.

| Risk | How we lower it |
| --- | --- |
| Call audio capture is flaky. Electron's capture has open bugs. Headsets change mid-call. Speakers cause echo. | M1 tests it first. A Swift helper is plan B. M2 is a whole milestone just for trust. |
| One lost call kills trust in the app. | Text and an audio backup are saved on the Mac as the call runs. A loud warning shows when no audio is heard. The team runs it beside Granola until gate 3. |
| Speaker names are less right than we hope. Google can change the Meet page and break the extension. | Three sources: the invite, the Meet signal, and voice. A one-click fix is always there. We measure against the 90% check. |
| Scope. Granola is built by a funded team, and a copy of everything is years of work. | Gates. We match daily use, not every feature. Phase 5 happens only if Linkt sells. |
| Privacy and law. Some places need everyone's OK before a call is transcribed. Granola, Otter and Fireflies are all being sued over this. Voice prints and kept audio raise the stakes. | The notice is on by default from M5. Voice memory is for team members who opt in, never guests. Audio is kept for a short, fixed time. Linkt gets a legal view before gate 2. |
| Cost creep from two streams, a second pass and AI notes. | Track cost per meeting hour from M3. Set a budget per meeting hour and alert when it is passed. |
| Agent-written code that nobody understands. | Small plans. An engineer reviews every change. Exit checks are tests. Permission tests are never skipped. |
| This app holds every client call, so a leak is serious. | No vendor keys in the app. Permission tests on every path. Secrets live in a secrets manager. |

## Open decisions

None of these block M0 or M1. All of them shape phase 2 and later.

- [ ] Current Granola plan and seat count at Linkt. This sets the cost baseline.
- [ ] Meeting apps to support first: Meet only, or Zoom and Teams too.
- [ ] Minimum macOS version across the team, and whether anyone is on Windows.
- [ ] Hosting provider, and the speech-to-text budget.
- [ ] Policy on keeping audio, and on storing voice prints.
- [ ] The first project to get a scoped MCP key.
- [ ] Who signs off each gate.
- [ ] The public name, if we sell. The internal name is Roger.
