import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunRecord, readRun, writeRun } from '../core/events';
import {
  type ItemRecord,
  describeItemError,
  itemPaths,
  listFolders,
  listItemIds,
  readItem,
} from './item';

/**
 * `bench forget --person <name>` or `--meeting <id>`: deletes every item that holds that person or
 * was clipped from that meeting, whoever else is on it, and those items' outputs in every run (the
 * events folder, and the item's entry in run.json, so the run still scores without it). Aggregate
 * reports stay. This is how a colleague's consent is withdrawn (M3 D2); deleting a meeting's audio
 * in the app never reaches the bench copies.
 *
 * Nothing is skipped in silence: an item or a run.json it cannot read is returned as unchecked,
 * because it may still hold the person, and so is a run's folder for an item whose folder is gone.
 */

export type ForgetTarget = { person: string } | { meetingId: string };

export interface ForgetResult {
  /** In item order, each with the runs whose outputs for it were deleted. */
  deleted: { itemId: string; runs: string[] }[];
  /** What could not be read, so may still hold the person or meeting: check it by hand. */
  unchecked: { what: string; reason: string }[];
  /** Everyone named on a readable item before the delete, to spot a mistyped --person. */
  names: string[];
}

export async function forget(benchDir: string, target: ForgetTarget): Promise<ForgetResult> {
  const wanted =
    'person' in target ? foldName(target.person) : target.meetingId.trim().toLowerCase();
  if (wanted === '') throw new Error('forget needs --person <name> or --meeting <id>');
  const holds = (item: ItemRecord): boolean =>
    'person' in target
      ? item.participants.some((person) => foldName(person.name) === wanted)
      : item.meetingId?.toLowerCase() === wanted;

  const result: ForgetResult = { deleted: [], unchecked: [], names: [] };
  const names = new Set<string>();
  const matched: string[] = [];
  const itemIds = await listItemIds(benchDir);
  for (const itemId of itemIds) {
    try {
      const item = await readItem(benchDir, itemId);
      for (const person of item.participants) names.add(person.name);
      if (holds(item)) matched.push(itemId);
    } catch (error) {
      result.unchecked.push({
        what: join(benchDir, 'items', itemId),
        reason: describeItemError(error),
      });
    }
  }
  result.names = [...names].sort((a, b) => a.localeCompare(b));

  // Every run folder, by name: one made by hand or cut short is still searched for the item.
  const runsDir = join(benchDir, 'runs');
  const runs = new Map<string, RunRecord | null>();
  for (const runId of await listFolders(runsDir)) {
    const path = join(runsDir, runId, 'run.json');
    runs.set(runId, null);
    if (!existsSync(path)) continue;
    try {
      runs.set(runId, await readRun(path));
    } catch (error) {
      result.unchecked.push({ what: path, reason: describeItemError(error) });
    }
  }

  for (const itemId of matched) {
    const touched: string[] = [];
    for (const [runId, run] of runs) {
      let held = false;
      const eventsDir = join(runsDir, runId, itemId);
      if (existsSync(eventsDir)) {
        await rm(eventsDir, { recursive: true, force: true });
        held = true;
      }
      if (run?.items.some((entry) => entry.itemId === itemId)) {
        const kept: RunRecord = {
          ...run,
          items: run.items.filter((entry) => entry.itemId !== itemId),
        };
        await writeRun(join(runsDir, runId, 'run.json'), kept);
        runs.set(runId, kept);
        held = true;
      }
      if (held) touched.push(runId);
    }
    // Last: until the item folder goes, a forget cut short finds the item again when re-run.
    await rm(itemPaths(benchDir, itemId).dir, { recursive: true, force: true });
    result.deleted.push({ itemId, runs: touched });
  }

  // Outputs are found through the item that names the person, so a run's folder for an item whose
  // folder was deleted by hand (as clip says to, to clip it again) can no longer say who it holds.
  // It may hold the person: listed, never deleted on a guess, as it may hold only people who
  // agreed. Its run.json entry is not listed: it holds timings and errors, never words.
  const known = new Set(itemIds);
  for (const runId of runs.keys()) {
    for (const itemId of await listFolders(join(runsDir, runId))) {
      if (known.has(itemId)) continue;
      result.unchecked.push({
        what: join(runsDir, runId, itemId),
        reason: `no item ${itemId} in items/ says who it holds`,
      });
    }
  }
  return result;
}

/** Names match ignoring case and extra spaces, never accents: an accented name is its own. */
function foldName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
