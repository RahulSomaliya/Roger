import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { ConnectionSetupState, SetupCheck } from '../../shared/ipc/setup';
import { ApiError, type ApiRequest } from '../api/http';
import { errorMessage, type Logger } from '../logger';

/**
 * The setup screen's two server rows (M2-T19): is the Roger API there, and would a Start get a
 * speech-to-text token from it. Each failure is said in plain words for the person; the raw error
 * ("POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000") goes to the log only.
 *
 * The token check asks `POST /v1/stt/token` and opens no vendor session: every open is billed and
 * spends the per-minute open budget (cost guard G3). It reads only the provider and the audio
 * format, and never logs the answer: `access_token` is a live vendor credential.
 */
export interface ConnectionChecksOptions {
  /** The Roger API (api/http.ts), with a timeout short enough for a screen a person waits on. */
  request: ApiRequest;
  /** The API's address, named in the message when nothing answers there. */
  baseUrl: string;
  /** False when config.json and ROGER_DESKTOP_API_TOKEN give none: no token fetch can succeed. */
  hasApiToken: boolean;
  /** ROGER_STT_PROVIDER: with `fake`, Start asks the API for no token (CaptureService.resolveStt). */
  sttProviderOverride: string | null;
  /** Whether this copy of Roger has an adapter for the vendor the API names (stt/registry.ts). */
  isKnownProvider: (provider: string) => boolean;
  logger: Logger;
}

export interface ConnectionResults {
  api: SetupCheck<ConnectionSetupState>;
  stt: SetupCheck<ConnectionSetupState>;
}

/** What the token check reads of `POST /v1/stt/token`: never `access_token`. */
interface TokenFormat {
  provider: string;
  stream: { sample_rate: number; encoding: string };
}

const OK: SetupCheck<ConnectionSetupState> = Object.freeze({
  state: 'ok',
  message: null,
  relaunchNeeded: false,
});

const API_TOKEN_SETTING =
  'ROGER_DESKTOP_API_TOKEN (or "apiToken" in config.json in the app data folder)';
const API_URL_SETTING = 'ROGER_API_URL (or "apiUrl" in config.json in the app data folder)';

/** Runs both checks at once, so the screen waits for the slower one, not for their sum. */
export async function checkConnections(
  options: ConnectionChecksOptions,
): Promise<ConnectionResults> {
  const [health, token] = await Promise.allSettled([
    options.request('GET', '/health'),
    tokenCheck(options),
  ]);
  const api = health.status === 'fulfilled' ? OK : failed(options, 'api health', health.reason);
  let stt: SetupCheck<ConnectionSetupState>;
  if (token.status === 'fulfilled') {
    stt = token.value;
  } else if (
    isUnreachable(token.reason) &&
    health.status === 'rejected' &&
    isUnreachable(health.reason)
  ) {
    // One cause, one red row: the server row already says nothing answers. The renderer keeps this
    // `unknown` grey only because the server row failed (setupRows.ts, connectionRow); an
    // `unknown` with a message anywhere else reads as needing the person.
    logFailure(options, 'stt token', token.reason);
    stt = {
      state: 'unknown',
      message: "Not checked: Roger can't reach its server.",
      relaunchNeeded: false,
    };
  } else {
    stt = failed(options, 'stt token', token.reason);
  }
  return { api, stt };
}

async function tokenCheck(
  options: ConnectionChecksOptions,
): Promise<SetupCheck<ConnectionSetupState>> {
  if (options.sttProviderOverride === 'fake') return OK;
  if (!options.hasApiToken) {
    return {
      state: 'failed',
      message: `Roger has no API token. Set ${API_TOKEN_SETTING}, then relaunch Roger.`,
      relaunchNeeded: true,
    };
  }
  const token = await options.request<TokenFormat>('POST', '/v1/stt/token');
  if (!options.isKnownProvider(token.provider)) {
    options.logger.warn('setup check: the API names a speech-to-text vendor with no adapter', {
      provider: token.provider,
    });
    return {
      state: 'failed',
      message: `Roger's server uses "${token.provider}" for speech-to-text, which this copy of Roger cannot use. Update Roger, or set STT_PROVIDER on the server to a vendor it knows.`,
      relaunchNeeded: false,
    };
  }
  const { sample_rate: sampleRate, encoding } = token.stream;
  if (sampleRate !== PCM_SAMPLE_RATE || encoding !== PCM_ENCODING) {
    // The same refusal as Start's (stt/streamSettings.ts): other audio is transcribed as garbage.
    options.logger.warn('setup check: the API asks for another audio format', {
      sampleRate,
      encoding,
    });
    return {
      state: 'failed',
      message: `Roger's server asks for ${sampleRate} Hz ${encoding} audio, but Roger sends ${PCM_SAMPLE_RATE} Hz ${PCM_ENCODING}. Set STT_SAMPLE_RATE=${PCM_SAMPLE_RATE} and STT_ENCODING=${PCM_ENCODING} on the server.`,
      relaunchNeeded: false,
    };
  }
  return OK;
}

function failed(
  options: ConnectionChecksOptions,
  check: string,
  error: unknown,
): SetupCheck<ConnectionSetupState> {
  logFailure(options, check, error);
  return { state: 'failed', ...describeServerFailure(error, options.baseUrl) };
}

function logFailure(options: ConnectionChecksOptions, check: string, error: unknown): void {
  // The ApiError's text names the method, path and cause, never a body or a credential (http.ts).
  options.logger.warn('setup check failed', { check, error: errorMessage(error) });
}

function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/**
 * A failed request to the Roger API, as a person reads it: what is wrong and what to do, never the
 * method, path or socket error the ApiError carries.
 */
export function describeServerFailure(
  error: unknown,
  baseUrl: string,
): { message: string; relaunchNeeded: boolean } {
  const say = (message: string, relaunchNeeded = false) => ({ message, relaunchNeeded });
  if (!(error instanceof ApiError)) {
    return say(`Roger could not check its server: ${errorMessage(error)}.`);
  }
  const fix = 'Check that the Roger API is running and that this Mac is online.';
  switch (true) {
    case error.status === 0 && error.message.includes('timed out'):
      return say(`Roger's server at ${baseUrl} did not answer in time. ${fix}`);
    case error.status === 0:
      return say(`Roger can't reach its server at ${baseUrl}. ${fix}`);
    case error.status === 401 || error.status === 403:
      // index.ts reads the token once at startup: a fixed config.json needs a new process.
      return say(
        `Roger's server refused its API token. Set ${API_TOKEN_SETTING}, then relaunch Roger.`,
        true,
      );
    case error.status === 404:
      return say(
        `Roger's server at ${baseUrl} does not know this request: it may be older than this copy of Roger.`,
      );
    case error.code === 'stt_provider_error':
      return say(
        "Roger's server could not get a speech-to-text token: the vendor refused or did not answer. Check the vendor key on the server.",
      );
    case error.status === 503:
      // GET /health answers 503 when Postgres is unreachable (docs/api-contract.md).
      return say("Roger's server is running but cannot reach its database.");
    case error.status >= 500:
      return say(`Roger's server failed (HTTP ${error.status}). Its log says why.`);
    case error.code === 'invalid_response' || error.code === 'http_error':
      // api/http.ts's codes for a reply without the API's error envelope, which the Roger API
      // always sends (roger_api/error_handlers.py); their message is the request ("GET /health
      // returned non-JSON"), never shown. A sign-in page answers 200 with HTML.
      return say(
        `Something at ${baseUrl} answered, but not the way Roger's server does: a network sign-in page, or another server at that address. Check that ${API_URL_SETTING} is the Roger API's address, then relaunch Roger.`,
        true,
      );
    default:
      // The API's own refusal: its envelope's message is for the log (logFailure), not people.
      return say(
        `Roger's server turned down the check (HTTP ${error.status}). Roger's log says why.`,
      );
  }
}
