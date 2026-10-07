/**
 * The one clock the renderer writes: 12-hour, lowercase, no leading zero ("9:14 am"). The rule and
 * its traps live in `shared/clock.ts`, which main uses too (stop notices, tray, default title).
 * It takes the optional IANA `timeZone` calendarFormat's zone-pinned tests pass.
 */
export { formatClock } from '../../shared/clock';
