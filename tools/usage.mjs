#!/usr/bin/env node
/**
 * usage — print every configured provider's plan usage without a running DSH.
 *
 * Usage:
 *   node tools/usage.mjs                      # human report
 *   node tools/usage.mjs --json               # the raw document
 *   node tools/usage.mjs --watch 60           # re-print every 60s
 *   node tools/usage.mjs --only opencode-go,commandcode
 *   node tools/usage.mjs --key commandcode=sk-…   # override one provider's key
 *
 * Credentials are read exactly like the plugin reads them: each provider's
 * reference in `$DSH_HOME/.credentials.yaml`, or the environment variable of
 * the same name. The day-baseline state file is read (never written), so any
 * provider that derives a day delta shows the same figure as the GUI.
 *
 * @module dsh-plan-usage/tools/usage
 */

import { PROVIDERS, loadState, probeAll } from '../lib/probe.mjs'
import { getJson } from '../lib/http.mjs'
import { bar, money, until } from '../lib/format.mjs'

const WINDOW_LABELS = [['5h', '5 小时'], ['week', '周'], ['month', '月']]

const USAGE = `usage — 各提供商套餐用量

  node tools/usage.mjs [--json] [--watch <sec>] [--only <id,id>] [--key <id>=<key>]

  --json             输出原始 document JSON
  --watch <sec>      每隔 N 秒刷新一次
  --only <ids>       只查询列出的提供商（${PROVIDERS.map((provider) => provider.id).join(' / ')}）
  --key <id>=<key>   直接指定某个提供商的密钥（可重复）
`

/** Parse the CLI arguments. */
function parseArgs(argv) {
  const options = { json: false, watch: 0, only: null, keys: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') options.json = true
    else if (token === '--watch') options.watch = Number(argv[++index] ?? 60) || 60
    else if (token === '--only') options.only = String(argv[++index] ?? '').split(',').map((id) => id.trim()).filter(Boolean)
    else if (token === '--key') {
      const [id, ...rest] = String(argv[++index] ?? '').split('=')
      options.keys[id] = rest.join('=')
    } else if (token === '--help' || token === '-h') options.help = true
    else {
      console.error(`unknown argument: ${token}`)
      process.exit(2)
    }
  }
  return options
}

/** Render one provider's block. */
function renderProvider(provider) {
  const lines = []
  const badge = provider.plan && provider.plan.name ? ` · ${provider.plan.name} 套餐` : ''
  const status = provider.status ? ` · ${provider.status}` : ''
  lines.push(`${provider.displayName}${badge}${status}`)
  if (provider.skipped === true) {
    lines.push(`  ${provider.reason}`)
    return lines
  }
  if (provider.ok !== true) {
    lines.push(`  探测失败：${(provider.errors || []).join('; ') || 'unknown error'}`)
    if (provider.authFailed === true) {
      lines.push(`  密钥被上游拒绝（来源：${provider.credentialSource ?? '未知'}${provider.credentialMasked ? ` · ${provider.credentialMasked}` : ''}）`)
      lines.push(`  换一个有效密钥即可：DSH 模型页 / 环境变量 ${provider.apiKeyEnv} / $DSH_HOME/.credentials.yaml 的 refs`)
    }
    return lines
  }
  const rows = WINDOW_LABELS.filter(([key]) => provider.windows[key] !== undefined)
  for (const [key, label] of rows) {
    const row = provider.windows[key]
    const reset = until(row.resetAt)
    const detail = typeof row.cap === 'number'
      ? `${money(row.used)} / ${money(row.cap)}`
      : `已用 ${Math.round(row.percent ?? 0)}%`
    lines.push(
      `  ${label.padEnd(7)} ${bar(row.percent)} ${String(Math.round(row.percent)).padStart(3)}%`
      + `  ${detail.padEnd(20)}`
      + (reset === '' ? '' : ` · 重置 ${reset}`),
    )
  }
  const facts = []
  if (provider.credits) {
    facts.push(typeof provider.credits.remaining === 'number'
      ? `剩余 ${money(provider.credits.remaining)}${typeof provider.credits.pool === 'number' && provider.credits.pool > 0 ? ` / 额度池 ${money(provider.credits.pool)}` : ''}`
      : `累计消费 ${money(provider.credits.used)}`)
  }
  if (provider.usage) {
    if (typeof provider.usage.today === 'number') facts.push(`今日 +${money(provider.usage.today)}`)
    if (typeof provider.usage.models === 'number') facts.push(`模型 ${provider.usage.models}`)
    if (provider.usage.requests !== undefined) facts.push(`本期请求 ${provider.usage.requests}`)
    if (provider.usage.cost !== undefined) facts.push(`本期消费 ${money(provider.usage.cost)}`)
  }
  if (facts.length > 0) lines.push(`  ${facts.join(' · ')}`)
  if (provider.credits && provider.credits.note) lines.push(`  ${provider.credits.note}`)
  if (provider.authFailed === true) {
    lines.push(`  密钥被上游拒绝（来源：${provider.credentialSource ?? '未知'}${provider.credentialMasked ? ` · ${provider.credentialMasked}` : ''}）`)
    lines.push(`  换一个有效密钥即可：DSH 模型页 / 环境变量 ${provider.apiKeyEnv} / $DSH_HOME/.credentials.yaml 的 refs`)
  }
  if (provider.credentialMasked && provider.ok === true) {
    lines.push(`  密钥来源 ${provider.credentialSource} · ${provider.credentialMasked}`)
  }
  if (rows.length === 0 && !provider.credits) lines.push('  （该提供商没有可读的额度信息）')
  return lines
}

/** One probe + print. */
async function once() {
  const state = await loadState()
  const config = {}
  for (const [id, key] of Object.entries(keys)) config[id] = { apiKeyEnv: `__CLI_${id.toUpperCase().replaceAll('-', '_')}` }
  // CLI key overrides ride the environment: the adapter's resolution order
  // asks the credential plane, then the environment, then the file.
  for (const [id, key] of Object.entries(keys)) {
    const provider = PROVIDERS.find((entry) => entry.id === id)
    const ref = config[id]?.apiKeyEnv ?? provider?.apiKeyEnv
    if (ref !== undefined) process.env[ref] = key
  }
  const { document } = await probeAll({ config, state })
  const providers = only === null ? document.providers : document.providers.filter((provider) => only.includes(provider.id))
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...document, providers }, null, 2)}\n`)
    return
  }
  const chunks = []
  for (const provider of providers) {
    chunks.push(renderProvider(provider).join('\n'))
  }
  if (chunks.length === 0) chunks.push('没有匹配的提供商')
  chunks.push(`更新于 ${new Date(document.fetchedAt).toLocaleString()}`)
  process.stdout.write(`${chunks.join('\n\n')}\n`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log(USAGE)
  process.exit(0)
}
const { json, watch, only, keys } = options

await once()
if (watch > 0) {
  const timer = setInterval(() => {
    void once().catch((error) => console.error(String(error)))
  }, watch * 1000)
  timer.unref?.()
}
