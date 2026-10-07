/**
 * Cost guards: every number that bounds how long Roger keeps a billed speech-to-text session open,
 * in one place. AssemblyAI bills each second a session is open, silent or not, at $0.15 an hour per
 * stream, and every meeting runs two streams (mic and call audio). A session nobody needs is money
 * lost every second it stays open: a recording forgotten overnight (14 hours, two streams) costs
 * about $4.20, and one abandoned socket runs to the vendor's 3-hour cap, $0.45.
 *
 * Each guard can be overridden in `config.json` (seconds or counts) or with its ROGER_* variable,
 * which wins. A value out of range is a configuration error that blocks Start: a typo must never
 * silently loosen a guard. apps/desktop/README.md ("Cost guards") lists them for people; keep the
 * two in step.
 */

export interface CostGuards {
  /** Close a source's session when it sends no audio chunk for this long; its next chunk reopens. */
  sttStallCloseMs: number;
  /** Audio held while a session reopens, then sent in order once it is ready. */
  sttReopenBufferMs: number;
  /** Vendor sessions opened per rolling minute, both sources together, Start included. */
  sttOpensPerMinute: number;
  /** Vendor sessions opened per meeting, Start included. */
  sttOpensPerMeeting: number;
  /** First wait before reopening after the vendor ended a session mid-call; doubles per failure. */
  sttReopenBackoffMs: number;
  sttReopenBackoffMaxMs: number;
  /** Stop when no final line arrived from either source for this long. */
  noSpeechStopMs: number;
  /** Stop any recording this old. */
  maxRecordingMs: number;
  /** How long quitting waits for the normal stop before the app exits anyway. */
  quitStopTimeoutMs: number;
  /** Asked of the vendor: close a session that receives nothing for this long (AssemblyAI). */
  sttVendorIdleTimeoutMs: number;
  /**
   * The silence gate's hang-over (M3-T20): close a source's session after this long with chunks
   * arriving and none of them speech; its next speech chunk reopens it. 0 turns the gate off.
   */
  sttSilenceCloseMs: number;
  /** Audio kept while a source is closed for silence, sent first when speech reopens it. */
  sttSilencePreRollMs: number;
  /** The gate's own reopens per meeting, both sources together; past it the gate is off. */
  sttSilenceReopensPerMeeting: number;
}

export interface CostGuardSetting {
  guard: keyof CostGuards;
  /** The key in config.json. */
  file: string;
  env: string;
  unit: 'seconds' | 'count';
  /** Bounds in `unit`. */
  min: number;
  max: number;
  why: string;
}

/** The defaults. Why each value: its `why` in COST_GUARD_SETTINGS below. */
export const DEFAULT_COST_GUARDS: Readonly<CostGuards> = Object.freeze({
  sttStallCloseMs: 30_000,
  sttReopenBufferMs: 3_000,
  sttOpensPerMinute: 4,
  sttOpensPerMeeting: 30,
  sttReopenBackoffMs: 2_000,
  sttReopenBackoffMaxMs: 60_000,
  noSpeechStopMs: 15 * 60_000,
  maxRecordingMs: 4 * 3_600_000,
  quitStopTimeoutMs: 5_000,
  sttVendorIdleTimeoutMs: 120_000,
  sttSilenceCloseMs: 30_000,
  sttSilencePreRollMs: 1_000,
  sttSilenceReopensPerMeeting: 120,
});

/** Definition order is the order errors are reported in, and the README table's order. */
export const COST_GUARD_SETTINGS: readonly CostGuardSetting[] = [
  {
    guard: 'sttStallCloseMs',
    file: 'sttStallCloseSeconds',
    env: 'ROGER_STT_STALL_CLOSE_SECONDS',
    unit: 'seconds',
    // Above NO_AUDIO_WARNING_MS (5 s): the "no audio" warning shows before the session closes.
    min: 10,
    max: 300,
    why:
      'A source that sends no chunk at all has a dead capture path, yet its session bills like a ' +
      'live one until Stop. 30 s is long enough that a device switch does not churn sessions ' +
      '(each reopen spends one of the per-minute opens).',
  },
  {
    guard: 'sttReopenBufferMs',
    file: 'sttReopenBufferSeconds',
    env: 'ROGER_STT_REOPEN_BUFFER_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 10,
    why:
      'Holds the audio that arrives while a session reopens (a connect takes about a second), so ' +
      'the chunk that woke it is not lost. Kept short: it is paced at 1x (AssemblyAI closes a ' +
      'session sent audio faster than real time, 3007), so it adds its own length of lag to that ' +
      'session until it closes.',
  },
  {
    guard: 'sttOpensPerMinute',
    file: 'sttOpensPerMinute',
    env: 'ROGER_STT_OPENS_PER_MINUTE',
    unit: 'count',
    // Start opens two sessions at once.
    min: 2,
    max: 100,
    why:
      'AssemblyAI lets a free account start 5 sessions a minute, and refuses the next after the ' +
      'handshake. Counted across meetings, since the vendor counts per account.',
  },
  {
    guard: 'sttOpensPerMeeting',
    file: 'sttOpensPerMeeting',
    env: 'ROGER_STT_OPENS_PER_MEETING',
    unit: 'count',
    min: 2,
    max: 1000,
    why:
      'Bounds a reopen loop against a vendor that keeps failing: past it the source stays closed ' +
      'with a visible error. 30 allows a reopen every 8 minutes of a 4-hour call.',
  },
  {
    guard: 'sttReopenBackoffMs',
    file: 'sttReopenBackoffSeconds',
    env: 'ROGER_STT_REOPEN_BACKOFF_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 60,
    why:
      'After the vendor ends a session mid-call, wait before reopening, doubling per failure in a ' +
      'row, so a failing vendor does not burn the per-minute opens in seconds.',
  },
  {
    guard: 'sttReopenBackoffMaxMs',
    file: 'sttReopenBackoffMaxSeconds',
    env: 'ROGER_STT_REOPEN_BACKOFF_MAX_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 600,
    why:
      'The longest wait between reopens. A minute matches the per-minute window, so a source ' +
      'that keeps failing tries about once a minute until the per-meeting cap.',
  },
  {
    guard: 'noSpeechStopMs',
    file: 'noSpeechStopSeconds',
    env: 'ROGER_NO_SPEECH_STOP_SECONDS',
    unit: 'seconds',
    min: 60,
    max: 14_400,
    why:
      'A forgotten Stop with silence still flowing (a muted mic, a call audio stream without its ' +
      'permission) bills two streams for hours: 15 minutes with no final line from either source ' +
      'stops the recording ($0.075 spent, where a night would be $4.20).',
  },
  {
    guard: 'maxRecordingMs',
    file: 'maxRecordingSeconds',
    env: 'ROGER_MAX_RECORDING_SECONDS',
    unit: 'seconds',
    min: 60,
    max: 86_400,
    why:
      'Hard cap per recording, even with speech (a TV left on): 4 hours is past any real meeting ' +
      'and costs $1.20 for both streams.',
  },
  {
    guard: 'quitStopTimeoutMs',
    file: 'quitStopTimeoutSeconds',
    env: 'ROGER_QUIT_STOP_TIMEOUT_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 30,
    why:
      'Quitting while recording runs the normal stop (last lines saved, sessions closed) but never ' +
      'hangs the quit: after 5 s the app exits, and process exit closes the sockets anyway.',
  },
  {
    guard: 'sttVendorIdleTimeoutMs',
    file: 'sttVendorIdleTimeoutSeconds',
    env: 'ROGER_STT_VENDOR_IDLE_TIMEOUT_SECONDS',
    unit: 'seconds',
    // AssemblyAI's inactivity_timeout takes 5..3600 s.
    min: 10,
    max: 3_600,
    why:
      "AssemblyAI's inactivity_timeout: the vendor closes a session that received nothing for this " +
      'long. Above the stall close, so it only fires when Roger cannot act (the Mac slept with the ' +
      'socket half-open); unset, such a session bills to the 3-hour cap.',
  },
  {
    guard: 'sttSilenceCloseMs',
    file: 'sttSilenceCloseSeconds',
    env: 'ROGER_STT_SILENCE_CLOSE_SECONDS',
    unit: 'seconds',
    // 0 turns the gate off; 1 to 9 is refused in loadCostGuards (MIN_SILENCE_CLOSE_MS).
    min: 0,
    max: 3_600,
    why:
      'AssemblyAI bills a session that only hears silence (a muted mic, a waiting room, an hour ' +
      'of listening) like one that hears talk. After 30 s of chunks with no speech in them the ' +
      "source's session closes, and its next speech chunk reopens it (CaptureSession). Long, " +
      'because a wrong "silence" loses words while a wrong "speech" only costs money.',
  },
  {
    guard: 'sttSilencePreRollMs',
    file: 'sttSilencePreRollSeconds',
    env: 'ROGER_STT_SILENCE_PRE_ROLL_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 3,
    why:
      'The audio just before the speech that reopens a gated session, sent first, so a soft first ' +
      'syllable the level check missed is not lost. 1 s, because held audio is paced at 1x and ' +
      'every held second is lag on that session until it next closes.',
  },
  {
    guard: 'sttSilenceReopensPerMeeting',
    file: 'sttSilenceReopensPerMeeting',
    env: 'ROGER_STT_SILENCE_REOPENS_PER_MEETING',
    unit: 'count',
    min: 1,
    max: 1_000,
    why:
      "The silence gate's own reopens, both sources together: each takes a slot in the " +
      'per-minute window but never one of sttOpensPerMeeting, which failures need. Past it the ' +
      'gate is off for that meeting and sessions stay open through silence until Stop.',
  },
];

/**
 * The shortest silence gate hang-over besides 0 (off). Shorter ones close sessions in the pauses
 * of a conversation: every reopen is a handshake, a token, and up to the held audio of lag.
 */
const MIN_SILENCE_CLOSE_MS = 10_000;

/**
 * The most audio a gate reopen may hold (the pre-roll plus sttReopenBufferMs): the core sends it
 * at 1x (T18), so it is lag on that session until it next closes.
 */
const MAX_GATE_HELD_MS = 10_000;

/** Default for one setting, in its config unit (seconds or a count). */
export function settingDefault(setting: CostGuardSetting): number {
  const value = DEFAULT_COST_GUARDS[setting.guard];
  return setting.unit === 'seconds' ? value / 1000 : value;
}

/**
 * Reads every guard from the environment (wins) and config.json's values. A refused value keeps its
 * default and adds an error: the caller blocks Start on any error, so it never runs loosened.
 */
export function loadCostGuards(
  env: NodeJS.ProcessEnv,
  file: Readonly<Record<string, unknown>>,
): { guards: CostGuards; errors: string[] } {
  const guards: CostGuards = { ...DEFAULT_COST_GUARDS };
  const errors: string[] = [];
  for (const setting of COST_GUARD_SETTINGS) {
    const envValue = env[setting.env];
    const fromEnv = typeof envValue === 'string' && envValue.trim() !== '';
    const raw: unknown = fromEnv ? envValue : file[setting.file];
    if (raw === undefined) continue;
    const value = fromEnv ? parseWholeNumber(envValue) : raw;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < setting.min ||
      value > setting.max
    ) {
      const where = fromEnv ? setting.env : `config.json "${setting.file}"`;
      errors.push(
        `${where} must be a whole number from ${setting.min} to ${setting.max} (got ${JSON.stringify(raw)})`,
      );
      continue;
    }
    guards[setting.guard] = toGuardValue(setting, value);
  }
  if (guards.sttVendorIdleTimeoutMs <= guards.sttStallCloseMs) {
    errors.push(
      `sttVendorIdleTimeoutSeconds (${guards.sttVendorIdleTimeoutMs / 1000}) must be above ` +
        `sttStallCloseSeconds (${guards.sttStallCloseMs / 1000}): the vendor timeout is the net ` +
        'for when Roger cannot close the session itself',
    );
  }
  if (guards.sttReopenBackoffMaxMs < guards.sttReopenBackoffMs) {
    errors.push(
      `sttReopenBackoffMaxSeconds (${guards.sttReopenBackoffMaxMs / 1000}) must be at least ` +
        `sttReopenBackoffSeconds (${guards.sttReopenBackoffMs / 1000})`,
    );
  }
  if (guards.sttSilenceCloseMs > 0 && guards.sttSilenceCloseMs < MIN_SILENCE_CLOSE_MS) {
    errors.push(
      `sttSilenceCloseSeconds (${guards.sttSilenceCloseMs / 1000}) must be 0 (the silence gate ` +
        `off) or at least ${MIN_SILENCE_CLOSE_MS / 1000}: a shorter hang-over closes sessions in ` +
        'the pauses of a conversation',
    );
  }
  if (guards.sttSilencePreRollMs + guards.sttReopenBufferMs > MAX_GATE_HELD_MS) {
    errors.push(
      `sttSilencePreRollSeconds (${guards.sttSilencePreRollMs / 1000}) plus ` +
        `sttReopenBufferSeconds (${guards.sttReopenBufferMs / 1000}) must be at most ` +
        `${MAX_GATE_HELD_MS / 1000}: every second held for a reopen is lag on that session until ` +
        'it closes',
    );
  }
  return { guards, errors };
}

function toGuardValue(setting: CostGuardSetting, value: number): number {
  return setting.unit === 'seconds' ? value * 1000 : value;
}

/** "45" → 45; anything else (a unit, a sign, a fraction) → NaN, which the range check refuses. */
function parseWholeNumber(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}
