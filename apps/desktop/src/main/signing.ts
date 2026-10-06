import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * How this copy of Roger is signed, read from its designated requirement. macOS pins every privacy
 * grant (Microphone, System Audio Recording, Screen Recording) to that requirement: when it
 * changes, `tccd` logs "Failed to match existing code requirement" and asks again, or denies call
 * audio silently while System Settings still shows Roger switched on (field report, 2026-10-06).
 *
 * - `local-identity`: `identifier "ai.linkt.roger" and certificate leaf = H"..."`, the per-Mac
 *   self-signed identity `make install-desktop` signs with. Stable across rebuilds.
 * - `developer-id`: Apple's Developer ID chain (M11). Stable.
 * - `adhoc`: `cdhash H"..."`, the hash of this exact build. Every rebuild loses the grants.
 * - `unsigned`: no signature at all.
 *
 * Read it once at startup with `readSigningIdentity(process.execPath)`. In `make dev-desktop` that is
 * Electron.app in node_modules, which is not what macOS checks: the terminal holds the grants there.
 */
export type SigningKind = 'local-identity' | 'developer-id' | 'adhoc' | 'unsigned';

export interface SigningIdentity {
  kind: SigningKind;
  /** The designated requirement as codesign prints it, without `designated =>`; null when unsigned. */
  requirement: string | null;
  /**
   * SHA-256 (hex) of `requirement`; null when unsigned. "System audio verified" is stored against
   * this hash, so it resets exactly when the grants do: a new identity, or every ad-hoc rebuild.
   */
  requirementHash: string | null;
}

export class SigningCheckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SigningCheckError';
  }
}

export interface CodesignOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs codesign with these arguments. Rejects only when codesign could not run or hung. */
export type RunCodesign = (args: readonly string[]) => Promise<CodesignOutput>;

const CODESIGN = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 10_000;

/**
 * codesign prints the requirement on stdout. An ad-hoc signature has no explicit requirement, so
 * codesign prints the implicit one behind a "#" (`# designated => cdhash H"..."`); a pattern without
 * the "#" reads every ad-hoc build as unsigned. install-mac.sh parses the same line the same way.
 */
const DESIGNATED_LINE = /^#?\s*designated => (.+)$/m;
const NOT_SIGNED = 'code object is not signed at all';
/** One cdhash per architecture or hash type: `cdhash H"..." or cdhash H"..."`. */
const ADHOC_REQUIREMENT = /^cdhash H"[0-9a-f]+"( or cdhash H"[0-9a-f]+")*$/i;
/** The leaf marker of a Developer ID Application certificate. */
const DEVELOPER_ID_LEAF = 'certificate leaf[field.1.2.840.113635.100.6.1.13]';
/** A certificate pinned by its hash: what codesign writes for a self-signed identity. */
const PINNED_LEAF = /certificate leaf = H"[0-9a-f]+"/i;

/** Reads how the code at `executablePath` is signed (`codesign -d -r-`). */
export async function readSigningIdentity(
  executablePath: string,
  runCodesign: RunCodesign = codesignRunner(),
): Promise<SigningIdentity> {
  const output = await runCodesign(['-d', '-r-', executablePath]);
  if (output.exitCode !== 0) {
    if (output.stderr.includes(NOT_SIGNED)) {
      return { kind: 'unsigned', requirement: null, requirementHash: null };
    }
    throw new SigningCheckError(
      `codesign could not read the signature of ${executablePath} (exit ${output.exitCode}): ${output.stderr.trim()}`,
    );
  }
  const requirement = DESIGNATED_LINE.exec(output.stdout)?.[1]?.trim();
  if (requirement === undefined || requirement === '') {
    throw new SigningCheckError(`codesign printed no designated requirement for ${executablePath}`);
  }
  return {
    kind: signingKind(requirement, executablePath),
    requirement,
    requirementHash: createHash('sha256').update(requirement).digest('hex'),
  };
}

/**
 * Anything else (Apple Development, the App Store, Apple's own code) is not a way Roger is built,
 * so it is refused with the requirement in the message rather than guessed into a kind.
 */
function signingKind(
  requirement: string,
  executablePath: string,
): Exclude<SigningKind, 'unsigned'> {
  if (ADHOC_REQUIREMENT.test(requirement)) return 'adhoc';
  if (requirement.includes('anchor apple generic') && requirement.includes(DEVELOPER_ID_LEAF)) {
    return 'developer-id';
  }
  if (!requirement.includes('anchor apple') && PINNED_LEAF.test(requirement)) {
    return 'local-identity';
  }
  throw new SigningCheckError(
    `unrecognised designated requirement for ${executablePath}: ${requirement}`,
  );
}

/** Runs `file` (codesign unless a test passes another binary), killed after `timeoutMs`. */
export function codesignRunner(
  file: string = CODESIGN,
  timeoutMs: number = CODESIGN_TIMEOUT_MS,
): RunCodesign {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // A number is the exit code of a process that ran; codesign exits 1 for unsigned code.
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        const reason =
          error.killed === true && error.code === null
            ? `${file} gave no answer within ${timeoutMs} ms`
            : `could not run ${file}: ${error.message}`;
        reject(new SigningCheckError(reason, { cause: error }));
      });
    });
}
