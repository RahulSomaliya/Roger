import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  codesignRunner,
  readSigningIdentity,
  SigningCheckError,
  type CodesignOutput,
  type RunCodesign,
} from './signing';

const EXE = '/Applications/Roger.app/Contents/MacOS/Roger';

// `codesign -d -r-` prints the requirement on stdout and `Executable=...` on stderr. The ad-hoc,
// Developer ID and unsigned outputs below were captured from codesign on macOS 26.6.2 (2026-10-06).
// The local-identity line has the shape install-mac.sh produces (field report, 2026-10-06); the
// leaf hashes are made up.
const LOCAL_A =
  'designated => identifier "ai.linkt.roger" and certificate leaf = H"b4573c0f9e1d2a6b8c7d5e4f3a2b1c0d9e8f7a6b"';
const LOCAL_B =
  'designated => identifier "ai.linkt.roger" and certificate leaf = H"0c11d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9"';
const ADHOC_TWO_HASHES =
  '# designated => cdhash H"f40d49a2e7aed51d2d4e12e57bb2c2a9c21d5a6a" or cdhash H"b11649a74856a7074570c1db801588be781fb724"';
const ADHOC_ONE_HASH = '# designated => cdhash H"871dca53d71b5ff5be3a9d5883bf258ef7ec9e68"';
const DEVELOPER_ID =
  'designated => identifier node and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = HX7739G8FX';

function signed(line: string): CodesignOutput {
  return { exitCode: 0, stdout: `${line}\n`, stderr: `Executable=${EXE}\n` };
}

function fakeCodesign(output: CodesignOutput): RunCodesign & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run = (args: readonly string[]): Promise<CodesignOutput> => {
    calls.push(args);
    return Promise.resolve(output);
  };
  return Object.assign(run, { calls });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('readSigningIdentity', () => {
  it('asks codesign for the designated requirement of the given executable', async () => {
    const codesign = fakeCodesign(signed(LOCAL_A));
    await readSigningIdentity(EXE, codesign);
    expect(codesign.calls).toEqual([['-d', '-r-', EXE]]);
  });

  it('reports the local identity install-mac.sh signs with, and hashes its requirement', async () => {
    const identity = await readSigningIdentity(EXE, fakeCodesign(signed(LOCAL_A)));
    const requirement =
      'identifier "ai.linkt.roger" and certificate leaf = H"b4573c0f9e1d2a6b8c7d5e4f3a2b1c0d9e8f7a6b"';
    expect(identity).toEqual({
      kind: 'local-identity',
      requirement,
      requirementHash: sha256(requirement),
    });
  });

  it('gives a new requirement hash when the identity changes, and the same one on a rebuild', async () => {
    const first = await readSigningIdentity(EXE, fakeCodesign(signed(LOCAL_A)));
    const rebuilt = await readSigningIdentity(EXE, fakeCodesign(signed(LOCAL_A)));
    const otherIdentity = await readSigningIdentity(EXE, fakeCodesign(signed(LOCAL_B)));
    const adhoc = await readSigningIdentity(EXE, fakeCodesign(signed(ADHOC_ONE_HASH)));

    expect(rebuilt.requirementHash).toBe(first.requirementHash);
    expect(otherIdentity.requirementHash).not.toBe(first.requirementHash);
    expect(adhoc.requirementHash).not.toBe(first.requirementHash);
    expect(first.requirementHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports an ad-hoc build, whose implicit requirement codesign prints behind a "#"', async () => {
    for (const line of [ADHOC_TWO_HASHES, ADHOC_ONE_HASH]) {
      const identity = await readSigningIdentity(EXE, fakeCodesign(signed(line)));
      expect(identity.kind).toBe('adhoc');
      expect(identity.requirement).toBe(line.replace('# designated => ', ''));
      expect(identity.requirementHash).toBe(sha256(line.replace('# designated => ', '')));
    }
  });

  it('reports a Developer ID signature', async () => {
    const identity = await readSigningIdentity(EXE, fakeCodesign(signed(DEVELOPER_ID)));
    expect(identity.kind).toBe('developer-id');
    expect(identity.requirement).toBe(DEVELOPER_ID.replace('designated => ', ''));
  });

  it('reports unsigned code with no requirement and no hash', async () => {
    const unsigned: CodesignOutput = {
      exitCode: 1,
      stdout: '',
      stderr: `${EXE}: code object is not signed at all\n`,
    };
    expect(await readSigningIdentity(EXE, fakeCodesign(unsigned))).toEqual({
      kind: 'unsigned',
      requirement: null,
      requirementHash: null,
    });
  });

  it("fails with the path and codesign's message when codesign cannot read the code", async () => {
    const missing: CodesignOutput = {
      exitCode: 1,
      stdout: '',
      stderr: `${EXE}: No such file or directory\n`,
    };
    const reading = readSigningIdentity(EXE, fakeCodesign(missing));
    await expect(reading).rejects.toBeInstanceOf(SigningCheckError);
    await expect(reading).rejects.toThrow(`${EXE}: No such file or directory`);
    await expect(reading).rejects.toThrow('exit 1');
  });

  it('fails when codesign succeeds but prints no designated requirement', async () => {
    const empty: CodesignOutput = { exitCode: 0, stdout: '', stderr: `Executable=${EXE}\n` };
    await expect(readSigningIdentity(EXE, fakeCodesign(empty))).rejects.toThrow(
      `codesign printed no designated requirement for ${EXE}`,
    );
  });

  it('refuses a requirement that is none of the four kinds, naming it', async () => {
    const appleOwn = 'designated => identifier "com.apple.calculator" and anchor apple';
    const appleDevelopment =
      'designated => identifier "ai.linkt.roger" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Someone (ABCDE12345)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */';
    for (const line of [appleOwn, appleDevelopment]) {
      const reading = readSigningIdentity(EXE, fakeCodesign(signed(line)));
      await expect(reading).rejects.toBeInstanceOf(SigningCheckError);
      await expect(reading).rejects.toThrow(line.replace('designated => ', ''));
    }
  });
});

describe('codesignRunner', () => {
  // Node stands in for /usr/bin/codesign so these run on Linux CI too.
  const node = process.execPath;

  it('resolves with the exit code and both outputs, also for a non-zero exit', async () => {
    const run = codesignRunner(node);
    const script = 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)';
    expect(await run(['-e', script])).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    expect(await run(['-e', 'process.stdout.write("ok")'])).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
  });

  it('rejects, naming the binary, when it cannot be run at all', async () => {
    const run = codesignRunner('/nonexistent/codesign');
    const running = run(['-d', '-r-', EXE]);
    await expect(running).rejects.toBeInstanceOf(SigningCheckError);
    await expect(running).rejects.toThrow('/nonexistent/codesign');
  });

  it('rejects when the command hangs past the timeout', async () => {
    const run = codesignRunner(node, 100);
    await expect(run(['-e', 'setTimeout(() => {}, 5000)'])).rejects.toThrow(
      `${node} gave no answer within 100 ms`,
    );
  });
});
