import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_USER_DATA_FOLDER, PACKAGED_USER_DATA_FOLDER, userDataOverride } from './userDataPath';

const appData = '/Users/someone/Library/Application Support';
const dev = { isPackaged: false, e2eOn: false, userDataSwitch: false, appData };

describe('the data folder', () => {
  it('is "Roger Dev" for a build that is not packaged', () => {
    expect(DEV_USER_DATA_FOLDER).toBe('Roger Dev');
    expect(userDataOverride(dev)).toBe(join(appData, 'Roger Dev'));
  });

  it('is left to Electron ("Roger") for a packaged build', () => {
    expect(PACKAGED_USER_DATA_FOLDER).toBe('Roger');
    expect(userDataOverride({ ...dev, isPackaged: true })).toBeNull();
  });

  it('never moves the e2e run, whose folder is its own (M2-T13)', () => {
    expect(userDataOverride({ ...dev, e2eOn: true })).toBeNull();
  });

  it('never overrides a folder the launch named with --user-data-dir', () => {
    expect(userDataOverride({ ...dev, userDataSwitch: true })).toBeNull();
  });

  it('keeps a dev run and the installed app on different folders, so both can run', () => {
    expect(userDataOverride(dev)).not.toBe(join(appData, PACKAGED_USER_DATA_FOLDER));
  });
});
