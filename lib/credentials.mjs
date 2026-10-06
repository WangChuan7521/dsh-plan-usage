/**
 * Where a provider's probe credential comes from.
 *
 * One ordered chain, every step a source this deployment already trusts, and
 * every step reporting which one answered — so a 401 can be traced to "the key
 * that was used" instead of guessed at:
 *
 *   1. `harness-record`     the credential the harness itself stores for the
 *                           model route (`llm-pi-ai/<provider>`, kind `api-key`)
 *                           — what the Models page / sign-in flow writes
 *   2. `credentials-service`  the same seam `apiKeyEnv` resolves per request
 *   3. `env`                the reference name as an environment variable
 *   4. `cli-env`            the provider's own CLI environment variable
 *   5. `cli-auth-file`      the provider CLI's own login file
 *   6. `credential-file`     `$DSH_HOME/.credentials.yaml` → `refs`
 *
 * Steps 4–5 are declared per provider (CommandCode ships a CLI whose local
 * login is a legitimate key source); a provider that has none simply skips
 * them. Secrets never leave this module except as the masked form
 * {@link maskSecret} produces.
 *
 * @module dsh-plan-usage/lib/credentials
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'
import { maskSecret, normalizeApiKey } from './http.mjs'

/** The scope the harness stores model-route credentials under. */
const HARNESS_SCOPE = 'llm-pi-ai'

/**
 * Provider-native credential sources, keyed by provider id.
 * `cliAuthFile` is the CLI's own login file; `keyField` is the field inside it.
 */
export const NATIVE_SOURCES = {
  commandcode: {
    cliEnvVar: 'COMMAND_CODE_API_KEY',
    cliAuthDir: '.commandcode',
    cliAuthFiles: ['auth.json', 'auth.staging.json', 'auth.local.json'],
    keyField: 'apiKey',
  },
}

/** The reference name a provider falls back to when its config names none. */
export function harnessRecordKey(providerId) {
  return `${HARNESS_SCOPE}/${providerId}`
}

/** Parse the `refs:` block of `$DSH_HOME/.credentials.yaml` without a YAML dependency. */
export function credentialRefsFromFile(text) {
  const refs = {}
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^[A-Za-z]/.test(line)) {
      inRefs = line.trimStart().startsWith('refs:')
      continue
    }
    if (!inRefs) continue
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (value !== '') refs[match[1]] = value
  }
  return refs
}

/** Read one JSON file, tolerating absence and malformed content. */
async function readJsonFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Resolve one provider's probe credential.
 *
 * @param options - `{ providerId, refName, ctx, env, home }`.
 * @returns `{ value, source, masked }`, or undefined when no source has a key.
 */
export async function resolveCredential(options) {
  const { providerId, refName } = options
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const ctx = options.ctx
  const native = NATIVE_SOURCES[providerId]

  /** Wrap one candidate so every return carries the same shape. */
  const accept = (raw, source) => {
    const value = normalizeApiKey(raw)
    return value === '' ? undefined : { value, source, masked: maskSecret(value) }
  }

  // 1 + 2: the harness credential plane. A record write for this route is the
  // key the user stored through the GUI; the reference is the configured one.
  if (ctx !== undefined && typeof ctx.get === 'function') {
    let credentials
    try {
      credentials = ctx.get('credentials')
    } catch {
      credentials = undefined
    }
    if (credentials !== undefined) {
      if (typeof credentials.readRecord === 'function') {
        try {
          const record = await credentials.readRecord(harnessRecordKey(providerId))
          if (record?.kind === 'api-key') {
            const accepted = accept(record.key, 'harness-record')
            if (accepted !== undefined) return accepted
          }
        } catch {
          // An unreadable record is simply not a source.
        }
      }
      if (typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(refName)
          const value = typeof resolved === 'string' ? resolved : resolved?.value
          const accepted = accept(value, 'credentials-service')
          if (accepted !== undefined) return accepted
        } catch {
          // A malformed reference reads as absent.
        }
      }
    }
  }

  // 3: the reference name as a plain environment variable.
  const fromEnv = accept(env[refName], 'env')
  if (fromEnv !== undefined) return fromEnv

  // 4: the provider CLI's own environment variable.
  if (native?.cliEnvVar !== undefined) {
    const fromCliEnv = accept(env[native.cliEnvVar], 'cli-env')
    if (fromCliEnv !== undefined) return fromCliEnv
  }

  // 5: the provider CLI's own login file.
  if (native?.cliAuthDir !== undefined) {
    for (const file of native.cliAuthFiles ?? []) {
      const record = await readJsonFile(join(home, native.cliAuthDir, file))
      if (record === null) continue
      const accepted = accept(record[native.keyField ?? 'apiKey'], `cli-auth-file:${native.cliAuthDir}/${file}`)
      if (accepted !== undefined) return accepted
    }
  }

  // 6: the harness credential file's refs table.
  const refs = credentialRefsFromFile(await readFile(join(dshHome(), '.credentials.yaml'), 'utf8').catch(() => ''))
  const fromFile = accept(refs[refName], 'credential-file')
  if (fromFile !== undefined) return fromFile

  return undefined
}
