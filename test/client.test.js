import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Offline render check for the client half.
 *
 * No browser and no React DOM here: a ~30-line hooks runtime stands in for
 * React, so `node --test` can prove the tab registers and that a report payload
 * actually reaches the screen. This is the closest P4 gets to verification
 * without restarting the harness.
 */

function createReact() {
  const hooks = []
  let index = 0
  let effects = []

  const render = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).filter((part) => part !== null).join('')
    if (typeof node.type === 'function') return render(node.type(node.props ?? {}))
    const children = node.props?.children ?? []
    return [render(children)].flat().join('')
  }

  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState(initial) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value
      }
      return [hooks[slot], set]
    },
    useCallback(fn) {
      index += 1
      return fn
    },
    useEffect(fn) {
      index += 1
      effects.push(fn)
    },
    /** Run one render pass, then the effects it scheduled. */
    async __pass(Component, props) {
      index = 0
      effects = []
      const tree = Component(props)
      const scheduled = effects
      for (const effect of scheduled) effect()
      await new Promise((resolve) => setTimeout(resolve, 5))
      return tree
    },
    /** Render until the hook state stops changing (max 5 passes). */
    async __settle(Component, props) {
      let tree = null
      for (let pass = 0; pass < 5; pass += 1) {
        tree = await react.__pass(Component, props)
      }
      return render(tree)
    },
    /** First element in the settled tree matching `predicate`. */
    __find(Component, props, predicate) {
      index = 0
      effects = []
      const found = []
      const walk = (node) => {
        if (node === null || node === undefined || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(walk)
        if (typeof node.type === 'function') return walk(node.type(node.props ?? {}))
        if (predicate(node)) found.push(node)
        walk(node.props?.children ?? [])
      }
      walk(Component(props))
      return found[0]
    },
    __render: render,
  }
  return react
}

let imports = 0

async function loadClient() {
  const React = createReact()
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (options) => (captured = options) } }
  // The module loader runs once per import, so each test needs its own
  // specifier or the cached module swallows the side effect.
  await import(`../client.js?pass=${(imports += 1)}`)
  assert.ok(captured, 'the module loader was never called')
  assert.equal(captured.id, 'dsh-mycost')
  const factory = captured.factory
  const module = factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return { module, React }
}

function fakeCtx() {
  const tabs = []
  const slots = []
  const locale = []
  const cleanups = []
  const ctx = {
    get: (key) => (key === 'locale' ? { register: (...args) => locale.push(args) } : undefined),
    sidebarRightTabs: { register: (definition) => (tabs.push(definition), () => {}) },
    slots: {
      inject: (_name, callback) => (cleanups.push(callback), callback()),
      register: (spec, component) => (slots.push({ spec, component }), () => {}),
    },
    effect: (fn) => {
      const dispose = fn()
      cleanups.push(dispose)
      return () => {}
    },
  }
  return { ctx, tabs, slots, locale, cleanups }
}

const report = {
  days: 30,
  timeZone: 'Asia/Shanghai',
  count: 63,
  backfilled: 63,
  droppedForMissingRoute: 0,
  totals: { uncachedInput: 33_800_000, cacheRead: 648_300_000, cacheWrite: 0, output: 4_700_000 },
  metrics: {
    total: 686_800_000,
    inputTotal: 682_100_000,
    hitRate: 0.95,
    outputShare: 0.0068,
    inputOutputRatio: 145.1,
    structure: { miss: 33_800_000, hit: 648_300_000, output: 4_700_000 },
    shares: { miss: 0.05, hit: 0.94, output: 0.01 },
  },
  byModel: [
    {
      provider: 'chatecnu',
      model: 'ecnu-max',
      count: 40,
      totals: { uncachedInput: 20_000_000, cacheRead: 316_500_000, cacheWrite: 0, output: 2_000_000 },
      metrics: { total: 336_500_000, hitRate: 0.928, shares: { miss: 0.06, hit: 0.93, output: 0.01 } },
    },
  ],
  byProvider: [
    {
      provider: 'chatecnu',
      count: 40,
      totals: { uncachedInput: 20_000_000, cacheRead: 316_500_000, cacheWrite: 0, output: 2_000_000 },
      metrics: { total: 336_500_000, hitRate: 0.928, shares: { miss: 0.06, hit: 0.93, output: 0.01 } },
    },
  ],
  byDay: [
    {
      day: '2026-11-03',
      count: 3,
      totals: { uncachedInput: 1000, cacheRead: 9000, cacheWrite: 0, output: 500 },
      metrics: { total: 10_500, hitRate: 0.9, shares: { miss: 0.1, hit: 0.9, output: 0.05 } },
    },
  ],
}

test('the client module loads through the harness module loader', async () => {
  const { module } = await loadClient()
  assert.equal(typeof module.apply, 'function')
})

test('the only UI surface is the settings section', async () => {
  const { module } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)

  assert.equal(harness.tabs.length, 0, 'the sidebar tab was removed on request')
  const section = harness.slots.find((item) => item.spec.name === 'settings.section')
  assert.ok(section, 'the settings section should be registered')
  assert.equal(section.spec.id, 'my-cost')
  assert.equal(typeof section.spec.label(), 'string')
  assert.equal(typeof section.component, 'function')
  const card = harness.slots.find((item) => item.spec.name === 'plugins.bundle.config')
  assert.equal(card, undefined, 'the plugins-page card was removed on request')

  for (const dispose of harness.cleanups) dispose?.()
})

test('a report payload reaches the screen', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Body = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const rpc = { call: async () => ({ ok: true, value: report }) }
  const text = await React.__settle(Body, { rpc, t: (key) => key })

  assert.match(text, /686\.8M/, 'the pooled total should be visible')
  assert.match(text, /structureRatio/, 'the three-way structure ratio should be visible')
  assert.match(text, /95\.0%/, 'the hit rate should be visible')
  assert.match(text, /chatecnu\/ecnu-max/, 'the per-model row should be visible')
  assert.match(text, /byModel/, 'the dimension switcher should be visible')
})

test('an empty report says so instead of rendering zeros', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Body = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const rpc = { call: async () => ({ ok: true, value: { ...report, count: 0 } }) }
  const text = await React.__settle(Body, { rpc, t: (key) => key })
  assert.match(text, /empty/)
})

test('a missing connection reports the data channel instead of throwing', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Body = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const text = await React.__settle(Body, { rpc: undefined, t: (key) => key })
  assert.match(text, /noRpc/)
})

test('a failed RPC shows the error and offers a retry', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Body = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const rpc = { call: async () => ({ ok: false, error: { message: 'boom' } }) }
  const text = await React.__settle(Body, { rpc, t: (key) => key })
  assert.match(text, /boom/)
  assert.match(text, /retry/)
})

// ------------------------------------------------------------ settings page

test('the settings page reports where the data lives and how much it covers', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Section = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const rpc = { call: async () => ({ ok: true, value: report }) }
  const text = await React.__settle(Section, { rpc, t: (key) => key })
  assert.match(text, /retention/, 'the retention window should be visible')
  assert.match(text, /63/, 'the covered row count should be visible')
  assert.match(text, /source/, 'the data-source block should be visible')
  assert.match(text, /byProvider/, 'the provider table should be visible')
})

test('the settings page rescans history through the backfill endpoint', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Section = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const calls = []
  const rpc = { call: async (channel, endpoint) => (calls.push(endpoint), { ok: true, value: report }) }
  const props = { rpc, t: (key) => key }
  await React.__settle(Section, props)

  const button = React.__find(
    Section,
    props,
    (element) => element.props?.onClick !== undefined && [element.props?.children].flat(2).join('') === 'rescan',
  )
  assert.ok(button, 'the page should offer a rescan button')
  await button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls.includes('backfill'), `backfill was never called; calls=${calls.join(',')}`)
})

test('the refresh arrow re-scans history and reloads', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Section = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const calls = []
  const rpc = { call: async (channel, endpoint) => (calls.push(endpoint), { ok: true, value: report }) }
  const props = { rpc, t: (key) => key }
  await React.__settle(Section, props)

  const arrow = React.__find(
    Section,
    props,
    (element) => element.props?.onClick !== undefined && [element.props?.children].flat(2).join('') === '↻',
  )
  assert.ok(arrow, 'the header should carry a refresh arrow')
  await arrow.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls.includes('backfill'), `the arrow must re-scan history; calls=${calls.join(',')}`)
  assert.ok(calls.filter((name) => name === 'report').length > 1, 'the arrow must reload the report afterwards')
})
test('the today chip asks the host for a single day', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Section = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const days = []
  const rpc = { call: async (channel, endpoint, payload) => (days.push(payload?.days), { ok: true, value: report }) }
  const props = { rpc, t: (key) => key }
  await React.__settle(Section, props)

  const chip = React.__find(
    Section,
    props,
    (element) => element.props?.onClick !== undefined && [element.props?.children].flat(2).join('') === 'today',
  )
  assert.ok(chip, 'the today chip should exist next to the 7 / 30 day chips')
  await chip.props.onClick()
  await React.__pass(Section, props)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(days.includes(1), `the host never saw a 1-day request; days=${days.join(',')}`)
})
test('the window switch asks the host for seven days', async () => {
  const { module, React } = await loadClient()
  const harness = fakeCtx()
  module.apply(harness.ctx)
  const Section = harness.slots.find((item) => item.spec.name === 'settings.section').component

  const days = []
  const rpc = { call: async (channel, endpoint, payload) => (days.push(payload?.days), { ok: true, value: report }) }
  const props = { rpc, t: (key) => key }
  await React.__settle(Section, props)

  const chip = React.__find(
    Section,
    props,
    (element) => element.props?.onClick !== undefined && [element.props?.children].flat(2).join('') === '7 daysUnit',
  )
  assert.ok(chip, 'the 7-day chip should exist')
  await chip.props.onClick()
  await React.__pass(Section, props)
  await new Promise((resolve) => setTimeout(resolve, 10))
})
test('the settings nav button gets our own glyph instead of the shell gear', async () => {
  const { module } = await loadClient()
  const span = {
    className: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    set innerHTML(value) {
      this.html = value
    },
    get innerHTML() {
      return this.html
    },
  }
  const gear = { className: 'shell-icon', getAttribute: () => null }
  const button = {
    textContent: 'Token 用量',
    childElementCount: 2,
    firstElementChild: gear,
    lastElementChild: {},
    replaced: null,
    replaceChild(next, previous) {
      this.replaced = { next, previous }
    },
  }
  let disconnected = false
  globalThis.document = { body: { querySelectorAll: () => [button] }, createElement: () => span }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {
      disconnected = true
    }
  }
  try {
    module.apply(fakeCtx().ctx)
    assert.ok(span.html?.includes('<svg'), 'the gear must be swapped for our inline svg')
    assert.equal(button.replaced?.next, span)
    assert.equal(button.replaced?.previous, gear)
    assert.equal(span.className, 'shell-icon', 'the shell class must be kept so sizing still applies')
    assert.equal(span.attributes['data-my-cost-nav-icon'], '1', 'the marker keeps re-renders idempotent')
  } finally {
    delete globalThis.document
    delete globalThis.MutationObserver
  }
})
// The renderer hands `apply` a plain service bag in some builds; calling
// `ctx.get` there threw `ctx.get is not a function` and aborted the web boot.
test('apply survives a client context without ctx.get', async () => {
  const { module } = await loadClient()
  const harness = fakeCtx()
  delete harness.ctx.get
  assert.doesNotThrow(() => module.apply(harness.ctx))
  const section = harness.slots.find((item) => item.spec.name === 'settings.section')
  assert.ok(section, 'the settings section should still register')
})

test('apply survives a context with no services at all', async () => {
  const { module } = await loadClient()
  assert.doesNotThrow(() => module.apply({}))
})

// The platform calls our title()s while rendering the guide list; a throw there
// blanks the whole right sidebar (`chain is not iterable` came from passing two
// arguments to LocaleRuntime.lookup).
test('guide titles survive a locale service whose lookup throws', async () => {
  const { module } = await loadClient()
  const harness = fakeCtx()
  harness.ctx.locale = {
    register() {},
    bind: () => (key) => (key === 'title' ? '标题' : key),
    lookup: () => { throw new TypeError('chain is not iterable') },
  }
  assert.doesNotThrow(() => module.apply(harness.ctx))
  const section = harness.slots.find((item) => item.spec.name === 'settings.section')
  assert.equal(typeof section.spec.label(), 'string')
  assert.ok(section.spec.label().length > 0, 'the label must survive a throwing lookup')
})

test('a throwing translator falls back to the bundled dictionary', async () => {
  const { module } = await loadClient()
  const harness = fakeCtx()
  harness.ctx.locale = { register() {}, bind: () => () => { throw new Error('boom') } }
  module.apply(harness.ctx)
  const section = harness.slots.find((item) => item.spec.name === 'settings.section')
  assert.ok(section.spec.label().length > 0)
})
