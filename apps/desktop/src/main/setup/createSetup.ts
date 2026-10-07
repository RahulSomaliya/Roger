import type { ApiConnection } from '../api/http';
import type { SystemAudio } from '../audio/system/createSystemAudio';
import type { DesktopConfig } from '../config';
import type { IpcMainLike, TrustedWindow } from '../ipc/trust';
import type { Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import { electronSetupPorts } from './electronSetupPorts';
import { PermissionService } from './PermissionService';
import { registerSetupIpc } from './setupIpc';

export interface SetupDeps {
  ipcMain: IpcMainLike;
  getWindow: () => TrustedWindow | null;
  /** `[slot M2-T10]`'s call audio: the probe adds to its proof, "I allowed it" rebuilds its tap. */
  systemAudio: Pick<SystemAudio, 'source' | 'verification'>;
  store: Pick<TranscriptStore, 'getAppState' | 'setAppState'>;
  config: Pick<DesktopConfig, 'apiToken' | 'sttProviderOverride'>;
  apiConnection: ApiConnection;
  /** `app.isPackaged`. */
  isPackaged: boolean;
  logger: Logger;
  clock?: () => number;
}

/**
 * The permission setup screen's main side (M2-T19): the checks, the actions and the `setup:*`
 * channels. `[slot M2-T19]` in capture/createCaptureRuntime.ts calls it.
 *
 * It opens no route itself: that slot runs before `[slot M4-S1]` in index.ts declares the
 * navigation, so the renderer opens the setup screen (app/slots/m2-setup.ts) on a first run and
 * when a Start is refused for the microphone, and the app menu opens it through M4-S1.
 */
export function createSetup(deps: SetupDeps): PermissionService {
  const service = new PermissionService({
    ports: electronSetupPorts({
      config: deps.config,
      apiConnection: deps.apiConnection,
      logger: deps.logger,
    }),
    systemAudio: deps.systemAudio,
    store: deps.store,
    isPackaged: deps.isPackaged,
    logger: deps.logger,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
  registerSetupIpc({
    ipcMain: deps.ipcMain,
    service,
    getWindow: deps.getWindow,
    logger: deps.logger,
  });
  return service;
}
