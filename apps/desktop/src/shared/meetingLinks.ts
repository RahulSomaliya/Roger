/**
 * The video-call host allowlist. "Join and take notes" opens a link in the default browser, so it
 * only ever opens a link that passes here, however the link reached the desktop.
 *
 * The allowlist exists twice: here and in the API's `services/calendar/video_links.py`, which picks
 * each event's `video_link` with the same rules. Change both in the same commit and keep the URL
 * table in `meetingLinks.test.ts` equal to the API's `tests/test_calendar_video_links.py`; a host
 * the API accepts and the desktop refuses shows no Join button, and the reverse opens a link the
 * API never vetted.
 *
 * No runtime imports: this file is bundled into main and the renderer.
 */

export type JoinLinkProvider = 'google_meet' | 'zoom' | 'teams';

export interface JoinLink {
  provider: JoinLinkProvider;
  /** The parsed href: the exact string that was checked is the one to open. */
  url: string;
}

interface JoinLinkRule {
  provider: JoinLinkProvider;
  host: (hostname: string) => boolean;
  /** Pathname patterns of a meeting. A bare host or a sign-in page is not one. */
  paths: readonly RegExp[];
}

const RULES: readonly JoinLinkRule[] = [
  {
    provider: 'google_meet',
    host: (hostname) => hostname === 'meet.google.com',
    // Only a meeting code: `/new` on the same host would start a fresh meeting instead of joining.
    paths: [/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i],
  },
  {
    provider: 'zoom',
    // Company and regional subdomains (`us02web.zoom.us`); the leading dot keeps `evilzoom.us` out.
    host: (hostname) => hostname === 'zoom.us' || hostname.endsWith('.zoom.us'),
    // A meeting (`/j/`), a personal room (`/my/`) or a webinar a registrant joins (`/w/`, with its
    // `tk` token in the query). Not `/s/`: that link starts the meeting as its host.
    paths: [/^\/[jw]\/\d+\/?$/, /^\/my\/[\w.-]+\/?$/],
  },
  {
    provider: 'teams',
    host: (hostname) => hostname === 'teams.microsoft.com' || hostname === 'teams.live.com',
    paths: [/^\/l\/meetup-join\/.+/, /^\/meet\/\d+\/?$/],
  },
];

/** The provider and href of a join link on an allowlisted host, or null for anything else. */
export function parseJoinLink(raw: string): JoinLink | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  // Credentials in a link push the real host out of sight (`https://meet.google.com@evil.io/`
  // parses to evil.io, and the reverse hides an allowed host behind a name); no join link has any.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const rule = RULES.find((candidate) => candidate.host(url.hostname));
  if (!rule?.paths.some((path) => path.test(url.pathname))) return null;
  return { provider: rule.provider, url: url.href };
}
