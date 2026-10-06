/**
 * Which notes template a meeting gets without asking (M4, "When notes generate"). Main uses it at
 * Stop (main/notes/NotesGenerator.ts) and the template picker preselects with it (M4-T18). The
 * rule, first match wins:
 *
 * 1. The template last picked for a meeting with the same title (notes.sqlite's
 *    `template_choices`, keyed by `templateTitleKey`).
 * 2. Words in the title: standup, daily, stand-up mean standup; 1:1, 1-1, one on one mean 1:1;
 *    client, demo, discovery, proposal, kickoff mean client call (in that order when several
 *    appear).
 * 3. Any invitee outside the user's email domain means client call (M5's invites; a manual start
 *    has none).
 * 4. Nothing: Roger asks "Which kind of call was this?", or uses General when the
 *    `notes.whenUnsure` preference says so. That choice is the caller's, not this file's.
 *
 * Pure, with no imports: the page bundles it too.
 */

/** The built-in templates' ids (the API's `note_templates/`, M4-T3). Templates are API data. */
export const NOTE_TEMPLATE_IDS = ['general', 'standup', 'client_call', 'one_on_one'] as const;
export type NoteTemplateId = (typeof NOTE_TEMPLATE_IDS)[number];

/** One invitee of the event a meeting was started for. M5's `CalendarAttendee` fits. */
export interface TemplateAttendee {
  email: string;
  /** The user's own entry: its domain is "inside". */
  isSelf: boolean;
}

export interface TemplateCues {
  title: string;
  /**
   * The template last picked for meetings with this normalised title, or null (notes.sqlite's
   * `getTemplateChoice`). Never asked for a title `templateTitleKey` refuses. The page, which
   * cannot read notes.sqlite, passes `() => null`.
   */
  lastPick: (titleKey: string) => string | null;
  /** The invite's attendees (M5); none for a manual start. */
  attendees?: readonly TemplateAttendee[];
}

/** What the rule found, and which cue said so; `none` means ask (or General, by preference). */
export type TemplateSuggestion =
  | { templateId: string; cue: 'last_pick' | 'title' | 'attendees' }
  | { templateId: null; cue: 'none' };

const UNTITLED_MEETING = 'untitled meeting';
/**
 * The title main gives a manual start, normalised: "Meeting 5 Oct 2026 10:05" from
 * `defaultMeetingTitle` (main/capture/CaptureService.ts, en-GB). ICU writes September "Sept" in
 * en-GB, hence up to four letters. If that format changes, this must change with it, or every
 * manual start remembers a pick under a title no other meeting will ever have and the page
 * offers it as "last picked"; NotesGenerator.test.ts checks every month of the real function.
 */
const DEFAULT_MEETING_TITLE = /^meeting \d{1,2} [a-z]{3,4} \d{4} \d{2}:\d{2}$/;

/**
 * Title words, matched on the normalised title, plurals included ("1:1s", "one-on-ones"). `1:1`
 * and `1-1` must not touch another digit, colon or hyphen: a clock time ("11:10") or a date
 * ("2026-11-10", "2026-1-1") holds the same three characters.
 */
const TITLE_RULES: readonly (readonly [pattern: RegExp, templateId: NoteTemplateId])[] = [
  [/\b(?:stand-?ups?|daily)\b/, 'standup'],
  [/(?<![\w:-])1[:-]1s?(?![\w:-])|\bone[- ]on[- ]ones?\b/, 'one_on_one'],
  [/\b(?:clients?|demos?|discovery|proposals?|kick-?offs?)\b/, 'client_call'],
];

/**
 * The key a template pick is remembered under: the title with case, spacing and look-alike
 * characters (NFKC) folded. Null for a title that says nothing about the call, which is never
 * remembered: no title, "Untitled meeting", and the title main gives a manual start.
 */
export function templateTitleKey(title: string): string | null {
  const key = title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (key === '' || key === UNTITLED_MEETING || DEFAULT_MEETING_TITLE.test(key)) return null;
  return key;
}

export function suggestTemplate(cues: TemplateCues): TemplateSuggestion {
  const key = templateTitleKey(cues.title);
  if (key !== null) {
    const picked = cues.lastPick(key);
    if (picked !== null) return { templateId: picked, cue: 'last_pick' };
    for (const [pattern, templateId] of TITLE_RULES) {
      if (pattern.test(key)) return { templateId, cue: 'title' };
    }
  }
  if (hasOutsideAttendee(cues.attendees ?? []))
    return { templateId: 'client_call', cue: 'attendees' };
  return { templateId: null, cue: 'none' };
}

/** With no attendee marked as the user, nobody can be told apart as outside. */
function hasOutsideAttendee(attendees: readonly TemplateAttendee[]): boolean {
  const self = attendees.find((attendee) => attendee.isSelf);
  const home = self === undefined ? null : emailDomain(self.email);
  if (home === null) return false;
  return attendees.some((attendee) => {
    if (attendee.isSelf) return false;
    const domain = emailDomain(attendee.email);
    return domain !== null && domain !== home;
  });
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  const domain =
    at < 0
      ? ''
      : email
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return domain === '' ? null : domain;
}
