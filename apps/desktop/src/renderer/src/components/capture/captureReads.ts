import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CaptureReport } from '../../../../shared/capture';
import type { MeetingKeptForRerun } from '../../../../shared/ipc/capture';
import { describeError } from '../../app/describeError';
import { LatestRead } from '../../meeting/latestRead';
import type { Read } from '../../meeting/useMeeting';

/*
 * The capture details' reads from main: a meeting's capture report and the list of meetings whose
 * audio is kept for a re-run. Neither has a change event (main sends a status every 2 s and
 * nothing for these), so each read repeats when a key the caller builds changes, as useMeeting's
 * does (meeting/useMeeting.ts: its useLatestRead is not exported, and is the same ten lines).
 */

/** Tells every region that main's answers may have changed: a re-run, a delete, an unhide. */
let epoch = 0;
const epochListeners = new Set<() => void>();

/**
 * Call after any action of ours that changes what a report or the kept list says. The report region
 * and the audio note are separate slots reading separately: without this, deleting the audio in the
 * note left the report's timeline (and Home's list) showing the audio still there.
 */
export function reportsChanged(): void {
  epoch += 1;
  for (const listener of [...epochListeners]) listener();
}

/** The count of `reportsChanged` calls: put it in a read's key. */
export function useReportsEpoch(): number {
  return useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener);
      return () => {
        epochListeners.delete(listener);
      };
    },
    () => epoch,
    () => 0,
  );
}

function useRead<T>(reader: LatestRead<T>, refreshKey: string): Read<T> {
  // The server snapshot is the empty state: renderToString (the page tests) never reads.
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  // readFor decides whether to read; renderToString runs no effects.
  useEffect(() => {
    reader.readFor(refreshKey);
  }, [reader, refreshKey]);
  return useMemo(() => ({ ...state, refresh: reader.refresh }), [state, reader]);
}

/** One meeting's capture report (`capture:get-report`); `value` is undefined until main answers. */
export function useCaptureReport(meetingId: string, refreshKey: string): Read<CaptureReport> {
  const reader = useMemo(
    () =>
      new LatestRead(
        () => window.roger.getCaptureReport({ meetingId }),
        (error) => `Roger could not read this meeting's capture report: ${describeError(error)}`,
      ),
    [meetingId],
  );
  return useRead(reader, refreshKey);
}

/** Every meeting whose audio is kept for a re-run (`audio:list-kept-for-rerun`), newest first. */
export function useKeptForRerun(refreshKey: string): Read<MeetingKeptForRerun[]> {
  const reader = useMemo(
    () =>
      new LatestRead(
        () => window.roger.listMeetingsKeptForRerun(),
        (error) => `Roger could not list the audio kept for a re-run: ${describeError(error)}`,
      ),
    [],
  );
  return useRead(reader, refreshKey);
}
