import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSigningIdentity } from '../signing';

// install-mac.sh's signature checks, run for real. Never run the script itself from a test: it
// builds, quits Roger and replaces /Applications/Roger.app. Each function below is cut out of the
// script's text and run alone, under /bin/bash (3.2, what a fresh Mac has) and the script's own
// shell options. Mac-only: it needs codesign. It sits beside helperPath.test.ts, which also reads
// install-mac.sh, because scripts/ is in no tsconfig.

const SCRIPT = readFileSync(new URL('../../../scripts/install-mac.sh', import.meta.url), 'utf8');
const STRICT = 'set -euo pipefail';
const HELPER_ID = 'ai.linkt.roger.audio';
/** As openssl prints a fingerprint (upper case); codesign prints the same hash in lower case. */
const LEAF_HASH = 'B4573C0F9E1D2A6B8C7D5E4F3A2B1C0D9E8F7A6B';
const PINNED = `identifier "${HELPER_ID}" and certificate leaf = H"${LEAF_HASH.toLowerCase()}"`;

/** A top-level `name() {` ... `}` function of install-mac.sh, as text. */
function scriptFunction(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(SCRIPT);
  if (match === null) throw new Error(`install-mac.sh has no top-level function ${name}()`);
  return match[0];
}

interface BashResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBash(
  lines: readonly string[],
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): BashResult {
  const result = spawnSync('/bin/bash', ['-c', lines.join('\n'), 'install-mac', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  if (result.error !== undefined) {
    throw new Error(`could not run install-mac.sh's functions in /bin/bash`, {
      cause: result.error,
    });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'roger-install-mac-'));
}

/** Not code: real codesign reads it as unsigned, and `codesignReporting` answers as it is told. */
function plainFile(): string {
  const path = join(scratchDir(), 'roger-audio');
  writeFileSync(path, 'not code\n');
  return path;
}

/** A copy of a system binary signed ad hoc (`codesign -s -`), and its requirement (signing.ts). */
async function adhocSignedBinary(): Promise<{ path: string; requirement: string }> {
  const path = join(scratchDir(), 'adhoc');
  copyFileSync('/usr/bin/true', path);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path], { stdio: 'ignore' });
  const { kind, requirement } = await readSigningIdentity(path);
  if (kind !== 'adhoc' || requirement === null) {
    throw new Error(`codesign -s - left ${path} signed as ${kind}, not ad hoc`);
  }
  return { path, requirement };
}

/** A `codesign` first on PATH that reports code signed with `requirement` (a pinned leaf). */
function codesignReporting(requirement: string): Record<string, string> {
  const dir = scratchDir();
  const path = join(dir, 'codesign');
  // Real codesign's shape: `Executable=...` on stderr, the requirement on stdout.
  writeFileSync(path, `#!/bin/sh\necho "Executable=$3" >&2\necho 'designated => ${requirement}'\n`);
  chmodSync(path, 0o755);
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

it('runs the functions under the shell options install-mac.sh sets', () => {
  expect(SCRIPT).toMatch(new RegExp(`^${STRICT}$`, 'm'));
});

describe('designated_requirement', () => {
  // As install-mac.sh assigns it: `previous_requirement="$(designated_requirement "$DEST")"`.
  function designatedRequirement(path: string): BashResult {
    return runBash(
      [
        STRICT,
        scriptFunction('designated_requirement'),
        'requirement="$(designated_requirement "$1")"',
        'printf "read:%s\\n" "$requirement"',
      ],
      [path],
    );
  }

  // codesign exits 1 for unsigned code. Without the `|| true` in the function, the failed pipeline
  // ended the whole install at the assignment above, with no message.
  it('reads unsigned code as no requirement, and the install goes on', async () => {
    const path = plainFile();
    expect((await readSigningIdentity(path)).kind).toBe('unsigned');
    expect(designatedRequirement(path)).toEqual({ status: 0, stdout: 'read:\n', stderr: '' });
  });

  it('reads a missing app as no requirement', () => {
    const path = join(scratchDir(), 'Roger.app');
    expect(designatedRequirement(path)).toEqual({ status: 0, stdout: 'read:\n', stderr: '' });
  });

  // codesign prints an ad-hoc requirement as "# designated => cdhash ...". signing.ts parses the
  // same line; both must read the same requirement, or a stale grant is never cleared.
  it('reads an ad-hoc signature from its "#" line, as signing.ts does', async () => {
    const { path, requirement } = await adhocSignedBinary();
    expect(requirement).toMatch(/^cdhash H"/);
    expect(designatedRequirement(path)).toEqual({
      status: 0,
      stdout: `read:${requirement}\n`,
      stderr: '',
    });
  });
});

describe('require_local_signature', () => {
  // signing_identity_hash reads this Mac's certificate; the stub prints a fixed fingerprint.
  function requireLocalSignature(path: string, env: Record<string, string> = {}): BashResult {
    return runBash(
      [
        STRICT,
        scriptFunction('designated_requirement'),
        scriptFunction('require_local_signature'),
        `signing_identity_hash() { echo ${LEAF_HASH}; }`,
        `require_local_signature "$1" ${HELPER_ID}`,
        'echo "signed as expected"',
      ],
      [path],
      env,
    );
  }

  function refusal(path: string, found: string): string {
    return [
      `install-mac: ${path} is not signed as ${HELPER_ID} with the local identity`,
      `  expected: ${PINNED}`,
      `  found:    ${found}`,
      '',
    ].join('\n');
  }

  it("passes code signed as the identifier with this Mac's identity", () => {
    expect(requireLocalSignature(plainFile(), codesignReporting(PINNED))).toEqual({
      status: 0,
      stdout: 'signed as expected\n',
      stderr: '',
    });
  });

  it.each([
    ['the identifier the linker gave the helper', PINNED.replace(HELPER_ID, 'roger-audio.partial')],
    [
      "another identity's certificate",
      PINNED.replace(LEAF_HASH.toLowerCase(), '0c11d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9'),
    ],
  ])('stops the install on %s', (_case, requirement) => {
    const path = plainFile();
    expect(requireLocalSignature(path, codesignReporting(requirement))).toEqual({
      status: 1,
      stdout: '',
      stderr: refusal(path, requirement),
    });
  });

  // Without the `|| true` in designated_requirement this exits 1 too, but silently.
  it('stops the install on unsigned code and says so', () => {
    const path = plainFile();
    expect(requireLocalSignature(path)).toEqual({
      status: 1,
      stdout: '',
      stderr: refusal(path, 'no signature'),
    });
  });

  it('stops the install on an ad-hoc signature', async () => {
    const { path, requirement } = await adhocSignedBinary();
    expect(requireLocalSignature(path)).toEqual({
      status: 1,
      stdout: '',
      stderr: refusal(path, requirement),
    });
  });
});
