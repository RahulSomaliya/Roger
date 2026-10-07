import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RerunStatus } from '../../../../shared/capture';
import {
  GapLine,
  type GapLineProps,
  KeptAudio,
  type KeptAudioProps,
  RERUN_BLOCKED_WHILE_RECORDING,
} from './AudioKept';
import type { AudioNoteView } from './reportText';

const KEPT: AudioNoteView = {
  text: 'Audio kept on this Mac until 4 Nov (12.4 MB). 2 parts are not transcribed yet.',
  canRerun: true,
  canDelete: true,
};

const RUNNING: RerunStatus = { meetingId: 'm', state: 'running', gaps: 2, finished: 1 };

const handlers = () => ({
  onRerun: vi.fn(),
  onAskDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onCancelDelete: vi.fn(),
});

function kept(props: Partial<KeptAudioProps> = {}): string {
  return renderToStaticMarkup(
    createElement(KeptAudio, {
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

function gapLine(props: Partial<GapLineProps> = {}): string {
  return renderToStaticMarkup(
    createElement(GapLine, {
      parts: 2,
      rerun: null,
      canRerun: true,
      rerunBlockedBy: null,
      busy: false,
      error: null,
      onRerun: vi.fn(),
      ...props,
    }),
  );
}

describe('KeptAudio (in Details)', () => {
  it('says how long the audio is kept, with Transcribe again and Delete audio', () => {
    const html = kept();
    expect(html).toContain('Audio kept on this Mac until 4 Nov');
    expect(html).toMatch(/data-variant="secondary"[^>]*>Transcribe again</);
    // Delete is ghost: the dialog has no primary, and a destructive step is never the loud one.
    expect(html).toMatch(/data-variant="ghost"[^>]*>Delete audio</);
    expect(html).not.toContain('Re-run');
  });

  it('offers nothing to transcribe again when nothing is waiting, and no button once the audio is gone', () => {
    expect(kept({ view: { ...KEPT, canRerun: false } })).not.toContain('Transcribe again');
    const gone = kept({ view: { ...KEPT, canRerun: false, canDelete: false } });
    expect(gone).not.toContain('<button');
  });

  it('says why transcribing again is refused while a recording runs, once, with nothing to click', () => {
    const html = kept({ rerunBlockedBy: RERUN_BLOCKED_WHILE_RECORDING });
    expect(html.match(/Transcribe again once the recording stops/g)).toHaveLength(1);
    expect(html).not.toContain('>Transcribe again<');
    // The delete is still allowed: only the meeting being recorded refuses it.
    expect(html).toContain('>Delete audio<');
  });

  it('asks before deleting in place: the same button reads Delete, and its lines stay', () => {
    const html = kept({ confirming: true });
    expect(html).toContain('Delete audio? Its lines stay.');
    expect(html).toMatch(/data-variant="secondary"[^>]*>Delete</);
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('>Delete audio<');
  });

  it('is busy, not disabled, while main works: full colour, aria-disabled, and says what it does', () => {
    const html = kept({ busy: 'rerun', rerun: RUNNING });
    expect(html).toContain('Transcribing again: 1 of 2 parts done.');
    expect(html).toMatch(/aria-disabled="true"[^>]*>Transcribing again…</);
    expect(html).not.toContain('disabled=""');
  });

  it('shows why an action failed, as an alert problem line', () => {
    const html = kept({ error: 'Roger is recording: parts are transcribed once it stops.' });
    expect(html).toMatch(/class="problem"[^>]*role="alert"|role="alert"[^>]*class="problem"/);
    expect(html).not.toMatch(/class="(?:[^"]* )?error[" ]/);
  });
});

describe('GapLine (under the header)', () => {
  it('says how many parts were not transcribed, with Transcribe again beside it', () => {
    const html = gapLine();
    expect(html).toContain('2 parts were not transcribed');
    expect(html).toMatch(/data-variant="secondary"[^>]*>Transcribe again</);
    expect(html).toContain('role="status"');
  });

  it('reads one part in the singular', () => {
    expect(gapLine({ parts: 1 })).toContain('1 part was not transcribed');
  });

  it('says nothing when every part is transcribed', () => {
    expect(gapLine({ parts: 0 })).toBe('');
  });

  it('offers no button once the audio is gone, but still says the parts are missing', () => {
    const html = gapLine({ canRerun: false });
    expect(html).toContain('2 parts were not transcribed');
    expect(html).not.toContain('<button');
  });

  it('says it fills them in after Stop while a recording runs, with nothing to click', () => {
    const html = gapLine({ rerunBlockedBy: RERUN_BLOCKED_WHILE_RECORDING });
    expect(html).toContain('2 parts were not transcribed');
    expect(html).toContain('Transcribe again once the recording stops');
    expect(html).not.toContain('<button');
  });

  it('shows the progress in the same line while it transcribes again, with no button', () => {
    const html = gapLine({ rerun: RUNNING, busy: true });
    expect(html).toContain('Transcribing again: 1 of 2 parts done.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<progress');
  });

  it('shows a failure as a loud line, even when no part is left to say', () => {
    const html = gapLine({ parts: 0, error: 'The audio for it is gone' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('The audio for it is gone');
  });
});
