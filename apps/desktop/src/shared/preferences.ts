/**
 * Preferences: the small choices a user makes once (the theme, notes after Stop, the reminder lead
 * time), read by main and by the page. Main's PreferencesStore (src/main/preferences/) keeps them
 * in `userData/preferences.json` and serves them over IPC (src/shared/ipc/prefs.ts). `config.json`
 * is not this: it holds startup settings read once (src/main/config.ts).
 *
 * This file holds the registry, the keys the app shell and the notes own, and the type of every
 * key in the app. Every other milestone keeps its keys, defaults and checks in its own file (M5:
 * src/shared/calendarPrefs.ts) and wires them in three places:
 *
 * 1. Typed access: PreferenceValues below extends that file's values type, so `get`,
 *    `getPreferences` and the change events know the keys' types. It is done here, not by
 *    augmenting the interface from a milestone's file: the page's type check reads only
 *    src/renderer, src/shared and preview (tsconfig.web.json), so an augmentation in main is
 *    invisible to it, and M5's one shared file (calendarPrefs.ts, M5-T8) had already landed.
 * 2. Main: the milestone hands its specs to `PreferencesStore.register` before the window opens,
 *    from its own slot in src/main/index.ts (M5: `registerCalendarPreferences`, M5-T9a, from
 *    M5-T9c's slot). A key typed here but never registered in main is missing from
 *    `getPreferences` at run time, and nothing catches that: until M5-T9c lands, M5's are.
 * 3. The preview: preview/fakes/prefs.ts registers every milestone's specs, because M4-S2 is
 *    that file's one writer in Phase 2 (phase-2-build-order.md) and no M5 task may edit it. Its
 *    spec map is typed with every key, so a key typed here but missing there fails the type check.
 *
 * A milestone with new keys after Phase 2 does steps 1 and 3 in these two files, in the same
 * change as its own file. Keep this file free of runtime imports: it is bundled into every
 * process (a type-only import is erased).
 */

import type { CalendarPreferenceValues } from './calendarPrefs';

/** `system` follows macOS; `light` and `dark` force one (renderer/src/theme/useTheme.ts). */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * What Roger does at Stop when no rule picks a notes template (M4, "When notes generate"): ask
 * with the four templates, or use General.
 */
export const NOTES_WHEN_UNSURE = ['ask', 'general'] as const;
export type NotesWhenUnsure = (typeof NOTES_WHEN_UNSURE)[number];

/** Every preference's value type, by key: this file's, and each milestone's (top of the file). */
export interface PreferenceValues extends CalendarPreferenceValues {
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
   * Every registered key's value. Typed as every key of PreferenceValues: a key typed there but
   * never registered is missing at run time (see the top of this file).
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
