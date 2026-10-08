import { useId, useState, type KeyboardEvent } from 'react';
import { THEME_PREFERENCES, type ThemePreference } from '../../../shared/preferences';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import { describeError } from '../app/describeError';
import { nextIndex } from '../components/ui/keyNav';
import { applyTheme, useTheme, type ThemeRoot } from '../theme/useTheme';
import { SettingsProblem } from './SettingsProblem';
import { SettingsRow } from './SettingsRow';
import './settings.css';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** The id of an option, so a key press can move focus onto the one it chose. */
const optionId = (group: string, value: ThemePreference): string => `${group}-${value}`;

/** What choosing calls on `window.roger`; a test passes a stand-in. */
export type AppearanceSaver = Pick<PrefsApi, 'setPreference'>;

/**
 * The option an arrow key (or Home or End) lands on, or null for any other key. Arrows choose as
 * they move, as the tab row does: the look changes at once, so there is nothing to confirm. From
 * "nothing checked" (main has not answered) the move starts at System.
 */
export function appearanceFromKey(
  current: ThemePreference | null,
  key: string,
): ThemePreference | null {
  const from = current === null ? 0 : THEME_PREFERENCES.indexOf(current);
  const next = nextIndex('horizontal', key, from, THEME_PREFERENCES.length);
  return next === null ? null : (THEME_PREFERENCES[next] ?? null);
}

/**
 * Applies the choice to this window at once, then saves it. Main applies it to every other
 * surface through `nativeTheme.themeSource` (T3), so the prompt panel follows; the saved value
 * also comes back as a change event that useTheme applies, which is why this window needs no
 * wait. When main refuses, the look goes back to `previous` and the returned sentence says why
 * (null when it saved).
 */
export async function chooseAppearance(
  prefs: AppearanceSaver,
  root: ThemeRoot,
  previous: ThemePreference,
  chosen: ThemePreference,
): Promise<string | null> {
  applyTheme(root, chosen);
  try {
    await prefs.setPreference('theme', chosen);
    return null;
  } catch (error) {
    applyTheme(root, previous);
    return `Roger could not save the look: ${describeError(error)}`;
  }
}

/** Settings' first section: the look of Roger, System, Light or Dark. */
export function AppearanceSetting() {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  return (
    <AppearanceSection
      preference={theme.preference}
      error={error}
      onChoose={(chosen) => {
        setError(null);
        void chooseAppearance(
          window.roger,
          document.documentElement,
          theme.preference ?? 'system',
          chosen,
        ).then(setError);
      }}
    />
  );
}

interface AppearanceSectionProps {
  /** The stored choice; null until main answers. */
  preference: ThemePreference | null;
  error: string | null;
  onChoose: (chosen: ThemePreference) => void;
}

/**
 * The section for one state: a `radiogroup` in the tab track's look (`fill` track, the checked
 * option on `control` with `e1`). Saves on change: no Save button. Only the checked option is in
 * the Tab order and the arrow keys move between them; before main answers the first one is
 * reachable instead, so the group is never a dead stop.
 */
export function AppearanceSection({ preference, error, onChoose }: AppearanceSectionProps) {
  const headingId = useId();
  const labelId = useId();
  const group = useId();
  const pick = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = appearanceFromKey(preference, event.key);
    if (target === null) return;
    event.preventDefault();
    onChoose(target);
    // Focus follows the pick; the option exists already, so no effect is needed.
    document.getElementById(optionId(group, target))?.focus();
  };
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-section-title">
        Appearance
      </h2>
      <SettingsRow
        label="Look"
        labelId={labelId}
        help="System follows your Mac’s own light or dark setting."
      >
        <div className="segmented" role="radiogroup" aria-labelledby={labelId} onKeyDown={pick}>
          {THEME_PREFERENCES.map((value) => (
            <button
              key={value}
              id={optionId(group, value)}
              type="button"
              role="radio"
              className="segmented-option"
              aria-checked={value === preference}
              tabIndex={value === (preference ?? THEME_PREFERENCES[0]) ? 0 : -1}
              onClick={() => {
                onChoose(value);
              }}
            >
              {LABELS[value]}
            </button>
          ))}
        </div>
      </SettingsRow>
      {error === null ? null : <SettingsProblem role="alert">{error}</SettingsProblem>}
    </section>
  );
}
