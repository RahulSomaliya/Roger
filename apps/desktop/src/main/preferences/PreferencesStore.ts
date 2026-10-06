import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  type PreferenceChange,
  type PreferenceKey,
  PreferenceRegistry,
  type PreferenceSpecs,
  type PreferenceValues,
} from '../../shared/preferences';
import { errorMessage, type Logger } from '../logger';

/** The file calls the store makes. Tests wrap the real ones to watch a write or break it. */
export interface PreferenceFiles {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, text: string, options: { flush: boolean }): void;
  renameSync(from: string, to: string): void;
}

const NODE_FILES: PreferenceFiles = { readFileSync, writeFileSync, renameSync };

const UNREADABLE =
  'preferences file unreadable; using defaults, and moving it aside at the next save';

export interface PreferencesStoreOptions {
  /** `userData/preferences.json`. */
  path: string;
  logger: Logger;
  files?: PreferenceFiles;
}

/**
 * The user's preferences in main (src/shared/preferences.ts has the registry and the keys). Read
 * once at startup; every milestone registers its keys before the window opens (its slot in
 * index.ts), and a value already in the file is checked as its key registers: a bad one falls back
 * to the default, with a log line. `set` refuses unknown keys and bad values, writes the file, then
 * sends one change event. The page reaches it through preferences-ipc.ts.
 *
 * The file holds only what the user set, plus every key this build does not know: a default is
 * never written, so a default changed in a later build reaches everyone who never chose, and an
 * older build saving never drops a newer build's keys. A file that exists but cannot be used (not
 * JSON, not an object, no permission) reads as defaults and is moved aside, intact, before the
 * first save (moveAside), so a save never replaces values Roger could not read.
 *
 * Everything is synchronous on purpose. A set is a few hundred bytes, and two async writes in
 * flight could rename in the wrong order and leave the older value on disk.
 */
export class PreferencesStore {
  private readonly path: string;
  private readonly logger: Logger;
  private readonly files: PreferenceFiles;
  private readonly registry = new PreferenceRegistry();
  /** The file as last read or written, every key in it, registered or not. */
  private stored: ReadonlyMap<string, unknown>;
  /** The file exists but read() could not use it: the next save moves it aside first. */
  private unreadable: boolean;
  /** The registered keys whose stored value passed their spec. Others read as the default. */
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<(change: PreferenceChange) => void>();

  constructor({ path, logger, files = NODE_FILES }: PreferencesStoreOptions) {
    this.path = path;
    this.logger = logger;
    this.files = files;
    const stored = this.read();
    this.unreadable = stored === null;
    this.stored = stored ?? new Map();
  }

  /** Adds a milestone's keys (PreferenceRegistry.register) and checks their values in the file. */
  register(specs: PreferenceSpecs): void {
    for (const key of this.registry.register(specs)) {
      if (!this.stored.has(key)) continue;
      try {
        this.values.set(key, this.registry.parse(key, this.stored.get(key)).value);
      } catch (error) {
        this.logger.warn('preference in the file refused; using its default', {
          key,
          error: errorMessage(error),
        });
      }
    }
  }

  get<K extends PreferenceKey>(key: K): PreferenceValues[K] {
    return this.registry.valueIn(key, this.values);
  }

  /** Every registered key's value: what `prefs:get-all` answers. */
  getAll(): PreferenceValues {
    return this.registry.snapshot(this.values);
  }

  set<K extends PreferenceKey>(key: K, value: PreferenceValues[K]): void {
    this.parseAndSet(key, value);
  }

  /**
   * Sets a key and a value from outside the type system (IPC). Throws, writing nothing, for a key
   * nobody registered, for a value its spec refuses, and when the file cannot be written.
   */
  parseAndSet(key: unknown, raw: unknown): PreferenceChange {
    const change = this.registry.parse(key, raw);
    const next = new Map(this.stored).set(change.key, change.value);
    this.write(next, change.key);
    this.stored = next;
    this.values.set(change.key, change.value);
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        // The value is saved; a failing listener must not turn the set into an error for the page
        // or keep the change from the listeners after it.
        this.logger.error('preference change listener failed', {
          key: change.key,
          error: errorMessage(error),
        });
      }
    }
    return change;
  }

  /** Called once per successful set, after the file is written. */
  onChange(listener: (change: PreferenceChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every key in the file; an empty map when there is none; null when it exists but is unusable. */
  private read(): ReadonlyMap<string, unknown> | null {
    let text: string;
    try {
      text = this.files.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return new Map();
      // The code only, as config.ts does: an EACCES must not read as "no preferences" silently.
      this.logger.warn(UNREADABLE, {
        error: `${this.path} could not be read (${errnoCode(error) ?? 'unknown error'})`,
      });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not the parse error: V8 quotes the input, and the notice text is the user's own words.
      this.logger.warn(UNREADABLE, { error: `${this.path} is not valid JSON` });
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.logger.warn(UNREADABLE, { error: `${this.path} must contain a JSON object` });
      return null;
    }
    return new Map(Object.entries(parsed));
  }

  /**
   * A temp file, flushed to disk, then renamed over the real one: a crash or a full disk mid-write
   * leaves the last good file in place, never a torn one.
   */
  private write(next: ReadonlyMap<string, unknown>, key: PreferenceKey): void {
    const temp = `${this.path}.tmp`;
    try {
      this.files.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`, {
        flush: true,
      });
      if (this.unreadable) this.moveAside();
      this.files.renameSync(temp, this.path);
    } catch (error) {
      throw new Error(`could not save preference ${key} to ${this.path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Keeps a file read() could not use: the save holds only what was set since startup, so renaming
   * over it would lose every other value in it for good (a hand edit's trailing comma, a file root
   * owns).
   * config.ts falls back to defaults the same way but never writes config.json, so it needs no
   * such step; this store does write. Throws, so the save writes nothing, when the move fails.
   */
  private moveAside(): void {
    const aside = `${this.path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      this.files.renameSync(this.path, aside);
      this.logger.warn('unreadable preferences file moved aside; copy its values back by hand', {
        file: aside,
      });
    } catch (error) {
      // Deleted since startup: nothing is left to keep.
      if (errnoCode(error) !== 'ENOENT') {
        throw new Error(`could not move the unreadable file aside: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
    this.unreadable = false;
  }
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
