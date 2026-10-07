import { describe, expect, it } from 'vitest';
import { APP_PREFERENCES, PreferenceRegistry } from './preferences';

function appRegistry(): PreferenceRegistry {
  const registry = new PreferenceRegistry();
  registry.register(APP_PREFERENCES);
  return registry;
}

describe('the preference registry', () => {
  it('rejects unknown keys and wrong types', () => {
    const registry = appRegistry();
    expect(() => registry.parse('colour', 'dark')).toThrow('unknown preference "colour"');
    expect(() => registry.parse(42, 'dark')).toThrow('unknown preference 42');
    expect(() => registry.parse('theme', 'sepia')).toThrow(
      'theme must be one of system, light or dark (got "sepia")',
    );
    expect(() => registry.parse('theme', null)).toThrow(
      'theme must be one of system, light or dark (got null)',
    );
    expect(() => registry.parse('notes.autoGenerate', 'yes')).toThrow(
      'notes.autoGenerate must be true or false (got "yes")',
    );
    expect(() => registry.parse('notes.whenUnsure', ['ask'])).toThrow(
      'notes.whenUnsure must be ask or general (got object)',
    );
  });

  it('names a long bad value by its length, so a log line never copies user text', () => {
    expect(() => appRegistry().parse('theme', 'x'.repeat(500))).toThrow('(got 500 characters)');
  });

  it('returns a good value as a change for its key', () => {
    const registry = appRegistry();
    expect(registry.parse('theme', 'dark')).toEqual({ key: 'theme', value: 'dark' });
    expect(registry.parse('notes.autoGenerate', false)).toEqual({
      key: 'notes.autoGenerate',
      value: false,
    });
    expect(registry.parse('notes.whenUnsure', 'general')).toEqual({
      key: 'notes.whenUnsure',
      value: 'general',
    });
  });

  it('follows the system theme, generates notes after Stop and asks when unsure, by default', () => {
    expect(appRegistry().snapshot(new Map())).toEqual({
      theme: 'system',
      'notes.autoGenerate': true,
      'notes.whenUnsure': 'ask',
    });
  });

  it('reads each key from the current values, and the default where it has none', () => {
    const registry = appRegistry();
    const current = new Map<string, unknown>([['theme', 'light']]);
    expect(registry.valueIn('theme', current)).toBe('light');
    expect(registry.valueIn('notes.autoGenerate', current)).toBe(true);
    expect(registry.snapshot(current)).toMatchObject({ theme: 'light', 'notes.whenUnsure': 'ask' });
  });

  // Two milestones registering one key would silently share or overwrite a setting.
  it('refuses a key registered twice, and registers nothing from that call', () => {
    const registry = new PreferenceRegistry();
    registry.register({ theme: APP_PREFERENCES.theme });
    expect(() => {
      registry.register(APP_PREFERENCES);
    }).toThrow('preference theme is registered twice');
    expect(registry.keys()).toEqual(['theme']);
  });

  it('refuses to read a key nobody registered', () => {
    const registry = new PreferenceRegistry();
    registry.register({ theme: APP_PREFERENCES.theme });
    expect(() => registry.valueIn('notes.autoGenerate', new Map())).toThrow(
      'unknown preference "notes.autoGenerate"',
    );
    expect(() => registry.parse('notes.autoGenerate', true)).toThrow(
      'unknown preference "notes.autoGenerate"',
    );
  });

  it('returns the keys each register call added, in order', () => {
    const registry = new PreferenceRegistry();
    expect(registry.register(APP_PREFERENCES)).toEqual([
      'theme',
      'notes.autoGenerate',
      'notes.whenUnsure',
    ]);
    expect(registry.keys()).toEqual(['theme', 'notes.autoGenerate', 'notes.whenUnsure']);
  });
});
