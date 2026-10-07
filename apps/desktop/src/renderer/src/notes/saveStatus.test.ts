import { describe, expect, it } from 'vitest';
import type { NoteSyncState } from '../../../shared/notes';
import { describeSaveStatus } from './saveStatus';

const SAVED = { phase: 'saved' } as const;

describe('describeSaveStatus', () => {
  it('moves through saved on this Mac, waiting for the meeting, syncing, synced, offline and conflict', () => {
    const journey: NoteSyncState[] = [
      'saved_locally',
      'waiting_for_meeting',
      'syncing',
      'synced',
      'offline',
      'conflict',
    ];
    expect(journey.map((sync) => describeSaveStatus(SAVED, sync))).toEqual([
      expect.objectContaining({ label: 'Saved on this Mac', tone: 'quiet' }),
      expect.objectContaining({ label: 'Waiting for the meeting to upload', tone: 'quiet' }),
      expect.objectContaining({ label: 'Syncing', tone: 'quiet' }),
      expect.objectContaining({ label: 'Synced', tone: 'good' }),
      expect.objectContaining({ label: 'Offline: saved on this Mac', tone: 'warn' }),
      expect.objectContaining({ label: 'Two versions', tone: 'warn' }),
    ]);
  });

  it('says why each state is safe, or what to do', () => {
    expect(describeSaveStatus(SAVED, 'offline')?.detail).toMatch(/uploads them when/);
    expect(describeSaveStatus(SAVED, 'conflict')?.detail).toMatch(/Pick the version to keep/);
    expect(describeSaveStatus(SAVED, 'waiting_for_meeting')?.detail).toMatch(/Saved on this Mac/);
  });

  it('shows the save on its way to the Mac before what main last said', () => {
    for (const phase of ['pending', 'saving'] as const) {
      expect(describeSaveStatus({ phase }, 'synced')).toEqual(
        expect.objectContaining({ label: 'Saving...', tone: 'quiet' }),
      );
    }
  });

  it('shows a refused save above everything, with its reason, and that the text is kept', () => {
    const status = describeSaveStatus(
      { phase: 'failed', message: 'note not saved: nested deeper than 32 levels' },
      'synced',
    );
    expect(status).toEqual(expect.objectContaining({ label: 'Not saved', tone: 'bad' }));
    expect(status?.detail).toContain('note not saved: nested deeper than 32 levels');
    expect(status?.detail).toMatch(/still here/);
  });

  it('says nothing for notes nobody has written yet', () => {
    expect(describeSaveStatus(SAVED, null)).toBeNull();
  });
});
