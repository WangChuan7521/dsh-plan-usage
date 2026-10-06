/**
 * Small value helpers shared by every provider adapter and both halves of the
 * plugin. No I/O, no imports: pure functions over provider payloads.
 * @module dsh-plan-usage/lib/format
 */

/** Read a finite number, else undefined. */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Read a non-empty trimmed string, else undefined. */
export function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Clamp a percentage into the renderable 0-100 band. */
export function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

/** Used-percent from a used/cap pair, or undefined when either is unusable. */
export function usedPercent(used, cap) {
  const usedNum = num(used)
  const capNum = num(cap)
  if (usedNum === undefined || capNum === undefined || capNum <= 0) return undefined
  return clampPercent((usedNum / capNum) * 100)
}

/** Round to a fixed number of decimals without float noise. */
export function round(value, decimals = 6) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Millisecond epoch, second epoch or ISO string → epoch ms, else null.
 * Fractional seconds and numeric strings are accepted because relay APIs
 * publish all three spellings.
 * @param value - the instant to normalize.
 * @returns epoch milliseconds, or null when it is not an instant.
 */
export function toEpochMs(value) {
  const direct = num(value)
  if (direct !== undefined && direct > 0) {
    // Values below 1e12 are seconds (the epoch-ms threshold is year 2001).
    return direct < 1e12 ? Math.round(direct * 1000) : Math.round(direct)
  }
  const text = str(value)
  if (text === undefined) return null
  if (/^\d+(\.\d+)?$/.test(text)) return toEpochMs(Number(text))
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

/** `$1.23`, or an em dash when the number is absent. */
export function money(value) {
  const amount = num(value)
  return amount === undefined ? '—' : `$${amount.toFixed(2)}`
}

/** Integer with thousands separators, or an em dash. */
export function count(value) {
  const amount = num(value)
  return amount === undefined ? '—' : Math.round(amount).toLocaleString('en-US')
}

/** `3h 12m` / `2d 4h` until an epoch-ms instant, or '' once past. */
export function until(instant, now = Date.now()) {
  const at = num(instant)
  if (at === undefined) return ''
  const delta = at - now
  if (delta <= 0) return 'resetting now'
  const minutes = Math.max(1, Math.ceil(delta / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/** One `███░░░░░░░` bar of a used-percentage. */
export function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(((num(percent) ?? 0) / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** The local `YYYY-MM-DD` key of an instant. */
export function localDayKey(instant = Date.now()) {
  const date = new Date(instant)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
