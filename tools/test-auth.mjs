#!/usr/bin/env node
/**
 * test-auth — the authentication and error-handling contract, offline.
 *
 * Every request is served by a stub `fetch`, so this suite runs with no key,
 * no network and no provider account. It pins the five behaviours an auth bug
 * would break, plus the credential chain and the de-duplication the UI depends
 * on:
 *
 *   1. a resolved key leaves as exactly one `Authorization: Bearer <key>`
 *   2. no credential → no request at all, and a clear reason
 *   3. a wrong token → the 401 is classified `auth` and propagates verbatim
 *   4. a stored `Bearer …` prefix can never become `Bearer Bearer …`
 *   5. HTTP 401 becomes ONE error line on ONE card, never a repeated blob
 *
 * Usage: node tools/test-auth.mjs
 *
 * @module dsh-plan-usage/tools/test-auth
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError, classifyStatus, getJson, maskSecret, normalizeApiKey, parseErrorBody } from '../lib/http.mjs'
import { credentialRefsFromFile, resolveCredential } from '../lib/credentials.mjs'
import { commandcode } from '../lib/providers/commandcode.mjs'
import { probeAll } from '../lib/probe.mjs'

let failures = 0
let checked = 0

/** Assert one condition, recording a failure instead of throwing. */
function check(label, condition, detail = '') {
  checked += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const SECRET = 'user_TEST-ONLY-not-a-real-key-0123456789'

/** Install a stub `fetch` that records every request and answers from `responder`. */
const calls = []
function stubFetch(responder) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, method: init?.method ?? 'GET' })
    const reply = await responder(url, init)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async text() { return reply.body ?? '' },
      async json() {
        if (reply.json === undefined) throw new Error('not json')
        return reply.json
      },
    }
  }
}

/** The single Authorization header a call carried, or undefined. */
function authHeaderOf(call) {
  const entries = Object.entries(call.headers)
  const matches = entries.filter(([name]) => name.toLowerCase() === 'authorization')
  return matches.length === 0 ? undefined : matches[0][1]
}

console.log('header construction')
stubFetch(() => ({ status: 200, json: { ok: true } }))
await getJson('https://example.test/v1/thing', SECRET)
check('exactly one request was made', calls.length === 1, `got ${calls.length}`)
const authEntries = Object.entries(calls[0].headers).filter(([name]) => name.toLowerCase() === 'authorization')
check('exactly one Authorization header exists', authEntries.length === 1, JSON.stringify(calls[0].headers))
check('it is exactly "Bearer <key>"', authHeaderOf(calls[0]) === `Bearer ${SECRET}`, authHeaderOf(calls[0]))
check('no doubled Bearer', !/Bearer\s+Bearer/i.test(authHeaderOf(calls[0]) ?? ''))
check('the key is never duplicated elsewhere in the headers', !JSON.stringify(calls[0].headers).includes(`Bearer ${SECRET} ${SECRET}`))

console.log('key normalization')
check('a bare key is unchanged', normalizeApiKey(SECRET) === SECRET)
check('a "Bearer " prefix is stripped', normalizeApiKey(`Bearer ${SECRET}`) === SECRET)
check('a lowercase "bearer " prefix is stripped', normalizeApiKey(`bearer ${SECRET}`) === SECRET)
check('surrounding whitespace is trimmed', normalizeApiKey(`  ${SECRET}\n`) === SECRET)
stubFetch(() => ({ status: 200, json: {} }))
await getJson('https://example.test/v1/thing', `Bearer ${SECRET}`)
check('a prefixed stored key still yields one Bearer', authHeaderOf(calls[0]) === `Bearer ${SECRET}`, authHeaderOf(calls[0]))
check('double-Bearer is impossible after normalization', !/Bearer\s+Bearer/i.test(authHeaderOf(calls[0]) ?? ''))

console.log('masking')
const masked = maskSecret(SECRET)
check('the mask hides the middle', masked.includes('…') && !masked.includes(SECRET.slice(12, 40)), masked)
check('the mask reports the length', masked.includes(`(${SECRET.length})`), masked)
check('a short key reveals nothing but its length', maskSecret('abc123') === 'ab…(6)', maskSecret('abc123'))
check('null for an empty value', maskSecret('   ') === null)
for (const length of [8, 11, 12, 15, 16, 20, 40, 92]) {
  const probeKey = 'k'.repeat(length - 4) + 'tail'
  const maskedKey = maskSecret(probeKey)
  const revealed = maskedKey.replace(/….*$/, '').length + (/…(\d+)\)$/.test(maskedKey) ? 0 : 0)
  check(`a ${length}-char key is never revealed in full`, maskedKey.length < length || revealed < length, maskedKey)
}

console.log('missing credential')
calls.length = 0
let missing = null
try {
  await getJson('https://example.test/v1/thing', '')
} catch (error) {
  missing = error
}
check('an empty key throws', missing instanceof HttpError, String(missing))
check('it is classified no-credential', missing?.kind === 'no-credential', String(missing?.kind))
check('no request was made at all', calls.length === 0, `got ${calls.length}`)
let undefinedKey = null
try {
  await getJson('https://example.test/v1/thing', undefined)
} catch (error) {
  undefinedKey = error
}
check('an undefined key throws the same way', undefinedKey?.kind === 'no-credential', String(undefinedKey?.kind))

console.log('401 propagation')
const COMMANDCODE_401 = JSON.stringify({
  success: false,
  error: { code: 'UNAUTHORIZED', status: 401, message: "Invalid 'Authorization' header or token.", docs: 'https://commandcode.ai/docs/reference/errors/unauthorized' },
})
stubFetch(() => ({ status: 401, body: COMMANDCODE_401 }))
let rejected = null
try {
  await getJson('https://api.commandcode.ai/alpha/billing/credits', SECRET)
} catch (error) {
  rejected = error
}
check('a 401 throws an HttpError', rejected instanceof HttpError, String(rejected))
check('status is preserved', rejected?.status === 401, String(rejected?.status))
check('the provider code is preserved', rejected?.code === 'UNAUTHORIZED', String(rejected?.code))
check('it is classified auth', rejected?.kind === 'auth', String(rejected?.kind))
check('auth is not retryable', rejected?.retryable === false)
check('the message carries status, code and sentence', rejected?.message === "HTTP 401 UNAUTHORIZED: Invalid 'Authorization' header or token.", String(rejected?.message))
check('the message is not a raw JSON blob', !rejected.message.includes('{'), rejected.message)
check('the message never contains the key', !rejected.message.includes(SECRET))

console.log('body parsing and classification')
check('CommandCode envelope', parseErrorBody(COMMANDCODE_401).code === 'UNAUTHORIZED', JSON.stringify(parseErrorBody(COMMANDCODE_401)))
check('OpenAI/New API envelope', parseErrorBody('{"error":{"message":"bad key","type":"authentication_error"}}').message === 'bad key')
check('plain text body', parseErrorBody('upstream exploded').message === 'upstream exploded')
check('HTML body is collapsed', parseErrorBody('<html>\n  <body>nope</body>\n</html>').message === '<html> <body>nope</body> </html>')
check('empty body parses to nothing', Object.keys(parseErrorBody('')).length === 0)
check('401 → auth', classifyStatus(401) === 'auth')
check('403 → auth', classifyStatus(403) === 'auth')
check('UNAUTHORIZED code → auth even on 400', classifyStatus(400, 'UNAUTHORIZED') === 'auth')
check('402 → quota', classifyStatus(402) === 'quota')
check('429 → rate-limit', classifyStatus(429) === 'rate-limit')
check('404 → not-found', classifyStatus(404) === 'not-found')
check('503 → server', classifyStatus(503) === 'server')
check('418 → client', classifyStatus(418) === 'client')

console.log('transport failures')
globalThis.fetch = async () => {
  const error = new Error('getaddrinfo ENOTFOUND')
  error.name = 'TypeError'
  throw error
}
let network = null
try {
  await getJson('https://api.commandcode.ai/alpha/billing/credits', SECRET)
} catch (error) {
  network = error
}
check('a transport error becomes HttpError', network instanceof HttpError)
check('it is classified network', network?.kind === 'network', String(network?.kind))
check('network is retryable', network?.retryable === true)
globalThis.fetch = async () => {
  const error = new Error('timed out')
  error.name = 'TimeoutError'
  throw error
}
let timedOut = null
try {
  await getJson('https://api.commandcode.ai/alpha/billing/credits', SECRET)
} catch (error) {
  timedOut = error
}
check('a timeout is classified timeout', timedOut?.kind === 'timeout', String(timedOut?.kind))

// The reason a person can act on lives on `cause`: Node's fetch says only
// "fetch failed", so the deepest cause must reach the message.
globalThis.fetch = async () => {
  const root = new Error("Hostname/IP does not match certificate's altnames: Cert does not contain a DNS name")
  root.code = 'ERR_TLS_CERT_ALTNAME_INVALID'
  const middle = new TypeError('fetch failed')
  middle.cause = root
  throw middle
}
let tlsError = null
try {
  await getJson('https://opencode.ai/zen/go/v1/usage', SECRET)
} catch (error) {
  tlsError = error
}
check('a certificate failure is classified tls', tlsError?.kind === 'tls', String(tlsError?.kind))
check('the message names the TLS code, not "fetch failed"', tlsError?.message.includes('ERR_TLS_CERT_ALTNAME_INVALID'), String(tlsError?.message))
check('the message keeps the upstream sentence', tlsError?.message.includes('does not contain a DNS name'), String(tlsError?.message))
check('a TLS failure is retryable (the upstream fixes it)', tlsError?.retryable === true)
check('the message still never contains the key', !String(tlsError?.message).includes(SECRET))

console.log('credential chain')
const home = await mkdtemp(join(tmpdir(), 'plan-usage-'))
await mkdir(join(home, '.commandcode'), { recursive: true })
const CLI_KEY = 'user_TEST-CLI-FILE-not-a-real-key-0123456789'
await writeFile(join(home, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: `Bearer ${CLI_KEY}`, userName: 'tester' }))
const ENV_KEY = 'user_TEST-ENV-not-a-real-key-0123456789'
const ALIAS_KEY = 'user_TEST-CLI-ENV-not-a-real-key-0123456789'

const fromCliEnv = await resolveCredential({
  providerId: 'commandcode',
  refName: 'COMMANDCODE_API_KEY',
  env: { COMMAND_CODE_API_KEY: ALIAS_KEY },
  home,
})
check('the CLI env var is a source', fromCliEnv?.source === 'cli-env', String(fromCliEnv?.source))
check('its value is normalized', fromCliEnv?.value === ALIAS_KEY)

const fromCliFile = await resolveCredential({
  providerId: 'commandcode',
  refName: 'COMMANDCODE_API_KEY',
  env: {},
  home,
})
check('the CLI login file is a source', fromCliFile?.source === 'cli-auth-file:.commandcode/auth.json', String(fromCliFile?.source))
check('a "Bearer " prefix in the file is stripped', fromCliFile?.value === CLI_KEY, String(fromCliFile?.value?.slice(0, 12)))
check('the source is reported for the UI', typeof fromCliFile?.masked === 'string' && fromCliFile.masked.includes('…'), String(fromCliFile?.masked))

const fromEnv = await resolveCredential({
  providerId: 'commandcode',
  refName: 'COMMANDCODE_API_KEY',
  env: { COMMANDCODE_API_KEY: ENV_KEY, COMMAND_CODE_API_KEY: ALIAS_KEY },
  home,
})
check('the configured reference beats the CLI alias', fromEnv?.source === 'env' && fromEnv.value === ENV_KEY, `${fromEnv?.source}`)

const harnessKey = 'user_TEST-HARNESS-not-a-real-key-0123456789'
const fromRecord = await resolveCredential({
  providerId: 'commandcode',
  refName: 'COMMANDCODE_API_KEY',
  env: { COMMANDCODE_API_KEY: ENV_KEY },
  home,
  ctx: {
    get: (name) => (name === 'credentials'
      ? {
          async readRecord(key) {
            return key === 'llm-pi-ai/commandcode' ? { kind: 'api-key', key: harnessKey } : undefined
          },
          async resolve() { return { value: ENV_KEY } },
        }
      : undefined),
  },
})
check('the harness record is the first source', fromRecord?.source === 'harness-record', String(fromRecord?.source))
check('it wins over the environment', fromRecord?.value === harnessKey)

const noSource = await resolveCredential({ providerId: 'commandcode', refName: 'NOT_SET_ANYWHERE', env: {}, home: join(home, 'empty') })
check('nothing configured resolves to undefined', noSource === undefined, JSON.stringify(noSource))

check('refs parsing ignores records', credentialRefsFromFile('records:\n  a:\n    kind: grant\nrefs:\n  A_KEY: one\n  B_KEY: two\n').A_KEY === 'one')
check('refs parsing stops at the refs block', credentialRefsFromFile('refs:\n  A_KEY: one\nother:\n  C: three\n').C === undefined)

console.log('provider-level 401 handling')
const auth401 = async () => ({ status: 401, body: COMMANDCODE_401 })
stubFetch(auth401)
const result = await commandcode.probe({
  apiKey: SECRET,
  baseUrl: 'https://api.commandcode.ai',
  request: (url, key) => getJson(url, key, { timeoutMs: 1000 }),
})
check('the adapter reports failure', result.ok === false)
check('it sets authFailed', result.authFailed === true)
check('all three endpoints were attempted and collapsed to one line', result.errors.length === 1, JSON.stringify(result.errors))
check('the line is the classified sentence', result.errors[0] === "HTTP 401 UNAUTHORIZED: Invalid 'Authorization' header or token.", result.errors[0])
check('it carries no raw JSON', !result.errors[0].includes('{'))
check('it carries no key', !result.errors[0].includes(SECRET))
check('no windows are invented', Object.keys(result.windows).length === 0)

console.log('partial availability (no invented numbers)')
stubFetch(async (url) => {
  if (url.includes('/alpha/billing/subscriptions')) {
    return {
      status: 200,
      json: {
        success: true,
        data: {
          planId: 'individual-goat',
          status: 'active',
          currentPeriodStart: '2026-09-22T13:13:36.000Z',
          currentPeriodEnd: '2026-10-22T13:13:36.000Z',
        },
      },
    }
  }
  if (url.includes('/alpha/billing/credits')) return { status: 500, body: '{"error":{"message":"boom"}}' }
  return { status: 200, json: { totalCount: 5, totalCost: 1.5 } }
})
const partial = await commandcode.probe({
  apiKey: SECRET,
  baseUrl: 'https://api.commandcode.ai',
  request: (url, key) => getJson(url, key, { timeoutMs: 1000 }),
})
check('the probe is marked failed', partial.ok === false)
check('the plan still resolves from subscriptions', partial.plan?.name === 'GOAT', JSON.stringify(partial.plan))
check('no credit windows are invented', Object.keys(partial.windows).length === 0, JSON.stringify(partial.windows))
check('no balance is invented', partial.credits === null, JSON.stringify(partial.credits))
check('the failure is reported once', partial.errors.length === 1, JSON.stringify(partial.errors))
check('it is not misreported as an auth failure', partial.authFailed === false)
check('the period facts still come through', partial.period.end === '2026-10-22T13:13:36.000Z', String(partial.period.end))

// The other half of partial availability: the balance arrived but the plan did
// not. The monthly window needs the plan's pool, so it must be absent rather
// than rendered from the remaining balance as a fake $59.21 pool.
stubFetch(async (url) => {
  if (url.includes('/alpha/billing/subscriptions')) return { status: 503, body: 'upstream down' }
  if (url.includes('/alpha/billing/credits')) {
    return {
      status: 200,
      json: {
        credits: { monthlyCredits: 59.21, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 0.5, cap: 14, exceeded: false, resetAt: 1791219489798 }, weekly: { used: 4.5, cap: 35, exceeded: false, resetAt: 1791454278203 } },
      },
    }
  }
  return { status: 200, json: {} }
})
const noPlan = await commandcode.probe({
  apiKey: SECRET,
  baseUrl: 'https://api.commandcode.ai',
  request: (url, key) => getJson(url, key, { timeoutMs: 1000 }),
})
check('the probe is marked failed', noPlan.ok === false)
check('the plan is unknown', noPlan.plan === null, JSON.stringify(noPlan.plan))
check('the 5h and weekly windows still come through', noPlan.windows['5h']?.cap === 14 && noPlan.windows.week?.cap === 35, JSON.stringify(noPlan.windows))
check('the monthly window is not invented', noPlan.windows.month === undefined, JSON.stringify(noPlan.windows.month))
check('the remaining balance is still reported', noPlan.credits?.remaining === 59.21, JSON.stringify(noPlan.credits))
check('the pool is not invented', noPlan.credits?.pool === null, String(noPlan.credits?.pool))
check('the spent figure is not invented', noPlan.credits?.used === null, String(noPlan.credits?.used))
check('the failure is one line', noPlan.errors.length === 1, JSON.stringify(noPlan.errors))

// An unknown plan id (a new tier this build predates) is the same situation.
stubFetch(async (url) => {
  if (url.includes('/alpha/billing/subscriptions')) {
    return { status: 200, json: { success: true, data: { planId: 'individual-mystery', status: 'active', currentPeriodEnd: '2026-10-22T13:13:36.000Z' } } }
  }
  return { status: 200, json: { credits: { monthlyCredits: 12, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { limited: true, fiveHour: { used: 1, cap: 5, exceeded: false }, weekly: { used: 2, cap: 9, exceeded: false } } } }
})
const unknownPlan = await commandcode.probe({
  apiKey: SECRET,
  baseUrl: 'https://api.commandcode.ai',
  request: (url, key) => getJson(url, key, { timeoutMs: 1000 }),
})
check('an unknown plan reports no monthly window', unknownPlan.windows.month === undefined)
check('an unknown plan keeps its real windows', unknownPlan.windows['5h']?.cap === 5)
check('an unknown plan still reports the balance', unknownPlan.credits?.remaining === 12)

console.log('document-level de-duplication')
stubFetch(async (url) => (url.includes('/alpha/') ? { status: 401, body: COMMANDCODE_401 } : { status: 500, body: 'nope' }))
const credential = { value: SECRET, source: 'test', masked: maskSecret(SECRET) }
const { document } = await probeAll({
  config: { commandcode: { enabled: true, apiKeyEnv: 'COMMANDCODE_API_KEY' }, 'opencode-go': { enabled: false } },
  env: { COMMANDCODE_API_KEY: SECRET },
  ctx: { get: () => undefined },
  home,
})
const card = document.providers.find((provider) => provider.id === 'commandcode')
check('one card is produced', document.providers.length === 1, JSON.stringify(document.providers.map((p) => p.id)))
check('the card holds exactly one error line', card.errors.length === 1, JSON.stringify(card.errors))
check('the document holds exactly one error line', document.errors.length === 1, JSON.stringify(document.errors))
check('the document prefixes the provider id', document.errors[0].startsWith('commandcode: '), document.errors[0])
check('the card marks authFailed for the UI', card.authFailed === true)
check('the card reports its credential provenance', card.credentialSource === 'env' && card.credentialMasked === masked, `${card.credentialSource} / ${card.credentialMasked}`)

console.log('missing-credential card')
// A skipped provider must not reach the network: count the calls this probe
// makes, not the ones earlier sections left in the log.
const callsBeforeMissing = calls.length
const missingRun = await probeAll({
  config: { commandcode: { enabled: true, apiKeyEnv: 'DEFINITELY_NOT_SET' }, 'opencode-go': { enabled: false } },
  env: {},
  ctx: { get: () => undefined },
  home: join(home, 'empty-again'),
})
const skipped = missingRun.document.providers[0]
check('it is skipped, not failed', skipped.skipped === true && skipped.ok === false)
check('it explains how to configure the key', /DEFINITELY_NOT_SET/.test(skipped.reason) && /credentials\.yaml/.test(skipped.reason), skipped.reason)
check('it made no request', calls.length === callsBeforeMissing, `made ${calls.length - callsBeforeMissing}`)

console.log(failures === 0 ? `\nauth: all ${checked} checks passed` : `\nauth: ${failures}/${checked} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
