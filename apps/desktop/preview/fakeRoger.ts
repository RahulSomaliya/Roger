import type { RogerApi, RogerApiParts } from '../src/shared/ipc';
import { createAppFake } from './fakes/app';
import { createCalendarFake } from './fakes/calendar';
import { createCaptureFake } from './fakes/capture';
import { createChatFake } from './fakes/chat';
import type { FakeHub } from './fakes/hub';
import { createLoginItemFake } from './fakes/loginItem';
import { createMeetingsFake } from './fakes/meetings';
import { createNotesFake } from './fakes/notes';
import { createPrefsFake } from './fakes/prefs';
import { createSetupFake } from './fakes/setup';
import { createVocabularyFake } from './fakes/vocabulary';

/**
 * One fake per feature of `window.roger` (src/shared/ipc.ts, RogerApiParts). The type makes a
 * missing fake, or one that does not implement its feature's API, a type error.
 */
export const featureFakes: {
  [Part in keyof RogerApiParts]: (hub: FakeHub) => RogerApiParts[Part];
} = {
  capture: createCaptureFake,
  setup: createSetupFake,
  app: createAppFake,
  prefs: createPrefsFake,
  meetings: createMeetingsFake,
  vocabulary: createVocabularyFake,
  notes: createNotesFake,
  chat: createChatFake,
  calendar: createCalendarFake,
  loginItem: createLoginItemFake,
};

/**
 * The preview harness's `window.roger`: every feature's fake over one hub, which the harness's
 * scenarios drive. Not edited after P2-F1: a feature changes its own fake in ./fakes/.
 */
export function createFakeRoger(hub: FakeHub): RogerApi {
  return {
    ...featureFakes.capture(hub),
    ...featureFakes.setup(hub),
    ...featureFakes.app(hub),
    ...featureFakes.prefs(hub),
    ...featureFakes.meetings(hub),
    ...featureFakes.vocabulary(hub),
    ...featureFakes.notes(hub),
    ...featureFakes.chat(hub),
    ...featureFakes.calendar(hub),
    ...featureFakes.loginItem(hub),
  };
}
