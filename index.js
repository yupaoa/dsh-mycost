// dsh-mycost — host half.
//
// Inputs are documented harness seams only: the `session/event` feed (with the
// `request/context` and `assistant/message` payloads it carries) and the
// Connection RPC channel below. Nothing here reads a harness-internal file.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'

import { createStore } from './store.js'
import { BUCKETS, cutoffDay, formatTokens, makeRow, rollup, dayKey } from './wire.js'

export const name = 'my-cost'

/** Only `tools` is required; Connection RPC is optional and probed at mount. */
export const inject = ['tools']

export const Config = z.object({
  retentionDays: z.number().min(1).max(365).default(30),
  timeZone: z.string().default('Asia/Shanghai'),
})

export const CHANNEL = '/my-cost'

/**
 * Projection keys this plugin reads. `snapshot(session, keys)` computes only the
 * named units, so the list is also the cost bound of every read.
 */
const PROJECTION_KEYS = ['tokenUsage', 'modelSelection', 'sessionListMetadata']

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Fallback cadence of the real-time top-up when no projection hook fires. */
const SYNC_INTERVAL_MS = 20 * 1000

/** Bursts of projection changes collapse into one write pass after this quiet gap. */
const SYNC_DEBOUNCE_MS = 700

/** `session/event` is `(session, event)`; tolerate the reversed shape defensively. */
function splitArgs(first, second) {
  const looksLikeEvent = (value) => value !== null && typeof value === 'object' && typeof value.type === 'string'
  return looksLikeEvent(first) ? { event: first, session: second } : { event: second, session: first }
}

/** Route for one session, from the newest logged request envelope. */
function routeOf(event, previous) {
  if (event.type === 'request/context') {
    const provider = event.data?.provider
    const model = event.data?.model
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
    return previous
  }
  if (event.type === 'request/header') {
    const config = event.data?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  return previous
}

/**
 * A plugin that throws inside `apply` aborts the whole web boot
 * (`web boot: N entry did not activate`) and the harness reports nothing
 * beyond the entry name. This plugin must never be able to do that: every
 * mount step is contained, and a failure is written to `boot.log` next to the
 * data file so the cause survives the crash dialog.
 */
function recordBootFailure(step, error) {
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'my-cost')
  const detail = `${new Date().toISOString()} step=${step}\n${error?.stack ?? error}\n\n`
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), detail)
  } catch {
    // Ignore: the console fallback below still reports the failure.
  }
  try {
    console.error(`dsh-mycost: ${step} failed`, error)
  } catch {
    // Ignore.
  }
}

export function apply(ctx, config = {}) {
  let step = 'init'
  try {
    mount(ctx, config, (next) => {
      step = next
    })
  } catch (error) {
    recordBootFailure(step, error)
  }
}

/**
 * RPC transport for the client half: POST `<CHANNEL>/<endpoint>` carrying
 * `{type:'client-request', method, payload}`, answered with
 * `{type:'server-response', rpcId, result}`.
 */
async function serveRpc(req, res, admit, handle) {
  let rejection
  try {
    rejection = admit(req)
  } catch {
    rejection = 500
  }
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const endpoint = url.pathname.startsWith(`${CHANNEL}/`) ? url.pathname.slice(CHANNEL.length + 1) : ''
  if (req.method !== 'POST' || endpoint === '') {
    res.writeHead(req.method === 'POST' ? 404 : 405)
    res.end()
    return
  }
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
  const reply = (result) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }
  if (message?.type !== 'client-request' || message.method !== endpoint) {
    reply({ ok: false, error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} } })
    return
  }
  try {
    reply(await handle(endpoint, message.payload))
  } catch (error) {
    reply({
      ok: false,
      error: { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: {} },
    })
  }
}

function mount(ctx, config, mark = () => {}) {
  mark('config')
  // Unconditional mount marker: without it, "no data on disk" is ambiguous
  // between "never mounted" and "mounted but nothing recorded yet".
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'my-cost')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), `${new Date().toISOString()} mounted\n`)
  } catch (error) {
    recordBootFailure('mount-marker', error)
  }
  const retentionDays = config.retentionDays ?? 30
  const timeZone = config.timeZone ?? 'Asia/Shanghai'
  const baseDir = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(baseDir, 'my-cost', 'usage.v1.jsonl')
  const warn = (message) => {
    try {
      ctx.logger?.('my-cost')?.warn?.(message) ?? console.warn(message)
    } catch {
      // A logging failure must never break accounting.
    }
  }
  const store = createStore({ file, onWarn: warn })

  /** sessionId → {provider, model}; overwritten whenever the route changes. */
  const routes = new Map()
  /** Sessions observed before any route was logged. */
  const sessionsSeen = new Set()
  /** Session store, captured once the scoped service becomes available. */
  let sessions
  /** Session projection reader (`tokenUsage`, `modelSelection`). */
  let projections
  /** Cold-session enumerator (`sessionQuery.listSessions()`). */
  let coldQuery
  /** Cached projections for sessions that are not live. */
  let projectionCache
  let droppedForMissingRoute = 0

  const cutoff = () => cutoffDay(Date.now(), retentionDays, timeZone)

  async function prune() {
    try {
      await store.load()
      const removed = await store.prune(cutoff())
      if (removed > 0) warn(`my-cost: pruned ${removed} row(s) older than ${cutoff()}`)
    } catch (error) {
      warn(`my-cost: prune failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Client views at a Session's cursor — the supported read face.
   *
   * `sessionProjections.stateOf(session, key)` is deprecated since 0.2.2-rc.1
   * (one warning per key per boot) and returns host state; `snapshot` returns the
   * same units as their wire views, which is what the two read sites below want.
   * The views differ from host state only in wrapping — `tokenUsage`'s view *is*
   * its totals slice, `modelSelection`'s keeps `lastUsed` — so both keep their
   * `?.totals ?? x` / `?.lastUsed ?? x` tolerance for either face.
   *
   * `values` is empty when no selected unit is registered, so an absent
   * projection is simply a missing key, never an error.
   */
  function snapshotValues(session) {
    if (typeof projections?.snapshot !== 'function') return undefined
    try {
      return projections.snapshot(session, PROJECTION_KEYS)?.values
    } catch (error) {
      warn(`my-cost: projection snapshot failed: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * Rebuild history from the sessions the harness already has on disk.
   *
   * Session summaries carry their cached `tokenUsage` and `modelSelection`
   * projections, so this reads the documented Host service instead of opening
   * cold session bodies or parsing session files. The attribution is per
   * session, not per call: a session that switched models lands entirely on its
   * last used route, which is why those rows are marked `src: 'backfill'`.
   */
  async function backfill() {
    // Two sources, because one is not enough:
    //  * `sessions.list()` knows only the sessions this process has opened, and
    //    `sessionController` (the cold-safe list) is a namespaced service a root
    //    plugin cannot reach — that is why the first imports brought in one row.
    //  * `sessionQuery.listSessions()` enumerates every persisted session, and
    //    `sessionProjectionCache.cachedSnapshot(header)` returns the cached
    //    projection values for the ones that are not live.
    const store_ = sessions ?? ctx.get?.('sessions')
    const query = coldQuery
    const cache = projectionCache
    if (typeof store_?.list !== 'function' && typeof query?.listSessions !== 'function') {
      warn('my-cost: no session source is available; history will start at this boot')
      return { imported: 0, skipped: 0, unavailable: true }
    }
    const candidates = []
    if (typeof store_?.list === 'function') {
      try {
        for (const entry of (await store_.list()) ?? []) {
          candidates.push({
            kind: 'live',
            session: entry?.session ?? entry,
            values: entry?.projections?.values,
            stamped: entry?.updatedAt,
          })
        }
      } catch (error) {
        warn(`my-cost: backfill list failed: ${error?.message ?? error}`)
      }
    }
    if (typeof query?.listSessions === 'function') {
      try {
        for (const record of (await query.listSessions()) ?? []) {
          const header = record?.header ?? record
          if (!header?.id) continue
          let values
          try {
            values = cache?.cachedSnapshot?.(header)?.values
          } catch (error) {
            warn(`my-cost: cached projections unavailable for ${header.id}: ${error?.message ?? error}`)
          }
          candidates.push({ kind: 'cold', session: header, values, stamped: undefined })
        }
      } catch (error) {
        warn(`my-cost: backfill cold list failed: ${error?.message ?? error}`)
      }
    }
    const known = await store.load()
    // The import fills in sessions the store has never seen. Anything already
    // written — an earlier import row or live deltas — *is* the baseline the
    // next delta measures from, so importing again would double count.
    const stored = storedBySession(known)
    const seen = new Set()
    let written = 0
    let skipped = 0
    let seededCount = 0
    for (const candidate of candidates) {
      const session = candidate.session
      const sessionId = session?.id ?? session?.sessionId
      const values = candidate.values ?? {}
      // Live sessions read the registry's client views; cold ones read the cached
      // block, whose `values[key]` is already unwrapped (an older layout nested
      // `{ver,seq,val}`).
      const liveValues = candidate.kind === 'live' ? snapshotValues(session) : undefined
      const read = (key) => {
        const live = liveValues?.[key]
        if (live !== undefined) return live
        const cached = values[key]
        return cached && typeof cached === 'object' && 'val' in cached ? cached.val : cached
      }
      // The projection value is `{totals:{...}, last:{...}}`; tolerate a bare
      // totals object as well.
      const tokenUsage = read('tokenUsage')
      const usage = tokenUsage?.totals ?? tokenUsage
      const selection = read('modelSelection')
      const route = selection?.lastUsed ?? selection
      // A session object carries no `updatedAt`: the host derives it as
      // `max(header.createdAt, sessionListMetadata.lastPromptAt)`. Reproduce it
      // so a backfilled row lands on the day it was used, not on "today".
      const metadata = read('sessionListMetadata')
      const created = session?.header?.createdAt ?? session?.createdAt
      const derived = Math.max(typeof created === 'number' ? created : 0, metadata?.lastPromptAt ?? 0)
      const stamped = candidate.stamped ?? session?.updatedAt ?? derived
      const ts = stamped > 0 ? stamped : Date.now()
      // Sessions whose last use predates the window are still imported: that row
      // is the delta baseline, invisible to every window because of its own
      // day. Skipping it would leave the baseline empty and the next sync would
      // count a whole old session as if it happened today.
      // A fork is imported even when it already has rows: its ledger may be short of
      // the baseline it inherited, and topping that up is idempotent.
      const isFork = sessionId ? seedParentOf(session, sessionId) !== null : false
      if (!sessionId || seen.has(sessionId) || !usage || !route || (stored.has(sessionId) && !isFork)) {
        skipped += 1
        continue
      }
      if (isFork) {
        seen.add(sessionId)
        seededCount += await topUpSeeded(session, sessionId, usage, route, stored, ts)
        // What the fork spent on its own is the growth above the baseline.
        const baseline = stored.get(sessionId) ?? {}
        const own = {
          uncachedInput: Math.max(0, (usage.uncachedInputTokens ?? 0) - (baseline.uncachedInput ?? 0)),
          cacheRead: Math.max(0, (usage.cacheReadTokens ?? 0) - (baseline.cacheRead ?? 0)),
          cacheWrite: Math.max(0, (usage.cacheWriteTokens ?? 0) - (baseline.cacheWrite ?? 0)),
          output: Math.max(0, (usage.outputTokens ?? 0) - (baseline.output ?? 0)),
        }
        if (BUCKETS.some((key) => own[key] > 0)) {
          const row = makeRow({
            ts,
            sessionId,
            provider: route.provider,
            model: route.model,
            usage: {
              inputTokens: own.uncachedInput,
              outputTokens: own.output,
              cacheReadTokens: own.cacheRead,
              cacheWriteTokens: own.cacheWrite,
            },
            src: 'backfill',
            timeZone,
          })
          if (row !== null) {
            await store.upsert(row)
            const entry = stored.get(sessionId) ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, rows: 0 }
            for (const key of BUCKETS) entry[key] += own[key]
            entry.rows = (entry.rows ?? 0) + 1
            stored.set(sessionId, entry)
            written += 1
          }
        }
        continue
      }
      const row = makeRow({
        ts,
        sessionId,
        provider: route.provider,
        model: route.model,
        usage: {
          inputTokens: usage.uncachedInputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        },
        src: 'backfill',
        timeZone,
      })
      if (row === null) {
        skipped += 1
        continue
      }
      seen.add(sessionId)
      await store.upsert(row)
      stored.set(sessionId, {
        uncachedInput: row.uncachedInput,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        output: row.output,
        rows: 1,
      })
      written += 1
    }
    if (written > 0) warn(`my-cost: backfilled ${written} session(s) from cached projections`)
    if (seededCount > 0) warn(`my-cost: seeded ${seededCount} forked session(s) from their parent`)
    return { imported: written, skipped, seeded: seededCount }
  }

  // ------------------------------------------------------- real-time top-up

  /** Buckets already on disk per session — the baseline the next delta is measured from. */
  function storedBySession(rows) {
    const map = new Map()
    for (const row of rows) {
      const sessionId = row.sessionId
      if (!sessionId) continue
      let entry = map.get(sessionId)
      if (entry === undefined) {
        entry = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, rows: 0 }
        map.set(sessionId, entry)
      }
      for (const key of BUCKETS) entry[key] += Number(row[key]) || 0
      entry.rows += 1
    }
    return map
  }

  /** True when a session was seeded from another one, so its totals start non-zero. */
  function seedParentOf(session, sessionId) {
    const seeded = session?.isSeeded ?? session?.header?.isSeeded
    if (seeded !== true) return null
    const parentSession = session?.parentSession ?? session?.header?.parentSession
    if (!parentSession || parentSession === sessionId) return null
    return parentSession
  }

  /**
   * A seeded (forked) session inherits the parent's cumulative projection, so
   * importing it as new would count the parent's whole history a second time.
   * The inherited portion becomes a `seeded` row: a baseline that is measured
   * against but never aggregated. Capped by what the child actually holds, so a
   * child can never come out with a negative delta.
   */
  function seededBaseline(session, sessionId, usage, stored) {
    const parentSession = seedParentOf(session, sessionId)
    if (parentSession === null) return null
    const parent = stored.get(parentSession)
    if (parent === undefined) return null
    const cap = (child, inherited) => Math.max(0, Math.min(Number(child) || 0, Number(inherited) || 0))
    return {
      uncachedInput: cap(usage?.uncachedInputTokens, parent.uncachedInput),
      cacheRead: cap(usage?.cacheReadTokens, parent.cacheRead),
      cacheWrite: cap(usage?.cacheWriteTokens, parent.cacheWrite),
      output: cap(usage?.outputTokens, parent.output),
    }
  }

  /** Persist a seeded baseline row; returns it, or null when the numbers are unusable. */
  async function writeSeeded(sessionId, route, seeded, ts) {
    const row = makeRow({
      ts,
      sessionId,
      provider: route.provider,
      model: route.model,
      usage: {
        inputTokens: seeded.uncachedInput,
        outputTokens: seeded.output,
        cacheReadTokens: seeded.cacheRead,
        cacheWriteTokens: seeded.cacheWrite,
      },
      src: 'seeded',
      timeZone,
    })
    if (row === null) return null
    await store.upsert(row)
    return row
  }

  /**
   * Make sure a forked session's ledger covers the usage it inherited.
   *
   * The invariant is "the rows always hold at least the inherited amount", not
   * "the first import was right": a fork can be re-imported, its rows can be
   * repaired, or it can be seen for the first time after it already did some
   * work. Comparing the stored total against the parent's baseline and writing
   * only the shortfall makes every one of those cases converge, and running it
   * twice is a no-op.
   */
  async function topUpSeeded(session, sessionId, usage, route, stored, ts) {
    if (seedParentOf(session, sessionId) === null) return 0
    const inherited = seededBaseline(session, sessionId, usage, stored)
    if (inherited === null) return 0
    const before = stored.get(sessionId)
    const gap = {}
    let short = false
    for (const key of BUCKETS) {
      gap[key] = Math.max(0, (inherited[key] ?? 0) - (before?.[key] ?? 0))
      if (gap[key] > 0) short = true
    }
    if (!short) return 0
    if ((await writeSeeded(sessionId, route, gap, ts)) === null) return 0
    const entry = before ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, rows: 0 }
    for (const key of BUCKETS) entry[key] += gap[key]
    entry.rows = (entry.rows ?? 0) + 1
    stored.set(sessionId, entry)
    return 1
  }

  let syncCounter = 0

  /**
   * Real-time top-up. Whatever a session's totals were the last time we wrote,
   * the store already holds those buckets, so `current - stored` is exactly what
   * happened since. No separate baseline to keep in sync, and a lost or
   * rewritten row simply reappears on the next pass.
   */
  async function runSync(reason) {
    if (typeof sessions?.list !== 'function' || typeof projections?.snapshot !== 'function') {
      return { unavailable: true, reason, written: 0 }
    }
    try {
      const now = Date.now()
      const today = dayKey(now, timeZone)
      if (today < cutoff()) return { reason, written: 0, skipped: 'out-of-retention' }
      const stored = storedBySession(await store.load())
      let written = 0
      let seededRows = 0
      // list() may be sync or async depending on the host build; awaiting a
      // plain array is harmless, while iterating an un-awaited promise silently
      // yields zero sessions (which is how the first version wrote nothing).
      const live = await sessions.list()
      for (const session of Array.isArray(live) ? live : []) {
        const sessionId = session?.id ?? session?.sessionId
        if (!sessionId) continue
        const values = snapshotValues(session) ?? {}
        const tokenUsage = values.tokenUsage
        const usage = tokenUsage?.totals ?? tokenUsage
        if (!usage) continue
        const selection = values.modelSelection
        const route = selection?.lastUsed ?? selection
        if (!route?.provider || !route?.model) continue
        seededRows += await topUpSeeded(session, sessionId, usage, route, stored, now)
        const before = stored.get(sessionId)
        // Row fields are the store's own vocabulary (wire.js BUCKETS); the
        // projection uses provider names. Translate once, here.
        const delta = {
          uncachedInput: Math.max(0, (usage.uncachedInputTokens ?? 0) - (before?.uncachedInput ?? 0)),
          cacheRead: Math.max(0, (usage.cacheReadTokens ?? 0) - (before?.cacheRead ?? 0)),
          cacheWrite: Math.max(0, (usage.cacheWriteTokens ?? 0) - (before?.cacheWrite ?? 0)),
          output: Math.max(0, (usage.outputTokens ?? 0) - (before?.output ?? 0)),
        }
        if (BUCKETS.every((key) => delta[key] === 0)) continue
        const row = makeRow({
          ts: now,
          sessionId,
          provider: route.provider,
          model: route.model,
          // Unique per write; the delta itself is the idempotency, not the id.
          turn: 'live',
          step: `${now}-${++syncCounter}`,
          usage: {
            inputTokens: delta.uncachedInput,
            outputTokens: delta.output,
            cacheReadTokens: delta.cacheRead,
            cacheWriteTokens: delta.cacheWrite,
          },
          src: 'live',
          timeZone,
        })
        if (row === null) continue
        await store.upsert(row)
        written += 1
      }
      if (written > 0) warn(`my-cost: ${reason} sync wrote ${written} live row(s)`)
      if (seededRows > 0) warn(`my-cost: ${reason} sync seeded ${seededRows} forked session(s)`)
      return { reason, written, seeded: seededRows }
    } catch (error) {
      warn(`my-cost: ${reason} sync failed: ${error?.message ?? error}`)
      return { reason, written: 0, error: String(error?.message ?? error) }
    }
  }

  let syncChain = Promise.resolve()
  /**
   * Serialise the passes: a boot-time top-up and a user-triggered one can land
   * at the same instant, and two overlapping read-modify-write cycles would
   * measure the same baseline and double count.
   */
  function syncNow(reason = 'timer') {
    const run = syncChain.then(
      () => runSync(reason),
      () => runSync(reason),
    )
    syncChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  let syncQueued = false
  /** Coalesce bursts of projection changes into one write pass. */
  function scheduleSync(reason) {
    if (syncQueued) return
    syncQueued = true
    const timer = setTimeout(() => {
      syncQueued = false
      void syncNow(reason)
    }, SYNC_DEBOUNCE_MS)
    timer.unref?.()
  }

  const ready = Promise.resolve(store.load()).catch((error) => {
    warn(`my-cost: cannot open ${file}: ${error?.message ?? error}`)
    return []
  })
  void ready.then(prune).then(backfill).then(() => syncNow('ready'))

  // Services are resolved lazily: at mount time they are usually not yet
  // available, so the first import would find nothing. Wait for the two global
  // services explicitly and re-run the import the moment they appear.
  mark('session services')
  ctx.inject(['sessions', 'sessionProjections'], (scoped) => {
    const store_ = scoped.get('sessions')
    const lookup = scoped.get('sessionProjections')
    if (typeof store_?.list !== 'function') return
    sessions = store_
    projections = lookup
    scoped.effect(() => () => {
      if (sessions === store_) sessions = undefined
      if (projections === lookup) projections = undefined
    })
    void ready.then(backfill).then(() => syncNow('live-sessions'))

    // Path A of the real-time feed: the registry announces every projection
    // change, so `tokenUsage` moving means new tokens landed. Feature-detected —
    // the polling timer below is the guaranteed path when this hook is absent.
    try {
      if (typeof lookup?.onChanged === 'function') {
        scoped.effect(
          () =>
            lookup.onChanged((session, key) => {
              if (key === 'tokenUsage') scheduleSync('projection')
            }),
          'my-cost: projection hook',
        )
      } else {
        warn('my-cost: sessionProjections.onChanged unavailable; relying on the 20s poll')
      }
    } catch (error) {
      warn(`my-cost: projection hook failed: ${error?.message ?? error}`)
    }
  })

  // The cold sources are separate on purpose: `ctx.inject` waits for *every*
  // listed service, so bundling an optional one would block the live path when
  // it never appears.
  ctx.inject(['sessionQuery'], (scoped) => {
    const query = scoped.get('sessionQuery')
    if (typeof query?.listSessions !== 'function') return
    coldQuery = query
    scoped.effect(() => () => {
      if (coldQuery === query) coldQuery = undefined
    })
    void ready.then(backfill)
  })

  ctx.inject(['sessionProjectionCache'], (scoped) => {
    const cache = scoped.get('sessionProjectionCache')
    if (typeof cache?.cachedSnapshot !== 'function') return
    projectionCache = cache
    scoped.effect(() => () => {
      if (projectionCache === cache) projectionCache = undefined
    })
    void ready.then(backfill)
  })

  mark('effect')
  ctx.effect(() => {
    const timer = setInterval(() => void prune(), PRUNE_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'my-cost: retention timer')

  // Path B: the guaranteed top-up. Cheap — it only walks the in-memory session
  // list and writes a row when a session's totals actually moved.
  ctx.effect(() => {
    const timer = setInterval(() => void syncNow('poll'), SYNC_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'my-cost: realtime sync timer')

  mark('session/event')
  // The event feed is only a *trigger*: rows are written from the delta between
  // the store and the session's cumulative projection. Writing `event.usage`
  // here as well would count the same tokens twice (and this event never
  // reached a root-scoped plugin anyway — the store had no live row at all).
  ctx.on('session/event', (first, second) => {
    const { event, session } = splitArgs(first, second)
    if (!event) return
    const sessionId = session?.id ?? event.sessionId ?? 'unknown'
    sessionsSeen.add(sessionId)
    const nextRoute = routeOf(event, routes.get(sessionId))
    if (nextRoute) routes.set(sessionId, nextRoute)
    if (event.type === 'assistant/message') scheduleSync('session-event')
  })

  async function report(days = retentionDays) {
    const window = Math.max(1, Math.min(365, Number(days) || retentionDays))
    const rows = await store.load()
    // `seeded` rows carry a forked session's inherited baseline. They exist so the
    // next delta is measured from the right place, and must never be counted.
    const counted = rows.filter((row) => row.src !== 'seeded')
    const kept = counted.filter((row) => row.day >= cutoffDay(Date.now(), window, timeZone))
    const snapshot = rollup(kept)
    return {
      days: window,
      timeZone,
      retentionDays,
      file,
      rows: kept.length,
      stored: rows.length,
      today: dayKey(Date.now(), timeZone),
      droppedForMissingRoute,
      backfilled: kept.filter((row) => row.src === 'backfill').length,
      live: kept.filter((row) => row.src === 'live').length,
      totals: snapshot.totals,
      metrics: snapshot.metrics,
      count: snapshot.count,
      byModel: snapshot.byModel,
      byProvider: snapshot.byProvider,
      byDay: snapshot.byDay,
    }
  }

  mark('connection')
  // The channel is a webServer route of our own, not `connection.register`
  // (there is no such API in this host: the call silently did nothing and every
  // client request came back as HTTP 405). The wire format is the platform's
  // client-request / server-response pair, same as image-lite's transport.
  ctx.inject(['connection', 'webServer'], (scoped) => {
    const connection = scoped.get('connection')
    const webServer = scoped.get('webServer')
    if (webServer === undefined) {
      warn('my-cost: webServer unavailable; the sidebar tab will show no data')
      return
    }
    const admit = (request) =>
      typeof connection?.requestRejection === 'function' ? connection.requestRejection(request) : undefined

    const handle = async (endpoint, payload) => {
      // The wire envelope is `{ok, value}` / `{ok:false, error}`; the transport
      // only wraps thrown failures, so successes are enveloped here.
      if (endpoint === 'report') return { ok: true, value: await report(payload?.days) }
      if (endpoint === 'backfill') {
        // Re-scan history *and* top up the live deltas: after a long pause the
        // numbers a user expects on this button live in both places.
        const scan = await backfill()
        const sync = await syncNow('rescan')
        return { ok: true, value: { ...scan, live: sync.written ?? 0, sync } }
      }
      if (endpoint === 'prune') {
        await prune()
        return { ok: true, value: { pruned: true } }
      }
      throw new Error(`my-cost: unknown endpoint ${JSON.stringify(endpoint)}`)
    }

    scoped.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: CHANNEL,
          handler: (req, res) => serveRpc(req, res, admit, handle),
        }),
      'my-cost: rpc route',
    )
  })

  // A plain definition object rather than `defineTool()`: the registry's
  // contract is the same JSON-Schema shape, and skipping the import keeps this
  // plugin free of every harness package that is not published for out-of-tree
  // use (`dsh-tools` in the running host is a newer rc than any npm release).
  // Registration is contained: a rejected definition must not abort the boot,
  // because the sidebar tab and the RPC channel do not depend on the tool.
  mark('tool')
  try {
    ctx.tools.register({
    name: 'usage_report',
    description:
      'Report this machine token usage for the last N days, split by model and provider, with cache hit rate. Use when the user asks how many tokens were used or how much a model cost in tokens.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days, 1-365. Defaults to the configured retention.' },
        model: { type: 'string', description: 'Optional: only this model id.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const data = await report(args.days)
      const lines = [`Token 用量（最近 ${data.days} 天，时区 ${data.timeZone}）`, '']
      const m = data.metrics
      lines.push(
        `总计 ${formatTokens(m.total)}：未命中输入 ${formatTokens(data.totals.uncachedInput)} / 缓存读 ${formatTokens(data.totals.cacheRead)} / 缓存写 ${formatTokens(data.totals.cacheWrite)} / 输出 ${formatTokens(data.totals.output)}`,
        `缓存命中率 ${m.hitRate === null ? '—' : `${(m.hitRate * 100).toFixed(1)}%`}，输出占比 ${(m.outputShare * 100).toFixed(1)}%，输入:输出 ${m.inputOutputRatio === 0 ? '—' : m.inputOutputRatio.toFixed(1)}:1`,
        `调用 ${data.count} 次，覆盖 ${data.byModel.length} 个模型 / ${data.byProvider.length} 个提供商`,
      )
      const models = args.model ? data.byModel.filter((row) => row.model === args.model) : data.byModel
      if (models.length > 0) {
        lines.push('', '按模型：')
        for (const row of models.slice(0, 15)) {
          lines.push(
            `- ${row.provider}/${row.model}  ${formatTokens(row.metrics.total)}  (未命中 ${formatTokens(row.totals.uncachedInput)}，缓存读 ${formatTokens(row.totals.cacheRead)}，输出 ${formatTokens(row.totals.output)}，命中率 ${row.metrics.hitRate === null ? '—' : `${(row.metrics.hitRate * 100).toFixed(1)}%`})`,
          )
        }
      }
      if (data.droppedForMissingRoute > 0) {
        lines.push('', `注：${data.droppedForMissingRoute} 次调用因未记录到 provider/model 未计入。`)
      }
      return lines.join('\n')
    },
    })
  } catch (error) {
    recordBootFailure('tools.register', error)
  }
}
