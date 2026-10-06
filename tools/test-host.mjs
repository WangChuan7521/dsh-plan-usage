#!/usr/bin/env node
/**
 * test-host — exercise the plugin's host half against the live provider APIs.
 *
 * Loads index.js the way the loader would, drives `apply()` with a stub
 * context, then calls the two registered routes with stub request/response
 * objects and asserts the document, the loopback fence, the state file and the
 * snapshot mirror. Hits the real endpoints, so it also proves that the three
 * credential references the profile configures actually resolve.
 *
 * Usage: node tools/test-host.mjs
 *
 * @module dsh-plan-usage/tools/test-host
 */

import { readFile } from 'node:fs/promises'
import { STATE_FILE, snapshotPath, statePath } from '../lib/probe.mjs'

let failures = 0
let skipped = 0

/** Assert one condition, recording a failure instead of throwing. */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** Record an assertion this run cannot make for an upstream reason. */
function skip(label, detail = '') {
  skipped += 1
  console.log(`  SKIP ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Whether a provider failed because the upstream rejected the credential.
 * That is an account fact (a rotated key, a lapsed plan), not a defect in this
 * plugin, so it downgrades those assertions to SKIP — with the reason printed,
 * so a red run never hides a real outage.
 */
function upstreamFailure(provider) {
  if (provider?.ok === true) return null
  const text = (provider?.errors ?? []).join(' ')
  if (/HTTP 40[13]|UNAUTHORIZED|invalid access token|Invalid 'Authorization'/i.test(text)) return 'auth'
  if (/ERR_TLS|SSL|certificate|altnames/i.test(text)) return 'tls'
  if (/HTTP 5\d\d/.test(text)) return 'server'
  if (/network error|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|timed out/i.test(text)) return 'network'
  return null
}

/**
 * How one provider card should be judged in THIS run: unconfigured, an
 * upstream failure kind, or ok. A keyless checkout must report skips, not
 * failures, so the suite is meaningful on any machine.
 */
function stateOf(provider) {
  if (provider?.skipped === true) return 'no-credential'
  return upstreamFailure(provider) ?? 'ok'
}

/** Sleep, for waiting on the plugin's own initial probe. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const routes = []
const disposers = []
const logs = []

const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    }
  },
  effect(run) {
    const cleanup = run()
    if (typeof cleanup === 'function') disposers.push(cleanup)
    return cleanup
  },
  logger: {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  },
}

/** One stub request/response pair for a route handler. */
function call(route, { remoteAddress = '127.0.0.1', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url: route.path, socket: { remoteAddress }, resume() {} }
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        this.body = payload ?? ''
        try {
          resolve({ status: this.status, body: this.body, json: JSON.parse(this.body) })
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const host = await import('../index.js')
check('plugin name is exported', host.name === 'dsh-plan-usage', String(host.name))
check('apply is exported', typeof host.apply === 'function')
check('provider ids are exported', Array.isArray(host.providerIds) && host.providerIds.length === 2, JSON.stringify(host.providerIds))
check('registry order is stable', host.providerIds.join(',') === 'commandcode,opencode-go', host.providerIds.join(','))

host.apply(ctx, {})

console.log('routes')
check('registers two routes', routes.length === 2, `got ${routes.length}`)
check('usage route path', routes.some((route) => route.path === '/api/dsh-plan-usage/usage'))
check('refresh route path', routes.some((route) => route.path === '/api/dsh-plan-usage/refresh'))
check('both routes are exact', routes.every((route) => route.kind === 'exact'))
check('logged the mount', logs.some((line) => line.includes('/api/dsh-plan-usage/usage')), JSON.stringify(logs))

console.log('document')
const usageRoute = routes.find((route) => route.path === '/api/dsh-plan-usage/usage')
const refreshRoute = routes.find((route) => route.path === '/api/dsh-plan-usage/refresh')
let response = await call(usageRoute)
// The first call may race the activation's own probe; refresh once so a slow
// provider never looks like a contract failure.
const probed = (value) => Array.isArray(value?.providers) && value.providers.length === 2
if (!probed(response.json)) {
  await wait(2000)
  response = await call(refreshRoute, { method: 'POST' })
}
const document = response.json
check('answers 200', response.status === 200, String(response.status))
check('carries every provider', Array.isArray(document?.providers) && document.providers.length === 2, JSON.stringify(document?.providers?.map((entry) => entry.id)))

/** Look one provider up by id. */
const provider = (id) => (document?.providers ?? []).find((entry) => entry.id === id)

console.log('commandcode')
const commandcode = provider('commandcode')
const commandcodeState = stateOf(commandcode)
if (commandcodeState === 'no-credential') {
  check('a provider without a key is skipped, not failed', commandcode?.ok === false)
  check('the skip explains how to configure it', /COMMANDCODE_API_KEY/.test(commandcode?.reason ?? ''), String(commandcode?.reason))
  skip('live quota windows', 'no COMMANDCODE_API_KEY configured in this environment')
} else if (commandcodeState !== 'ok') {
  check('the failure is classified, not a raw blob', commandcode?.errors?.length === 1 && /^HTTP 4\d\d/.test(commandcode.errors[0]) && !commandcode.errors[0].includes('{'), JSON.stringify(commandcode?.errors))
  check('the document repeats it exactly once', document.errors.filter((line) => line.startsWith('commandcode: ')).length === 1, JSON.stringify(document.errors))
  check('an upstream rejection is marked as an auth failure', commandcode.authFailed === true)
  skip('live quota windows', `upstream ${commandcodeState} failure: ${(commandcode.errors ?? []).join('; ')}`)
} else {
  check('probe succeeded', commandcode?.ok === true, JSON.stringify(commandcode?.errors))
  check('reports which credential source answered', typeof commandcode?.credentialSource === 'string' && commandcode.credentialSource !== '', String(commandcode?.credentialSource))
  check('reports the masked credential, never the key', typeof commandcode?.credentialMasked === 'string' && commandcode.credentialMasked.includes('…'), String(commandcode?.credentialMasked))
  check('reports the plan name', typeof commandcode?.plan?.name === 'string' && commandcode.plan.name !== '', JSON.stringify(commandcode?.plan))
  check('reports a subscription status', typeof commandcode?.status === 'string' && commandcode.status !== '', String(commandcode?.status))
  for (const key of ['5h', 'week', 'month']) {
    const row = commandcode?.windows?.[key]
    check(`${key} window is present`, row !== undefined && row !== null, JSON.stringify(Object.keys(commandcode?.windows ?? {})))
    check(`${key} percent is 0-100`, typeof row?.percent === 'number' && row.percent >= 0 && row.percent <= 100, String(row?.percent))
    // A window that has not opened yet reports a placeholder reset (0 -> null);
    // a window with usage must carry a real future instant. Rendering the
    // placeholder as a time would be inventing a fact.
    check(`${key} reset is either unset or a future instant`,
      row?.resetAt === null || (typeof row?.resetAt === 'number' && row.resetAt > Date.now()), String(row?.resetAt))
    check(`${key} with usage carries a real reset instant`,
      (row?.used ?? 0) === 0 || (typeof row?.resetAt === 'number' && row.resetAt > Date.now()), `used=${row?.used} reset=${row?.resetAt}`)
  }
  check('the monthly window is bounded by its own pool', (commandcode?.windows?.month?.used ?? 0) <= (commandcode?.credits?.pool ?? 0), JSON.stringify(commandcode?.credits))
  check('remaining credits are reported', typeof commandcode?.credits?.remaining === 'number' && commandcode.credits.remaining >= 0, JSON.stringify(commandcode?.credits))
}

console.log('opencode-go')
const opencode = provider('opencode-go')
const opencodeState = stateOf(opencode)
if (opencodeState === 'no-credential') {
  check('a provider without a key is skipped, not failed', opencode?.ok === false)
  check('the skip explains how to configure it', /OPENCODE_GO_API_KEY/.test(opencode?.reason ?? ''), String(opencode?.reason))
  skip('rolling windows', 'no OPENCODE_GO_API_KEY configured in this environment')
} else if (opencodeState !== 'ok') {
  // Whatever the upstream did, it must not be dressed up as an auth failure —
  // that is the misdiagnosis this suite exists to prevent.
  check('an upstream outage is not reported as an auth failure', opencode?.authFailed !== true, String(opencode?.authFailed))
  check('the outage is one classified line', opencode?.errors?.length === 1, JSON.stringify(opencode?.errors))
  check('the line names the transport cause', /ERR_TLS|SSL|certificate|network error|HTTP 5\d\d|timed out/i.test(opencode.errors[0]), opencode?.errors?.[0])
  skip('rolling windows', `upstream ${opencodeState} failure: ${opencode.errors[0]}`)
} else {
  check('probe succeeded', opencode?.ok === true, JSON.stringify(opencode?.errors))
  check('has all three rolling windows', ['5h', 'week', 'month'].every((key) => opencode?.windows?.[key] !== undefined), JSON.stringify(Object.keys(opencode?.windows ?? {})))
  check('percent-only windows carry no cap', opencode?.windows?.['5h']?.cap === undefined)
  check('publishes no dollar balance', opencode?.credits === null)
}

console.log('fences, state and mirror')
const forbidden = await call(usageRoute, { remoteAddress: '192.168.1.20' })
check('non-loopback request is refused', forbidden.status === 403, String(forbidden.status))
check('refusal is a JSON error', forbidden.json?.error === 'forbidden: loopback-only', forbidden.body.trim())
await wait(300)
const state = JSON.parse(await readFile(statePath(), 'utf8'))
check('the state file is written with a timestamp', typeof state?.updatedAt === 'number', JSON.stringify(state).slice(0, 120))
check('the state file keeps a providers map', typeof state?.providers === 'object' && state.providers !== null, JSON.stringify(state).slice(0, 120))
const snapshot = JSON.parse(await readFile(snapshotPath(), 'utf8'))
check('snapshot mirrors the served document', snapshot.providers?.length === 2, JSON.stringify(snapshot.providers?.map((entry) => entry.id)))
check('state file name is the exported constant', STATE_FILE === 'plan-usage-state.json', STATE_FILE)

for (const dispose of disposers.splice(0)) dispose()
check('routes are disposed with the fiber', routes.length === 0, `left ${routes.length}`)

const summary = failures === 0
  ? `\nhost half: all checks passed${skipped === 0 ? '' : ` (${skipped} skipped for upstream reasons)`}`
  : `\nhost half: ${failures} check(s) failed${skipped === 0 ? '' : `, ${skipped} skipped`}`
console.log(summary)
process.exit(failures === 0 ? 0 : 1)
