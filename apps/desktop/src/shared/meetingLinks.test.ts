import { describe, expect, it } from 'vitest';
import { parseJoinLink, type JoinLinkProvider } from './meetingLinks';

/**
 * The same table as the API's `tests/test_calendar_video_links.py` (M5-T2). The API picks
 * `video_link` with these rules and the desktop re-checks before Join opens it, so a row added or
 * changed here is added or changed there in the same change.
 */
const JOIN_LINK_CASES: readonly (readonly [url: string, expected: JoinLinkProvider | null])[] = [
  // Accepted
  ['https://meet.google.com/abc-defg-hij', 'google_meet'],
  ['https://meet.google.com/abc-defg-hij?authuser=1', 'google_meet'],
  ['https://MEET.google.com/ABC-DEFG-HIJ', 'google_meet'],
  ['https://zoom.us/j/1234567890', 'zoom'],
  ['https://us02web.zoom.us/j/81234567890?pwd=AbC123', 'zoom'],
  ['https://linkt.zoom.us/my/rahul.s', 'zoom'],
  [
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d',
    'teams',
  ],
  ['https://teams.microsoft.com/meet/2345678901234?p=AbCdEf', 'teams'],
  ['https://teams.live.com/meet/9876543210', 'teams'],
  // Refused: not https
  ['http://meet.google.com/abc-defg-hij', null],
  ['http://zoom.us/j/1234567890', null],
  ['javascript:alert(1)', null],
  ['file:///etc/passwd', null],
  // Refused: lookalike hosts
  ['https://meet.google.com.evil.io/abc-defg-hij', null],
  ['https://meet.google.com@evil.io/abc-defg-hij', null],
  ['https://zoom.us.evil.io/j/1234567890', null],
  ['https://evilzoom.us/j/1234567890', null],
  ['https://teams.microsoft.com.evil.io/l/meetup-join/abc', null],
  ['https://calendar.google.com/calendar/event?eid=abc', null],
  // Refused: right host, not a meeting
  ['https://meet.google.com/', null],
  ['https://meet.google.com/new', null],
  ['https://meet.google.com/landing', null],
  ['https://zoom.us/', null],
  ['https://zoom.us/signin', null],
  ['https://zoom.us/j/', null],
  ['https://teams.microsoft.com/', null],
  ['https://teams.microsoft.com/l/meetup-join/', null],
  // Refused: credentials hide the real host from a glance
  ['https://user:secret@meet.google.com/abc-defg-hij', null],
  // Refused: not a URL
  ['meet.google.com/abc-defg-hij', null],
  ['', null],
];

describe('parseJoinLink', () => {
  it.each(JOIN_LINK_CASES)('%s → %s', (url, expected) => {
    expect(parseJoinLink(url)?.provider ?? null).toBe(expected);
  });

  it('returns the parsed href, so the link opened is the link checked', () => {
    expect(parseJoinLink('https://MEET.google.com/abc-defg-hij')).toEqual({
      provider: 'google_meet',
      url: 'https://meet.google.com/abc-defg-hij',
    });
  });
});
