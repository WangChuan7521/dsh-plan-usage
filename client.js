/**
 * dsh-plan-usage — browser half.
 *
 * Renders one card per provider the host half probed: a first-level Settings
 * section ("套餐用量") with every provider's quota windows, plus a compact
 * pill in the composer dock for a glance while coding.
 *
 * Only numbers reach this file — API keys and every provider call stay in the
 * host process behind `GET /api/dsh-plan-usage/usage`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plan-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The client plugin context, captured by `apply` for the pill's selection read. */
    let pluginCtx = null

    /** Document-relative: the GUI is served with `<base href="./">`. */
    const USAGE_PATH = 'api/dsh-plan-usage/usage'
    const REFRESH_PATH = 'api/dsh-plan-usage/refresh'
    const FETCH_TIMEOUT_MS = 20_000

    /** Poll cadences: the open section is chatty, the always-mounted pill is not. */
    const SECTION_POLL_MS = 30_000
    const PILL_POLL_MS = 120_000

    /** Window keys, in the order every provider's card lists them. */
    const WINDOW_LABELS = [
      ['5h', '5 小时'],
      ['week', '周'],
      ['month', '月'],
    ]

    /** Short codes for the pill, keyed by provider id. */
    const SHORT = { commandcode: 'CC', 'opencode-go': 'OC' }

    /** Window keys as the narrow pill spells them. */
    const PILL_WINDOWS = [['5h', '5h'], ['week', '周'], ['month', '月']]

    /** How often the pill re-reads the session's selected provider. */
    const SELECTION_POLL_MS = 2_000
    /** Floor between catalogue loads while the selection is still unknown. */
    const CATALOGUE_LOAD_FLOOR_MS = 30_000

    const TOKEN = {
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
    }

    /** Fill colour for a used-percentage. */
    function tone(percent) {
      if (percent >= 90) return TOKEN.bad
      if (percent >= 70) return TOKEN.warn
      return TOKEN.ok
    }

    /** `$1.23`, or an em dash when the number is absent. */
    function money(value) {
      return typeof value === 'number' && Number.isFinite(value) ? '$' + value.toFixed(2) : '—'
    }

    /** `$2.2k` — the pill has no room for cents. */
    function compactMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1000) return '$' + (value / 1000).toFixed(1) + 'k'
      return '$' + value.toFixed(2)
    }

    /** Integer with thousands separators. */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—'
    }

    /** `3h 12m` / `2d 4h` until an epoch-ms instant, or '' once past. */
    function until(instant) {
      if (typeof instant !== 'number' || !Number.isFinite(instant)) return ''
      const delta = instant - Date.now()
      if (delta <= 0) return '即将重置'
      const minutes = Math.max(1, Math.ceil(delta / 60_000))
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`
      if (hours > 0) return mins > 0 ? `${hours}小时 ${mins}分` : `${hours}小时`
      return `${mins}分`
    }

    /** The local clock time an instant resets at. */
    function clock(instant) {
      if (typeof instant !== 'number' || !Number.isFinite(instant)) return ''
      return new Date(instant).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    /**
     * The provider the session is currently routed to, from the GUI's own model
     * directory (`ctx.modelDirectories.directoryFor(sessionId).store`, the same
     * store the composer's model seat renders from).
     *
     * Read defensively and re-read on a slow tick rather than captured once:
     * `directoryFor` throws by design until the session scope is bound, and the
     * directory instance is rebuilt when the binding resets — a captured one
     * goes permanently stale. A missing service degrades to `null`, which the
     * pill renders as "all providers".
     *
     * @param ctx - the client plugin context.
     * @param sessionId - the slot's session.
     * @returns the selected provider route id, or null while unknown.
     */
    function useSelectedProvider(ctx, sessionId) {
      const [provider, setProvider] = React.useState(null)
      React.useEffect(() => {
        if (ctx === null || sessionId === null) return undefined
        let alive = true
        let lastLoadAt = 0

        /** One resolution attempt; never throws. */
        const read = () => {
          try {
            const directories = typeof ctx.get === 'function' ? ctx.get('modelDirectories') : ctx.modelDirectories
            if (directories === undefined || directories === null || typeof directories.directoryFor !== 'function') return null
            const directory = directories.directoryFor(sessionId)
            const snapshot = directory?.store?.getSnapshot?.() ?? null
            const current = snapshot?.current ?? null
            if (typeof current?.provider === 'string' && current.provider !== '') return current.provider
            // No selection yet: the catalogue may still be idle, and loading it
            // is what populates `current` for a session with no saved choice.
            const now = Date.now()
            if (typeof directory?.load === 'function' && now - lastLoadAt > CATALOGUE_LOAD_FLOOR_MS) {
              lastLoadAt = now
              try {
                Promise.resolve(directory.load()).catch(() => {})
              } catch {
                // A synchronous throw is the store's problem, not the pill's.
              }
            }
            return null
          } catch {
            return null
          }
        }

        const sync = () => {
          if (!alive) return
          const next = read()
          setProvider((previous) => (previous === next ? previous : next))
        }

        sync()
        const timer = setInterval(sync, SELECTION_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [ctx, sessionId])
      return provider
    }

    /** A provider's headline number for the pill: the fullest window, else null. */
    function headline(provider) {
      const rows = Object.values(provider.windows || {})
      const percents = rows.map((row) => row && row.percent).filter((value) => typeof value === 'number')
      return percents.length > 0 ? Math.max(...percents) : null
    }

    /** Poll the host document; returns the latest view plus any transport error. */
    function useUsage(pollMs) {
      const [state, setState] = React.useState({ view: null, error: null })
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(USAGE_PATH, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setState({ view: await response.json(), error: null })
        } catch (error) {
          setState((previous) => ({ ...previous, error: String((error && error.message) || error) }))
        }
      }, [])
      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(REFRESH_PATH, { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setState({ view: await response.json(), error: null })
        } catch (error) {
          setState((previous) => ({ ...previous, error: String((error && error.message) || error) }))
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        void load()
        const timer = setInterval(() => {
          if (alive) void load()
        }, pollMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load, pollMs])
      return { ...state, refresh }
    }

    /** One labelled quota meter. */
    function Meter(props) {
      const row = props.row
      const percent = row && typeof row.percent === 'number' ? Math.max(0, Math.min(100, row.percent)) : 0
      const colour = tone(percent)
      const reset = row ? until(row.resetAt) : ''
      const detail = row
        ? (typeof row.cap === 'number' ? `${money(row.used)} / ${money(row.cap)}` : `已用 ${Math.round(percent)}%`)
        : '暂无数据'
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 } },
          h('span', { style: { color: TOKEN.label, fontWeight: 600, minWidth: 62 } }, props.label),
          h('span', { style: { color: colour, fontWeight: 600, minWidth: 40 } }, row ? Math.round(percent) + '%' : '—'),
          h('span', { style: { color: TOKEN.label3, fontSize: 12 } }, detail),
          reset !== ''
            ? h('span', { style: { marginLeft: 'auto', color: TOKEN.label3, fontSize: 12 } },
                `${clock(row.resetAt)} 重置 · ${reset}`)
            : null),
        h('div', {
          style: {
            height: 8, borderRadius: 'var(--dsw-radius-sm)', background: TOKEN.layer2,
            border: `1px solid ${TOKEN.borderSoft}`, overflow: 'hidden',
          },
        }, h('div', {
          style: { width: percent + '%', height: '100%', background: colour, transition: 'width .3s ease' },
        })))
    }

    /** One provider's card: windows, credits and the period's request facts. */
    function ProviderCard(props) {
      const provider = props.provider
      const windows = provider.windows || {}
      const credits = provider.credits
      const usage = provider.usage
      const rows = WINDOW_LABELS.filter(([key]) => windows[key] !== undefined && windows[key] !== null)
      const creditsText = credits === null || credits === undefined
        ? null
        : (typeof credits.remaining === 'number'
            ? `剩余 ${money(credits.remaining)}${typeof credits.pool === 'number' && credits.pool > 0 ? ` / 额度池 ${money(credits.pool)}` : ''}`
            : `累计消费 ${money(credits.used)}`)
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 14, padding: 16,
          background: TOKEN.layer1, border: `1px solid ${TOKEN.border}`, borderRadius: 'var(--dsw-radius-lg)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('span', { style: { fontWeight: 600, fontSize: 14, color: TOKEN.label } }, provider.displayName),
        provider.plan && provider.plan.name
          ? h('span', {
              style: {
                padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                color: TOKEN.business, border: `1px solid ${TOKEN.border}`,
              },
            }, `${provider.plan.name} 套餐`)
          : null,
        provider.status
          ? h('span', { style: { fontSize: 11, color: TOKEN.label3 } }, provider.status)
          : null,
        provider.limited
          ? h('span', { style: { fontSize: 11, color: TOKEN.warn } }, '已触达窗口上限')
          : null),
      provider.skipped === true
        ? h('div', { style: { fontSize: 12, color: TOKEN.label3 } }, provider.reason || '未配置密钥')
        : (rows.length > 0
            ? rows.map(([key, label]) => h(Meter, { key, label, row: windows[key] }))
            : h('div', { style: { fontSize: 12, color: TOKEN.label3 } }, '该提供商没有滚动窗口，只提供累计消费')),
      creditsText !== null || usage
        ? h('div', {
            style: {
              display: 'flex', gap: 18, flexWrap: 'wrap', paddingTop: 10, fontSize: 12,
              color: TOKEN.label3, borderTop: `1px solid ${TOKEN.borderSoft}`,
            },
          },
          creditsText !== null ? h('span', null, creditsText) : null,
          usage && typeof usage.today === 'number' ? h('span', null, '今日 ', h('b', { style: { color: TOKEN.label2 } }, '+' + money(usage.today))) : null,
          usage && typeof usage.models === 'number' ? h('span', null, '模型 ', h('b', { style: { color: TOKEN.label2 } }, count(usage.models))) : null,
          usage && usage.requests !== undefined ? h('span', null, '本期请求 ', h('b', { style: { color: TOKEN.label2 } }, count(usage.requests))) : null,
          usage && usage.cost !== undefined ? h('span', null, '本期消费 ', h('b', { style: { color: TOKEN.label2 } }, money(usage.cost))) : null)
        : null,
      credits && credits.note
        ? h('div', { style: { fontSize: 11, color: TOKEN.label3 } }, credits.note)
        : null,
      // The credential this probe ran with, so "which key was rejected" is a
      // fact on the card instead of an investigation. Never the full secret.
      provider.credentialMasked
        ? h('div', { style: { fontSize: 11, color: TOKEN.label3 } },
            `密钥来源：${provider.credentialSource || '未知'} · ${provider.credentialMasked}`)
        : null,
      provider.ok !== true && provider.skipped !== true && provider.authFailed === true
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { fontSize: 12, color: TOKEN.bad } },
              '密钥被上游拒绝：' + ((provider.errors || []).join('；') || 'HTTP 401')),
            h('div', { style: { fontSize: 11, color: TOKEN.label3 } },
              '换一个有效密钥即可，无需重启：在 DSH 模型页保存，或写入环境变量 '
              + (provider.apiKeyEnv || '') + '／$DSH_HOME/.credentials.yaml 的 refs，下一次探测自动生效。'))
        : (provider.ok !== true && provider.skipped !== true
            ? h('div', { style: { fontSize: 12, color: TOKEN.bad } },
                '读取失败：' + ((provider.errors || []).join('；') || 'unknown error'))
            : null))
    }

    /** First-level Settings section: one card per provider. */
    function UsageSection() {
      const { view, error, refresh } = useUsage(SECTION_POLL_MS)
      const providers = (view && view.providers) || []
      // Document errors are prefixed with their provider id; the ones a card
      // already renders are dropped here.
      const unattributed = ((view && view.errors) || []).filter((line) => {
        const match = /^([a-z0-9-]+):/.exec(line)
        return match === null || !providers.some((provider) => provider.id === match[1])
      })
      return h('section', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720, width: '100%', color: TOKEN.label },
      },
      h('header', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '套餐用量'),
        h('span', { style: { fontSize: 12, color: TOKEN.label3 } },
          providers.length > 0 ? `${providers.length} 个提供商` : ''),
        h('button', {
          type: 'button',
          onClick: () => void refresh(),
          style: {
            marginLeft: 'auto', padding: '4px 12px', fontSize: 12, cursor: 'pointer',
            color: TOKEN.label2, background: 'transparent',
            border: `1px solid ${TOKEN.border}`, borderRadius: 'var(--dsw-radius-sm)',
          },
        }, '刷新')),
      h('p', { style: { margin: 0, fontSize: 13, color: TOKEN.label2, lineHeight: 1.6 } },
        '宿主进程用各提供商自己的密钥查询额度：CommandCode 的 5 小时/周/月窗口、OpenCode Go 的滚动窗口。密钥不会进入浏览器。'),
      providers.map((provider) => h(ProviderCard, { key: provider.id, provider })),
      providers.length === 0 && error === null
        ? h('div', { style: { fontSize: 12, color: TOKEN.label3 } }, '暂无数据，点「刷新」立刻探测一次。')
        : null,
      error !== null
        ? h('div', { style: { fontSize: 12, color: TOKEN.bad } }, '读取失败：' + error)
        : null,
      // A provider's own card owns its failure; this line carries only what no
      // card can show, so one 401 is never printed twice.
      unattributed.length > 0
        ? h('div', { style: { fontSize: 12, color: TOKEN.warn } }, '上游告警：' + unattributed.join('；'))
        : null,
      view && view.fetchedAt
        ? h('div', { style: { fontSize: 11, color: TOKEN.label3 } }, '更新于 ' + new Date(view.fetchedAt).toLocaleTimeString())
        : null)
    }

    /** The provider's one-line summary inside the pill. */
    function pillSummary(provider) {
      const windows = (provider.windows || {})
      const parts = PILL_WINDOWS
        .filter(([key]) => windows[key] !== undefined && windows[key] !== null)
        .map(([key, label]) => `${label} ${typeof windows[key].percent === 'number' ? Math.round(windows[key].percent) + '%' : '—'}`)
      if (parts.length > 0) return parts.join(' · ')
      const credits = provider.credits
      if (credits !== null && credits !== undefined) {
        if (typeof credits.remaining === 'number') return `剩余 ${compactMoney(credits.remaining)}`
        if (typeof credits.used === 'number') return `累计 ${compactMoney(credits.used)}`
      }
      if (provider.skipped === true) return '未配置密钥'
      if (provider.ok !== true) return provider.authFailed === true ? '密钥被拒绝' : '读取失败'
      return '暂无数据'
    }

    /** One provider's row inside the expanded panel. */
    function PanelRow(props) {
      const provider = props.provider
      const windows = provider.windows || {}
      const rows = WINDOW_LABELS.filter(([key]) => windows[key] !== undefined && windows[key] !== null)
      const credits = provider.credits
      const usage = provider.usage
      const creditsText = credits === null || credits === undefined
        ? null
        : (typeof credits.remaining === 'number'
            ? `剩余 ${money(credits.remaining)}${typeof credits.pool === 'number' && credits.pool > 0 ? ` / 池 ${money(credits.pool)}` : ''}`
            : `累计 ${money(credits.used)}`)
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px',
          // The session's own provider is the reason the panel was opened, so
          // it is the row that reads as selected.
          background: props.active ? TOKEN.layer2 : 'transparent',
          border: `1px solid ${props.active ? TOKEN.business : 'transparent'}`,
          borderRadius: 'var(--dsw-radius-md)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('span', { style: { fontWeight: 600, fontSize: 12, color: TOKEN.label } }, provider.displayName),
        provider.plan && provider.plan.name
          ? h('span', { style: { fontSize: 10, color: TOKEN.business, border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '0 6px' } }, provider.plan.name)
          : null,
        props.active ? h('span', { style: { fontSize: 10, color: TOKEN.business } }, '当前') : null,
        !provider.ok && provider.skipped !== true
          ? h('span', { style: { fontSize: 10, color: TOKEN.bad } }, provider.authFailed === true ? '密钥被拒绝' : '读取失败')
          : null,
        creditsText !== null
          ? h('span', { style: { marginLeft: 'auto', fontSize: 11, color: TOKEN.label3 } }, creditsText)
          : null),
      provider.skipped === true
        ? h('div', { style: { fontSize: 11, color: TOKEN.label3 } }, provider.reason || '未配置密钥')
        : (rows.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                rows.map(([key, label]) => h(Meter, { key, label, row: windows[key] })))
            : h('div', { style: { fontSize: 11, color: TOKEN.label3 } },
                usage && typeof usage.today === 'number'
                  ? `今日 +${money(usage.today)}`
                  : '该提供商没有滚动窗口')),
      provider.ok !== true && provider.skipped !== true
        ? h('div', { style: { fontSize: 11, color: provider.authFailed === true ? TOKEN.bad : TOKEN.warn } },
            (provider.errors || []).join('；') || 'unknown error')
        : null)
    }

    /**
     * The composer-dock pill: it follows the session's selected provider, and
     * opens the full provider list upward.
     *
     * The panel is positioned `fixed` from the pill's own rect because the
     * composer area is not guaranteed to allow a child to escape its overflow.
     */
    function UsagePill(props) {
      const { view, refresh } = useUsage(PILL_POLL_MS)
      const providers = (view && view.providers) || []
      const selectedId = useSelectedProvider(props.__ctx ?? pluginCtx, props.sessionId ?? null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const wrapRef = React.useRef(null)

      const active = selectedId === null ? null : providers.find((provider) => provider.id === selectedId) ?? null
      const worst = providers.reduce((max, provider) => {
        const value = headline(provider)
        return value === null ? max : Math.max(max, value)
      }, 0)

      /**
       * Measure the pill so the panel can sit directly above it.
       *
       * A measurement that is impossible or throws still anchors the panel: a
       * popover that silently refuses to open because the pill could not be
       * measured is a worse failure than one placed approximately.
       */
      const place = React.useCallback(() => {
        // Every number is sanitized: an unavailable or non-finite viewport
        // measurement must not turn the anchor into NaN, which would render the
        // panel at an invalid offset instead of simply further from the pill.
        const rawWidth = typeof window === 'undefined' ? 0 : Number(window.innerWidth)
        const rawHeight = typeof window === 'undefined' ? 0 : Number(window.innerHeight)
        const viewportWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 420
        const viewportHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 700
        const width = Math.min(380, Math.max(260, viewportWidth - 24))
        const fallback = { left: 12, bottom: Math.max(64, Math.round(viewportHeight / 4)), width }
        const node = wrapRef.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') {
          setAnchor(fallback)
          return
        }
        try {
          const rect = node.getBoundingClientRect()
          const rectLeft = Number.isFinite(rect?.left) ? rect.left : 12
          const rectTop = Number.isFinite(rect?.top) ? rect.top : viewportHeight
          const left = Math.max(12, Math.min(rectLeft, viewportWidth - width - 12))
          setAnchor({ left, bottom: Math.max(8, viewportHeight - rectTop + 8), width })
        } catch {
          setAnchor(fallback)
        }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        place()
        const onDown = (event) => {
          const node = wrapRef.current
          if (node !== null && typeof node.contains === 'function' && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onMove = () => place()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [open, place])

      const dotColour = active !== null
        ? (active.ok === true ? tone(headline(active) ?? 0) : TOKEN.bad)
        : (view === null ? TOKEN.label3 : (view.ok ? tone(worst) : TOKEN.bad))

      return h('div', {
        ref: wrapRef,
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      },
      open && anchor !== null
        ? h('div', {
            role: 'dialog',
            'aria-label': '各提供商套餐用量',
            style: {
              position: 'fixed', left: anchor.left, bottom: anchor.bottom, width: anchor.width, zIndex: 60,
              display: 'flex', flexDirection: 'column',
              background: TOKEN.layer1, border: `1px solid ${TOKEN.border}`,
              borderRadius: 'var(--dsw-radius-lg)', boxShadow: '0 12px 32px rgba(0,0,0,.28)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
              borderBottom: `1px solid ${TOKEN.borderSoft}`, fontSize: 12, color: TOKEN.label,
            },
          },
          h('span', { style: { fontWeight: 600 } }, '各提供商用量'),
          h('button', {
            type: 'button',
            onClick: () => void refresh(),
            style: {
              marginLeft: 'auto', padding: '2px 10px', fontSize: 11, cursor: 'pointer',
              color: TOKEN.label2, background: 'transparent',
              border: `1px solid ${TOKEN.border}`, borderRadius: 'var(--dsw-radius-sm)',
            },
          }, '刷新')),
          h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 4, padding: 6, maxHeight: 'min(56vh, 480px)', overflowY: 'auto' },
          },
          providers.length > 0
            ? providers.map((provider) => h(PanelRow, { key: provider.id, provider, active: provider.id === selectedId }))
            : h('div', { style: { padding: 12, fontSize: 11, color: TOKEN.label3 } }, '暂无数据，点「刷新」立刻探测一次。')),
          view && view.fetchedAt
            ? h('div', {
                style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.borderSoft}`, fontSize: 10, color: TOKEN.label3 },
              }, '更新于 ' + new Date(view.fetchedAt).toLocaleTimeString())
            : null)
        : null,
      h('button', {
        type: 'button',
        title: active !== null
          ? `${active.displayName} 套餐用量（点击查看全部提供商）`
          : '各提供商套餐用量（点击展开）',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => {
          // Measure before the state flip so the panel's first paint already
          // has its anchor (no one-frame jump at the wrong place).
          if (!open) place()
          setOpen(!open)
        },
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px', cursor: 'pointer',
          fontSize: 11, color: TOKEN.label2, background: TOKEN.layer1,
          border: `1px solid ${TOKEN.border}`, borderRadius: 999,
        },
      },
      h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: dotColour } }),
      h('span', { style: { fontWeight: 600, color: TOKEN.label } },
        active !== null ? (SHORT[active.id] || active.displayName) : '套餐'),
      h('span', null, active !== null
        ? [active.plan && active.plan.name ? active.plan.name : null, pillSummary(active)].filter((part) => part !== null).join(' · ')
        : (providers.length > 0 ? '用量' : '暂无数据')),
      h('span', { style: { color: TOKEN.label3, fontSize: 9, lineHeight: 1 } }, open ? '▾' : '▴')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The pill reads the session's selected provider off the client
        // context; the slot framework also hands it over as `props.__ctx`
        // (that is how the official composer plugins get it).
        pluginCtx = ctx
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'plan-usage',
          order: 152,
          label: () => '套餐用量',
        }, UsageSection))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'plan-usage-pill',
          order: 40,
          // Session-scoped slot: this is what gives the pill its sessionId,
          // and with it the session's model/provider selection.
          inject: (sessionId) => ({ sessionId }),
        }, UsagePill))
      },
    }
  },
})
