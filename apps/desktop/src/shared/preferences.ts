/**
 * Preferences: the small choices a user makes once (the theme, notes after Stop, the reminder lead
 * time), read by main and by the page. Main's PreferencesStore (src/main/preferences/) keeps them
 * in `userData/preferences.json` and serves them over IPC (src/shared/ipc/prefs.ts). `config.json`
 * is not this: it holds startup settings read once (src/main/config.ts).
 *
 * This file holds the registry and the keys the app shell and the notes own. Every other
 * milestone keeps its keys in its own file (M5: src/shared/calendarPrefs.ts) and adds them in two
 * places, in the same change:
 *
 * 1. Typed access: augment PreferenceValues from that file, so `get`, `getPreferences` and the
 *    change events know the new keys' types:
 *
 *        declare module './preferences' {
 *          interface PreferenceValues {
 *            'calendar.reminderLeadMinutes': ReminderLeadMinutes;
 *          }
 *        }
 *
 * 2. Registration: hand its specs to `PreferencesStore.register` in main before the window opens
 *    (its slot in src/main/index.ts), and to the preview's fake (preview/fakes/prefs.ts). `register`
 *    takes only specs whose keys are in PreferenceValues, so step 1 cannot be skipped; a key
 *    augmented but never registered is missing from `getPreferences` at run time, and nothing
 *    else catches that.
 *
 * Keep this file free of runtime imports: it is bundled into every process.
 */

/** `system` follows macOS; `light` and `dark` force one (renderer/src/theme/useTheme.ts). */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * What Roger does at Stop when no rule picks a notes template (M4, "When notes generate"): ask
 * with the four templates, or use General.
 */
export const NOTES_WHEN_UNSURE = ['ask', 'general'] as const;
export type NotesWhenUnsure = (typeof NOTES_WHEN_UNSURE)[number];

/** Every preference's value type, by key. Other milestones augment it (see the top of the file). */
export interface PreferenceValues {
  theme: ThemePreference;
  /** Generate AI notes after Stop (M4-T23, wired by M4-T16). */
  'notes.autoGenerate': boolean;
  'notes.whenUnsure': NotesWhenUnsure;
}

export type PreferenceKey = keyof PreferenceValues;

/**
 * One entry of the registry: `parse` returns the value, or throws with a message that names the
 * key. The store refuses a bad set with that message, and falls back to `default` when the file
 * holds a bad value.
 */
export interface PreferenceSpec<K extends PreferenceKey> {
  key: K;
  default: PreferenceValues[K];
  parse: (raw: unknown) => PreferenceValues[K];
}

/** What `register` takes: specs by key, such as APP_PREFERENCES or M5's CALENDAR_PREFERENCES. */
export type PreferenceSpecs = { readonly [K in PreferenceKey]?: PreferenceSpec<K> };

/** One key's new value: what a set carries and what every change event sends. */
export type PreferenceChange = {
  [K in PreferenceKey]: { key: K; value: PreferenceValues[K] };
}[PreferenceKey];

type AppPreferenceKey = 'theme' | 'notes.autoGenerate' | 'notes.whenUnsure';

/** The keys this file owns: the theme (the app shell) and M4's notes switches. */
export const APP_PREFERENCES: { readonly [K in AppPreferenceKey]: PreferenceSpec<K> } = {
  theme: {
    key: 'theme',
    default: 'system',
    parse: (raw) => parseOneOf('theme', THEME_PREFERENCES, raw),
  },
  'notes.autoGenerate': {
    key: 'notes.autoGenerate',
    default: true,
    parse: (raw) => {
      if (typeof raw === 'boolean') return raw;
      throw new Error(`notes.autoGenerate must be true or false (got ${describe(raw)})`);
    },
  },
  'notes.whenUnsure': {
    key: 'notes.whenUnsure',
    default: 'ask',
    parse: (raw) => parseOneOf('notes.whenUnsure', NOTES_WHEN_UNSURE, raw),
  },
};

type AnyPreferenceSpec = PreferenceSpec<PreferenceKey>;

/**
 * The registered specs: which keys exist, their defaults, and the check every value passes, in
 * main (PreferencesStore) and in the preview's fake alike, so both refuse the same values with the
 * same words.
 */
export class PreferenceRegistry {
  private readonly specs = new Map<string, AnyPreferenceSpec>();

  /** Adds the specs and returns their keys. A key registered before refuses the whole call. */
  register(specs: PreferenceSpecs): PreferenceKey[] {
    // exactOptionalPropertyTypes: a key left out is absent, never present as undefined.
    const incoming: AnyPreferenceSpec[] = Object.values(specs);
    const taken = incoming.find((spec) => this.specs.has(spec.key));
    if (taken) throw new Error(`preference ${taken.key} is registered twice`);
    for (const spec of incoming) this.specs.set(spec.key, spec);
    return incoming.map((spec) => spec.key);
  }

  /** Every registered key, in registration order. */
  keys(): PreferenceKey[] {
    return [...this.specs.values()].map((spec) => spec.key);
  }

  /**
   * Checks a key and a value from outside the type system (a file, IPC). Throws for a key nobody
   * registered and for a value its spec refuses, with a message that names the key.
   */
  parse(key: unknown, raw: unknown): PreferenceChange {
    const spec = this.specOf(key);
    // The map forgets which value type goes with which key. register() stored each spec under its
    // own key, so this spec's parse returns this key's type.
    return { key: spec.key, value: spec.parse(raw) } as PreferenceChange;
  }

  /** The key's value in `current` (values that passed parse), else its default. */
  valueIn<K extends PreferenceKey>(
    key: K,
    current: ReadonlyMap<string, unknown>,
  ): PreferenceValues[K] {
    const spec = this.specOf(key);
    // As in parse(): `current` holds only values that passed this key's spec.
    return (current.has(key) ? current.get(key) : spec.default) as PreferenceValues[K];
  }

  /**
   * Every registered key's value. Typed as every key of PreferenceValues: a key augmented there
   * but never registered is missing at run time (see the top of this file).
   */
  snapshot(current: ReadonlyMap<string, unknown>): PreferenceValues {
    const values: Partial<Record<PreferenceKey, PreferenceValues[PreferenceKey]>> = {};
    for (const key of this.keys()) values[key] = this.valueIn(key, current);
    return values as PreferenceValues;
  }

  private specOf(key: unknown): AnyPreferenceSpec {
    const spec = typeof key === 'string' ? this.specs.get(key) : undefined;
    if (!spec) throw new Error(`unknown preference ${describe(key)}`);
    return spec;
  }
}

function parseOneOf<T extends string>(key: string, choices: readonly T[], raw: unknown): T {
  const match = choices.find((choice) => choice === raw);
  if (match !== undefined) return match;
  const list = `${choices.slice(0, -1).join(', ')} or ${String(choices.at(-1))}`;
  const allowed = choices.length > 2 ? `one of ${list}` : list;
  throw new Error(`${key} must be ${allowed} (got ${describe(raw)})`);
}

/** Enough of a bad value to fix it, without copying a long text into a log line. */
function describe(raw: unknown): string {
  if (typeof raw === 'string') return raw.length > 40 ? `${raw.length} characters` : `"${raw}"`;
  if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) return String(raw);
  return typeof raw;
}
