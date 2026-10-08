import { describe, expect, it } from 'vitest';
import {
  BLUETOOTH_MIC_DEAD_WARNING_MS,
  CALL_AUDIO_NEVER_HEARD_WARNING_MS,
  CALL_AUDIO_SILENT_LOUD_MS,
  CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS,
  CALL_AUDIO_SILENT_WARNING_MS,
  MIC_DEAD_WARNING_MS,
  NO_AUDIO_WARNING_MS,
} from '../../shared/capture';
import { warningHeadline, wordsOutsideDetails } from '../../shared/captureWords';
import type { AudioSource } from '../../shared/transcript';
import {
  deadSignalAfterMs,
  type DetectedWarning,
  detectWarnings,
  KEYTERMS_REJECTED_MESSAGE,
  type SignalFacts,
  type SourceSignal,
  warningTitle,
  WarningSpells,
} from './warnings';

/** A source that is fine: chunks flow and carry sound. */
function healthy(overrides: Partial<SourceSignal> = {}): SourceSignal {
  return { stopped: null, noChunkForMs: 100, silentForMs: 0, heard: true, ...overrides };
}

function facts(
  sources: Partial<Record<AudioSource, Partial<SourceSignal>>> = {},
  overrides: Partial<Omit<SignalFacts, 'sources'>> = {},
): SignalFacts {
  return {
    sources: { mic: healthy(sources.mic), system: healthy(sources.system) },
    micBluetooth: false,
    micSpokeSinceCallSilence: false,
    systemAudioVerified: true,
    offline: false,
    ...overrides,
  };
}

/** What the rules decided, without the wording, which the next tests read on their own. */
function kinds(detected: DetectedWarning[]): Pick<DetectedWarning, 'kind' | 'source' | 'loud'>[] {
  return detected.map(({ kind, source, loud }) => ({ kind, source, loud }));
}

describe('detectWarnings', () => {
  it('warns of nothing while both sources send audio that carries sound', () => {
    expect(detectWarnings(facts())).toEqual([]);
  });

  it('warns loudly of a source that sent no chunk for 5 s, dated from its last chunk', () => {
    expect(detectWarnings(facts({ mic: { noChunkForMs: NO_AUDIO_WARNING_MS - 1 } }))).toEqual([]);
    const detected = detectWarnings(facts({ system: { noChunkForMs: NO_AUDIO_WARNING_MS } }));
    expect(kinds(detected)).toEqual([{ kind: 'no-audio', source: 'system', loud: true }]);
    expect(detected[0]?.heldForMs).toBe(NO_AUDIO_WARNING_MS);
  });

  it('calls a mic dead after 8 s of digital silence', () => {
    expect(detectWarnings(facts({ mic: { silentForMs: MIC_DEAD_WARNING_MS - 1 } }))).toEqual([]);
    const detected = detectWarnings(facts({ mic: { silentForMs: MIC_DEAD_WARNING_MS } }));
    expect(kinds(detected)).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    expect(detected[0]?.heldForMs).toBe(MIC_DEAD_WARNING_MS);
  });

  it('gives a Bluetooth mic 30 s before calling it dead (D4)', () => {
    const bluetooth = { micBluetooth: true };
    expect(detectWarnings(facts({ mic: { silentForMs: MIC_DEAD_WARNING_MS } }, bluetooth))).toEqual(
      [],
    );
    expect(
      detectWarnings(facts({ mic: { silentForMs: BLUETOOTH_MIC_DEAD_WARNING_MS - 1 } }, bluetooth)),
    ).toEqual([]);
    expect(
      kinds(
        detectWarnings(facts({ mic: { silentForMs: BLUETOOTH_MIC_DEAD_WARNING_MS } }, bluetooth)),
      ),
    ).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    expect(deadSignalAfterMs('mic', true)).toBe(BLUETOOTH_MIC_DEAD_WARNING_MS);
    expect(deadSignalAfterMs('mic', false)).toBe(MIC_DEAD_WARNING_MS);
    // A Bluetooth mic says nothing about call audio.
    expect(deadSignalAfterMs('system', true)).toBe(CALL_AUDIO_SILENT_WARNING_MS);
  });

  it('warns of call audio never heard for 20 s: loud while unverified, on screen once verified', () => {
    // Before call audio was ever heard, its 8 s mid-call rule does not apply: a waiting room and
    // an early join are silent too.
    const never = (silentForMs: number) => ({ system: { heard: false, silentForMs } });
    expect(
      detectWarnings(
        facts(never(CALL_AUDIO_NEVER_HEARD_WARNING_MS - 1), { systemAudioVerified: false }),
      ),
    ).toEqual([]);
    expect(
      kinds(
        detectWarnings(
          facts(never(CALL_AUDIO_NEVER_HEARD_WARNING_MS), { systemAudioVerified: false }),
        ),
      ),
    ).toEqual([{ kind: 'call-audio-never-heard', source: 'system', loud: true }]);
    expect(
      kinds(
        detectWarnings(
          facts(never(CALL_AUDIO_NEVER_HEARD_WARNING_MS), { systemAudioVerified: true }),
        ),
      ),
    ).toEqual([{ kind: 'call-audio-never-heard', source: 'system', loud: false }]);
  });

  it('shows call audio gone silent mid-call at 8 s, loud at 180 s, or at 60 s while the mic talks (D3)', () => {
    const silent = (silentForMs: number, micSpokeSinceCallSilence = false) =>
      kinds(detectWarnings(facts({ system: { silentForMs } }, { micSpokeSinceCallSilence })));
    const onScreen = [{ kind: 'call-audio-silent', source: 'system', loud: false }];
    const loud = [{ kind: 'call-audio-silent', source: 'system', loud: true }];

    expect(silent(CALL_AUDIO_SILENT_WARNING_MS - 1, true)).toEqual([]);
    expect(silent(CALL_AUDIO_SILENT_WARNING_MS)).toEqual(onScreen);
    expect(silent(CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS - 1, true)).toEqual(onScreen);
    expect(silent(CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS, true)).toEqual(loud);
    expect(silent(CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS)).toEqual(onScreen);
    expect(silent(CALL_AUDIO_SILENT_LOUD_MS - 1)).toEqual(onScreen);
    expect(silent(CALL_AUDIO_SILENT_LOUD_MS)).toEqual(loud);
  });

  it('names a source that stopped over any silence of it, never quoting its reason', () => {
    const detected = detectWarnings(
      facts({
        mic: {
          stopped: { message: 'spawn EACCES' },
          noChunkForMs: 20_000,
          silentForMs: 20_000,
        },
      }),
    );
    expect(kinds(detected)).toEqual([{ kind: 'source-ended', source: 'mic', loud: true }]);
    // The reason is the source's own message, which Details shows (sweep W2).
    expect(detected[0]?.message).toBe(
      "Your microphone stopped, so Roger can't hear you. Check it is connected, then press Stop and Start notes again.",
    );
    const callAudio = detectWarnings(
      facts({ system: { stopped: { message: 'the call audio helper quit (exit 1)' } } }),
    )[0]?.message;
    expect(callAudio).toBe(
      "Call audio stopped, so Roger can't hear the call. Press Stop, then Start notes again.",
    );
    expect(detectWarnings(facts({ system: { stopped: { message: null } } }))[0]?.message).toBe(
      callAudio,
    );
  });

  it('gives a source that stopped sending chunks one warning, not a silence warning as well', () => {
    expect(
      kinds(
        detectWarnings(
          facts({ mic: { noChunkForMs: NO_AUDIO_WARNING_MS, silentForMs: MIC_DEAD_WARNING_MS } }),
        ),
      ),
    ).toEqual([{ kind: 'no-audio', source: 'mic', loud: true }]);
  });

  it('warns once, for both streams, while transcription is offline', () => {
    expect(kinds(detectWarnings(facts({}, { offline: true })))).toEqual([
      { kind: 'offline', source: null, loud: true },
    ]);
  });

  it('says what is wrong and what to do in every warning, with no placeholder left in', () => {
    const every = [
      ...detectWarnings(facts({ mic: { noChunkForMs: 9_000 }, system: { noChunkForMs: 9_000 } })),
      ...detectWarnings(facts({ mic: { silentForMs: 9_000 } }, { offline: true })),
      ...detectWarnings(facts({ system: { heard: false, silentForMs: 30_000 } })),
      ...detectWarnings(
        facts({ system: { heard: false, silentForMs: 30_000 } }, { systemAudioVerified: false }),
      ),
      ...detectWarnings(facts({ system: { silentForMs: 9_000 } })),
      ...detectWarnings(facts({ system: { silentForMs: CALL_AUDIO_SILENT_LOUD_MS } })),
    ];
    every.push(
      ...detectWarnings(facts({ mic: { stopped: { message: 'gone' } } })),
      ...detectWarnings(facts({ system: { stopped: { message: 'gone' } } })),
      ...detectWarnings(
        facts(
          { system: { silentForMs: CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS } },
          {
            micSpokeSinceCallSilence: true,
          },
        ),
      ),
    );
    expect(every).toHaveLength(11);
    expect(new Set(every.map((warning) => warning.message)).size).toBe(11);
    for (const warning of [...every.map(({ message }) => message), KEYTERMS_REJECTED_MESSAGE]) {
      expect(warning.length).toBeGreaterThan(20);
      expect(warning).not.toMatch(/\$\{/);
      // The naming list, and no vendor, code or internal word: these reach the banner and a
      // macOS notification's body (docs/design.md, Words from main).
      expect(wordsOutsideDetails(warning), warning).toEqual([]);
    }
  });
});

describe('warningTitle', () => {
  it("titles a notification with the page's headline for the same warning (sweep N1)", () => {
    for (const warning of [
      { kind: 'no-audio', source: 'mic' },
      { kind: 'no-audio', source: 'system' },
      { kind: 'source-ended', source: 'mic' },
      { kind: 'mic-dead', source: 'mic' },
      { kind: 'offline', source: null },
      { kind: 'keyterms-rejected', source: 'system' },
    ] as const) {
      expect(warningTitle(warning)).toBe(warningHeadline(warning));
    }
  });

  it('titles a notification by what is wrong and with which stream', () => {
    expect(warningTitle({ kind: 'no-audio', source: 'mic' })).not.toBe(
      warningTitle({ kind: 'no-audio', source: 'system' }),
    );
    expect(warningTitle({ kind: 'offline', source: null })).toBe('The Mac is offline');
    // Kinds other features raise (M2-T10's watchdog, M2-T15's disk guard) are titled here too: the
    // Notifier posts every loud warning in the status, whoever raised it.
    expect(warningTitle({ kind: 'helper-hung', source: 'system' })).toBe('Call audio stalled');
    expect(warningTitle({ kind: 'backup-paused', source: null })).toBe('Audio backup paused');
  });
});

const T0 = Date.parse('2026-10-07T10:00:00.000Z');

function detected(overrides: Partial<DetectedWarning> = {}): DetectedWarning {
  return {
    kind: 'mic-dead',
    source: 'mic',
    loud: true,
    message: 'The mic sends only silence.',
    heldForMs: MIC_DEAD_WARNING_MS,
    ...overrides,
  };
}

describe('WarningSpells', () => {
  it('dates a spell from when its condition began, and keeps that date while it lasts', () => {
    const spells = new WarningSpells();
    const first = spells.update([detected()], T0);
    const since = new Date(T0 - MIC_DEAD_WARNING_MS).toISOString();
    expect(first.warnings).toEqual([
      {
        kind: 'mic-dead',
        source: 'mic',
        loud: true,
        message: 'The mic sends only silence.',
        since,
      },
    ]);
    expect(first.raised).toEqual(first.warnings);
    expect(first.changed).toBe(true);

    const later = spells.update([detected({ heldForMs: MIC_DEAD_WARNING_MS + 1_000 })], T0 + 1_000);
    expect(later.warnings[0]?.since).toBe(since);
    expect(later.raised).toEqual([]);
    expect(later.cleared).toEqual([]);
    expect(later.changed).toBe(false);
  });

  it('ends a spell when its warning is gone; the next one is a new spell', () => {
    const spells = new WarningSpells();
    const [first] = spells.update([detected()], T0).warnings;
    const gone = spells.update([], T0 + 1_000);
    expect(gone.warnings).toEqual([]);
    expect(gone.cleared).toEqual([first]);
    expect(gone.changed).toBe(true);

    const again = spells.update([detected()], T0 + 60_000);
    expect(again.raised).toHaveLength(1);
    expect(again.warnings[0]?.since).not.toBe(first?.since);
  });

  it('keeps one spell per kind and stream', () => {
    const spells = new WarningSpells();
    const both = spells.update(
      [detected(), detected({ kind: 'no-audio', source: 'system', heldForMs: 5_000 })],
      T0,
    );
    expect(both.warnings.map(({ kind, source }) => `${kind}/${String(source)}`)).toEqual([
      'mic-dead/mic',
      'no-audio/system',
    ]);
    const one = spells.update([detected({ heldForMs: 9_000 })], T0 + 1_000);
    expect(one.cleared.map(({ kind }) => kind)).toEqual(['no-audio']);
  });

  it('raises a spell again when it turns loud, keeping its date', () => {
    const spells = new WarningSpells();
    const quiet = detected({
      kind: 'call-audio-silent',
      source: 'system',
      loud: false,
      message: 'Call audio is silent.',
      heldForMs: CALL_AUDIO_SILENT_WARNING_MS,
    });
    const [onScreen] = spells.update([quiet], T0).warnings;
    const louder = spells.update(
      [{ ...quiet, loud: true, message: 'Call audio has been silent for 3 minutes.' }],
      T0 + 172_000,
    );
    expect(louder.raised).toEqual([
      {
        kind: 'call-audio-silent',
        source: 'system',
        loud: true,
        message: 'Call audio has been silent for 3 minutes.',
        since: onScreen?.since,
      },
    ]);
    expect(louder.changed).toBe(true);

    // Quiet again (verified mid-spell): an update, not a new spell, and nothing to raise.
    const calmer = spells.update([{ ...quiet, heldForMs: 200_000 }], T0 + 200_000);
    expect(calmer.raised).toEqual([]);
    expect(calmer.changed).toBe(true);
    expect(calmer.warnings[0]).toMatchObject({ loud: false, since: onScreen?.since });
  });

  it('ends every spell at once when the recording ends', () => {
    const spells = new WarningSpells();
    const { warnings } = spells.update([detected()], T0);
    expect(spells.clear()).toEqual(warnings);
    expect(spells.update([], T0 + 1_000)).toEqual({
      warnings: [],
      raised: [],
      cleared: [],
      changed: false,
    });
  });
});
