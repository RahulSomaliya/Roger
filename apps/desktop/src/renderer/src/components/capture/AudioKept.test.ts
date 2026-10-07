import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RerunStatus } from '../../../../shared/capture';
import type { MeetingKeptForRerun } from '../../../../shared/ipc/capture';
import {
  AudioNote,
  type AudioNoteProps,
  KeptForRerun,
  type KeptForRerunProps,
  RERUN_BLOCKED_WHILE_RECORDING,
} from './AudioKept';
import type { AudioNoteView } from './reportText';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const KEPT: AudioNoteView = {
  tone: 'quiet',
  text: 'Audio kept for a re-run until 4 Nov (12.4 MB): 2 gaps are not filled yet.',
  canRerun: true,
  canDelete: true,
};

const handlers = () => ({
  onRerun: vi.fn(),
  onAskDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onCancelDelete: vi.fn(),
});

function note(props: Partial<AudioNoteProps> = {}): string {
  return renderToStaticMarkup(
    createElement(AudioNote, {
      view: KEPT,
      rerunBlockedBy: null,
      busy: null,
      confirming: false,
      error: null,
      rerun: null,
      ...handlers(),
      ...props,
    }),
  );
}

describe('AudioNote', () => {
  it('says how long the audio is kept, with a re-run and a delete', () => {
    const html = note();
    expect(html).toContain('Audio kept for a re-run until 4 Nov');
    expect(html).toContain('>Re-run gaps<');
    expect(html).toContain('>Delete audio<');
  });

  it('offers no re-run when there is nothing to fill, and nothing at all once the audio is gone', () => {
    expect(note({ view: { ...KEPT, canRerun: false } })).not.toContain('Re-run gaps');
    const gone = note({ view: { ...KEPT, canRerun: false, canDelete: false } });
    expect(gone).not.toContain('<button');
  });

  it('says why a re-run is refused while a recording runs, and disables it', () => {
    const html = note({ rerunBlockedBy: RERUN_BLOCKED_WHILE_RECORDING });
    expect(html).toContain(RERUN_BLOCKED_WHILE_RECORDING);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Re-run gaps</);
    // The delete is still allowed: only the meeting being recorded refuses it.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete audio</);
  });

  it('asks before deleting: the audio cannot be brought back', () => {
    const html = note({ confirming: true });
    expect(html).toContain('Delete this meeting’s audio? Its lines stay.');
    expect(html).toContain('>Delete<');
    expect(html).toContain('>Keep it<');
    expect(html).not.toContain('>Delete audio<');
  });

  it('disables both actions while main works, and shows re-run progress', () => {
    const rerun: RerunStatus = { meetingId: 'm', state: 'running', gaps: 2, finished: 1 };
    const html = note({ busy: 'rerun', rerun });
    expect(html).toContain('<progress');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('shows why an action failed, as an alert', () => {
    const html = note({ error: 'Roger is recording: gaps are re-run once the recording stops.' });
    expect(html).toContain('role="alert"');
  });

  it('draws a backup that paused or failed as a warning', () => {
    const html = note({
      view: {
        tone: 'warn',
        text: 'The audio backup is paused.',
        canRerun: false,
        canDelete: false,
      },
    });
    expect(html).toContain('data-tone="warn"');
  });
});

const MEETINGS: MeetingKeptForRerun[] = [
  { meetingId: 'a', title: 'Client call', keepUntil: '2026-11-04T10:00:00.000Z' },
  { meetingId: 'b', title: 'Standup', keepUntil: null },
];

function card(props: Partial<KeptForRerunProps> = {}): string {
  return renderToStaticMarkup(
    createElement(KeptForRerun, {
      meetings: MEETINGS,
      now: NOW,
      rerun: null,
      rerunBlockedBy: null,
      busy: null,
      confirming: null,
      error: null,
      listError: null,
      onOpen: vi.fn(),
      onRerun: vi.fn(),
      onAskDelete: vi.fn(),
      onConfirmDelete: vi.fn(),
      onCancelDelete: vi.fn(),
      ...props,
    }),
  );
}

describe('KeptForRerun', () => {
  it('lists each meeting with when its audio goes, and the open one as being recorded', () => {
    const html = card();
    expect(html).toContain('Audio kept for a re-run');
    expect(html).toContain('Client call');
    expect(html).toContain('kept until');
    expect(html).toContain('Standup');
    expect(html).toContain('recording now');
    expect(html.match(/>Re-run gaps</g)).toHaveLength(2);
  });

  it('shows nothing when no meeting waits for a re-run', () => {
    expect(card({ meetings: [] })).toBe('');
  });

  it('shows why the list could not be read, even with none to show', () => {
    const html = card({ meetings: [], listError: 'Roger could not list the kept audio' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Roger could not list the kept audio');
  });

  it('shows the progress under the meeting being re-run, and only that one', () => {
    const html = card({ rerun: { meetingId: 'a', state: 'running', gaps: 3, finished: 1 } });
    expect(html.match(/<progress/g)).toHaveLength(1);
    expect(html.indexOf('<progress')).toBeGreaterThan(html.indexOf('Client call'));
    expect(html.indexOf('<progress')).toBeLessThan(html.indexOf('Standup'));
  });

  it('disables the re-run while a recording runs, naming why once', () => {
    const html = card({ rerunBlockedBy: RERUN_BLOCKED_WHILE_RECORDING });
    expect(html.match(/<button[^>]*disabled=""[^>]*>Re-run gaps</g)).toHaveLength(2);
  });

  it('offers no delete for the meeting still being recorded: main refuses it', () => {
    // Only "Client call" has an end date; "Standup" is open (keepUntil null).
    expect(card().match(/>Delete audio</g)).toHaveLength(1);
  });

  it('asks before deleting one meeting’s audio, and only that one’s', () => {
    const html = card({ confirming: 'a' });
    expect(html.match(/Delete this meeting’s audio\?/g)).toHaveLength(1);
    expect(html).not.toContain('>Delete audio<');
  });

  it('opens a meeting from its title', () => {
    expect(card()).toContain('aria-label="Open Client call"');
  });
});
