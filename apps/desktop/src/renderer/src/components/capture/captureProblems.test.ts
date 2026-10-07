import { describe, expect, it } from 'vitest';
import type { UploadStatus } from '../../../../shared/capture';
import { refusedLinesProblem } from './captureProblems';

const upload = (rejected: number): UploadStatus => ({
  state: 'idle',
  pending: 0,
  rejected,
  lastError: null,
  nextAttemptAt: null,
});

describe('refusedLinesProblem', () => {
  // House rule 1: lines the server refused for good never reach it, and the person must see that.
  // The capture panel's "Postgres" row said it before; this is what says it now.
  it('says nothing while the server took every line', () => {
    expect(refusedLinesProblem(upload(0))).toBeNull();
  });

  it('says one line or many, and that they stay on this Mac', () => {
    expect(refusedLinesProblem(upload(1))).toBe(
      "Roger's server refused 1 line for good. It stays saved on this Mac only.",
    );
    expect(refusedLinesProblem(upload(3))).toBe(
      "Roger's server refused 3 lines for good. They stay saved on this Mac only.",
    );
  });

  it('does not hide behind a retry in progress: a backoff is not a refusal', () => {
    expect(
      refusedLinesProblem({ ...upload(0), state: 'backoff', pending: 4, lastError: 'down' }),
    ).toBeNull();
  });
});
