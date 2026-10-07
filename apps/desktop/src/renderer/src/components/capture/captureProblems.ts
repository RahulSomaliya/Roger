import type { UploadStatus } from '../../../../shared/capture';

/*
 * What capture must tell the person, as plain sentences. House rule 1 holds through every
 * removal in docs/plans/redesign.md: a call that is not being saved is always on screen.
 */

/**
 * The line for lines the server refused for good (`UploadStatus.rejected`: the API answered 4xx
 * and the uploader set them aside), or null when none was. They stay in roger.sqlite and never
 * reach Postgres, so the person must hear it, and no warning in `CaptureStatus.warnings` says it:
 * the capture panel's "Postgres" row was the only place, and that row is Details-only now.
 *
 * A retry in progress (`backoff`) is not a refusal: its lines upload once the server answers, and
 * Details counts them. `rejected` counts every refused line on this Mac, not this meeting's, so the
 * sentence names no meeting.
 */
export function refusedLinesProblem(upload: UploadStatus): string | null {
  const count = upload.rejected;
  if (count <= 0) return null;
  const refused = `Roger's server refused ${count} line${count === 1 ? '' : 's'} for good.`;
  return `${refused} ${count === 1 ? 'It stays' : 'They stay'} saved on this Mac only.`;
}
