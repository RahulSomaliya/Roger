import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { wordsOutsideDetails } from '../../shared/captureWords';
import { AUDIO_SOURCES } from '../../shared/transcript';
import { ApiError, createApiRequest } from '../api/http';
import { parseStartCaptureRequest } from '../ipc-validation';
import { createLogger } from '../logger';
import { createSpeechToText } from '../stt/createSpeechToText';
import { LOCAL_STT_PROVIDERS, STT_VENDORS } from '../stt/registry';
import { SttConnectError } from '../stt/SpeechToText';
import { streamSettingsMismatch } from '../stt/streamSettings';
import {
  configurationWords,
  MicrophoneDeniedError,
  ResumeRefusedError,
  START_FAILURE_SENTENCES,
  startFailureWords,
  stopFailureWords,
  streamFailureWords,
  StreamFormatError,
  SttProviderChangedError,
  unsavedLinesWords,
} from './errorWords';
import { SttOpenBudget } from './SttOpenBudget';

const SENTENCE = START_FAILURE_SENTENCES;

/** A failed `POST /v1/stt/token` as main's API client really throws it. */
async function tokenFailure(fetchImpl: typeof fetch): Promise<unknown> {
  const request = createApiRequest({ baseUrl: 'http://127.0.0.1:8000', token: 't', fetchImpl });
  return request('POST', '/v1/stt/token').then(
    () => {
      throw new Error('the request was expected to fail');
    },
    (error: unknown) => error,
  );
}

function answering(status: number, body: string): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

function envelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

/** What node:sqlite really throws, from a real database. */
function sqliteError(): unknown {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE meetings (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO meetings VALUES ('m-1')");
    db.exec("INSERT INTO meetings VALUES ('m-1')");
    throw new Error('the insert was expected to fail');
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('startFailureWords', () => {
  it('words the xAI refusal that started the sweep as the speech-to-text service, raw text in the detail', () => {
    const words = startFailureWords(new SttConnectError('xAI: rejected with HTTP 401', 401));
    expect(words.sentence).toBe(SENTENCE.serviceRefused);
    expect(words.sentence).toContain('speech-to-text service');
    expect(wordsOutsideDetails(words.sentence)).toEqual([]);
    expect(words.detail).toBe('xAI: rejected with HTTP 401');
  });

  it('reads a vendor refusal by its HTTP status', () => {
    const at = (status: number) =>
      startFailureWords(new SttConnectError(`xAI: rejected with HTTP ${status}`, status)).sentence;
    expect(at(403)).toBe(SENTENCE.serviceRefused);
    expect(at(404)).toBe(SENTENCE.serviceRefused);
    expect(at(429)).toBe(SENTENCE.serviceBusy);
    expect(at(503)).toBe(SENTENCE.serviceProblem);
  });

  it('tells a vendor it could not reach from one that never got ready', () => {
    const at = (message: string) => startFailureWords(new SttConnectError(message)).sentence;
    expect(at('xAI: getaddrinfo ENOTFOUND api.x.ai')).toBe(SENTENCE.serviceUnreachable);
    expect(at('Soniox: connection timed out after 10000 ms')).toBe(SENTENCE.serviceUnreachable);
    expect(at('xAI did not start the session within 10000 ms')).toBe(SENTENCE.serviceNotReady);
    expect(
      at(
        'AssemblyAI ended the connection before the session began (code 3009: too many ' +
          'concurrent sessions). AssemblyAI limits how many sessions start per minute',
      ),
    ).toBe(SENTENCE.serviceNotReady);
  });

  it("reads Roger's server failing the token request, as main's API client throws it", async () => {
    const unreachable = await tokenFailure(() =>
      Promise.reject(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8000') }),
      ),
    );
    expect(startFailureWords(unreachable)).toEqual({
      sentence: SENTENCE.serverAway,
      detail: 'POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000',
    });
    const at = async (status: number, body: string) =>
      startFailureWords(await tokenFailure(answering(status, body))).sentence;
    expect(await at(401, envelope('unauthorized', 'bad token'))).toBe(SENTENCE.serverRefusedMac);
    expect(await at(502, envelope('stt_provider_error', 'vendor said no'))).toBe(
      SENTENCE.serviceAway,
    );
    expect(await at(500, envelope('internal_error', 'boom'))).toBe(SENTENCE.serverProblem);
    expect(await at(200, 'not json')).toBe(SENTENCE.serverProblem);
    expect(await at(422, envelope('validation_error', 'x'))).toBe(SENTENCE.serverRefusedStart);
    expect(
      startFailureWords(new ApiError(0, 'network_error', 'x failed: timed out')).sentence,
    ).toBe(SENTENCE.serverAway);
  });

  it('words the refusals main makes itself', () => {
    expect(startFailureWords(new MicrophoneDeniedError()).sentence).toBe(SENTENCE.microphone);
    expect(startFailureWords(new ResumeRefusedError('m-1', 'it already ended')).sentence).toBe(
      SENTENCE.resume,
    );
    const mismatch = streamSettingsMismatch({
      model: 'm',
      language: 'en',
      sampleRate: 48_000,
      encoding: 'linear16',
      pricePerHourUsd: null,
      keyterms: [],
    });
    expect(mismatch).not.toBeNull();
    expect(startFailureWords(new StreamFormatError(mismatch ?? '')).sentence).toBe(
      SENTENCE.updateRoger,
    );
    const unknownVendor = thrownBy(() => createSpeechToText('nope', { logger: silentLogger() }));
    expect(startFailureWords(unknownVendor).sentence).toBe(SENTENCE.updateRoger);
    expect(startFailureWords(new SttProviderChangedError('xai', 'soniox')).sentence).toBe(
      SENTENCE.serviceSwitched,
    );
    const badRequest = thrownBy(() => parseStartCaptureRequest({ source: 'nowhere' }));
    expect(startFailureWords(badRequest).sentence).toBe(SENTENCE.badRequest);
    expect(startFailureWords(sqliteError()).sentence).toBe(SENTENCE.notSavedOnMac);
  });

  it("words the open budget's refusal, alone and after the jargon list was refused", () => {
    const budget = new SttOpenBudget({ perMinute: 1, perMeeting: 10 }, () => 0);
    budget.acquire(1);
    const refusal = budget.acquire(2);
    expect(refusal.ok).toBe(false);
    const message = refusal.ok ? '' : refusal.message;
    // CaptureSession.open's text: CaptureService.test.ts runs the real path end to end.
    expect(
      startFailureWords(new Error(`Speech-to-text was not started: ${message}`)).sentence,
    ).toBe(SENTENCE.tooManyStarts);
    // CaptureSession.openStream's, when the open without the list was refused.
    expect(
      startFailureWords(
        new Error(
          `xAI ended the connection before the session began (the jargon list was rejected); ` +
            `not opened again without the jargon list: ${message}`,
        ),
      ).sentence,
    ).toBe(SENTENCE.jargonListRefused);
    // CaptureSession.connect's, when the open without the list failed too: read by its cause.
    const retry = new SttConnectError('xAI: rejected with HTTP 401', 401);
    expect(
      startFailureWords(
        new Error('xAI: closed early; and without the jargon list: xAI: rejected with HTTP 401', {
          cause: retry,
        }),
      ).sentence,
    ).toBe(SENTENCE.serviceRefused);
  });

  it('falls back to one plain sentence for anything it does not know, the raw text kept', () => {
    expect(startFailureWords(new Error('something odd'))).toEqual({
      sentence: SENTENCE.unknown,
      detail: 'something odd',
    });
    expect(startFailureWords('a string')).toEqual({
      sentence: SENTENCE.unknown,
      detail: 'a string',
    });
    expect(startFailureWords(undefined).detail).toBe('undefined');
  });

  it('holds no vendor, code, route, errno or internal word in any sentence it can write', () => {
    for (const [name, sentence] of Object.entries(SENTENCE)) {
      expect(wordsOutsideDetails(sentence), name).toEqual([]);
      expect(sentence, name).toMatch(/\.$/);
    }
  });
});

describe('the other capture failures', () => {
  it('words a failed Stop plainly and keeps the store error as the detail', () => {
    const words = stopFailureWords(new Error('database or disk is full'));
    expect(wordsOutsideDetails(words.sentence)).toEqual([]);
    expect(words.sentence).toContain('this Mac');
    expect(words.detail).toBe('database or disk is full');
  });

  it('words a configuration problem found at launch, the setting named only in the detail', () => {
    const raw =
      'No API token. Set ROGER_DESKTOP_API_TOKEN (or "apiToken" in config.json in the app data folder) and restart.';
    const words = configurationWords(raw);
    expect(wordsOutsideDetails(words.sentence)).toEqual([]);
    expect(words.detail).toBe(raw);
  });

  it('names the source of a stream that failed mid-call, with no countdown, and says whether it comes back', () => {
    for (const source of AUDIO_SOURCES) {
      const back = streamFailureWords(source, 'xAI connection failed: socket hang up', true);
      const gone = streamFailureWords(source, 'xAI connection failed: socket hang up', false);
      const name = source === 'mic' ? 'microphone' : 'call audio';
      for (const words of [back, gone]) {
        expect(words.sentence).toContain(name);
        expect(wordsOutsideDetails(words.sentence)).toEqual([]);
        // A time that ticks never rides in a message (docs/design.md, Words from main).
        expect(words.sentence).not.toMatch(/\d+ s\b/);
        expect(words.detail).toContain('xAI connection failed: socket hang up');
      }
      expect(back.sentence).toContain('reconnects on its own');
      expect(gone.sentence).toContain('Press Stop, then Start notes again');
    }
  });

  it('keeps the count of lines not saved on this Mac and the way out (house rule 1)', () => {
    expect(unsavedLinesWords(1, 'database or disk is full')).toEqual({
      sentence:
        '1 line could not be saved on this Mac. Recording continues; free some disk space, or press Stop if this keeps happening.',
      detail: 'database or disk is full',
    });
    expect(unsavedLinesWords(12, 'SQLITE_BUSY').sentence).toMatch(/^12 lines could not be saved/);
    expect(wordsOutsideDetails(unsavedLinesWords(12, 'SQLITE_BUSY').sentence)).toEqual([]);
  });
});

describe('the preview', () => {
  it("shows main's real words for a Start that found no server, copied since it cannot import main", () => {
    const scenarios = readFileSync(
      new URL('../../../preview/scenarios.ts', import.meta.url),
      'utf8',
    );
    // Prettier never splits a string, so the sentence stays whole on its line.
    expect(scenarios).toContain(`'${SENTENCE.serverAway}'`);
  });
});

describe('wordsOutsideDetails vendor list', () => {
  it("names every network adapter's vendor, so a new one cannot reach a sentence unseen", () => {
    for (const provider of STT_VENDORS.keys()) {
      if (LOCAL_STT_PROVIDERS.has(provider)) continue;
      const { vendorName } = createSpeechToText(provider, { logger: silentLogger() });
      expect(wordsOutsideDetails(`${vendorName} said no`), provider).toEqual([vendorName]);
    }
  });
});

function silentLogger() {
  return createLogger({ level: 'error', format: 'json', sink: () => undefined });
}
