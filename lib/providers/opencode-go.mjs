/**
 * OpenCode Go (opencode.ai/zen/go) coding-plan usage.
 *
 * One endpoint answers everything:
 *   GET /v1/usage  →  { usage: { rolling, weekly, monthly } }
 *
 * Each window carries `status`, a whole-number `percent` already used and the
 * instant it resets — the plan publishes no dollar figures, so these three
 * rows are percent-only by construction. `rolling` is the 5-hour window;
 * `weekly` and `monthly` are the weekly and billing windows.
 *
 * A window reports `percent: 0` with a placeholder `resetsAt` (now + window)
 * before its first request, so a zero window's reset instant is dropped
 * rather than rendered as fact.
 *
 * @module dsh-plan-usage/lib/providers/opencode-go
 */

import { clampPercent, num, round, str, toEpochMs } from '../format.mjs'

/** The API's window field → this plugin's window key. */
const WINDOWS = [
  ['rolling', '5h'],
  ['weekly', 'week'],
  ['monthly', 'month'],
]

export const opencodeGo = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  baseUrl: 'https://opencode.ai/zen/go',

  /**
   * Probe the plan usage endpoint.
   * @param options - `{ apiKey, baseUrl, request }`.
   * @returns the provider's view fields.
   */
  async probe({ apiKey, baseUrl, request }) {
    try {
      const body = await request(`${baseUrl}/v1/usage`, apiKey)
      const usage = body?.usage
      if (usage === undefined || usage === null || typeof usage !== 'object') {
        return { ok: false, errors: ['usage object missing from the response'], windows: {}, credits: null, usage: null, status: null, plan: null }
      }
      const windows = {}
      for (const [field, key] of WINDOWS) {
        const row = usage[field]
        if (row === undefined || row === null || typeof row !== 'object') continue
        const percent = num(row.percent)
        if (percent === undefined) continue
        windows[key] = {
          percent: clampPercent(percent),
          // Round percent-only rows still report a placeholder reset instant.
          resetAt: percent === 0 ? null : toEpochMs(row.resetsAt),
          status: str(row.status) ?? null,
        }
      }
      const limited = WINDOWS.some(([, key]) => windows[key]?.percent >= 100)
      return {
        ok: true,
        errorDetails: [],
        authFailed: false,
        status: str(usage.rolling?.status) ?? null,
        plan: null,
        period: { start: null, end: null },
        windows,
        credits: null,
        usage: null,
        limited,
        errors: [],
      }
    } catch (error) {
      return {
        ok: false,
        errorDetails: [{ kind: typeof error?.kind === 'string' ? error.kind : 'network' }],
        authFailed: error?.kind === 'auth',
        windows: {},
        credits: null,
        usage: null,
        status: null,
        plan: null,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  },
}

/** Exported for the CLI's table: window order and their human labels. */
export const OPENCODE_WINDOW_ORDER = WINDOWS.map(([, key]) => key)

/** Rounding helper re-exported so a caller can shape raw numbers consistently. */
export { round }
