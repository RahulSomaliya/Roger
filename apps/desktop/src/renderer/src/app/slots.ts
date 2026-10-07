import { mergeSlots, type Slots } from './slotRegistry';
import { contributions as m2CaptureDetails } from './slots/m2-capture-details';
import { contributions as m2CaptureStatus } from './slots/m2-capture-status';
import { contributions as m2Setup } from './slots/m2-setup';
import { contributions as m3Transcript } from './slots/m3-transcript';
import { contributions as m4Notes } from './slots/m4-notes';
import { contributions as m5Calendar } from './slots/m5-calendar';

/**
 * Everything mounted in the shell, by slot. Only M4-S1 edits this file; a mount task fills its own
 * file under ./slots/ instead. slotRegistry.test.ts fails on two entries with one id in a slot.
 */
export const slots: Slots = mergeSlots({
  'm2-capture-status': m2CaptureStatus,
  'm2-setup': m2Setup,
  'm2-capture-details': m2CaptureDetails,
  'm3-transcript': m3Transcript,
  'm4-notes': m4Notes,
  'm5-calendar': m5Calendar,
});
