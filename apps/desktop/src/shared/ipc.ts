import { appChannels, type AppApi } from './ipc/app';
import { calendarChannels, type CalendarApi } from './ipc/calendar';
import { captureChannels, type CaptureApi } from './ipc/capture';
import { chatChannels, type ChatApi } from './ipc/chat';
import { loginItemChannels, type LoginItemApi } from './ipc/loginItem';
import { meetingsChannels, type MeetingsApi } from './ipc/meetings';
import { notesChannels, type NotesApi } from './ipc/notes';
import { prefsChannels, type PrefsApi } from './ipc/prefs';
import { promptChannels } from './ipc/prompt';
import { setupChannels, type SetupApi } from './ipc/setup';
import { vocabularyChannels, type VocabularyApi } from './ipc/vocabulary';

/**
 * The IPC contract between renderer and main. Each feature owns one module under ./ipc/ with its
 * channel names and its part of `window.roger`; the preload bridges them (src/preload/bridges/),
 * main registers handlers for them through src/main/ipc/trust.ts, and the preview harness fakes
 * them (preview/fakes/). This file only composes the modules and is not edited after P2-F1: a
 * feature changes its own module, bridge and fake.
 */

/** Every feature's channel map. ipc.test.ts fails when two share a key or a channel name. */
export const featureChannels = {
  capture: captureChannels,
  setup: setupChannels,
  app: appChannels,
  prefs: prefsChannels,
  meetings: meetingsChannels,
  vocabulary: vocabularyChannels,
  notes: notesChannels,
  chat: chatChannels,
  calendar: calendarChannels,
  loginItem: loginItemChannels,
  prompt: promptChannels,
} as const;

/**
 * Every channel, flat. A key two features share is no type error: the later spread silently
 * replaces the earlier channel, which ipc.test.ts catches. The prompt panel's channels are here
 * too, although its API is not RogerApi: they share ipcMain's one namespace.
 */
export const IpcChannel = {
  ...captureChannels,
  ...setupChannels,
  ...appChannels,
  ...prefsChannels,
  ...meetingsChannels,
  ...vocabularyChannels,
  ...notesChannels,
  ...chatChannels,
  ...calendarChannels,
  ...loginItemChannels,
  ...promptChannels,
} as const;

/**
 * Each feature's part of `window.roger`, by feature (every feature of featureChannels but the
 * prompt panel, which has its own preload). The preview composes its fakes from this map.
 */
export interface RogerApiParts {
  capture: CaptureApi;
  setup: SetupApi;
  app: AppApi;
  prefs: PrefsApi;
  meetings: MeetingsApi;
  vocabulary: VocabularyApi;
  notes: NotesApi;
  chat: ChatApi;
  calendar: CalendarApi;
  loginItem: LoginItemApi;
}

/** A union's members as one intersection: `A | B` becomes `A & B`. */
type AllOf<U> = (U extends unknown ? (part: U) => void : never) extends (part: infer I) => void
  ? I
  : never;

/**
 * What the renderer sees as `window.roger`: every part at once. Built from the map, not written
 * as `CaptureApi & SetupApi & ...`, because the stubs are all `object` until their owners fill
 * them, and lint refuses an intersection that repeats a type.
 */
export type RogerApi = AllOf<RogerApiParts[keyof RogerApiParts]>;

export type { Unsubscribe } from './ipc/unsubscribe';
// Kept on the barrel: CaptureSession, CaptureService, stt/streamSettings.ts, the AssemblyAI
// protocol, ipc-validation.ts and the renderer's AudioCaptureController import them from here, and
// those files belong to other tasks. New code imports from the feature module.
export {
  PCM_ENCODING,
  PCM_SAMPLE_RATE,
  type AudioChunkMessage,
  type AudioSourceStateMessage,
} from './ipc/capture';
