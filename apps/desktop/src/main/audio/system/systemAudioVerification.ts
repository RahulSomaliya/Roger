import { errorMessage, type Logger } from '../../logger';
import type { SigningIdentity } from '../../signing';
import type { TranscriptStore } from '../../store/TranscriptStore';

/**
 * The `app_state` key that holds the signing requirement hash (signing.ts, `requirementHash`) call
 * audio was last heard under. One key, one identity: a build signed another way reads as not
 * verified, exactly as macOS then asks for System Audio Recording again (the field report of
 * 2026-10-06). M2-T19's probe writes it through this class too.
 */
export const SYSTEM_AUDIO_VERIFIED_KEY = 'system-audio.verified-for';

/**
 * Who heard it: tap audio above digital silence (TapSystemAudio), or a probe that heard its test
 * sound (M2-T19). For the log.
 */
export type HeardBy = 'tap' | 'probe';

export interface SystemAudioVerificationOptions {
  store: Pick<TranscriptStore, 'getAppState' | 'setAppState'>;
  /** This copy of Roger's signing identity (`readSigningIdentity`); a rejection is "unknown". */
  identity: Promise<SigningIdentity>;
  logger: Logger;
  clock?: () => number;
  /** `verified` changed: the status contributor's part did. */
  onChange?: () => void;
}

/**
 * Whether System Audio Recording is known to work for this signing identity (M2 design,
 * "Permission check for system audio"). No public API reads that permission, and a refused or
 * still-pending tap records digital silence with no error, so the only proof is call audio that
 * was heard. While unverified, M2-T11 makes "call audio never heard for 20 s" a loud warning and
 * TapSystemAudio rebuilds the tap when Roger regains focus (a tap built while the macOS dialog was
 * up stays silent after the grant).
 *
 * An unsigned build, or one codesign could not read, has no identity to pin the proof to: it is
 * verified for this run only once heard, and nothing is stored.
 */
export class SystemAudioVerification {
  /** Resolves once the identity is read and what was stored for it is applied. */
  readonly ready: Promise<void>;
  private readonly clock: () => number;
  /** Undefined until the identity is read; null when it is unknown or unsigned. */
  private hash: string | null | undefined = undefined;
  private isVerified = false;
  /** Heard before the identity was read: stored once it is. */
  private heardBy: HeardBy | null = null;

  constructor(private readonly options: SystemAudioVerificationOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.ready = options.identity.then(
      (identity) => {
        this.identityRead(identity.requirementHash);
      },
      (error: unknown) => {
        options.logger.warn('signing identity unknown; system audio stays unverified until heard', {
          error: errorMessage(error),
        });
        this.identityRead(null);
      },
    );
  }

  get verified(): boolean {
    return this.isVerified;
  }

  /** Call audio above digital silence was heard. Cheap after the first call. */
  markHeard(by: HeardBy): void {
    if (this.isVerified) return;
    this.isVerified = true;
    this.heardBy = by;
    if (this.hash === undefined) {
      this.options.logger.info('system audio heard; saved once the signing identity is read', {
        heardBy: by,
      });
    } else {
      this.save(by);
    }
    this.options.onChange?.();
  }

  private identityRead(hash: string | null): void {
    this.hash = hash;
    if (this.heardBy !== null) {
      this.save(this.heardBy);
      return;
    }
    if (hash === null || !this.storedFor(hash)) return;
    this.isVerified = true;
    this.options.onChange?.();
  }

  private storedFor(hash: string): boolean {
    try {
      return this.options.store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)?.value === hash;
    } catch (error) {
      this.options.logger.error('system audio verified state not read', {
        error: errorMessage(error),
      });
      return false;
    }
  }

  private save(by: HeardBy): void {
    const { logger, store } = this.options;
    const hash = this.hash;
    if (hash === undefined) return;
    if (hash === null) {
      logger.warn('system audio verified for this run only: the signing identity is unknown', {
        heardBy: by,
      });
      return;
    }
    try {
      store.setAppState(SYSTEM_AUDIO_VERIFIED_KEY, hash, new Date(this.clock()).toISOString());
      logger.info('system audio verified', { heardBy: by, requirementHash: hash.slice(0, 12) });
    } catch (error) {
      // The proof holds for this run; the next launch asks again (a loud 20 s rule), no worse.
      logger.error('system audio verified, but not saved', {
        heardBy: by,
        error: errorMessage(error),
      });
    }
  }
}
