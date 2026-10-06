/**
 * dsh-plan-usage — coding-plan quota for every provider this DSH profile
 * talks to, on one page.
 *
 * Host half. Polls each configured provider's own usage endpoint with the API
 * key the profile already stores for that model route, and publishes one
 * document:
 *
 *   - CommandCode   5-hour / weekly / monthly windows ($ caps + credit pool)
 *   - OpenCode Go   rolling 5-hour / weekly / monthly windows (percent)
 *
 * The browser half never sees a key: every probe runs here, the document is
 * mirrored into `$DSH_HOME/plan-usage.json` (day baselines in
 * `$DSH_HOME/plan-usage-state.json`), and the Web GUI reads it from the
 * loopback-only routes:
 *
 *   GET  /api/dsh-plan-usage/usage     the latest document
 *   POST /api/dsh-plan-usage/refresh   force a probe cycle, then answer it
 *
 * @module dsh-plan-usage
 */

import {
  PROVIDERS,
  STATE_FILE,
  loadState,
  probeAll,
  snapshotPath,
  writeJsonAtomic,
} from './lib/probe.mjs'

import { dirname, join } from 'node:path'

/** Poll bounds, in seconds. */
const DEFAULT_POLL_SEC = 60
const MIN_POLL_SEC = 15
const MAX_POLL_SEC = 3600

/**
 * Read one config field that the Host may hand over as a live reference
 * (`volatile()` output) or as a plain value (profile patch).
 * @param field - the configured field.
 * @param fallback - value used when absent or unusable.
 */
function readConfigField(field, fallback) {
  const raw = typeof field === 'object' && field !== null && typeof field.get === 'function' ? field.get() : field
  return raw === undefined || raw === null || raw === '' ? fallback : raw
}

/** Whether a request arrived over the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Send one JSON response. */
function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export const name = 'dsh-plan-usage'

/** The provider ids this row reports, for a caller that wants to know early. */
export const providerIds = PROVIDERS.map((provider) => provider.id)

/**
 * Host body: probe on a poll cycle, mirror to disk, serve over loopback HTTP.
 * @param ctx - host context.
 * @param config - this row's configuration.
 */
export function apply(ctx, config) {
  const pollSec = Math.max(
    MIN_POLL_SEC,
    Math.min(MAX_POLL_SEC, Number(readConfigField(config?.pollIntervalSec, DEFAULT_POLL_SEC)) || DEFAULT_POLL_SEC),
  )
  const providersConfig = readConfigField(config?.providers, {}) ?? {}
  const snapshot = snapshotPath()
  const stateFile = join(dirname(snapshot), STATE_FILE)

  /** Last document, served while a probe is in flight or failing. */
  let latest = null
  /** In-flight probe, so overlapping cycles share one round trip. */
  let inFlight = null
  let timer = null
  const disposers = []

  /** Run one probe cycle: load state, probe every provider, persist both files. */
  const probe = () => {
    if (inFlight !== null) return inFlight
    const run = (async () => {
      try {
        const state = await loadState(stateFile)
        const result = await probeAll({ ctx, config: providersConfig, state })
        latest = result.document
        await writeJsonAtomic(snapshot, latest).catch(() => {})
        await writeJsonAtomic(stateFile, result.state).catch(() => {})
      } catch (error) {
        ctx.logger?.warn?.(`dsh-plan-usage: probe failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return latest
    })()
    inFlight = run
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  }

  /** The current document, probing first when nothing has been read yet. */
  const current = async () => latest ?? (await probe())

  /** Register the HTTP routes once the web server exists. */
  const registerRoutes = () => {
    let webServer
    try {
      webServer = ctx.get('webServer')
    } catch {
      webServer = undefined
    }
    if (webServer === undefined || typeof webServer.register !== 'function') return false
    const guard = (req, res) => {
      if (!isLoopback(req)) {
        req.resume()
        sendJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return false
      }
      return true
    }
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/dsh-plan-usage/usage',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        req.resume()
        sendJson(res, 200, await current())
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/dsh-plan-usage/refresh',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        req.resume()
        sendJson(res, 200, await probe())
      },
    }))
    ctx.logger?.info?.(
      `dsh-plan-usage: serving ${PROVIDERS.map((provider) => provider.id).join(', ')} on /api/dsh-plan-usage/usage`,
    )
    return true
  }

  ctx.effect(() => {
    // The web server may mount after this row (or never, in a headless boot):
    // probe regardless, and pick the route up on a later cycle.
    registerRoutes()
    void probe()
    timer = setInterval(() => {
      if (disposers.length === 0) registerRoutes()
      void probe()
    }, pollSec * 1000)
    timer.unref?.()
    return () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // The route fiber is already gone during shutdown.
        }
      }
    }
  }, 'dsh-plan-usage: probe loop')
}
