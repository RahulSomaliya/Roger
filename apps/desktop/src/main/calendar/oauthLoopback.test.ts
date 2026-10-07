import { describe, expect, it } from 'vitest';
import {
  createOAuthState,
  createPkce,
  listenForOAuthCallback,
  type OAuthLoopback,
  type OAuthOutcome,
  pkceChallenge,
  signInTimeoutMessage,
} from './oauthLoopback';

// Real HTTP requests to the real listener, as the browser makes them after Google's consent.

const STATE = 'st-8f2c1d9e0a7b';
const CODE = '4/0AVG7fiQ-secret-code';
const MINUTE = 60_000;

async function listen(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return listenForOAuthCallback({
    state: STATE,
    timeoutMs: options.timeoutMs ?? MINUTE,
    ...options,
  });
}

/** A GET to the listener, as the browser sends it; the answer's status and page. */
async function visit(loopback: OAuthLoopback, query: string, path = '/oauth/callback') {
  const url = new URL(loopback.redirectUri);
  const response = await fetch(`${url.origin}${path}${query}`);
  return { status: response.status, page: await response.text(), headers: response.headers };
}

/** Whether anything still listens on the redirect's port. */
async function portIsOpen(loopback: OAuthLoopback): Promise<boolean> {
  try {
    await fetch(loopback.redirectUri);
    return true;
  } catch {
    // fetch rejects with "fetch failed" (ECONNREFUSED) once the port is closed: the answer here.
    return false;
  }
}

/** Whether the outcome is still open after the listener has had time to act on a request. */
async function stillWaiting(outcome: Promise<OAuthOutcome>): Promise<boolean> {
  const pending = Symbol('pending');
  const raced = await Promise.race([
    outcome,
    new Promise<symbol>((resolve) =>
      setTimeout(() => {
        resolve(pending);
      }, 30),
    ),
  ]);
  return raced === pending;
}

function failure(outcome: OAuthOutcome): Error {
  if (outcome.ok) throw new Error('expected the sign-in to fail, it gave a code');
  return outcome.error;
}

describe('listenForOAuthCallback', () => {
  it('listens on 127.0.0.1 on a random port, at /oauth/callback', async () => {
    const first = await listen();
    const second = await listen();
    const port = (uri: string) =>
      Number(/^http:\/\/127\.0\.0\.1:(\d+)\/oauth\/callback$/.exec(uri)?.[1]);
    expect(port(first.redirectUri)).toBeGreaterThan(0);
    expect(port(second.redirectUri)).toBeGreaterThan(0);
    expect(port(first.redirectUri)).not.toBe(port(second.redirectUri));
    await expect(portIsOpen(first)).resolves.toBe(true);
    await visit(first, `?code=a&state=${STATE}`);
    await visit(second, `?code=b&state=${STATE}`);
  });

  it('resolves with the code when the state matches, answers a closing page and closes the port', async () => {
    const loopback = await listen();
    const answer = await visit(
      loopback,
      `?code=${encodeURIComponent(CODE)}&state=${STATE}&scope=email`,
    );

    await expect(loopback.outcome).resolves.toEqual({ ok: true, code: CODE });
    expect(answer.status).toBe(200);
    expect(answer.page).toContain('You can close this tab');
    expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    await expect(portIsOpen(loopback)).resolves.toBe(false);
  });

  it('keeps waiting through a request without a code, another path and another method', async () => {
    const loopback = await listen();

    expect((await visit(loopback, `?state=${STATE}`)).status).toBe(400);
    expect((await visit(loopback, `?code=&state=${STATE}`)).status).toBe(400);
    expect((await visit(loopback, '', '/favicon.ico')).status).toBe(404);
    const posted = await fetch(`${loopback.redirectUri}?code=${CODE}&state=${STATE}`, {
      method: 'POST',
    });
    expect(posted.status).toBe(405);
    await expect(stillWaiting(loopback.outcome)).resolves.toBe(true);

    await visit(loopback, `?code=${CODE}&state=${STATE}`);
    await expect(loopback.outcome).resolves.toEqual({ ok: true, code: CODE });
  });

  it('fails on another state, so a reply to some other sign-in is never redeemed', async () => {
    const loopback = await listen();
    const answer = await visit(loopback, `?code=${CODE}&state=someone-else`);

    expect(answer.status).toBe(400);
    expect(failure(await loopback.outcome).message).toBe(
      'The Google sign-in reply did not match the sign-in Roger started. Connect again.',
    );
    await expect(portIsOpen(loopback)).resolves.toBe(false);
  });

  it('fails with "You cancelled the Google sign-in" when the user said no', async () => {
    const loopback = await listen();
    const answer = await visit(loopback, `?error=access_denied&state=${STATE}`);

    expect(failure(await loopback.outcome).message).toBe('You cancelled the Google sign-in.');
    expect(answer.page).toContain('You cancelled the Google sign-in');
  });

  it("fails naming Google's error code, and only a code-shaped one", async () => {
    const named = await listen();
    await visit(named, `?error=invalid_scope&state=${STATE}`);
    expect(failure(await named.outcome).message).toBe(
      'Google sign-in did not finish (invalid_scope). Connect again.',
    );

    const odd = await listen();
    await visit(odd, `?error=${encodeURIComponent('<script>x</script>')}&state=${STATE}`);
    expect(failure(await odd.outcome).message).toBe(
      'Google sign-in did not finish. Connect again.',
    );
  });

  it('counts only the first callback', async () => {
    const loopback = await listen();
    await visit(loopback, `?code=first&state=${STATE}`);
    // The port is closed by now; a late reply cannot reach it, let alone change the outcome.
    await expect(visit(loopback, `?code=second&state=${STATE}`)).rejects.toThrow();
    await expect(loopback.outcome).resolves.toEqual({ ok: true, code: 'first' });

    const refused = await listen();
    await visit(refused, `?code=${CODE}&state=wrong`);
    await expect(visit(refused, `?code=${CODE}&state=${STATE}`)).rejects.toThrow();
    expect(failure(await refused.outcome).message).toMatch(/did not match/);
  });

  it('times out, closing the port', async () => {
    const loopback = await listen({ timeoutMs: 50 });
    expect(failure(await loopback.outcome).message).toBe(
      'Google sign-in timed out after 50 ms. Connect again.',
    );
    await expect(portIsOpen(loopback)).resolves.toBe(false);
  });

  it('says the timeout in minutes when it is whole minutes', () => {
    expect(signInTimeoutMessage(3 * MINUTE)).toBe(
      'Google sign-in timed out after 3 minutes. Connect again.',
    );
    expect(signInTimeoutMessage(MINUTE)).toBe(
      'Google sign-in timed out after 1 minute. Connect again.',
    );
  });

  it("stops on abort with the signal's reason, closing the port", async () => {
    const controller = new AbortController();
    const loopback = await listen({ signal: controller.signal });
    const reason = new Error('Replaced by a newer Connect.');
    controller.abort(reason);
    expect(failure(await loopback.outcome)).toBe(reason);
    await expect(portIsOpen(loopback)).resolves.toBe(false);
  });

  it('stops at once for a signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const loopback = await listen({ signal: controller.signal });
    expect(failure(await loopback.outcome).message).toBe('gone');
    await expect(portIsOpen(loopback)).resolves.toBe(false);
  });

  it('never puts the code, the state or the error text on the page', async () => {
    const cases = [
      `?code=${CODE}&state=${STATE}`,
      `?code=${CODE}&state=wrong-${STATE}`,
      `?error=access_denied&state=${STATE}&code=${CODE}`,
      `?error=${encodeURIComponent('<b>odd</b>')}&state=${STATE}`,
      `?state=${STATE}`,
    ];
    for (const query of cases) {
      const loopback = await listen();
      const { page } = await visit(loopback, query);
      expect(page).not.toContain(CODE);
      expect(page).not.toContain(STATE);
      expect(page).not.toContain('odd');
      expect(page).not.toContain('<script');
      if (await stillWaiting(loopback.outcome)) await visit(loopback, `?code=x&state=${STATE}`);
    }
  });
});

describe('PKCE and state', () => {
  it('makes the S256 challenge of RFC 7636, appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh verifier and its challenge, in the forms the API accepts', () => {
    const first = createPkce();
    const second = createPkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toBe(pkceChallenge(first.verifier));
    expect(second.verifier).not.toBe(first.verifier);
  });

  it('makes a fresh state the API accepts', () => {
    const state = createOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9._~-]{1,512}$/);
    expect(state.length).toBeGreaterThanOrEqual(22);
    expect(createOAuthState()).not.toBe(state);
  });
});
