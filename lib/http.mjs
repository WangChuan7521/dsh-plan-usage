/**
 * The plugin's whole HTTP surface: one authenticated JSON GET, provider-agnostic
 * error parsing, and a typed error every caller can act on.
 *
 * Two rules this module exists to enforce:
 *
 *   1. Exactly one `Authorization: Bearer <key>` header leaves this process,
 *      with the key normalized first — a stored value that already carries a
 *      `Bearer ` prefix can never become `Bearer Bearer …`.
 *   2. A failure reaches the caller as a classified {@link HttpError} whose
 *      message names the status, the provider's own error code and its
 *      sentence — never the raw body blob and never the secret.
 *
 * @module dsh-plan-usage/lib/http
 */

/** Per-request timeout when a caller names none. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** Error kinds a caller (or the UI) can branch on. */
export const ERROR_KINDS = ['no-credential', 'auth', 'quota', 'rate-limit', 'not-found', 'client', 'server', 'timeout', 'tls', 'network']

/**
 * One failed provider call.
 *
 * `kind` is the actionable part: `auth` means the credential was rejected (a
 * fresh key is the fix), while `network`/`timeout`/`server` are retryable and
 * must never be reported as an authentication problem.
 */
export class HttpError extends Error {
  /**
   * @param fields - the classified failure.
   */
  constructor({ url, status = 0, code = null, kind = 'network', message, cause = undefined }) {
    super(message)
    this.name = 'HttpError'
    this.url = url
    this.status = status
    this.code = code
    this.kind = kind
    this.retryable = kind === 'network' || kind === 'timeout' || kind === 'tls' || kind === 'server' || kind === 'rate-limit'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Strip whitespace and a `Bearer ` prefix a stored key may already carry, so
 * the header is always built from the bare secret.
 * @param raw - the stored credential value.
 * @returns the bare key, or '' when nothing usable is left.
 */
export function normalizeApiKey(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  const stripped = trimmed.replace(/^Bearer\s+/i, '').trim()
  return stripped
}

/**
 * A key safe to show a human: a masked prefix/suffix and its length, or null.
 *
 * The window is capped so the two halves can never add up to the whole secret —
 * an 11-character key would otherwise be printed in full.
 * @param value - the stored credential value.
 * @returns the mask, or null when there is nothing to mask.
 */
export function maskSecret(value) {
  const key = normalizeApiKey(value)
  if (key === '') return null
  if (key.length < 16) return `${key.slice(0, 2)}…(${key.length})`
  const head = Math.min(10, Math.floor(key.length / 3))
  const tail = Math.min(4, Math.floor(key.length / 4))
  if (head + tail >= key.length) return `${key.slice(0, 2)}…(${key.length})`
  return `${key.slice(0, head)}…${key.slice(-tail)} (${key.length})`
}

/**
 * Pull `{ code, message }` out of whatever error body a relay sent: CommandCode
 * wraps it in `{ success, error: { code, message } }`, New API answers
 * `{ error: { message, code } }` or `{ message }`, and a proxy may answer HTML.
 * @param text - the raw response body.
 * @returns the provider's own code and sentence, when it sent any.
 */
export function parseErrorBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return {}
    const nested = parsed.error
    const inner = nested !== null && typeof nested === 'object' ? nested : {}
    const code = [inner.code, parsed.code].find((value) => typeof value === 'string' && value !== '')
    const message = [inner.message, parsed.message, parsed.msg, typeof nested === 'string' ? nested : undefined]
      .find((value) => typeof value === 'string' && value.trim() !== '')
    return {
      code: code ?? null,
      message: typeof message === 'string' ? message.replaceAll(/\s+/g, ' ').trim().slice(0, 200) : null,
    }
  } catch {
    const collapsed = text.replaceAll(/\s+/g, ' ').trim().slice(0, 120)
    return collapsed === '' ? {} : { message: collapsed }
  }
}

/**
 * Classify one failed response.
 * @param status - the HTTP status.
 * @param code - the provider's own error code, when it sent one.
 * @returns the error kind the UI branches on.
 */
export function classifyStatus(status, code = null) {
  const upper = typeof code === 'string' ? code.toUpperCase() : ''
  if (status === 401 || status === 403 || upper === 'UNAUTHORIZED' || upper === 'FORBIDDEN' || upper === 'INVALID_API_KEY') return 'auth'
  if (status === 402 || upper.includes('QUOTA') || upper.includes('INSUFFICIENT')) return 'quota'
  if (status === 429 || upper.includes('RATE_LIMIT')) return 'rate-limit'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server'
  return 'client'
}

/** A human sentence for one classified failure, never containing the secret. */
function describe({ status, code, kind, message }) {
  const parts = [`HTTP ${status}`]
  if (code !== null && code !== '') parts.push(code)
  const head = parts.join(' ')
  return message === null || message === undefined || message === '' ? head : `${head}: ${message}`
}

/**
 * One authenticated JSON GET.
 *
 * @param url - absolute request URL.
 * @param apiKey - the stored credential; empty values are refused before any
 *   request is made, so a missing key can never look like a provider outage.
 * @param options - `{ timeoutMs, headers }`.
 * @returns the parsed JSON body.
 * @throws {HttpError} classified failure for a non-2xx response, a transport
 *   error, a timeout, or a missing credential.
 */
/**
 * The deepest `cause` in an error chain.
 *
 * Node's `fetch` reports only "fetch failed" at the top; the reason a user can
 * act on (a DNS failure, `ECONNREFUSED`, or a certificate whose SANs no longer
 * cover the host) lives on `cause`. Keeping the deepest one is what turns
 * "network error: fetch failed" into something diagnosable.
 *
 * @param error - the thrown value.
 * @returns the innermost Error, or undefined.
 */
export function deepestCause(error) {
  let current = error
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error) || current.cause === undefined || current.cause === null) break
    current = current.cause
  }
  return current instanceof Error ? current : undefined
}

/** One line naming the transport failure, using the code a human can look up. */
function describeTransport(error) {
  const root = deepestCause(error)
  if (root === undefined) return String(error)
  const code = typeof root.code === 'string' && root.code !== '' ? `${root.code}: ` : ''
  return `${code}${root.message}`
}

export async function getJson(url, apiKey, options = {}) {
  const key = normalizeApiKey(apiKey)
  if (key === '') {
    throw new HttpError({
      url,
      status: 0,
      kind: 'no-credential',
      message: 'no API key resolved for this provider',
    })
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const headers = {
    // Capitalized like the provider's own CLI sends it; HTTP header names are
    // case-insensitive, but matching the reference client removes one variable
    // from any future auth investigation.
    Authorization: `Bearer ${key}`,
    accept: 'application/json',
  }
  let response
  try {
    response = await fetch(url, { headers: { ...headers, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const detail = describeTransport(error)
    // A certificate the upstream no longer serves for this hostname is its own
    // kind: it is not the caller's key, and it is not transient packet loss.
    const tls = !timedOut && /ERR_TLS|SSL|certificate|altnames/i.test(detail)
    throw new HttpError({
      url,
      status: 0,
      kind: timedOut ? 'timeout' : (tls ? 'tls' : 'network'),
      message: timedOut ? `request timed out after ${timeoutMs}ms` : `network error: ${detail}`,
      cause: error,
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const { code, message } = parseErrorBody(text)
    const kind = classifyStatus(response.status, code)
    throw new HttpError({ url, status: response.status, code, kind, message: describe({ status: response.status, code, kind, message }) })
  }
  try {
    return await response.json()
  } catch (error) {
    throw new HttpError({ url, status: response.status, kind: 'client', message: 'response was not JSON', cause: error })
  }
}
