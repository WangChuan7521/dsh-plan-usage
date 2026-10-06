#!/usr/bin/env node
/**
 * test-client — exercise the browser half without a browser.
 *
 * Stubs the module loader and a minimal hook runtime, then checks that the
 * bundle registers the right module id, returns the plugin shape the client
 * module system expects, registers both slots with their options, and renders
 * a three-provider document into the text a user would actually see — plus the
 * degraded cases (a provider with no credential, a provider whose probe
 * failed).
 *
 * Usage: node tools/test-client.mjs
 *
 * @module dsh-plan-usage/tools/test-client
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

let failures = 0

/** Assert one condition, recording a failure instead of throwing. */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/**
 * Flatten a stub element tree into its text content. Function components are
 * expanded on the way down, so text a nested `<ProviderCard>` would render
 * counts as text the user sees.
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && typeof node.type === 'function') return textOf(node.type(node.props))
  if (typeof node === 'object' && node.children !== undefined) return textOf(node.children)
  return ''
}

/**
 * Every element in a stub tree whose type matches. Function components are
 * expanded on the way down (they take no hooks), so a nested `<Meter>` is
 * inspected as the DOM it would actually produce.
 */
function findAll(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const entry of node) findAll(entry, type, found)
    return found
  }
  if (typeof node.type === 'function') {
    return findAll(node.type(node.props), type, found)
  }
  if (node.type === type) found.push(node)
  if (node.children !== undefined) findAll(node.children, type, found)
  return found
}

/**
 * Minimal React: createElement plus a real (single-instance) hook runtime, so
 * a render pass can settle its fetch and be re-rendered with the data — the
 * only way to assert what the user actually sees.
 */
let hookSlots = []
let hookCursor = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hookSlots[index] = typeof value === 'function' ? value(hookSlots[index]) : value
    }
    return [hookSlots[index], set]
  },
  useEffect(effect) {
    const index = hookCursor++
    if (!(index in hookSlots)) {
      hookSlots[index] = true
      void effect()
    }
  },
  useCallback(fn) {
    hookCursor += 1
    return fn
  },
  useMemo(fn) {
    hookCursor += 1
    return fn()
  },
  useRef(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    hookCursor += 1
    return getSnapshot()
  },
}

/** Let queued promises and macrotasks settle. */
async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Render once to arm the hooks, let the data fetch settle, then render again
 * with whatever the component's own state now holds.
 * @param component - the registered component.
 * @param props - its props.
 * @returns the settled element tree.
 */
async function render(component, props) {
  hookSlots = []
  hookCursor = 0
  component(props)
  await settle()
  hookCursor = 0
  return component(props)
}

/**
 * Render again over the hook state the last pass left behind — the way a real
 * re-render after a click behaves.
 * @param component - the registered component.
 * @param props - its props.
 * @returns the re-rendered element tree.
 */
async function rerender(component, props) {
  hookCursor = 0
  const tree = component(props)
  await settle()
  hookCursor = 0
  return component(props)
}

/** The first element of a type in the tree (function components expanded). */
function first(tree, predicate) {
  return findAll(tree, 'div').concat(findAll(tree, 'button'), findAll(tree, 'span')).find(predicate) ?? null
}

/** Click the first button whose text contains `label`. */
function clickButton(tree, label) {
  const button = findAll(tree, 'button').find((node) => textOf(node).includes(label))
  if (button === undefined) throw new Error(`no button containing ${JSON.stringify(label)}`)
  button.props.onClick({ stopPropagation() {} })
}

/**
 * Click the pill itself. The pill's label changes with the selected provider
 * (a code when one is selected, "套餐" when none is), so it is addressed by the
 * disclosure attribute it always carries.
 */
function clickPill(tree) {
  const button = findAll(tree, 'button').find((node) => node.props?.['aria-expanded'] !== undefined)
  if (button === undefined) throw new Error('no pill button found')
  button.props.onClick({ stopPropagation() {} })
}

/** A stub model directory whose selected provider the test can switch. */
function modelDirectoryContext(provider, options = {}) {
  const state = { provider }
  const directory = {
    store: {
      getSnapshot: () => ({ current: state.provider === null ? null : { provider: state.provider, model: 'x' }, groups: [], status: 'ready' }),
      subscribe: () => () => {},
    },
    load: () => Promise.resolve(),
  }
  const ctx = {
    modelDirectories: options.missing === true
      ? undefined
      : { directoryFor: () => { if (options.throws === true) throw new Error('not bound yet'); return directory } },
  }
  return { ctx, setProvider: (next) => { state.provider = next } }
}

/** A canned document, shaped exactly like lib/probe.mjs probeAll output. */
const DOCUMENT = {
  ok: true,
  fetchedAt: Date.now(),
  errors: [],
  providers: [
    {
      id: 'commandcode',
      displayName: 'CommandCode',
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      ok: true,
      skipped: false,
      status: 'active',
      plan: { id: 'individual-goat', name: 'GOAT', monthlyCredits: 70 },
      period: { start: '2026-09-22T13:13:36.000Z', end: '2026-10-22T13:13:36.000Z' },
      windows: {
        '5h': { used: 0.127386, cap: 14, percent: 0.9099013, resetAt: Date.now() + 11_400_000, exceeded: false },
        week: { used: 4.505120515, cap: 35, percent: 12.8717729, resetAt: Date.now() + 245_000_000, exceeded: false },
        month: { used: 10.77184738, cap: 70, percent: 15.3883534, resetAt: Date.now() + 1_466_000_000, exceeded: false },
      },
      credits: { currency: 'USD', remaining: 59.22815262, used: 10.77184738, pool: 70, cumulative: false },
      usage: { requests: 3859, failed: 0, cost: 10.778260549, tokensIn: 561822038, tokensOut: 3267192, periodBasis: 'billing-period' },
      limited: true,
      errors: [],
      fetchedAt: Date.now(),
      source: 'live',
    },
    {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      ok: true,
      skipped: false,
      status: 'ok',
      plan: null,
      period: { start: null, end: null },
      windows: {
        '5h': { percent: 1, resetAt: Date.now() + 1_400_000, status: 'ok' },
        week: { percent: 0, resetAt: null, status: 'ok' },
        month: { percent: 2, resetAt: Date.now() + 2_300_000_000, status: 'ok' },
      },
      credits: null,
      usage: null,
      limited: false,
      errors: [],
      fetchedAt: Date.now(),
      source: 'live',
    },
    {
      id: 'example-relay',
      displayName: 'Example Relay',
      apiKeyEnv: 'EXAMPLE_RELAY_API_KEY',
      ok: true,
      skipped: false,
      status: 'list',
      plan: null,
      period: { start: null, end: null },
      windows: {},
      credits: { currency: 'USD', used: 2192.85, remaining: null, pool: null, cumulative: true, note: 'relay 只提供累计消费；余额需要控制台的访问令牌' },
      usage: { models: 3, today: 0.12 },
      limited: false,
      errors: [],
      fetchedAt: Date.now(),
      source: 'live',
    },
  ],
}

/** Install the loader/`fetch` stubs and load the bundle. */
const registrations = []
let served = DOCUMENT
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
    },
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return served } })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

await import(`file://${CLIENT}`)

console.log('client bundle')
check('registers exactly one module', registrations.length === 1, `got ${registrations.length}`)
const entry = registrations[0]
check('module id is the package name', entry?.id === 'dsh-plan-usage', String(entry?.id))
check('factory is a function', typeof entry?.factory === 'function')

const plugin = entry.factory((request) => {
  if (request === 'react') return React
  throw new Error(`unexpected require(${request})`)
})
check("plugin injects 'slots'", Array.isArray(plugin?.inject) && plugin.inject.includes('slots'))
check('plugin exposes apply()', typeof plugin?.apply === 'function')

const slots = []
const injected = []
plugin.apply({
  slots: {
    inject(name, register) {
      injected.push(name)
      register()
    },
    register(options, component) {
      slots.push({ options, component })
    },
  },
})
console.log('slot registration')
check('injects into settings.section', injected.includes('settings.section'))
check('injects into conversation.composer.dock', injected.includes('conversation.composer.dock'))
check('registers two entries', slots.length === 2, `got ${slots.length}`)
const section = slots.find((slot) => slot.options.name === 'settings.section')
const pill = slots.find((slot) => slot.options.name === 'conversation.composer.dock')
check('section id is stable', section?.options.id === 'plan-usage', String(section?.options.id))
check('section label is callable', section?.options.label() === '套餐用量', String(section?.options.label?.()))
check('section sits below the usage section', typeof section?.options.order === 'number' && section.options.order > 151)
check('pill id is stable', pill?.options.id === 'plan-usage-pill', String(pill?.options.id))

console.log('render')
const sectionTree = await render(section.component, { close: () => {} })
const sectionText = textOf(sectionTree)
check('section titles itself', sectionText.includes('套餐用量'), sectionText.slice(0, 80))
check('lists every provider', ['CommandCode', 'OpenCode Go', 'Example Relay'].every((name) => sectionText.includes(name)), sectionText.slice(0, 200))
check('shows the GOAT badge', sectionText.includes('GOAT 套餐'))
check('shows CommandCode money rows', sectionText.includes('$59.23') && sectionText.includes('$10.78'), sectionText)
check('shows the period request count', sectionText.includes('3,859'))
check('renders a meter per CommandCode window', findAll(sectionTree, 'div').filter((node) => node.props?.style?.height === 8).length >= 5)
check('describes OpenCode Go as percent-only', sectionText.includes('已用 1%'), sectionText)
check('shows the relay cumulative spend', sectionText.includes('累计消费 $2192.85'), sectionText)
check('shows the relay day delta', sectionText.includes('今日') && sectionText.includes('+$0.12'), sectionText)
check('shows the relay model count', sectionText.includes('模型'), sectionText)
check('explains the relay limitation', sectionText.includes('余额需要控制台的访问令牌'))

console.log('pill follows the session selection')
const selection = modelDirectoryContext('commandcode')
const pillProps = { sessionId: 'session-1', __ctx: selection.ctx }
const pillTree = await render(pill.component, pillProps)
const pillText = textOf(pillTree)
check('pill names the selected provider only', pillText.includes('CC') && !pillText.includes('OC') && !pillText.includes('52X'), pillText)
check('pill shows that provider\'s plan', pillText.includes('GOAT'), pillText)
check('pill shows that provider\'s windows', pillText.includes('5h 1%') && pillText.includes('周 13%') && pillText.includes('月 15%'), pillText)
check('pill does not leak another provider\'s numbers', !pillText.includes('$2192') && !pillText.includes('已用'), pillText)
check('pill advertises that it expands', pillText.includes('▴'), pillText)

selection.setProvider('example-relay')
const pillRelay = await render(pill.component, pillProps)
const relayText = textOf(pillRelay)
check('switching the session provider switches the pill', relayText.includes('Exam') && !relayText.includes('CC'), relayText)
check('a window-less provider shows its spend', relayText.includes('累计') && relayText.includes('$2.2k'), relayText)

selection.setProvider('deepseek-account')
const pillUnknown = await render(pill.component, pillProps)
const unknownText = textOf(pillUnknown)
check('an unsupported provider degrades to a neutral pill', unknownText.includes('套餐') && unknownText.includes('用量'), unknownText)
check('the neutral pill leaks no other provider', !unknownText.includes('GOAT') && !unknownText.includes('Example'), unknownText)

console.log('pill expands upward into the provider list')
selection.setProvider('commandcode')
let openTree = await render(pill.component, pillProps)
check('no panel before the click', !textOf(openTree).includes('各提供商用量'), textOf(openTree).slice(0, 80))
clickPill(openTree)
openTree = await rerender(pill.component, pillProps)
const openText = textOf(openTree)
check('the panel opens', openText.includes('各提供商用量'), openText.slice(0, 120))
check('the panel lists every provider', ['CommandCode', 'OpenCode Go', 'Example Relay'].every((name) => openText.includes(name)), openText.slice(0, 240))
check('the panel marks the current provider', openText.includes('当前'), openText.slice(0, 240))
check('the panel repeats the selected provider\'s numbers', openText.includes('$59.23') && openText.includes('$10.77'), openText.slice(0, 400))
check('the panel shows the other providers\' numbers too', openText.includes('3%') && openText.includes('$2192.85'), openText.slice(0, 600))
const panel = first(openTree, (node) => node.props?.role === 'dialog')
check('the panel is a dialog anchored above the pill', panel?.props?.style?.position === 'fixed' && typeof panel?.props?.style?.bottom === 'number' && panel.props.style.bottom > 0, JSON.stringify(panel?.props?.style))
check('the panel has a refresh control', findAll(panel, 'button').some((node) => textOf(node).includes('刷新')))
check('the pill reports its expanded state', findAll(openTree, 'button').some((node) => node.props?.['aria-expanded'] === 'true'))
clickPill(openTree)
const closedTree = await rerender(pill.component, pillProps)
check('clicking again collapses it', !textOf(closedTree).includes('各提供商用量'), textOf(closedTree).slice(0, 80))

console.log('pill degrades when the model directory is unavailable')
const noService = modelDirectoryContext('commandcode', { missing: true })
const noServiceTree = await render(pill.component, { sessionId: 'session-1', __ctx: noService.ctx })
check('a missing service does not throw', textOf(noServiceTree).length > 0)
check('a missing service falls back to the neutral pill', textOf(noServiceTree).includes('套餐'), textOf(noServiceTree))
const throwing = modelDirectoryContext('commandcode', { throws: true })
const throwingTree = await render(pill.component, { sessionId: 'session-1', __ctx: throwing.ctx })
check('a directory that is not bound yet does not throw', textOf(throwingTree).includes('套餐'), textOf(throwingTree))
const noSession = await render(pill.component, {})
check('a pill without a session renders the neutral state', textOf(noSession).includes('套餐'), textOf(noSession))

console.log('degraded states')
served = {
  ok: false,
  fetchedAt: Date.now(),
  errors: ["commandcode: HTTP 401 UNAUTHORIZED: Invalid 'Authorization' header or token."],
  providers: [
    {
      id: 'commandcode',
      displayName: 'CommandCode',
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      ok: false,
      skipped: false,
      authFailed: true,
      credentialSource: 'credential-file',
      credentialMasked: 'user_TESTON…aaaa (92)',
      status: null,
      plan: null,
      period: { start: null, end: null },
      windows: {},
      credits: null,
      usage: null,
      limited: false,
      errors: ["HTTP 401 UNAUTHORIZED: Invalid 'Authorization' header or token."],
      fetchedAt: Date.now(),
      source: 'live',
    },
    {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      ok: false,
      skipped: true,
      status: null,
      plan: null,
      period: { start: null, end: null },
      windows: {},
      credits: null,
      usage: null,
      limited: false,
      errors: [],
      reason: 'credential OPENCODE_GO_API_KEY is not configured',
      fetchedAt: Date.now(),
      source: 'skipped',
    },
  ],
}
const degraded = textOf(await render(section.component, { close: () => {} }))
check('an auth failure is named as such', degraded.includes('密钥被上游拒绝'), degraded.slice(0, 320))
check('it keeps the classified provider message', degraded.includes("HTTP 401 UNAUTHORIZED: Invalid 'Authorization' header or token."), degraded.slice(0, 320))
check('it names the credential source and masked key', degraded.includes('密钥来源：credential-file') && degraded.includes('user_TESTON…aaaa (92)'), degraded.slice(0, 400))
check('it states the remedy without a restart', degraded.includes('无需重启') && degraded.includes('COMMANDCODE_API_KEY'), degraded.slice(0, 500))
check('a credential-less provider shows the reference', degraded.includes('OPENCODE_GO_API_KEY'), degraded.slice(0, 400))
check('the failure is printed exactly once', degraded.split("Invalid 'Authorization' header or token.").length - 1 === 1, String(degraded.split("Invalid 'Authorization' header or token.").length - 1))
check('no duplicate upstream warning line for a failure a card owns', !degraded.includes('上游告警'), degraded.slice(0, 400))
check('the generic read-failure line is not used for an auth failure', !degraded.includes('读取失败：HTTP 401'), degraded.slice(0, 400))
const degradedSelection = modelDirectoryContext('commandcode')
const degradedPill = textOf(await render(pill.component, { sessionId: 'session-1', __ctx: degradedSelection.ctx }))
check('pill reports a rejected key for the selected provider', degradedPill.includes('CC') && degradedPill.includes('密钥被拒绝'), degradedPill)
const degradedNeutral = textOf(await render(pill.component, {}))
check('without a session the pill stays neutral, never wrong', degradedNeutral.includes('套餐') && !degradedNeutral.includes('GOAT'), degradedNeutral)

console.log(failures === 0 ? '\nclient half: all checks passed' : `\nclient half: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
