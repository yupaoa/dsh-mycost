/**
 * dsh-mycost — Client half.
 *
 * One Settings section 「Token 用量」 (`settings.section`, the same contract
 * dsh-persona-switcher uses): the last 7 or 30 days of provider-reported usage
 * — pooled totals, the cache hit rate, the usage structure (cache-hit input /
 * cache-miss input / output) and the input:output ratio, then one table each
 * for the model and the provider dimension, and a data-source block with the
 * "rescan history" action.
 *
 * There is no sidebar surface and no plugins-page card any more; those were
 * removed on request. Everything is read-only against the host RPC channel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mycost',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const CHANNEL = '/my-cost'
    const TAB_ID = 'my-cost'
    const LOCALE_NS = 'mycost'
    const MAX_ROWS = 40

    // ------------------------------------------------------------- formatting

    function tokens(value) {
      const number = Math.max(0, Number(value) || 0)
      if (number < 1000) return String(Math.round(number))
      if (number < 1e6) return `${(number / 1000).toFixed(2)}K`
      return `${(number / 1e6).toFixed(1)}M`
    }

    function percent(value) {
      return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
    }

    async function rpcCall(rpc, endpoint, payload) {
      const result = await rpc.call(CHANNEL, endpoint, payload)
      if (!result.ok) throw new Error(result.error?.message ?? String(result.error))
      return result.value
    }

    /**
     * A render failure inside this tab must not unmount the host surface it is
     * mounted in (the right sidebar keeps `keepMounted` tabs alive), so every
     * tree we hand back is wrapped in a real error boundary. Harnesses without
     * `React.Component` (the offline test stub) fall back to a passthrough.
     */
    function boundary(label, Inner) {
      if (typeof React.Component !== 'function') return Inner
      class Guard extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error }
        }
        componentDidCatch(error) {
          try {
            console.error(`dsh-mycost: ${label} render failed`, error)
          } catch {}
        }
        render() {
          if (this.state.error) {
            return h('div', { style: css.muted }, `${label}: ${this.state.error?.message ?? this.state.error}`)
          }
          return h(Inner, this.props)
        }
      }
      return Guard
    }

    // ------------------------------------------------------------- nav icon

    /**
     * The shell renders each settings row's glyph through the `settings.section.icon`
     * list slot — `renderSlot("settings.section.icon", { size: 16, active }, { only: row.id })`
     * — so registering an entry with our section id is the supported route and no
     * DOM patching is needed. Size and active state arrive as props.
     */
    const SettingsIcon = ({ size = 16, active = false } = {}) =>
      h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.7 : 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // Three ascending bars over a baseline: usage that grows.
        h('path', { key: 'base', d: 'M2.8 12.9h10.4' }),
        h('path', { key: 'a', d: 'M5 12.9V8.4' }),
        h('path', { key: 'b', d: 'M8 12.9V4.5' }),
        h('path', { key: 'c', d: 'M11 12.9V6.7' }),
      )

    // ---------------------------------------------------------------- styling

    const css = {
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px',
        fontSize: '12px',
        lineHeight: 1.5,
        overflowY: 'auto',
        height: '100%',
        boxSizing: 'border-box',
      },
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        borderRadius: '8px',
        padding: '10px',
      },
      rowFlex: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      big: { fontSize: '20px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      muted: { opacity: 0.62 },
      bar: { display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', marginTop: '6px' },
      segHit: { background: '#4c8bf5' },
      segMiss: { background: '#e0a33e' },
      segOut: { background: '#63b06a' },
      switcher: { display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 },
      chip: (active) => ({
        cursor: 'pointer',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        background: active ? 'var(--dsh-accent, rgba(76,139,245,.16))' : 'transparent',
        color: 'inherit',
        borderRadius: '999px',
        padding: '2px 10px',
        fontSize: '11px',
        // Without this the chips wrap into two stacked lines as soon as the
        // header text next to them grows.
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }),
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      item: { display: 'flex', flexDirection: 'column', gap: '2px' },
      name: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
      truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // Label and value stay together on the left: no space-between here.
      ratioRow: { display: 'flex', alignItems: 'baseline', gap: '6px', justifyContent: 'flex-start' },
      // Ratios are read at a glance, so they get tabular figures and weight.
      figure: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
      button: {
        cursor: 'pointer',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        background: 'transparent',
        color: 'inherit',
        padding: '4px 10px',
        fontSize: '11px',
        alignSelf: 'flex-start',
      },
    }

    function StructureBar({ metrics }) {
      const shares = metrics?.shares ?? { hit: 0, miss: 0, output: 0 }
      return h(
        'div',
        { style: css.bar },
        h('div', { style: { ...css.segHit, width: `${shares.hit * 100}%` } }),
        h('div', { style: { ...css.segMiss, width: `${shares.miss * 100}%` } }),
        h('div', { style: { ...css.segOut, width: `${shares.output * 100}%` } }),
      )
    }

    function Item({ label, sub, totals, metrics }) {
      return h(
        'div',
        { style: css.item },
        h(
          'div',
          { style: css.name },
          h('span', { style: css.truncate, title: label }, label),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, tokens(metrics.total)),
        ),
        h(StructureBar, { metrics }),
        h(
          'div',
          { style: { ...css.rowFlex, ...css.muted, fontSize: '10.5px' } },
          h('span', null, sub),
          h('span', null, `命中 ${percent(metrics.hitRate)}`),
        ),
      )
    }

    // ------------------------------------------------------------ settings page

    /** Windows offered by the page; 1 means today. */
    const WINDOWS = [1, 7, 30]

    /** How often an open page re-checks the window while it sits idle. */
    const AUTO_REFRESH_MS = 60 * 1000

    /** Where the last chosen window is remembered, so the page reopens on it. */
    const WINDOW_KEY = 'dsh-mycost:window'

    /** Storage can throw (private mode, sandboxed iframe); never let that break the page. */
    const readStoredWindow = () => {
      try {
        const raw = globalThis.localStorage?.getItem(WINDOW_KEY)
        const value = Number.parseInt(raw ?? '', 10)
        return WINDOWS.includes(value) ? value : null
      } catch {
        return null
      }
    }

    const storeWindow = (value) => {
      try {
        globalThis.localStorage?.setItem(WINDOW_KEY, String(value))
      } catch {
        /* remembering is a nicety, not a requirement */
      }
    }

    /** `1` reads as the "today" chip, every other window as "N 天". */
    const windowLabel = (value, t) => (value === 1 ? t('today') : `${value} ${t('daysUnit')}`)

    function ratio(input, output) {
      if (!output) return '—'
      return `${(input / output).toFixed(1)} : 1`
    }

    /** `hit : miss : output`, normalised so the output leg is exactly 1. */
    function tripleRatio(hit, miss, output) {
      if (!output) return '—'
      const leg = (value) => (value / output).toFixed(1)
      return `${leg(hit)} : ${leg(miss)} : 1`
    }

    function Legend({ color, label, value }) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
        h('span', { style: { width: '7px', height: '7px', borderRadius: '2px', background: color } }),
        h('span', null, `${label} ${value}`),
      )
    }

    /** One table per dimension: name, tokens, share of the window, hit rate. */
    function Breakdown({ label, rows, grand, t }) {
      const top = rows.slice(0, MAX_ROWS)
      return h(
        'div',
        { style: css.card },
        h(
          'div',
          { style: { ...css.rowFlex, fontWeight: 600, marginBottom: '6px' } },
          h('span', null, label),
          h('span', { style: { ...css.muted, fontWeight: 400 } }, `${rows.length} ${t('rows')}`),
        ),
        top.length === 0
          ? h('div', { style: css.muted }, t('empty'))
          : h(
              'div',
              { style: css.list },
              ...top.map((item) =>
                h(
                  'div',
                  { key: item.key, style: css.item },
                  h(
                    'div',
                    { style: css.name },
                    h('span', { style: css.truncate, title: item.key }, item.key),
                    h(
                      'span',
                      { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                      `${tokens(item.metrics.total)}  ${percent(grand ? item.metrics.total / grand : 0)}`,
                    ),
                  ),
                  h(StructureBar, { metrics: item.metrics }),
                  h(
                    'div',
                    { style: { ...css.rowFlex, ...css.muted, fontSize: '10.5px' } },
                    h('span', null, `${item.count} ${t('calls')}`),
                    h('span', null, `${t('hitRate')} ${percent(item.metrics.hitRate)}`),
                  ),
                ),
              ),
            ),
      )
    }

    function SettingsSection(props) {
      const rpc = props.rpc
      const t = props.t
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      // Reopen on whatever window was last used; 30 days stays the first-run default.
      const [days, setDays] = React.useState(() => readStoredWindow() ?? 30)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(
        async (window, { silent = false } = {}) => {
          if (!rpc) {
            setState({ loading: false, data: null, error: t('noRpc') })
            return
          }
          if (!silent) setState((prev) => ({ ...prev, loading: true, error: null }))
          try {
            const data = await rpcCall(rpc, 'report', { days: window })
            // A malformed payload degrades to an error line, never to a throw.
            if (!data || typeof data.count !== 'number' || !data.metrics || !Array.isArray(data.byModel)) {
              throw new Error(t('badPayload'))
            }
            setState({ loading: false, data, error: null })
          } catch (error) {
            // A background tick must not replace good numbers with an error
            // banner; only an explicit load may do that.
            if (silent) return
            setState({ loading: false, data: null, error: error?.message ?? String(error) })
          }
        },
        [rpc, t],
      )

      React.useEffect(() => {
        void load(days)
      }, [load, days])

      // The windows are computed from the current date on the host, so a page
      // left open across midnight would keep showing yesterday's "today". Poll
      // quietly: no spinner, and a failed tick leaves the last good numbers up.
      React.useEffect(() => {
        const id = setInterval(() => void load(days, { silent: true }), AUTO_REFRESH_MS)
        id?.unref?.()
        return () => clearInterval(id)
      }, [load, days])

      const rescan = async () => {
        if (!rpc || busy) return
        setBusy(true)
        try {
          await rpcCall(rpc, 'backfill', undefined)
          await load(days)
        } catch (error) {
          setState({ loading: false, data: null, error: error?.message ?? String(error) })
        } finally {
          setBusy(false)
        }
      }

      const header = h(
        'div',
        { style: { ...css.rowFlex, alignItems: 'center', flexWrap: 'nowrap' } },
        h(
          'div',
          // `minWidth: 0` lets the subtitle ellipsize instead of pushing the
          // window chips into a second row.
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
          h('div', { style: { fontSize: '15px', fontWeight: 600, whiteSpace: 'nowrap' } }, t('title')),
          h(
            'div',
            { style: { ...css.muted, ...css.truncate, fontSize: '11px' }, title: t('subtitle') },
            t('subtitle'),
          ),
        ),
        h(
          'div',
          { style: css.switcher },
          ...WINDOWS.map((value) =>
            h(
              'button',
              {
                key: String(value),
                style: css.chip(days === value),
                onClick: () => {
                  storeWindow(value)
                  setDays(value)
                },
              },
              windowLabel(value, t),
            ),
          ),
          // The refresh control does what the data-source button does: re-scan
          // history and then reload, so it can pick up sessions opened since.
          h(
            'button',
            {
              key: 'refresh',
              style: css.chip(false),
              title: busy ? t('rescanning') : t('rescan'),
              disabled: busy,
              onClick: () => void rescan(),
            },
            busy ? '…' : '↻',
          ),
        ),
      )

      const rescanButton = h(
        'button',
        { style: css.button, onClick: () => void rescan() },
        busy ? t('rescanning') : t('rescan'),
      )

      if (state.error) {
        return h(
          'div',
          { style: css.body },
          header,
          h(
            'div',
            { style: css.card },
            h('div', { style: css.muted }, state.error),
            h(
              'div',
              { style: { ...css.switcher, marginTop: '8px' } },
              h('button', { style: css.button, onClick: () => void load(days) }, t('retry')),
              rescanButton,
            ),
          ),
        )
      }
      if (state.loading && state.data === null) {
        return h('div', { style: css.body }, header, h('div', { style: css.muted }, t('loading')))
      }
      const data = state.data
      if (!data) return h('div', { style: css.body }, header)
      if (data.count === 0) {
        return h(
          'div',
          { style: css.body },
          header,
          h(
            'div',
            { style: css.card },
            h('div', { style: css.muted }, t('empty')),
            h('div', { style: { ...css.switcher, marginTop: '8px' } }, rescanButton),
          ),
        )
      }

      const metrics = data.metrics
      const miss = data.totals.uncachedInput + data.totals.cacheWrite
      const byModel = data.byModel.map((item) => ({
        key: `${item.provider}/${item.model}`,
        count: item.count,
        metrics: item.metrics,
      }))
      const byProvider = data.byProvider.map((item) => ({
        key: item.provider,
        count: item.count,
        metrics: item.metrics,
      }))

      return h(
        'div',
        { style: css.body },
        header,
        h(
          'div',
          { style: css.card },
          h(
            'div',
            { style: css.rowFlex },
            h(
              'div',
              null,
              h('div', { style: css.big }, tokens(metrics.total)),
              h('div', { style: { ...css.muted, fontSize: '11px' } }, t('tokensTotal')),
            ),
            h(
              'div',
              { style: { textAlign: 'right' } },
              h('div', { style: css.big }, percent(metrics.hitRate)),
              h('div', { style: { ...css.muted, fontSize: '11px' } }, t('hitRate')),
            ),
          ),
          h(StructureBar, { metrics }),
          h(
            'div',
            { style: { ...css.rowFlex, ...css.muted, fontSize: '10.5px', marginTop: '6px' } },
            h(Legend, { color: css.segHit.background, label: t('hit'), value: tokens(data.totals.cacheRead) }),
            h(Legend, { color: css.segMiss.background, label: t('miss'), value: tokens(miss) }),
            h(Legend, { color: css.segOut.background, label: t('output'), value: tokens(data.totals.output) }),
          ),
          // The two ratios sit in their own block at reading size: they are the
          // numbers checked most often, so they are not footnote-sized. Label
          // and value stay glued together on the left instead of being pushed
          // to opposite edges.
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '8px' } },
            h(
              'div',
              { style: { ...css.ratioRow, fontSize: '13px' } },
              h('span', { style: css.muted }, t('inOut')),
              h('span', { style: css.figure }, ratio(data.totals.cacheRead + miss, data.totals.output)),
            ),
            h(
              'div',
              { style: { ...css.ratioRow, fontSize: '13px' } },
              h('span', { style: css.muted }, t('structureRatio')),
              h(
                'span',
                { style: css.figure },
                tripleRatio(data.totals.cacheRead, miss, data.totals.output),
              ),
            ),
          ),
          h(
            'div',
            { style: { ...css.rowFlex, ...css.muted, fontSize: '10.5px', marginTop: '6px' } },
            h('span', null, `${data.count} ${t('calls')} · ${windowLabel(data.days, t)}`),
          ),
        ),
        h(Breakdown, { label: t('byModel'), rows: byModel, grand: metrics.total, t }),
        h(Breakdown, { label: t('byProvider'), rows: byProvider, grand: metrics.total, t }),
        h(
          'div',
          { style: css.card },
          h(
            'div',
            { style: { ...css.rowFlex, fontWeight: 600, marginBottom: '6px' } },
            h('span', null, t('source')),
            rescanButton,
          ),
          h(
            'div',
            { style: { ...css.muted, fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('span', { style: css.truncate, title: data.file }, data.file),
            h(
              'span',
              null,
              `${t('coverage')} ${data.count} ${t('calls')} · ${t('retention')} ${data.retentionDays} ${t('daysUnit')} · ${data.timeZone}`,
            ),
            h(
              'span',
              null,
              `${t('backfillShort')} ${data.backfilled} · ${t('liveShort')} ${data.live ?? 0}${
                data.droppedForMissingRoute > 0 ? ` · ${t('dropped')} ${data.droppedForMissingRoute}` : ''
              }`,
            ),
            data.backfilled > 0 ? h('span', null, t('backfillNote').replace('{n}', String(data.backfilled))) : null,
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- locale

    const LOCALE = {
      zh: {
        title: 'Token 用量',
        subtitle: '缓存命中 / 未命中 / 输出 token，按模型与提供商拆分。',
        today: '今天',
        daysUnit: '天',
        structureRatio: '命中 : 未命中 : 输出',
        inOut: '输入 : 输出',
        source: '数据源',
        rows: '行',
        dropped: '缺少模型信息的记录',
        guideTitle: 'Token 用量',
        guideDescription: '最近 30 天的缓存命中、未命中与输出用量，可按模型 / 提供商 / 天查看。',
        tokensTotal: '总计 token',
        window: '最近',
        days: ' 天',
        hitRate: '缓存命中率',
        hit: '缓存读',
        miss: '未命中',
        output: '输出',
        byModel: '按模型',
        byProvider: '按提供商',
        byDay: '按天',
        calls: '次调用',
        models: '个模型',
        providers: '个提供商',
        coverage: '覆盖',
        backfillNote: '历史回填按会话最后一次使用的模型归因；之后的新用量实时计入当天。',
        loading: '正在读取用量…',
        empty: '最近还没有记录到用量。发起一次对话后再回来看看。',
        refresh: '刷新',
        retry: '重试',
        badPayload: '数据格式异常（宿主返回的报文不完整）。',
        noRpc: '数据通道尚未就绪（宿主侧 Connection 未挂载）。',
        cardTitle: 'Token 用量统计',
        backfillShort: '历史回填',
        liveShort: '实时增量',
        rescan: '重新扫描历史',
        rescanning: '扫描中…',
      },
      en: {
        title: 'Token usage',
        subtitle: 'Cache hit / miss / output tokens, split by model and provider.',
        today: 'Today',
        daysUnit: 'd',
        structureRatio: 'hit : miss : output',
        inOut: 'input : output',
        source: 'Data source',
        rows: 'rows',
        dropped: 'records without a model',
        guideTitle: 'Token usage',
        guideDescription: 'Cache hit, cache miss and output tokens for the last 30 days, by model, provider or day.',
        tokensTotal: 'total tokens',
        window: 'last',
        days: ' days',
        hitRate: 'cache hit',
        hit: 'cache read',
        miss: 'miss',
        output: 'output',
        byModel: 'Model',
        byProvider: 'Provider',
        byDay: 'Day',
        calls: 'calls',
        models: 'models',
        providers: 'providers',
        coverage: 'covering',
        backfillNote: '{n} row(s) come from history backfill, attributed to each session\u2019s last used model.',
        loading: 'Reading usage…',
        empty: 'No usage recorded yet. Send a message and come back.',
        refresh: 'Refresh',
        retry: 'Retry',
        badPayload: 'Unexpected report payload from the host.',
        noRpc: 'The data channel is not ready (no host Connection).',
        cardTitle: 'Token usage',
        backfillShort: 'backfilled',
        liveShort: 'live',
        rescan: 'Rescan history',
        rescanning: 'Scanning…',
      },
    }

    function apply(ctx) {
      // Boot-time breadcrumbs. The client half has no file system, so the only
      // way to tell "never activated" from "activated but registered nothing"
      // is to say so out loud in the console and leave a window marker.
      try {
        console.info('[dsh-mycost] client apply', Object.keys(ctx ?? {}).join(','))
        globalThis.__dshMyCost = { applied: true, tab: false, card: false, services: {} }
      } catch {}
      try {
        mount(ctx)
        if (globalThis.__dshMyCost) globalThis.__dshMyCost.done = true
      } catch (error) {
        // One throwing client plugin aborts the whole web boot
        // (`web boot: N entry did not activate`); never let it escape.
        try {
          console.error('dsh-mycost: client mount failed', error)
        } catch {}
      }
    }

    function mount(ctx) {
      const disposers = []
      const softly = (label, run) => {
        try {
          disposers.push(run())
          try {
            console.info(`[dsh-mycost] ${label} ok`)
          } catch {}
        } catch (error) {
          try {
            console.error(`dsh-mycost: ${label} failed to register`, error)
          } catch {}
        }
      }

      // The client context is a plain service bag in some builds: `ctx.get` is
      // not guaranteed, and calling it blindly threw `ctx.get is not a function`
      // and took the whole boot down.
      const service = (name) => {
        try {
          if (typeof ctx.get === 'function') return ctx.get(name) ?? ctx[name]
        } catch {}
        return ctx[name]
      }
      const locale = service('locale')
      // `t` must never throw: the platform calls it while rendering the guide
      // list, and one throw there blanks the whole right sidebar. The locale
      // runtime is bound to a namespace (`bind(ns)`); calling `lookup` with two
      // arguments made it iterate the second one as a fallback chain and fail
      // with `TypeError: chain is not iterable`.
      let t = (key) => LOCALE.zh[key] ?? key
      softly('locale', () => {
        locale?.register?.(LOCALE_NS, LOCALE)
        const bound = typeof locale?.bind === 'function' ? locale.bind(LOCALE_NS) : null
        if (typeof bound === 'function') {
          t = (key) => {
            try {
              return bound(key) ?? LOCALE.zh[key] ?? key
            } catch {
              return LOCALE.zh[key] ?? key
            }
          }
        }
        return () => {}
      })

      // The sidebar tab, its pane body and the plugins-page card were removed on
      // request: the only UI surface is Settings → Token 用量. The RPC channel
      // and the tool are untouched.

      // Same contract persona-switcher uses: `settings.section` with a stable
      // id, an ordering hint and a label callback; the section body gets its
      // props from `inject`.
      softly(
        'settings section',
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: TAB_ID,
                order: 40,
                label: () => t('title'),
                inject: () => ({
                  rpc: service('connection')?.rpc,
                  t,
                }),
              },
              boundary('Token 用量', SettingsSection),
            ),
          ),
      )

      // The glyph for our row. The shell looks it up by section id, so this is the
      // whole contract — no nav DOM is touched.
      softly('settings icon', () =>
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: TAB_ID }, boundary('Token 用量图标', SettingsIcon)),
        ),
      )

      try {
        ctx.effect(
          () => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose?.()
              } catch {}
            }
          },
          'dsh-mycost: settings section',
        )
      } catch {}
    }

    exports.apply = apply
    // Declared services keep the loader from activating us before the sidebar
    // and locale registries exist (image-lite declares the same names).
    exports.inject = ['slots', 'locale', 'connection']
    exports.lib = { tokens, percent }
    return module.exports
  },
})
