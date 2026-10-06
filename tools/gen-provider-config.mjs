#!/usr/bin/env node
/**
 * gen-provider-config — emit the llm-pi-ai route blocks for every provider
 * this profile adds by hand, built from each provider's live model catalogue.
 *
 * The output belongs in a profile's `cordis.patch.yml` under
 * `- id: llm-pi-ai` → `config.providers`, and is what
 * `tools/install-provider-config.mjs` splices in (inside one marked region).
 *
 * The model list comes from the provider's own `/models` endpoint:
 *   CommandCode  https://api.commandcode.ai/provider/v1/models  (context_length
 *                published; filtered to /chat/completions, curated to GOAT)
 *
 * Usage:
 *   node tools/gen-provider-config.mjs                 # print the YAML region
 *   node tools/gen-provider-config.mjs --write         # also write provider/providers.yml
 *   node tools/gen-provider-config.mjs --all           # every /chat/completions model
 *
 * @module dsh-plan-usage/tools/gen-provider-config
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getJson } from '../lib/http.mjs'
import { resolveCredential } from '../lib/credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Where the generated region is kept as a reviewable artifact. */
const OUT_PATH = join(HERE, '..', 'provider', 'providers.yml')

/** GOAT-plan roster served over /chat/completions on CommandCode. */
const GOAT_MODELS = [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash-fast',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-fast',
  'deepseek/deepseek-v4-flash-vision-exp',
  'moonshotai/Kimi-K3',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K2.6',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'z-ai/glm-5.3-flash',
  'z-ai/glm-5.3-flashx',
  'MiniMaxAI/MiniMax-M3',
  'xiaomi/mimo-v2.6-pro',
  'xiaomi/mimo-v2.6-flash',
  'xiaomi/mimo-v2.5-pro',
  'xiaomi/mimo-v2.5',
  'Qwen/Qwen3.8-Max',
  'Qwen/Qwen3.8-Max-0902',
  'Qwen/Qwen3.8-Flash',
  'Qwen/Qwen3.8-Omni-Flash',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus',
  'Qwen/Qwen3.7-Flash',
  'google/gemini-3.8-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'xai/grok-4.7',
  'xai/grok-4.6',
  'xai/grok-4.5',
  'meta/muse-spark-1.3',
  'meta/muse-spark-1.2',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.3-codex',
  'stepfun/Step-5-Preview',
  'stepfun/Step-3.7-Flash',
  'tencent/hy4-preview',
  'tencent/hy3-paid',
  'meituan/LongCat-2.0',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-small',
  'inclusionai/ling-3.1-flash:free',
  'poolside/laguna-s-2.1-free',
  'stealth/space-bunny-alpha',
]

/** Effort ladders, exactly as the CommandCode CLI declares them. */
const LADDERS = {
  j: ['low', 'medium', 'high', 'xhigh', 'max'],
  b: ['low', 'medium', 'high', 'xhigh'],
  w: ['low', 'medium', 'high'],
  h: ['off', 'high', 'max'],
  g: ['off', 'low', 'high', 'max'],
  v: ['low', 'high', 'max'],
  hm: ['high', 'max'],
  q: ['low', 'medium', 'xhigh'],
  fx: ['high', 'xhigh'],
  sa: ['low', 'medium', 'high', 'max'],
}

/** model id → effort ladder (the CommandCode CLI's own table, keyed by wire id). */
const EFFORTS = {
  'gpt-6-astra': LADDERS.j,
  'gpt-6.1-sol': LADDERS.j,
  'gpt-6-sol': LADDERS.j,
  'gpt-6-luna': LADDERS.j,
  'gpt-5.6-sol': LADDERS.j,
  'gpt-5.6-terra': LADDERS.j,
  'gpt-5.6-luna': LADDERS.j,
  'gpt-5.5': LADDERS.b,
  'gpt-5.4': LADDERS.b,
  'gpt-5.3-codex': LADDERS.b,
  'gpt-5.4-mini': LADDERS.w,
  'deepseek/deepseek-v4-pro': LADDERS.h,
  'deepseek/deepseek-v4-flash': LADDERS.h,
  'deepseek/deepseek-v4-flash-vision-exp': LADDERS.h,
  'deepseek/deepseek-v4-flash-fast': LADDERS.v,
  'deepseek/deepseek-v4.1-flash': LADDERS.g,
  'deepseek/deepseek-v4.1-flash-fast': LADDERS.g,
  'moonshotai/Kimi-K3': LADDERS.v,
  'zai-org/GLM-5.3': LADDERS.v,
  'z-ai/glm-5.3-flash': LADDERS.v,
  'z-ai/glm-5.3-flashx': LADDERS.v,
  'zai-org/GLM-5.2': LADDERS.hm,
  'google/gemini-3.8-flash': LADDERS.w,
  'google/gemini-3.7-flash': LADDERS.w,
  'google/gemini-3.6-flash': LADDERS.w,
  'google/gemini-3.5-flash': LADDERS.w,
  'google/gemini-3.5-flash-lite': LADDERS.w,
  'google/gemini-3.1-flash-lite': LADDERS.w,
  'stealth/space-bunny-alpha': LADDERS.sa,
  'tencent/hy4-preview': LADDERS.w,
  'inclusionai/ling-3.1-flash:free': LADDERS.w,
  'sakana/fugu-ultra': LADDERS.fx,
  'xai/grok-4.5': LADDERS.w,
  'xai/grok-4.6': LADDERS.b,
  'xai/grok-4.7': LADDERS.b,
  'Qwen/Qwen3.8-Omni-Flash': LADDERS.q,
  'Qwen/Qwen3.8-Max-0902': LADDERS.q,
  'Qwen/Qwen3.8-Max': LADDERS.q,
  'Qwen/Qwen3.8-27B': LADDERS.q,
  'Qwen/Qwen3.8-Flash': LADDERS.q,
  'meta/muse-spark-1.1': LADDERS.b,
  'meta/muse-spark-1.2': LADDERS.b,
  'meta/muse-spark-1.2-contributor': LADDERS.b,
  'meta/muse-spark-1.3': LADDERS.j,
  'meta/muse-spark-1.3-contributor': LADDERS.b,
  'stepfun/Step-5-Preview': LADDERS.w,
  'MiniMaxAI/MiniMax-M3': LADDERS.w,
}

/** Models the CommandCode CLI treats as text-only (everything else accepts images). */
const TEXT_ONLY = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-fast',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
  'MiniMaxAI/MiniMax-M2.7',
  'MiniMaxAI/MiniMax-M2.5',
  'xiaomi/mimo-v2.5-pro',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.7-Max',
  'meituan/LongCat-2.0',
  'stepfun/Step-3.5-Flash',
  'tencent/hy4-preview',
  'tencent/hy3-paid',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free',
  'inclusionai/ling-3.1-flash:free',
])

/** Output-token cap declared for every model (pi-ai's own undeclared-model default). */
const MAX_TOKENS = 32768

/** Capacity assumed for a catalogue that publishes none. */
const ASSUMED_CONTEXT_WINDOW = 1_050_000

/** Ids whose capacity is that assumption, shared with the CommandCode catalogue. */
const ASSUMED_MODELS = {
  'gpt-6-astra': ASSUMED_CONTEXT_WINDOW,
  'gpt-6.1-sol': ASSUMED_CONTEXT_WINDOW,
  'gpt-5.6-sol': ASSUMED_CONTEXT_WINDOW,
}

/** The hand-declared routes this generator maintains. */
const SPECS = [
  {
    id: 'commandcode',
    displayName: 'CommandCode',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    catalogueUrl: 'https://api.commandcode.ai/provider/v1/models',
    /** Only models answering on /chat/completions (Claude stays on the Anthropic wire). */
    accept: (model) => (model.supported_endpoints ?? []).includes('/chat/completions'),
    capacity: (model) => Number(model.context_length) || ASSUMED_CONTEXT_WINDOW,
    allow: GOAT_MODELS,
  }
]

/** Fallback label for a catalogued id the spec does not name: `gpt-6.1-sol` → `Gpt 6.1 Sol`. */
function prettify(id) {
  return String(id)
    .replaceAll(/[:/]/g, ' ')
    .split(/[-\s]+/)
    .filter((part) => part !== '')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/** Quote a YAML scalar when it carries characters YAML would read as syntax. */
function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** Format one model entry at the route's indentation. */
function modelEntry(model) {
  const lines = [
    `          - id: ${yamlString(model.id)}`,
    `            name: ${yamlString(model.name)}`,
    `            contextWindow: ${model.contextWindow}`,
    `            maxTokens: ${MAX_TOKENS}`,
  ]
  const ladder = EFFORTS[model.id]
  if (ladder !== undefined) {
    lines.push('            reasoningEfforts:')
    for (const level of ladder) {
      // Only "off" may carry an empty wire value; every other level names its spelling.
      lines.push(level === 'off' ? '              off:' : `              ${level}: ${level}`)
    }
  }
  lines.push('            input:')
  lines.push('              - text')
  if (!TEXT_ONLY.has(model.id)) lines.push('              - image')
  return lines.join('\n')
}

/** Catalogue fetch budget: a model list is bigger and slower than a usage probe. */
const CATALOGUE_TIMEOUT_MS = 45_000

/** Resolve one spec's model list from its live catalogue. */
async function modelsFor(spec, useAll) {
  const credential = await resolveCredential({ providerId: spec.id, refName: spec.apiKeyEnv })
  if (credential === undefined) throw new Error(`${spec.id}: no credential (${spec.apiKeyEnv}) is configured`)
  const catalogue = await getJson(spec.catalogueUrl, credential.value, { timeoutMs: CATALOGUE_TIMEOUT_MS })
  const available = (catalogue.data ?? []).filter(spec.accept)
  const wanted = useAll || spec.allow === null ? available.map((model) => model.id) : spec.allow
  const chosen = wanted
    .map((id) => available.find((model) => model.id === id))
    .filter((model) => model !== undefined)
    .map((model) => ({
      id: model.id,
      name: model.name ?? spec.names?.[model.id] ?? prettify(model.id),
      contextWindow: spec.capacity(model),
    }))
  const missing = wanted.filter((id) => !available.some((model) => model.id === id))
  return { chosen, missing }
}

const args = process.argv.slice(2)
const useAll = args.includes('--all')
const onlyFlag = args.indexOf('--provider')
const only = onlyFlag === -1 ? null : args[onlyFlag + 1]
const specs = only === null ? SPECS : SPECS.filter((spec) => spec.id === only)

const blocks = []
for (const spec of specs) {
  const { chosen, missing } = await modelsFor(spec, useAll)
  if (missing.length > 0) console.error(`# ${spec.id}: no longer served — ${missing.join(', ')}`)
  blocks.push([
    `      ${spec.id}:`,
    `        displayName: ${spec.displayName}`,
    '        api: openai-completions',
    `        baseURL: ${spec.baseURL}`,
    `        apiKeyEnv: ${spec.apiKeyEnv}`,
    '        models:',
    ...chosen.map(modelEntry),
  ].join('\n'))
  console.error(`# ${spec.id}: ${chosen.length} models`)
}

const region = blocks.join('\n')
process.stdout.write(`${region}\n`)

if (args.includes('--write')) {
  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, `${region}\n`, 'utf8')
  console.error(`# wrote ${OUT_PATH}`)
}
