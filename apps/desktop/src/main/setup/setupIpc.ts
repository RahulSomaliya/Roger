import { SETTINGS_PANE_IDS, setupChannels } from '../../shared/ipc/setup';
import { parseSettingsPaneRequest } from '../ipc-validation';
import { handleTrusted, type IpcMainLike, type IpcTrust, type TrustedWindow } from '../ipc/trust';
import { errorMessage, type Logger } from '../logger';
import type { PermissionService } from './PermissionService';

/** What the channels call on the service; PermissionService is one, a test passes spies. */
export type SetupActions = Pick<
  PermissionService,
  | 'status'
  | 'requestMicrophone'
  | 'testSystemAudio'
  | 'confirmSystemAudioAllowed'
  | 'testNotification'
  | 'openSettingsPane'
  | 'relaunch'
>;

export interface SetupIpcDeps {
  ipcMain: IpcMainLike;
  service: SetupActions;
  /** The main window, whose page alone may use these channels; null while it is closed. */
  getWindow: () => TrustedWindow | null;
  logger: Logger;
}

const PANE_CHOICES = SETTINGS_PANE_IDS.map((pane) => JSON.stringify(pane)).join(' | ');

/**
 * Wires the setup channels (src/shared/ipc/setup.ts) to the PermissionService, for the main
 * window's page only (ipc/trust.ts): another page that could relaunch Roger or open System
 * Settings would be a nuisance at best. The one payload, the pane, is checked against the closed
 * list (ipc-validation.ts); main turns it into the link, so no page ever names a URL to open.
 */
export function registerSetupIpc({ ipcMain, service, getWindow, logger }: SetupIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };
  const handle = <T>(channel: string, run: (payload: unknown) => Promise<T> | T): void => {
    handleTrusted(trust, channel, async (payload) => {
      try {
        return await run(payload);
      } catch (error) {
        logger.warn('setup action failed', { channel, error: errorMessage(error) });
        throw error;
      }
    });
  };

  handle(setupChannels.SetupGetStatus, () => service.status());
  handle(setupChannels.SetupRequestMicrophone, () => service.requestMicrophone());
  handle(setupChannels.SetupTestSystemAudio, () => service.testSystemAudio());
  handle(setupChannels.SetupConfirmSystemAudio, () => service.confirmSystemAudioAllowed());
  handle(setupChannels.SetupTestNotification, () => service.testNotification());
  handle(setupChannels.SetupOpenSettingsPane, (payload) => {
    const request = parseSettingsPaneRequest(payload);
    if (request === null) {
      throw new Error(`${setupChannels.SetupOpenSettingsPane} takes { pane: ${PANE_CHOICES} }`);
    }
    return service.openSettingsPane(request.pane);
  });
  handle(setupChannels.SetupRelaunch, () => {
    service.relaunch();
  });
}
