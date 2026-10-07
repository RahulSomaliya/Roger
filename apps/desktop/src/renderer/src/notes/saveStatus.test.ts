import { describe, expect, it } from 'vitest';
import type { NoteSyncState } from '../../../shared/notes';
import { describeSaveStatus } from './saveStatus';

const SAVED = { phase: 'saved' } as const;

describe('describeSaveStatus', () => {
  it('says nothing while saving is normal: saved, waiting for the meeting, syncing, synced, conflict', () => {
    const quiet: NoteSyncState[] = [
      'saved_locally',
      'waiting_for_meeting',
      'syncing',
      'synced',
      // The conflict has its own line (ConflictBanner); a second label would say it twice.
      'conflict',
    ];
    expect(quiet.map((sync) => describeSaveStatus(SAVED, sync))).toEqual(quiet.map(() => null));
  });

  it('says Saved on this Mac, and why it is safe, only while the server cannot be reached', () => {
    expect(describeSaveStatus(SAVED, 'offline')).toEqual(
      expect.objectContaining({ label: 'Saved on this Mac', tone: 'quiet' }),
    );
    expect(describeSaveStatus(SAVED, 'offline')?.detail).toMatch(/uploads them when/);
  });

  it('says nothing while a save is on its way to the Mac', () => {
    for (const phase of ['pending', 'saving'] as const) {
      expect(describeSaveStatus({ phase }, 'synced')).toBeNull();
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
    // Even while the server is away: the failure is the news.
    expect(describeSaveStatus({ phase: 'failed', message: 'disk full' }, 'offline')?.label).toBe(
      'Not saved',
    );
  });

  it('says nothing for notes nobody has written yet', () => {
    expect(describeSaveStatus(SAVED, null)).toBeNull();
  });
});
