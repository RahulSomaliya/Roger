import { describe, expect, it } from 'vitest';
import { describeError, describeReadFailure } from './describeError';

describe('describeError', () => {
  it("keeps main's message from a rejected IPC call, without Electron's wrapper", () => {
    expect(
      describeError(
        new Error("Error invoking remote method 'capture:start': Error: the API is offline"),
      ),
    ).toBe('the API is offline');
    expect(
      describeError(new Error("Error invoking remote method 'capture:stop': TypeError: bad state")),
    ).toBe('bad state');
  });

  it('gives any other error its message, a string as it is, and anything else a plain phrase', () => {
    expect(describeError(new Error('Microphone: permission denied'))).toBe(
      'Microphone: permission denied',
    );
    expect(describeError('offline')).toBe('offline');
    expect(describeError({ code: 7 })).toBe('an unexpected error');
  });
});

describe('describeError on the API client messages', () => {
  const rejected = (message: string): Error =>
    new Error(`Error invoking remote method 'vocabulary:set': ApiError: ${message}`);

  it('says offline in plain words, never a request path or an address (QA: jargon list, redesign R13)', () => {
    const line = describeError(
      rejected('PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000'),
    );
    expect(line).toBe('Roger could not reach its server.');
    expect(line).not.toMatch(/\/v1|ECONN|127\.0/);
  });

  it('puts each kind of API failure in a few words, for an Error and a string alike', () => {
    expect(describeError(rejected('POST /v1/x failed: timed out after 10000 ms'))).toBe(
      'Roger could not reach its server.',
    );
    expect(describeError('GET /v1/x returned HTTP 401')).toBe(
      "Roger's server did not accept this Mac's access.",
    );
    expect(describeError(rejected('PUT /v1/x returned HTTP 422'))).toBe(
      "Roger's server turned that down.",
    );
    expect(describeError(rejected('POST /v1/notes returned HTTP 503'))).toBe(
      "Roger's server had a problem.",
    );
    expect(describeError(rejected('GET /v1/x returned non-JSON'))).toBe(
      "Roger's server sent an answer Roger could not read.",
    );
  });

  it('leaves a plain sentence from main alone', () => {
    expect(describeError(new Error('the notes of meeting m-1 are still being written'))).toBe(
      'the notes of meeting m-1 are still being written',
    );
  });
});

describe('describeReadFailure', () => {
  const rejected = (message: string): Error =>
    new Error(`Error invoking remote method 'chat:get-thread': ApiError: ${message}`);

  it('says why a read failed in a few plain words, per kind of failure', () => {
    expect(describeReadFailure(rejected('GET /v1/meetings/m-1/chat failed: fetch failed'))).toBe(
      'Roger could not reach its server.',
    );
    expect(describeReadFailure(rejected('GET /v1/x failed: timed out after 10000 ms'))).toBe(
      'Roger could not reach its server.',
    );
    expect(describeReadFailure(rejected('GET /v1/x returned HTTP 401'))).toBe(
      "Roger's server did not accept this Mac's access.",
    );
    expect(describeReadFailure(rejected('GET /v1/x returned HTTP 403'))).toBe(
      "Roger's server did not accept this Mac's access.",
    );
    expect(describeReadFailure(rejected('GET /v1/x returned HTTP 404'))).toBe(
      "Roger's server does not have this meeting yet.",
    );
    expect(describeReadFailure(rejected('Meeting 7f3c not found'))).toBe(
      "Roger's server does not have this meeting yet.",
    );
    expect(describeReadFailure(rejected('GET /v1/x returned HTTP 502'))).toBe(
      "Roger's server had a problem.",
    );
    expect(describeReadFailure(rejected('GET /v1/x returned non-JSON'))).toBe(
      "Roger's server sent an answer Roger could not read.",
    );
  });

  it('never shows a request path, a status code or text it cannot place', () => {
    for (const odd of [
      rejected('GET /v1/meetings/m-1/chat exploded'),
      new Error('OpenRouter: model overloaded'),
      'plain text',
      { code: 7 },
    ]) {
      expect(describeReadFailure(odd)).toBe('Something went wrong.');
    }
  });
});
