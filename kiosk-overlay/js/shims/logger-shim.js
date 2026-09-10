/**
 * Lightweight logger shim for kiosk bundle.
 * Replaces the main app's heavyweight logger (localStorage buffering, etc.)
 * with simple console forwarding.
 *
 * ⚠️ THIS IS THE SECOND SITE OF THE `[object Object]` DEFECT (board row 172), and the
 * one that matters most: kiosk/offline mode is the HA surface, where getting at a
 * device log is hardest. Android's `onConsoleMessage` receives a single flattened
 * string, so `console.info(prefix, msg, {…})` reached logcat as `… [object Object]`
 * and every detail was lost.
 *
 * The decision is SHARED with `js/utils/logger.js` rather than re-implemented here —
 * a second copy of "how do we render a detail" is exactly the hand-mirror the seam
 * rule forbids. `log-detail.js` is deliberately import-free so this shim can use it
 * without pulling in the heavyweight logger this file exists to avoid.
 */
import { flattensConsoleArgs, formatDetailTail } from '../../../js/utils/log-detail.js';

/**
 * Fold a trailing detail object into the message string, but only where the runtime
 * would otherwise flatten it away. On every other runtime the args pass through
 * untouched, so a browser console keeps its expandable object.
 */
function foldDetail(prefix, args) {
  if (args.length > 1 && flattensConsoleArgs()) {
    const detail = args[args.length - 1];
    const tail = formatDetailTail(detail);
    if (tail) return [prefix, ...args.slice(0, -1).map(String), tail.trimStart()];
  }
  return [prefix, ...args];
}

export function createLogger(name) {
  const prefix = `[${name}]`;
  return {
    debug: (...args) => console.debug(...foldDetail(prefix, args)),
    info: (...args) => console.info(...foldDetail(prefix, args)),
    warn: (...args) => console.warn(...foldDetail(prefix, args)),
    error: (...args) => console.error(...foldDetail(prefix, args)),
    verbose: () => {},
    success: (...args) => console.log(...foldDetail(prefix, args)),
  };
}
