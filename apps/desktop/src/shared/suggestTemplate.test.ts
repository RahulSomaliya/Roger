import { describe, expect, it } from 'vitest';
import {
  NOTE_TEMPLATE_IDS,
  suggestTemplate,
  type TemplateAttendee,
  type TemplateCues,
  templateTitleKey,
} from './suggestTemplate';

/** Cues with no pick remembered and no invite, so only the title can speak. */
function fromTitle(title: string): TemplateCues {
  return { title, lastPick: () => null };
}

function attendee(email: string, isSelf = false): TemplateAttendee {
  return { email, isSelf };
}

describe('templateTitleKey', () => {
  it('folds case, spacing and look-alike characters', () => {
    expect(templateTitleKey('  Weekly   Sync with ACME ')).toBe('weekly sync with acme');
    expect(templateTitleKey('Weekly\tsync\nwith acme')).toBe('weekly sync with acme');
    // NFKC: a full-width A (U+FF21) is the "a" anyone would type.
    expect(templateTitleKey('Sync with \uFF21cme')).toBe('sync with acme');
  });
});

describe('suggestTemplate', () => {
  it('last pick for the same title wins', () => {
    const picks = new Map([['weekly sync with acme', 'one_on_one']]);
    const asked: string[] = [];
    const lastPick = (titleKey: string): string | null => {
      asked.push(titleKey);
      return picks.get(titleKey) ?? null;
    };

    // Asked under the normalised title, and it beats the title's own words ("sync" is none, but
    // "client" below is) and an outside attendee.
    expect(suggestTemplate({ title: ' Weekly SYNC with Acme', lastPick })).toEqual({
      templateId: 'one_on_one',
      cue: 'last_pick',
    });
    expect(asked).toEqual(['weekly sync with acme']);

    picks.set('client standup', 'general');
    expect(
      suggestTemplate({
        title: 'Client standup',
        lastPick,
        attendees: [attendee('me@linkt.ai', true), attendee('cfo@acme.com')],
      }),
    ).toEqual({ templateId: 'general', cue: 'last_pick' });
  });

  it('title words pick standup, 1:1 and client call', () => {
    const cases: readonly (readonly [title: string, templateId: string])[] = [
      ['Standup', 'standup'],
      ['Team stand-up', 'standup'],
      ['Eng standups', 'standup'],
      ['Daily sync', 'standup'],
      ['Rahul / Sam 1:1', 'one_on_one'],
      ['1-1 with Sam', 'one_on_one'],
      ['One on one: Sam', 'one_on_one'],
      ['Sam one-on-one', 'one_on_one'],
      // Plurals count, as they do for the other title words.
      ['Weekly 1:1s', 'one_on_one'],
      ['Team 1-1s', 'one_on_one'],
      ['Manager one-on-ones', 'one_on_one'],
      ['Acme client call', 'client_call'],
      ['Clients review', 'client_call'],
      ['Product demo for Acme', 'client_call'],
      ['Discovery: Initech', 'client_call'],
      ['Proposal walkthrough', 'client_call'],
      ['Project kickoff', 'client_call'],
      ['Project kick-off', 'client_call'],
      // Several cues: standup, then 1:1, then client call.
      ['Client standup', 'standup'],
      ['Demo 1:1', 'one_on_one'],
    ];
    for (const [title, templateId] of cases) {
      expect(suggestTemplate(fromTitle(title)), title).toEqual({ templateId, cue: 'title' });
    }
    expect(NOTE_TEMPLATE_IDS).toEqual(['general', 'standup', 'client_call', 'one_on_one']);
  });

  it('an outside attendee means client call', () => {
    const cues = (attendees: TemplateAttendee[]): TemplateCues => ({
      title: 'Weekly sync',
      lastPick: () => null,
      attendees,
    });

    expect(
      suggestTemplate(cues([attendee('me@linkt.ai', true), attendee('cfo@Acme.com')])),
    ).toEqual({ templateId: 'client_call', cue: 'attendees' });
    // The user's own domain, in any case, is inside.
    expect(
      suggestTemplate(cues([attendee('Me@Linkt.ai', true), attendee('sam@LINKT.AI')])),
    ).toEqual({ templateId: null, cue: 'none' });
    // With no attendee marked as the user, nobody can be outside the user's domain.
    expect(suggestTemplate(cues([attendee('sam@linkt.ai'), attendee('cfo@acme.com')]))).toEqual({
      templateId: null,
      cue: 'none',
    });
    // An attendee with no usable address says nothing.
    expect(suggestTemplate(cues([attendee('me@linkt.ai', true), attendee('')]))).toEqual({
      templateId: null,
      cue: 'none',
    });
    // Title words come first.
    expect(
      suggestTemplate({
        title: 'Standup',
        lastPick: () => null,
        attendees: [attendee('me@linkt.ai', true), attendee('cfo@acme.com')],
      }),
    ).toEqual({ templateId: 'standup', cue: 'title' });
  });

  it('no cue means ask', () => {
    for (const title of [
      'Weekly sync',
      'Untitled meeting',
      '',
      // Clock times and dates hold "1:1" and "1-1" between other digits: no cue.
      'Meeting 11 Oct 2026 11:10',
      'Review 2026-11-10',
      'Plan for 2026-1-1',
      // A plural only after a whole 1:1: not a time or an id followed by letters.
      '11:1s',
      'Room 1:1st',
      // A word that only contains a cue word is not one.
      'Clientele review',
      'Dailyness',
    ]) {
      expect(suggestTemplate(fromTitle(title)), title).toEqual({ templateId: null, cue: 'none' });
    }
  });

  it('Untitled meeting is never remembered', () => {
    // Main names a manual start "Meeting 5 Oct 2026 10:05" (`defaultMeetingTitle`,
    // capture/CaptureService.ts; NotesGenerator.test.ts checks every month of it), and
    // "Untitled meeting" is the page's word for a meeting with no title. Neither says what kind
    // of call it was, and a pick remembered under one would be offered for every manual start.
    for (const title of [
      'Untitled meeting',
      '  untitled MEETING ',
      '',
      '   ',
      'Meeting 5 Oct 2026 10:05',
      'Meeting 15 Sept 2026 09:30',
      'meeting 1 jun 2026 23:59',
    ]) {
      expect(templateTitleKey(title), title).toBeNull();
      const asked: string[] = [];
      suggestTemplate({
        title,
        lastPick: (titleKey) => {
          asked.push(titleKey);
          return 'client_call';
        },
      });
      expect(asked, title).toEqual([]);
    }
    // A title that only starts like one is a real title.
    expect(templateTitleKey('Meeting 5 Oct 2026 10:05 with Acme')).toBe(
      'meeting 5 oct 2026 10:05 with acme',
    );
  });
});
