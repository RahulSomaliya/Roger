import { describe, expect, it } from 'vitest';
import { describeError } from './describeError';

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
