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
