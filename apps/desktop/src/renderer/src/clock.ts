/**
 * The one clock the renderer writes: 12-hour, lowercase, no leading zero ("9:14 am"). The rule and
 * its traps live in `shared/clock.ts`, which main uses too (stop notices, tray, default title).
 */
export { formatClock } from '../../shared/clock';
