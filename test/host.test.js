import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, Config } from '../index.js'

/** Minimal Cordis-shaped context: records listeners, effects, tools and RPC. */
function fakeContext({ sessions = [], cold = [] } = {}) {
  const listeners = new Map()
  const tools = []
  const effects = []
  const registered = []
  const ctx = {
    logger: () => ({ warn: () => {} }),
    get: (key) => (key === 'sessions' ? { list: async () => sessions } : undefined),
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    inject(_deps, callback) {
      callback(scoped)
    },
    tools: {
      register(definition) {
        tools.push(definition)
      },
    },
  }
  const routes = []
  const scoped = {
    get: (key) => {
      if (key === 'sessions') return { list: async () => sessions }
      if (key === 'sessionProjections') return { stateOf: (session, name) => session?.projections?.[name] }
      if (key === 'sessionQuery') return { listSessions: async () => cold.map((header) => ({ header })) }
      if (key === 'sessionProjectionCache') return { cachedSnapshot: (header) => ({ values: header?.values ?? {} }) }
      if (key === 'connection') return { requestRejection: () => undefined }
      if (key === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect: ctx.effect,
  }
  return {
    ctx,
    tools,
    registered,
    routes,
    sessions,
    emit(event, session = { id: 's1' }) {
      for (const handler of listeners.get('session/event') ?? []) handler(session, event)
    },
    /** Same feed, opposite argument order: the plugin must not depend on it. */
    emitReversed(event, session = { id: 's1' }) {
      for (const handler of listeners.get('session/event') ?? []) handler(event, session)
    },
  }
}

/** Drive the plugin's own HTTP route the way the web server does. */
function routeCall(handler) {
  return async (endpoint, payload) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'test', method: endpoint, payload })
    const req = {
      method: 'POST',
      url: `/my-cost/${endpoint}`,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield body
      },
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        this.body = chunk ?? ''
      },
    }
    await handler(req, res)
    const parsed = JSON.parse(res.body)
    if (!parsed.result?.ok) throw new Error(parsed.result?.error?.message ?? 'rpc failed')
    return parsed.result.value
  }
}

async function boot(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mycost-home-'))
  process.env.DSH_HOME = home
  const harness = fakeContext(options)
  apply(harness.ctx, { retentionDays: 30, timeZone: 'Asia/Shanghai' })
  const route = harness.routes.at(-1)
  assert.equal(route?.path, '/my-cost')
  assert.equal(route?.kind, 'prefix')
  return { ...harness, home, route, rpc: routeCall(route.handler) }
}

const usage = (input, read, out) => ({
  inputTokens: input,
  cacheReadTokens: read,
  outputTokens: out,
})

const request = (provider, model) => ({ type: 'request/context', data: { provider, model } })
const message = (turn, step, counts) => ({
  type: 'assistant/message',
  ts: Date.parse('2026-11-03T04:00:00Z'),
  data: { turn, step, usage: counts && usage(...counts) },
})

test('the plugin exports a name and a config schema with defaults', () => {
  assert.equal(name, 'my-cost')
  const value = Config({})
  assert.equal(value.retentionDays, 30)
  assert.equal(value.timeZone, 'Asia/Shanghai')
})

test('an unknown RPC endpoint fails loudly', async () => {
  const harness = await boot()
  await assert.rejects(() => harness.rpc('nope', {}), /unknown endpoint/)
})

// ------------------------------------------------------------------ backfill
/**
 * One `sessions.list()` entry as the harness builds it.
 *
 * The host hands back session objects; cached projections are read through
 * `sessionProjections.stateOf(session, key)`. `tokenUsage` nests its four
 * counters under `totals`; `modelSelection` carries `lastUsed`.
 */
const listed = (sessionId, over = {}) => ({
  id: sessionId,
  updatedAt: Date.parse('2026-11-03T04:00:00Z'),
  projections: {
    tokenUsage: {
      totals: { uncachedInputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 500 },
      last: { turn: 6, step: 3, buckets: { uncachedInputTokens: 80, cacheReadTokens: 110592, cacheWriteTokens: 0, outputTokens: 283 } },
    },
    modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max', reasoningEffort: 'high' }, pending: null },
  },
  ...over,
})

test('backfill imports a cold session from its cached projections', async () => {
  const harness = await boot({ sessions: [listed('s-cold')] })
  await harness.rpc('backfill', {})
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 1)
  assert.equal(report.backfilled, 1)
  assert.equal(report.byModel[0].model, 'ecnu-max')
  assert.equal(report.totals.cacheRead, 9000)
})

test('backfill skips sessions without usage or without a last-used model', async () => {
  const harness = await boot({
    sessions: [
      listed('s-a', { projections: {} }),
      listed('s-b', {
        projections: {
          values: { tokenUsage: { totals: { uncachedInputTokens: 1, outputTokens: 1 } } },
        },
      }),
      listed('s-c', { projections: undefined }),
    ],
  })
  await harness.rpc('backfill', {})
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 0)
})

// ------------------------------------------------------- cold sessions

/**
 * One persisted-but-not-opened session: `sessionQuery.listSessions()` returns
 * the header, `sessionProjectionCache.cachedSnapshot(header)` the cached
 * projection values (already unwrapped).
 */
const coldHeader = (id, over = {}) => ({
  id,
  cwd: '/workspace',
  createdAt: Date.parse('2026-10-20T02:00:00Z'),
  values: {
    tokenUsage: { totals: { uncachedInputTokens: 2000, cacheReadTokens: 18_000, cacheWriteTokens: 0, outputTokens: 900 } },
    modelSelection: { lastUsed: { provider: 'xiaomi', model: 'mimo-v2.6-flash' } },
    sessionListMetadata: { blank: false, lastPromptAt: Date.parse('2026-11-01T10:00:00Z') },
  },
  ...over,
})

test('backfill imports sessions this process never opened, from the projection cache', async () => {
  const harness = await boot({ sessions: [], cold: [coldHeader('s-cold-1'), coldHeader('s-cold-2')] })
  const result = await harness.rpc('backfill', {})
  assert.equal(result.imported, 2, 'both cold sessions must be imported')

  const report = await harness.rpc('report', {})
  assert.equal(report.count, 2)
  assert.equal(report.backfilled, 2)
  assert.equal(report.totals.cacheRead, 36_000)
  assert.equal(report.byModel[0].model, 'mimo-v2.6-flash')
  // The row must land on the day it was last prompted, not on today.
  assert.equal(report.byDay[0].day, '2026-11-01')
})

test('a cold session without cached projections is skipped, not counted as zero', async () => {
  const harness = await boot({
    sessions: [],
    cold: [coldHeader('s-empty', { values: {} }), coldHeader('s-ok')],
  })
  await harness.rpc('backfill', {})
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 1)
  assert.equal(report.byModel[0].model, 'mimo-v2.6-flash')
})

test('a session that is both live and cached is imported once', async () => {
  const harness = await boot({
    sessions: [listed('s-both')],
    cold: [coldHeader('s-both')],
  })
  const result = await harness.rpc('backfill', {})
  assert.equal(result.imported, 1, 'the second sighting of the same session must not add a row')
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 1)
  assert.equal(report.byModel[0].model, 'ecnu-max', 'the live session values win')
})

// one throwing entry aborts the entire web boot.
test('apply contains a throwing tool registry and records why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mycost-guard-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const broken = {
      logger: () => ({ warn: () => {} }),
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
      inject: () => {},
      tools: {
        register() {
          throw new Error('bad definition')
        },
      },
    }
    assert.doesNotThrow(() => apply(broken, { retentionDays: 30 }))
    const log = await readFile(join(dir, 'my-cost', 'boot.log'), 'utf8')
    assert.match(log, /tools\.register/, 'boot.log should name the failing step')
    assert.match(log, /bad definition/, 'boot.log should carry the original message')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// Regression: the channel is a webServer prefix route. When it was registered
// through a non-existent `connection.register` the client saw HTTP 405 for
// every call, including the very first `report`.
test('the RPC route speaks the client-request wire format', async () => {
  const harness = await boot()
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'report', payload: {} })
  const req = { method: 'POST', url: '/my-cost/report', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield body } }
  const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(chunk) { this.body = chunk ?? '' } }
  await harness.route.handler(req, res)
  assert.equal(res.status, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.rpcId, 'r1')
  assert.equal(parsed.result.ok, true)
})

test('a GET on the route is rejected instead of silently succeeding', async () => {
  const harness = await boot()
  const req = { method: 'GET', url: '/my-cost/report', headers: {}, async *[Symbol.asyncIterator]() {} }
  const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(chunk) { this.body = chunk ?? '' } }
  await harness.route.handler(req, res)
  assert.equal(res.status, 405)
})


test('a live session is imported once, then topped up by the delta', async () => {
  const sessions = [listed('s1')]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  const first = await harness.rpc('report', {})
  assert.equal(first.count, 1)
  assert.equal(first.totals.cacheRead, 9000)
  assert.equal(first.byModel[0].model, 'ecnu-max')

  sessions[0] = listed('s1', {
    projections: {
      tokenUsage: {
        totals: { uncachedInputTokens: 1600, cacheReadTokens: 14_000, cacheWriteTokens: 0, outputTokens: 570 },
      },
      modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max' } },
    },
  })
  await harness.rpc('backfill', {})

  // Assert the end state, not the RPC counter: the boot-time top-up may be the
  // pass that consumes the delta.
  const after = await harness.rpc('report', {})
  assert.equal(after.count, 2, 'one import row plus one delta row')
  assert.equal(after.totals.uncachedInput, 1600, 'import + delta must equal the session total')
  assert.equal(after.totals.cacheRead, 14_000)
  assert.equal(after.totals.output, 570)
  assert.equal(after.backfilled, 1)
  assert.equal(after.live, 1)
})

test('an unchanged session writes no delta', async () => {
  const harness = await boot({ sessions: [listed('s1')] })
  await harness.rpc('backfill', {})
  const second = await harness.rpc('backfill', {})
  assert.equal(second.live, 0)
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 1)
  assert.equal(report.totals.uncachedInput, 1000)
})

test('a session with no last-used model is skipped instead of guessed', async () => {
  const harness = await boot({
    sessions: [
      listed('s1', {
        projections: {
          tokenUsage: { totals: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } },
        },
      }),
    ],
  })
  await harness.rpc('backfill', {})
  assert.equal((await harness.rpc('report', {})).count, 0)
})

test('a mid-session model switch puts the new delta on the new model', async () => {
  const sessions = [listed('s1')]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  sessions[0] = listed('s1', {
    projections: {
      tokenUsage: {
        totals: { uncachedInputTokens: 1600, cacheReadTokens: 14_000, cacheWriteTokens: 0, outputTokens: 570 },
      },
      modelSelection: { lastUsed: { provider: 'agnes', model: 'agnes-3.0-flash' } },
    },
  })
  await harness.rpc('backfill', {})

  const byModel = (await harness.rpc('report', {})).byModel
  assert.deepEqual(byModel.map((row) => row.model).sort(), ['agnes-3.0-flash', 'ecnu-max'])
  const switched = byModel.find((row) => row.model === 'agnes-3.0-flash')
  assert.equal(switched.totals.uncachedInput, 600, 'the delta belongs to the model that produced it')
})

test('an event only schedules a top-up, it never writes usage itself', async () => {
  const harness = await boot({ sessions: [listed('s1')] })
  await harness.rpc('backfill', {})
  harness.emit(request('chatecnu', 'ecnu-max'))
  harness.emit(message(1, 1, [10, 90, 5]))
  const report = await harness.rpc('report', {})
  assert.equal(report.count, 1, 'only the imported row exists')
  assert.equal(report.live, 0, 'the event payload must not become a row')
  assert.equal(report.totals.uncachedInput, 1000)
})

test('the session/event argument order does not have to be trusted', async () => {
  const harness = await boot({ sessions: [listed('s1')] })
  await harness.rpc('backfill', {})
  harness.emitReversed(request('p', 'm'))
  harness.emitReversed(message(1, 1, [5, 5, 5]))
  assert.equal((await harness.rpc('report', {})).count, 1)
})

test('growth after import lands on today as its own live row', async () => {
  const sessions = [listed('s1', { updatedAt: Date.now() - 86_400_000 })]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  assert.equal((await harness.rpc('report', { days: 1 })).count, 0, 'yesterday’s import is not today')

  sessions[0] = listed('s1', {
    updatedAt: Date.now(),
    projections: {
      tokenUsage: {
        totals: { uncachedInputTokens: 1200, cacheReadTokens: 9500, cacheWriteTokens: 0, outputTokens: 640 },
      },
      modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max' } },
    },
  })
  await harness.rpc('backfill', {})

  const today = await harness.rpc('report', { days: 1 })
  assert.equal(today.count, 1, 'only the delta belongs to today')
  assert.equal(today.totals.uncachedInput, 200)
  assert.equal(today.totals.cacheRead, 500)
  assert.equal(today.totals.output, 140)
})

test('backfill never re-imports a session the store already has', async () => {
  const harness = await boot({ sessions: [listed('s1')] })
  const first = await harness.rpc('backfill', {})
  const second = await harness.rpc('backfill', {})
  assert.equal(first.imported, 1)
  assert.equal(second.imported, 0, 're-importing would double count the baseline')
  assert.equal((await harness.rpc('report', {})).count, 1)
})

test('the usage_report tool renders totals and the per-model breakdown', async () => {
  const harness = await boot({ sessions: [listed('s1')] })
  await harness.rpc('backfill', {})
  const tool = harness.tools.find((item) => item.name === 'usage_report')
  assert.ok(tool, 'usage_report should be registered')
  const text = await tool.execute({})
  assert.match(text, /ecnu-max/)
  assert.match(text, /缓存命中率 90\.0%/)
  assert.match(text, /调用 1 次/)
})

test('a session resumed after its history expired counts only the new tokens', async () => {
  const expired = Date.now() - 40 * 86_400_000
  const sessions = [listed('s1', { updatedAt: expired })]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  assert.equal((await harness.rpc('report', { days: 30 })).count, 0, 'the import lands before the window')

  sessions[0] = listed('s1', {
    updatedAt: Date.now(),
    projections: {
      tokenUsage: {
        totals: { uncachedInputTokens: 1200, cacheReadTokens: 9500, cacheWriteTokens: 0, outputTokens: 640 },
      },
      modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max' } },
    },
  })
  await harness.rpc('backfill', {})

  const report = await harness.rpc('report', { days: 30 })
  assert.equal(report.count, 1)
  assert.equal(report.totals.uncachedInput, 200, 'only the delta since the expired baseline')
  assert.equal(report.totals.cacheRead, 500)
  assert.equal(report.totals.output, 140)
})

test('a forked session inherits its baseline instead of re-counting the parent', async () => {
  const sessions = [listed('parent')]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  const first = await harness.rpc('report', { days: 30 })
  assert.equal(first.totals.cacheRead, 9000, 'the parent is imported once')

  // Same totals as the parent, but this is a seeded copy of it: nothing new was
  // spent, so the report must not move.
  sessions.push(
    listed('child', {
      isSeeded: true,
      parentSession: 'parent',
      updatedAt: Date.now(),
    }),
  )
  await harness.rpc('backfill', {})
  const afterFork = await harness.rpc('report', { days: 30 })
  assert.equal(afterFork.totals.cacheRead, 9000, 'the inherited history must not be counted twice')
  assert.equal(afterFork.totals.output, 500)
  assert.equal(afterFork.count, 1, 'a seeded baseline is not a call')

  // Real work in the fork is still counted, and only that work.
  sessions[1] = listed('child', {
    isSeeded: true,
    parentSession: 'parent',
    updatedAt: Date.now(),
    projections: {
      tokenUsage: {
        totals: { uncachedInputTokens: 1200, cacheReadTokens: 11500, cacheWriteTokens: 0, outputTokens: 640 },
        last: { turn: 6, step: 3, buckets: {} },
      },
      modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max' }, pending: null },
    },
  })
  await harness.rpc('backfill', {})
  const grown = await harness.rpc('report', { days: 30 })
  assert.equal(grown.totals.cacheRead, 9000 + 2500, 'only the post-fork delta counts')
  assert.equal(grown.totals.output, 500 + 140)
  assert.equal(grown.count, 2, 'one parent call plus one delta from the fork')
})

test('re-importing a fork is idempotent: the baseline is topped up once', async () => {
  const sessions = [listed('parent')]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  sessions.push(listed('child', { isSeeded: true, parentSession: 'parent', updatedAt: Date.now() }))

  await harness.rpc('backfill', {})
  const once = await harness.rpc('report', { days: 30 })
  await harness.rpc('backfill', {})
  const twice = await harness.rpc('report', { days: 30 })

  assert.equal(twice.totals.cacheRead, once.totals.cacheRead)
  assert.equal(twice.count, once.count)
  assert.equal(twice.stored, once.stored, 'a second pass must not write another baseline row')
})

test('a fork smaller than its parent contributes nothing', async () => {
  const sessions = [listed('parent')]
  const harness = await boot({ sessions })
  await harness.rpc('backfill', {})
  sessions.push(
    listed('child', {
      isSeeded: true,
      parentSession: 'parent',
      updatedAt: Date.now(),
      projections: {
        tokenUsage: {
          totals: { uncachedInputTokens: 900, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 400 },
          last: { turn: 5, step: 2, buckets: {} },
        },
        modelSelection: { lastUsed: { provider: 'chatecnu', model: 'ecnu-max' }, pending: null },
      },
    }),
  )

  await harness.rpc('backfill', {})
  const report = await harness.rpc('report', { days: 30 })
  assert.equal(report.totals.cacheRead, 9000, 'only the parent is real usage')
  assert.equal(report.totals.output, 500)
  assert.equal(report.count, 1, 'the fork never spent anything of its own')
})
