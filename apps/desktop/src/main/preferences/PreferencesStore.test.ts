import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_PREFERENCES, type PreferenceChange } from '../../shared/preferences';
import { createLogger } from '../logger';
import { PreferencesStore, type PreferenceFiles } from './PreferencesStore';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roger-prefs-'));
  path = join(dir, 'preferences.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The file system the store uses in the app, with every call recorded. */
function recordingFiles(): { files: PreferenceFiles; calls: string[] } {
  const calls: string[] = [];
  const files: PreferenceFiles = {
    readFileSync: (file, encoding) => readFileSync(file, encoding),
    writeFileSync: (file, text, options) => {
      calls.push(`write ${file}`);
      writeFileSync(file, text, options);
    },
    renameSync: (from, to) => {
      calls.push(`rename ${from} -> ${to}`);
      renameSync(from, to);
    },
  };
  return { files, calls };
}

function open(files?: PreferenceFiles) {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const store = new PreferencesStore({ path, logger, ...(files ? { files } : {}) });
  store.register(APP_PREFERENCES);
  const changes: PreferenceChange[] = [];
  store.onChange((change) => changes.push(change));
  return { store, lines, changes };
}

function fileJson(): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('PreferencesStore', () => {
  it('defaults when the file is missing', () => {
    const { store, lines } = open();
    expect(store.getAll()).toEqual({
      theme: 'system',
      'notes.autoGenerate': true,
      'notes.whenUnsure': 'ask',
    });
    expect(store.get('theme')).toBe('system');
    // Opening never writes: a missing file is the normal first run.
    expect(existsSync(path)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('a bad value falls back to its default and is logged', () => {
    writeFileSync(path, JSON.stringify({ theme: 'sepia', 'notes.autoGenerate': false }));
    const { store, lines } = open();
    expect(store.get('theme')).toBe('system');
    expect(store.get('notes.autoGenerate')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn',
      key: 'theme',
      error: 'theme must be one of system, light or dark (got "sepia")',
    });
  });

  it('set writes through a temp file and emits a change', () => {
    const { files, calls } = recordingFiles();
    const { store, changes } = open(files);
    store.set('theme', 'dark');
    expect(calls).toEqual([`write ${path}.tmp`, `rename ${path}.tmp -> ${path}`]);
    expect(fileJson()).toEqual({ theme: 'dark' });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(store.get('theme')).toBe('dark');
    expect(changes).toEqual([{ key: 'theme', value: 'dark' }]);
  });

  it('survives reopening', () => {
    const first = open().store;
    first.set('theme', 'light');
    first.set('notes.autoGenerate', false);
    first.set('notes.whenUnsure', 'general');
    expect(open().store.getAll()).toEqual({
      theme: 'light',
      'notes.autoGenerate': false,
      'notes.whenUnsure': 'general',
    });
  });

  it('a torn write keeps the last good copy', () => {
    open().store.set('theme', 'light');
    const { files } = recordingFiles();
    const crashing: PreferenceFiles = {
      ...files,
      // The crash lands between the temp file and the rename: the temp file is half written.
      writeFileSync: (file, text, options) => {
        files.writeFileSync(file, text.slice(0, 5), options);
      },
      renameSync: () => {
        throw new Error('EIO: i/o error, rename');
      },
    };
    const { store, changes } = open(crashing);
    expect(() => {
      store.set('theme', 'dark');
    }).toThrow(`could not save preference theme to ${path}: EIO: i/o error, rename`);
    expect(store.get('theme')).toBe('light');
    expect(changes).toEqual([]);
    expect(fileJson()).toEqual({ theme: 'light' });
    expect(open().store.get('theme')).toBe('light');
  });

  it('refuses unknown keys and bad values naming the key, and writes nothing', () => {
    const { files, calls } = recordingFiles();
    const { store, changes } = open(files);
    expect(() => store.parseAndSet('colour', 'dark')).toThrow('unknown preference "colour"');
    expect(() => store.parseAndSet('notes.autoGenerate', 'yes')).toThrow(
      'notes.autoGenerate must be true or false (got "yes")',
    );
    expect(calls).toEqual([]);
    expect(changes).toEqual([]);
    expect(store.parseAndSet('notes.whenUnsure', 'general')).toEqual({
      key: 'notes.whenUnsure',
      value: 'general',
    });
  });

  it('sends one change per set, even when the value does not change', () => {
    const { store, changes } = open();
    store.set('theme', 'dark');
    store.set('theme', 'dark');
    expect(changes).toEqual([
      { key: 'theme', value: 'dark' },
      { key: 'theme', value: 'dark' },
    ]);
  });

  it('logs a change listener that throws, and still sends the change to the others', () => {
    const { store, lines, changes } = open();
    store.onChange(() => {
      throw new Error('reminder scheduler is closed');
    });
    const later: PreferenceChange[] = [];
    store.onChange((change) => later.push(change));
    store.set('theme', 'dark');
    expect(changes).toEqual([{ key: 'theme', value: 'dark' }]);
    expect(later).toEqual([{ key: 'theme', value: 'dark' }]);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      level: 'error',
      key: 'theme',
      error: 'reminder scheduler is closed',
    });
  });

  it('stops sending changes to a listener that unsubscribed', () => {
    const { store } = open();
    const seen: PreferenceChange[] = [];
    const stop = store.onChange((change) => seen.push(change));
    stop();
    store.set('theme', 'dark');
    expect(seen).toEqual([]);
  });

  // Writing defaults would pin them: a default changed in a later build (calendarPrefs.ts plans
  // to flip app.openAtLogin) would never reach a user who never chose.
  it('stores only the values that were set, never the defaults', () => {
    const { store } = open();
    store.set('notes.whenUnsure', 'general');
    expect(fileJson()).toEqual({ 'notes.whenUnsure': 'general' });
  });

  // Another milestone registers its keys later in startup (M5 from its slot), and an older build
  // must not drop a newer build's keys when it saves.
  it('keeps the keys nobody registered when it writes', () => {
    writeFileSync(path, JSON.stringify({ 'calendar.reminderLeadMinutes': 5, theme: 'light' }));
    const { store } = open();
    store.set('notes.autoGenerate', false);
    expect(fileJson()).toEqual({
      'calendar.reminderLeadMinutes': 5,
      theme: 'light',
      'notes.autoGenerate': false,
    });
  });

  it('reads a value from the file for a key registered after opening', () => {
    writeFileSync(path, JSON.stringify({ theme: 'dark' }));
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', format: 'json', sink: (l) => lines.push(l) });
    const store = new PreferencesStore({ path, logger });
    expect(() => store.get('theme')).toThrow('unknown preference "theme"');
    store.register(APP_PREFERENCES);
    expect(store.get('theme')).toBe('dark');
  });

  it('refuses a key registered twice', () => {
    const { store } = open();
    expect(() => {
      store.register(APP_PREFERENCES);
    }).toThrow('preference theme is registered twice');
  });

  it('reads a file that is not JSON as defaults, and logs why without its contents', () => {
    writeFileSync(path, '{"theme": "dark", "notice.text": "secret');
    const { store, lines } = open();
    expect(store.get('theme')).toBe('system');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${path} is not valid JSON`);
    expect(lines[0]).not.toContain('secret');
  });

  it('reads a file that is not a JSON object as defaults, and logs it', () => {
    writeFileSync(path, '["dark"]');
    const { store, lines } = open();
    expect(store.get('theme')).toBe('system');
    expect(lines[0]).toContain(`${path} must contain a JSON object`);
  });

  it('reads a file it cannot open as defaults, and logs the error code', () => {
    mkdirSync(path);
    const { store, lines } = open();
    expect(store.get('theme')).toBe('system');
    expect(lines[0]).toContain(`${path} could not be read (EISDIR)`);
  });
});
