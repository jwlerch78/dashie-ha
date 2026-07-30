/**
 * Current date/time tool — ground truth for "what time/day/date is it" and for anchoring
 * any today/tomorrow/this-week reasoning.
 *
 * Why a tool: Gemini Live trusts its own internal clock (UTC) over the system prompt, so
 * it answered "Sunday, June 28" at 11:55 PM Eastern on June 27 (the UTC date) and a wrong
 * time. The model reads TOOL output reliably, so returning the exact local values here —
 * computed in the user's timezone — fixes it. No network, no card.
 */

import type { ToolContext, ToolDef, ToolResult } from './types.ts';

export const currentTimeTool: ToolDef = {
  name: 'get_current_time',
  description:
    'Get the CURRENT local date, time, and day of week for the user. Call this for any ' +
    'question about the current time, date, or day ("what time is it", "what\'s today\'s ' +
    'date", "what day is it"), and to anchor any today/tomorrow/this-week/next reasoning. ' +
    'It is authoritative — use it instead of your own internal clock, which is UTC and ' +
    'wrong for the user. Read the date/time back in the user\'s local zone; never say UTC.',
  parameters: { type: 'object', properties: {} },
  // deno-lint-ignore require-await
  async execute(_args, ctx: ToolContext): Promise<ToolResult> {
    const tz = ctx.timezone || 'UTC';
    const now = new Date();
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(now);
    const day = fmt({ weekday: 'long' });
    const date = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const time = fmt({ hour: 'numeric', minute: '2-digit' });
    return {
      result: {
        found: true,
        day,                       // "Saturday"
        date,                      // "Saturday, June 27, 2026"
        time,                      // "11:55 PM"
        timezone: tz,              // "America/New_York"
        spoken: `${date}, ${time}`,// ready-to-read: "Saturday, June 27, 2026, 11:55 PM"
      },
    };
  },
};
