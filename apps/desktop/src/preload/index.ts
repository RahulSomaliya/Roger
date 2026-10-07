import { contextBridge } from 'electron';
import type { RogerApi } from '../shared/ipc';
import { appBridge } from './bridges/app';
import { calendarBridge } from './bridges/calendar';
import { captureBridge } from './bridges/capture';
import { chatBridge } from './bridges/chat';
import { loginItemBridge } from './bridges/loginItem';
import { meetingsBridge } from './bridges/meetings';
import { notesBridge } from './bridges/notes';
import { prefsBridge } from './bridges/prefs';
import { setupBridge } from './bridges/setup';
import { vocabularyBridge } from './bridges/vocabulary';

/**
 * The only bridge between renderer and main: every feature's bridge (./bridges/, built from the
 * helpers in ./bridge.ts), typed by the shared contract. Nothing else from Node or Electron is
 * exposed to the page. Not edited after P2-F1: a feature changes its own bridge. Two bridges with
 * a member of the same name would overwrite one another here; the preview fakes' test
 * (preview/fakeRoger.test.ts) fails on that, because each fake implements the same API.
 */
const api: RogerApi = {
  ...captureBridge,
  ...setupBridge,
  ...appBridge,
  ...prefsBridge,
  ...meetingsBridge,
  ...vocabularyBridge,
  ...notesBridge,
  ...chatBridge,
  ...calendarBridge,
  ...loginItemBridge,
};

contextBridge.exposeInMainWorld('roger', api);
