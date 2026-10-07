import type { SetupApi, SetupStatus } from '../../../../shared/ipc/setup';
import { describeError } from '../../app/describeError';
import type { SetupAction, SetupActionKind, SetupRowId } from './setupRows';

export interface SetupScreenState {
  /** Main's last answer; null until the first read answers. */
  status: SetupStatus | null;
  /** Why the last read failed; null once one answers. */
  loadError: string | null;
  /** The action running now, on its row: one at a time, so every other button waits. */
  running: { row: SetupRowId; action: SetupActionKind } | null;
  /** Why the last action failed, on its row, until the next action starts. */
  failure: { row: SetupRowId; message: string } | null;
}

/**
 * The setup screen's state, outside React so it tests under Node: reads main's status and runs
 * the rows' actions through `window.roger` (shared/ipc/setup.ts). `load` and `run` never reject:
 * a failure becomes the state that shows it.
 */
export class SetupModel {
  private state: SetupScreenState = {
    status: null,
    loadError: null,
    running: null,
    failure: null,
  };
  private readonly listeners = new Set<() => void>();
  /** Counts requests that answer a status; only the newest one's answer is shown. */
  private asked = 0;
  private shown = 0;

  constructor(private readonly api: SetupApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SetupScreenState => this.state;

  /** Reads the status again; skipped while an action runs, whose answer is the status. */
  async load(): Promise<void> {
    if (this.state.running !== null) return;
    const ticket = ++this.asked;
    try {
      this.show(ticket, await this.api.getSetupStatus());
    } catch (error) {
      if (ticket > this.shown) this.update({ loadError: describeError(error) });
    }
  }

  /** Runs one row's action; a press while another runs does nothing. */
  async run(row: SetupRowId, action: SetupAction): Promise<void> {
    if (this.state.running !== null) return;
    this.update({ running: { row, action: action.kind }, failure: null });
    const ticket = ++this.asked;
    try {
      const status = await this.call(action);
      if (status !== null) this.show(ticket, status);
      this.update({ running: null });
    } catch (error) {
      // Main's setup errors are sentences for people (main/setup/PermissionService.ts).
      this.update({ running: null, failure: { row, message: describeError(error) } });
    }
  }

  /** The action's call: its answer when it answers a status, null when it answers none. */
  private async call(action: SetupAction): Promise<SetupStatus | null> {
    switch (action.kind) {
      case 'request-microphone':
        return this.api.requestMicrophoneAccess();
      case 'test-system-audio':
        return this.api.testSystemAudio();
      case 'confirm-system-audio':
        return this.api.confirmSystemAudioAllowed();
      case 'test-notification':
        return this.api.testNotification();
      case 'recheck':
        return this.api.getSetupStatus();
      case 'open-pane':
        await this.api.openSettingsPane({ pane: action.pane });
        return null;
      case 'relaunch':
        await this.api.relaunchRoger();
        return null;
    }
  }

  /** Shows a status unless a newer request's answer is already on screen. */
  private show(ticket: number, status: SetupStatus): void {
    if (ticket < this.shown) return;
    this.shown = ticket;
    this.update({ status, loadError: null });
  }

  private update(change: Partial<SetupScreenState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
}
