import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalendarAttendee, MeetingCalendarEvent } from '../shared/calendar';
import { START_SOURCES } from '../shared/capture';
import { SETTINGS_PANE_IDS } from '../shared/ipc/setup';
import {
  isUuidV4,
  isSourceStateMessage,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_CAPTURE_TIME_SKEW_MS,
  parseAudioChunk,
  parseMeetingRequest,
  parseSegmentRequest,
  parseSettingsPaneRequest,
  parseStartCaptureRequest,
} from './ipc-validation';
import { SETTINGS_PANES } from './settingsPanes';

const MEETING = '2f1d9c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f';
const SEGMENT = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const NOW = 1_791_000_000_000;

describe('parseAudioChunk', () => {
  it('accepts an ArrayBuffer or a view of even length from a known source', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3200) })?.pcm.byteLength).toBe(
      3200,
    );
    const view = new Uint8Array(new ArrayBuffer(10), 2, 4);
    expect(parseAudioChunk({ source: 'system', pcm: view })?.pcm.byteLength).toBe(4);
  });

  it('rejects odd lengths, empty chunks, oversized chunks, unknown sources and junk', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3201) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(0) })).toBeNull();
    expect(
      parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(MAX_AUDIO_CHUNK_BYTES + 2) }),
    ).toBeNull();
    expect(parseAudioChunk({ source: 'speaker', pcm: new ArrayBuffer(2) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: 'nope' })).toBeNull();
    expect(parseAudioChunk(null)).toBeNull();
  });

  it('keeps the capture time, or null when the renderer sent none', () => {
    const pcm = new ArrayBuffer(3200);
    expect(parseAudioChunk({ source: 'mic', pcm, capturedAtMs: NOW - 40 }, NOW)).toMatchObject({
      source: 'mic',
      capturedAtMs: NOW - 40,
    });
    // A chunk with none (the renderer sends one since M2-T12) is dated by its arrival.
    expect(parseAudioChunk({ source: 'mic', pcm }, NOW)?.capturedAtMs).toBeNull();
    // A day either way is still accepted: the bound catches junk. It does not absorb a renderer
    // clock that stops through sleeps (AudioChunkMessage.capturedAtMs says how to avoid one).
    expect(
      parseAudioChunk({ source: 'system', pcm, capturedAtMs: NOW + MAX_CAPTURE_TIME_SKEW_MS }, NOW)
        ?.capturedAtMs,
    ).toBe(NOW + MAX_CAPTURE_TIME_SKEW_MS);
  });

  it('refuses a chunk whose capture time is not a finite number or is far from now', () => {
    const pcm = new ArrayBuffer(3200);
    for (const capturedAtMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      String(NOW),
      null,
      0,
      NOW - MAX_CAPTURE_TIME_SKEW_MS - 1,
      NOW + MAX_CAPTURE_TIME_SKEW_MS + 1,
    ]) {
      expect(parseAudioChunk({ source: 'mic', pcm, capturedAtMs }, NOW)).toBeNull();
    }
  });
});

describe('isSourceStateMessage', () => {
  it('checks source, state and the optional message', () => {
    expect(isSourceStateMessage({ source: 'mic', state: 'active' })).toBe(true);
    expect(isSourceStateMessage({ source: 'system', state: 'error', message: 'denied' })).toBe(
      true,
    );
    expect(
      isSourceStateMessage({ source: 'mic', state: 'ended', message: 'device unplugged' }),
    ).toBe(true);
    expect(isSourceStateMessage({ source: 'system', state: 'paused' })).toBe(false);
    expect(isSourceStateMessage({ source: 'speaker', state: 'ended' })).toBe(false);
    expect(isSourceStateMessage({ source: 'mic', state: 'active', message: 5 })).toBe(false);
  });
});

describe('isUuidV4', () => {
  it('accepts a lowercase UUIDv4, as randomUUID() makes them', () => {
    expect(isUuidV4(MEETING)).toBe(true);
    expect(isUuidV4(crypto.randomUUID())).toBe(true);
  });

  // Meeting ids name folders on disk (userData/audio/<id>): anything else could climb out of it.
  it('refuses paths, other UUID versions, other spellings and non-strings', () => {
    for (const id of [
      '../x',
      `../${MEETING}`,
      `${MEETING}/..`,
      '/etc/passwd',
      `/Users/me/Library/Application Support/Roger/audio/${MEETING}`,
      '.',
      '',
      MEETING.toUpperCase(),
      `${MEETING}\n`,
      ` ${MEETING}`,
      MEETING.replaceAll('-', ''),
      '2f1d9c4e-8a3b-1c5d-9e6f-7a8b9c0d1e2f', // version 1
      '2f1d9c4e-8a3b-4c5d-7e6f-7a8b9c0d1e2f', // not the RFC 4122 variant
      42,
      null,
      undefined,
      { meetingId: MEETING },
    ]) {
      expect(isUuidV4(id)).toBe(false);
    }
  });
});

describe('parseMeetingRequest', () => {
  it('passes on only the meeting id', () => {
    expect(parseMeetingRequest({ meetingId: MEETING, extra: '../../x' })).toEqual({
      meetingId: MEETING,
    });
  });

  it('refuses a meeting id that is not a UUIDv4, a path included', () => {
    expect(parseMeetingRequest({ meetingId: '../x' })).toBeNull();
    expect(parseMeetingRequest({ meetingId: '/tmp' })).toBeNull();
    expect(parseMeetingRequest({})).toBeNull();
    expect(parseMeetingRequest(MEETING)).toBeNull();
    expect(parseMeetingRequest(null)).toBeNull();
  });
});

describe('parseSegmentRequest', () => {
  it('passes on only the meeting and segment ids', () => {
    expect(parseSegmentRequest({ meetingId: MEETING, segmentId: SEGMENT, text: 'x' })).toEqual({
      meetingId: MEETING,
      segmentId: SEGMENT,
    });
  });

  it('refuses either id when it is not a UUIDv4', () => {
    expect(parseSegmentRequest({ meetingId: MEETING, segmentId: '../x' })).toBeNull();
    expect(parseSegmentRequest({ meetingId: '../x', segmentId: SEGMENT })).toBeNull();
    expect(parseSegmentRequest({ meetingId: MEETING })).toBeNull();
    expect(parseSegmentRequest(undefined)).toBeNull();
  });
});

describe('parseSettingsPaneRequest', () => {
  it('accepts every pane main has a link for', () => {
    for (const pane of SETTINGS_PANE_IDS) {
      expect(parseSettingsPaneRequest({ pane })).toEqual({ pane });
    }
  });

  it('names the same panes as main', () => {
    expect([...SETTINGS_PANE_IDS].sort()).toEqual(Object.keys(SETTINGS_PANES).sort());
  });

  // The pane picks the URL main opens: never a URL or a key from the object's prototype.
  it('refuses unknown panes, prototype keys and URLs', () => {
    for (const pane of [
      'camera',
      'toString',
      '__proto__',
      'constructor',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
      'https://example.com',
      '',
      3,
    ]) {
      expect(parseSettingsPaneRequest({ pane })).toBeNull();
    }
    expect(parseSettingsPaneRequest('microphone')).toBeNull();
    expect(parseSettingsPaneRequest(null)).toBeNull();
  });
});

describe('parseStartCaptureRequest', () => {
  const attendee = (n: number): CalendarAttendee => ({
    email: `person${n}@linkt.ai`,
    displayName: `Person ${n}`,
    responseStatus: 'accepted',
    isSelf: n === 0,
    isOrganizer: n === 1,
  });
  const event: MeetingCalendarEvent = {
    provider: 'google',
    eventId: 'abc123_20261007T093000Z',
    icalUid: 'abc123@google.com',
    recurringEventId: 'abc123',
    scheduledStart: '2026-10-07T09:30:00.000Z',
    scheduledEnd: '2026-10-07T10:00:00.000Z',
    attendees: [attendee(0), attendee(1)],
  };
  const withEvent = (changes: Record<string, unknown>): unknown => ({
    source: 'notification',
    calendarEvent: { ...event, ...changes },
  });

  it('reads no request at all as a plain manual start', () => {
    expect(parseStartCaptureRequest(undefined)).toEqual({});
    expect(parseStartCaptureRequest({})).toEqual({});
  });

  it('passes on the source, title and event link, and nothing else the page sent', () => {
    expect(
      parseStartCaptureRequest({
        source: 'notification',
        title: 'Weekly sync',
        calendarEvent: { ...event, extra: 'x', attendees: [{ ...attendee(0), extra: 'y' }] },
        resume: { meetingId: '2f1d9c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f' },
      }),
    ).toEqual({
      source: 'notification',
      title: 'Weekly sync',
      calendarEvent: { ...event, attendees: [attendee(0)] },
    });
    // Left out, the optional ids and a display name read as null, as the API stores them.
    const { icalUid: _ical, recurringEventId: _series, ...bare } = event;
    expect(
      parseStartCaptureRequest({
        calendarEvent: {
          ...bare,
          attendees: [
            { email: 'a@b.c', responseStatus: 'tentative', isSelf: false, isOrganizer: false },
          ],
        },
      }),
    ).toEqual({
      calendarEvent: {
        ...bare,
        icalUid: null,
        recurringEventId: null,
        attendees: [
          {
            email: 'a@b.c',
            displayName: null,
            responseStatus: 'tentative',
            isSelf: false,
            isOrganizer: false,
          },
        ],
      },
    });
    expect(parseStartCaptureRequest({ calendarEvent: null })).toEqual({});
  });

  it('accepts every start source, call_detected included, and refuses any other', () => {
    for (const source of START_SOURCES) {
      expect(parseStartCaptureRequest({ source })).toEqual({ source });
    }
    for (const source of ['calendar', 'Manual', '', 'toString', 3, null]) {
      expect(() => parseStartCaptureRequest({ source })).toThrow(
        'invalid start request: source is not a start source',
      );
    }
  });

  it('names the same five sources as the API contract', () => {
    const contract = readFileSync(
      new URL('../../../../docs/api-contract.md', import.meta.url),
      'utf8',
    );
    const line = /^type StartSource = (.+);$/m.exec(contract)?.[1] ?? '';
    expect(line.split(' | ').map((name) => JSON.parse(name) as unknown)).toEqual([
      ...START_SOURCES,
    ]);
  });

  // The API stores at most 500 characters of a title once trimmed (MeetingTitle) and refuses the
  // whole create past that, transcript included: refused here, where the start can still say why.
  it('refuses a title over 500 characters once trimmed, counted as the API counts them', () => {
    const title = 'a'.repeat(500);
    expect(parseStartCaptureRequest({ title: `  ${title}  ` })).toEqual({ title: `  ${title}  ` });
    // Python counts code points: 500 emoji are 1000 UTF-16 units and still fit.
    const emoji = '\u{1F600}'.repeat(500);
    expect(parseStartCaptureRequest({ title: emoji })).toEqual({ title: emoji });
    expect(() => parseStartCaptureRequest({ title: `${title}b` })).toThrow(
      'invalid start request: title is over 500 characters',
    );
    expect(() => parseStartCaptureRequest({ title: 42 })).toThrow(
      'invalid start request: title is not text',
    );
  });

  // The API trims with pydantic's strip_whitespace, not JavaScript's trim() (storedMeetingText):
  // a byte order mark counts there and U+0085 does not, so a trim() measure would pass a 422.
  it('measures text as the API trims it, not as trim() does', () => {
    const nextLine = String.fromCharCode(0x85);
    const byteOrderMark = String.fromCharCode(0xfeff);
    expect(() => parseStartCaptureRequest({ title: `${'a'.repeat(500)}${byteOrderMark}` })).toThrow(
      'invalid start request: title is over 500 characters',
    );
    expect(() =>
      parseStartCaptureRequest(withEvent({ eventId: `${'x'.repeat(2048)}${byteOrderMark}` })),
    ).toThrow('invalid start request: calendarEvent.eventId is over 2048 characters');
    expect(() => parseStartCaptureRequest(withEvent({ eventId: nextLine }))).toThrow(
      'invalid start request: calendarEvent.eventId is blank',
    );
    const padded = `${nextLine}${'a'.repeat(500)}${nextLine}`;
    expect(parseStartCaptureRequest({ title: padded })).toEqual({ title: padded });
  });

  it('refuses an event link POST /v1/meetings would refuse with a 422', () => {
    const refusals: [unknown, string][] = [
      [{ calendarEvent: 'nope' }, 'calendarEvent is not an object'],
      [withEvent({ provider: 'outlook' }), 'calendarEvent.provider is not google or fake'],
      [withEvent({ eventId: '' }), 'calendarEvent.eventId is blank'],
      // The API drops U+0000 before it trims and counts, so an id of nothing else is blank too.
      [withEvent({ eventId: ' \u0000 ' }), 'calendarEvent.eventId is blank'],
      [withEvent({ eventId: 'x'.repeat(2049) }), 'calendarEvent.eventId is over 2048 characters'],
      [withEvent({ eventId: 7 }), 'calendarEvent.eventId is not text'],
      [withEvent({ icalUid: 'u'.repeat(2049) }), 'calendarEvent.icalUid is over 2048 characters'],
      [withEvent({ recurringEventId: 5 }), 'calendarEvent.recurringEventId is not text'],
      [
        withEvent({ scheduledStart: '2026-10-07T09:30:00' }),
        'calendarEvent.scheduledStart is not an instant with a zone',
      ],
      [
        withEvent({ scheduledEnd: 'tomorrow' }),
        'calendarEvent.scheduledEnd is not an instant with a zone',
      ],
      [
        withEvent({ scheduledEnd: null }),
        'calendarEvent.scheduledEnd is not an instant with a zone',
      ],
      [withEvent({ attendees: 'x' }), 'calendarEvent.attendees is not a list'],
      [
        withEvent({ attendees: Array.from({ length: 201 }, (_, n) => attendee(n)) }),
        'calendarEvent.attendees has over 200 people',
      ],
      [
        withEvent({ attendees: [attendee(0), null] }),
        'calendarEvent.attendees[1] is not an object',
      ],
      [
        withEvent({ attendees: [{ ...attendee(0), email: ' ' }] }),
        'calendarEvent.attendees[0].email is blank',
      ],
      [
        withEvent({ attendees: [{ ...attendee(0), displayName: 'd'.repeat(2049) }] }),
        'calendarEvent.attendees[0].displayName is over 2048 characters',
      ],
      [
        withEvent({ attendees: [{ ...attendee(0), responseStatus: 'maybe' }] }),
        'calendarEvent.attendees[0].responseStatus is not a response',
      ],
      [
        withEvent({ attendees: [{ ...attendee(0), isSelf: 'yes' }] }),
        'calendarEvent.attendees[0].isSelf is not true or false',
      ],
      [
        withEvent({ attendees: [{ ...attendee(0), isOrganizer: undefined }] }),
        'calendarEvent.attendees[0].isOrganizer is not true or false',
      ],
    ];
    for (const [payload, why] of refusals) {
      expect(() => parseStartCaptureRequest(payload), why).toThrow(`invalid start request: ${why}`);
    }
    // 200 people, ids at their limit and instants with an offset all pass.
    const full = withEvent({
      eventId: 'x'.repeat(2048),
      scheduledStart: '2026-10-07T11:30:00+02:00',
      attendees: Array.from({ length: 200 }, (_, n) => attendee(n)),
    });
    expect(parseStartCaptureRequest(full)).toEqual(full);
  });

  // Date.parse reads all of these. pydantic refuses hour 24 and year 0 (422), and fails on a time
  // whose zone moves it out of Python's years 1 to 9999 (an OverflowError, 500).
  it('refuses an instant the API cannot read, though Date.parse can', () => {
    for (const value of [
      '2026-10-07T24:00:00Z',
      '0000-06-01T10:00:00Z',
      '0000-12-31T23:30:00-01:00',
      '0001-01-01T00:00:00+01:00',
      '9999-12-31T23:59:59-01:00',
    ]) {
      expect(() => parseStartCaptureRequest(withEvent({ scheduledStart: value })), value).toThrow(
        'invalid start request: calendarEvent.scheduledStart is not an instant with a zone',
      );
    }
    for (const value of [
      '2026-10-07T23:59:59.999999Z',
      '0001-01-01T01:00:00+01:00',
      '9999-12-31T22:59:59-01:00',
    ]) {
      expect(parseStartCaptureRequest(withEvent({ scheduledEnd: value })), value).toEqual(
        withEvent({ scheduledEnd: value }),
      );
    }
  });

  it('refuses a request that is not an object', () => {
    for (const payload of [null, 'manual', 3, []]) {
      expect(() => parseStartCaptureRequest(payload)).toThrow(
        'invalid start request: not an object',
      );
    }
  });
});
