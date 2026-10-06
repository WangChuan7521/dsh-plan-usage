/**
 * Plan-usage orchestration — the shared core of the plugin (host half) and the
 * `usage.mjs` CLI.
 *
 * Every provider adapter in `lib/providers/` answers the same question in its
 * own dialect: "how much of my plan have I used, in which windows, resetting
 * when?". This module owns everything that is not dialect-specific — the
 * credential chain, the HTTP layer, the provider registry, the state file's
 * day baselines, and the document both halves render.
 *
 * Two properties the document guarantees, because a quota page is only useful
 * if its failures are readable:
 *
 *   - **One line per failure.** A provider whose three endpoints all answer the
 *     same 401 contributes exactly one deduplicated error, not three, and the
 *     card that owns it is the card that shows it.
 *   - **Provenance.** Each provider reports which credential source answered
 *     (and its masked form), so "which key was used" is a fact in the document
 *     rather than an investigation.
 *
 * Node built-ins only: the package ships as a `link:` dependency, so a bare
 * `@deepseek-ai/*` specifier would resolve against the workspace instead of
 * the profile's node_modules.
 *
 * @module dsh-plan-usage/lib/probe
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { commandcode } from './providers/commandcode.mjs'
import { opencodeGo } from './providers/opencode-go.mjs'
import { resolveCredential } from './credentials.mjs'
import { getJson, maskSecret } from './http.mjs'
import { dshHome, snapshotPath, statePath, SNAPSHOT_FILE, STATE_FILE } from './paths.mjs'

export { dshHome, snapshotPath, statePath, SNAPSHOT_FILE, STATE_FILE }
export { resolveCredential, maskSecret }

/** Every provider this plugin knows how to read, in render order. */
export const PROVIDERS = [commandcode, opencodeGo]

/**
 * Per-request timeout. CommandCode's `/alpha/usage/summary` aggregates a whole
 * billing period and regularly needs more than 10s on a cold cache; the poll
 * cycle is 60s, so a generous per-request bound costs nothing and stops a slow
 * endpoint from being reported as an outage.
 */
export const PROBE_TIMEOUT_MS = 25_000

/** How many distinct error lines one provider may contribute. */
const MAX_PROVIDER_ERRORS = 3

/** Collapse repeats while keeping the first-seen order. */
function dedupe(values, limit = Number.POSITIVE_INFINITY) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Resolve one provider's effective settings from the row config.
 * @param provider - the registered adapter.
 * @param entry - the row's `providers[id]` entry, when configured.
 * @returns enabled flag, credential reference, base URL and unit override.
 */
function settingsFor(provider, entry) {
  const config = entry ?? {}
  return {
    enabled: config.enabled !== false,
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv !== '' ? config.apiKeyEnv : provider.apiKeyEnv,
    baseUrl: String(config.baseUrl ?? provider.baseUrl).replace(/\/+$/, ''),
    unitsPerUsd: config.unitsPerUsd,
  }
}

/** Wrap one adapter's result in the document's per-provider shape. */
function toView(provider, settings, result, now, credential) {
  const errors = dedupe(result.errors ?? [], MAX_PROVIDER_ERRORS)
  const details = Array.isArray(result.errorDetails) ? result.errorDetails : []
  const authFailed = result.authFailed === true
    || details.some((detail) => detail.kind === 'auth')
    || /HTTP 40[13]|UNAUTHORIZED|FORBIDDEN/i.test(errors.join(' '))
  return {
    id: provider.id,
    displayName: provider.displayName,
    apiKeyEnv: settings.apiKeyEnv,
    credentialSource: credential?.source ?? null,
    credentialMasked: credential?.masked ?? null,
    ok: result.ok === true,
    skipped: false,
    authFailed,
    status: result.status ?? null,
    plan: result.plan ?? null,
    period: result.period ?? { start: null, end: null },
    windows: result.windows ?? {},
    credits: result.credits ?? null,
    usage: result.usage ?? null,
    limited: result.limited === true,
    errors,
    fetchedAt: now,
    source: 'live',
  }
}

/**
 * Probe every enabled provider once.
 *
 * A provider without a resolvable credential is reported as `skipped` rather
 * than failed: an unconfigured route is a configuration fact, not an outage.
 *
 * @param options - `{ ctx, config, state, now, timeoutMs, env, home }`.
 * @returns `{ document, state }` — the renderable document and the next state.
 */
export async function probeAll(options = {}) {
  const now = options.now ?? Date.now()
  const ctx = options.ctx
  const config = options.config ?? {}
  const state = options.state ?? {}
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  // The HTTP layer is provider-agnostic; the adapter names the URL it wants.
  const request = (url, apiKey, extra) => getJson(url, apiKey, { timeoutMs, ...(extra ?? {}) })

  const providers = []
  const nextState = { ...state, version: 1, providers: { ...(state.providers ?? {}) } }

  await Promise.all(PROVIDERS.map(async (provider) => {
    const settings = settingsFor(provider, config[provider.id])
    if (!settings.enabled) return

    const credential = await resolveCredential({
      providerId: provider.id,
      refName: settings.apiKeyEnv,
      ctx,
      env: options.env,
      home: options.home,
    })
    if (credential === undefined) {
      providers.push({
        id: provider.id,
        displayName: provider.displayName,
        apiKeyEnv: settings.apiKeyEnv,
        credentialSource: null,
        credentialMasked: null,
        ok: false,
        skipped: true,
        authFailed: false,
        status: null,
        plan: null,
        period: { start: null, end: null },
        windows: {},
        credits: null,
        usage: null,
        limited: false,
        errors: [],
        reason: `没有找到 ${settings.apiKeyEnv}：可在 DSH 模型页保存密钥、设置同名环境变量，或写入 $DSH_HOME/.credentials.yaml 的 refs`,
        fetchedAt: now,
        source: 'skipped',
      })
      return
    }

    try {
      const result = await provider.probe({
        apiKey: credential.value,
        baseUrl: settings.baseUrl,
        request,
        state: state.providers?.[provider.id],
        config: settings,
        now,
      })
      if (result.state !== undefined) nextState.providers[provider.id] = result.state
      providers.push(toView(provider, settings, result, now, credential))
    } catch (error) {
      providers.push(toView(provider, settings, {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
        errorDetails: [{ kind: error?.kind ?? 'network' }],
      }, now, credential))
    }
  }))

  providers.sort((left, right) => {
    const leftIndex = PROVIDERS.findIndex((provider) => provider.id === left.id)
    const rightIndex = PROVIDERS.findIndex((provider) => provider.id === right.id)
    return leftIndex - rightIndex
  })

  const live = providers.filter((provider) => provider.skipped !== true)
  const errors = []
  for (const provider of live) {
    for (const message of provider.errors) errors.push(`${provider.id}: ${message}`)
  }

  nextState.updatedAt = now
  return {
    document: {
      ok: live.length > 0 && live.every((provider) => provider.ok),
      fetchedAt: now,
      providers,
      errors: dedupe(errors),
    },
    state: nextState,
  }
}

/** Read the persisted state, tolerating a missing or malformed file. */
export async function loadState(path = statePath()) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed
  } catch {
    return {}
  }
}

/** Atomic JSON write through a unique temp file + rename. */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 1)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}
