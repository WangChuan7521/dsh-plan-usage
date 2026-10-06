/**
 * CommandCode (commandcode.ai) plan usage.
 *
 * Three endpoints, all read with `Authorization: Bearer <key>`:
 *   GET /alpha/billing/credits          remaining monthly/purchased/free credits
 *                                       plus the live 5h and weekly window rows
 *   GET /alpha/billing/subscriptions    planId, status, current period start/end
 *   GET /alpha/usage/summary?since=…    requests, tokens and cost for the period
 *
 * The monthly window is the billing period's credit pool minus what is left;
 * the pool is the plan tier's published figure (GOAT 70, Go 10, Pro 80 …),
 * widened to whatever the API reports when that is larger.
 *
 * Failure shape: the three calls are independent, so their errors are collected
 * as classified `errorDetails` and collapsed to distinct sentences upstream. A
 * 401 from all three is ONE line, and it is marked `authFailed` so the UI can
 * say "the token was rejected" instead of printing the same JSON blob thrice.
 *
 * @module dsh-plan-usage/lib/providers/commandcode
 */

import { clampPercent, num, round, toEpochMs } from '../format.mjs'

/** Plan catalogue, longest planId prefix first (`individual-goat` beats `individual-go`). */
export const PLANS = [
  ['individual-goat', 'GOAT', 70],
  ['individual-pro-v1', 'Pro', 80],
  ['individual-provider', 'Provider', 15],
  ['individual-ultra', 'Ultra', 300],
  ['individual-max', 'Max', 150],
  ['individual-go-v1', 'Go', 10],
  ['individual-go', 'Go', 10],
  ['individual-pro', 'Pro', 30],
  ['teams-pro', 'Teams Pro', 40],
].sort((left, right) => right[0].length - left[0].length)

/** Resolve the plan row a planId names, or null. */
export function planFor(planId) {
  if (typeof planId !== 'string' || planId === '') return null
  const normalized = planId.toLowerCase().replaceAll('_', '-')
  const match = PLANS.find(([prefix]) => normalized.startsWith(prefix))
  return match === undefined ? null : { id: planId, name: match[1], monthlyCredits: match[2] }
}

/** One window row from the API's `{used, cap, resetAt, exceeded}`. */
function windowRow(row) {
  const cap = num(row?.cap)
  if (cap === undefined) return undefined
  const used = Math.max(0, num(row?.used) ?? 0)
  return {
    used: round(used),
    cap,
    percent: cap > 0 ? clampPercent((used / cap) * 100) : 0,
    resetAt: toEpochMs(row?.resetAt),
    exceeded: row?.exceeded === true,
  }
}

/**
 * The distinct sentences among the classified failures. Three endpoints
 * answering the same 401 is one fact about the credential, so it is one line —
 * the adapter guarantees this itself rather than relying on its caller.
 */
function uniqueMessages(details) {
  const seen = new Set()
  const out = []
  for (const detail of details) {
    const text = typeof detail.message === 'string' ? detail.message.trim() : ''
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** The document fields for a probe where every endpoint failed. */
function failure(details) {
  return {
    ok: false,
    errorDetails: details,
    authFailed: details.some((detail) => detail.kind === 'auth'),
    status: null,
    plan: null,
    period: { start: null, end: null },
    windows: {},
    credits: null,
    usage: null,
    limited: false,
    errors: uniqueMessages(details),
  }
}

export const commandcode = {
  id: 'commandcode',
  displayName: 'CommandCode',
  apiKeyEnv: 'COMMANDCODE_API_KEY',
  baseUrl: 'https://api.commandcode.ai',

  /**
   * Probe the account API.
   * @param options - `{ apiKey, baseUrl, request }`.
   * @returns the provider's view fields.
   */
  async probe({ apiKey, baseUrl, request }) {
    /** One call that records a classified failure instead of throwing. */
    const attempt = async (url) => {
      try {
        return { body: await request(url, apiKey), error: null }
      } catch (error) {
        return {
          body: null,
          error: {
            kind: typeof error?.kind === 'string' ? error.kind : 'network',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }

    const subscription = await attempt(`${baseUrl}/alpha/billing/subscriptions`)
    const credits = await attempt(`${baseUrl}/alpha/billing/credits`)
    const details = [subscription.error, credits.error].filter((error) => error !== null)

    if (subscription.body === null && credits.body === null) return failure(details)

    const periodStart = subscription.body?.data?.currentPeriodStart ?? null
    const summary = periodStart === null
      ? { body: null, error: null }
      : await attempt(`${baseUrl}/alpha/usage/summary?since=${encodeURIComponent(periodStart)}`)
    if (summary.error !== null) details.push(summary.error)

    const subscriptionData = subscription.body?.data ?? null
    const creditsBody = credits.body ?? null
    const plan = planFor(subscriptionData?.planId)
    // Two facts gate the monthly window, and each comes from a different call:
    // the remaining balance (credits) and the plan's pool (subscriptions). When
    // either is missing the window is NOT computable, and a window rendered from
    // the half we happen to have would be an invented number — a failed
    // subscriptions call would otherwise show "月 0% / $59.21" as if the plan had
    // a $59.21 pool. The failure line states what is missing instead.
    const haveCredits = creditsBody !== null
    const havePlan = plan !== null
    const remainingMonthly = Math.max(0, num(creditsBody?.credits?.monthlyCredits) ?? 0)
    const remainingPurchased = Math.max(0, num(creditsBody?.credits?.purchasedCredits) ?? 0)
    const remainingFree = Math.max(0, num(creditsBody?.credits?.freeCredits) ?? 0)
    const remaining = remainingMonthly + remainingPurchased + remainingFree
    const pool = havePlan
      ? Math.max(plan.monthlyCredits, remainingMonthly) + remainingPurchased + remainingFree
      : null
    const spent = pool === null ? null : Math.max(0, pool - remaining)
    const periodEnd = toEpochMs(subscriptionData?.currentPeriodEnd)
    const summaryBody = summary.body

    return {
      ok: details.length === 0,
      errorDetails: details,
      authFailed: details.some((detail) => detail.kind === 'auth'),
      status: subscriptionData?.status ?? null,
      plan: plan ?? (subscriptionData === null
        ? null
        : { id: subscriptionData.planId ?? null, name: null, monthlyCredits: null }),
      period: {
        start: subscriptionData?.currentPeriodStart ?? null,
        end: subscriptionData?.currentPeriodEnd ?? null,
      },
      windows: haveCredits
        ? {
            '5h': windowRow(creditsBody?.windowLimits?.fiveHour),
            week: windowRow(creditsBody?.windowLimits?.weekly),
            month: pool !== null && pool > 0 && spent !== null
              ? {
                  used: round(spent),
                  cap: pool,
                  percent: clampPercent((spent / pool) * 100),
                  resetAt: periodEnd,
                  exceeded: false,
                }
              : undefined,
          }
        : {},
      credits: haveCredits
        ? {
            currency: 'USD',
            remaining: round(remaining),
            // `used` and `pool` describe the plan's pool, so they are reported
            // only when the plan is known; `remaining` is a fact either way.
            used: spent === null ? null : round(spent),
            pool,
            // The monthly figure is a balance, not a lifetime counter: it can go up.
            cumulative: false,
          }
        : null,
      usage: summaryBody === null
        ? null
        : {
            requests: num(summaryBody.totalCount) ?? null,
            failed: num(summaryBody.failedCount) ?? null,
            cost: num(summaryBody.totalCost) ?? null,
            tokensIn: num(summaryBody.totalTokensIn) ?? null,
            tokensOut: num(summaryBody.totalTokensOut) ?? null,
            periodBasis: typeof summaryBody.periodBasis === 'string' ? summaryBody.periodBasis : null,
          },
      limited: creditsBody?.windowLimits?.limited === true,
      errors: uniqueMessages(details),
    }
  },
}
