// dsh-mycost — pure aggregation helpers.
// No DSH imports here on purpose: `node --test` runs this file with plain Node,
// so every metric the plugin shows is testable without booting a harness.

/** Local calendar day the UI groups by. Report days follow the user's clock. */
export const LOCAL_TZ = 'Asia/Shanghai'

/** The four provider-reported buckets. `uncachedInput` excludes cache reads. */
export const BUCKETS = Object.freeze(['uncachedInput', 'cacheRead', 'cacheWrite', 'output'])

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Format a timestamp as the local `YYYY-MM-DD` day bucket.
 * @param {number} ts epoch milliseconds
 * @param {string} [timeZone] IANA zone, defaults to the report zone
 */
export function dayKey(ts, timeZone = LOCAL_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** A non-negative integer, or null when the value is not one. */
function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Map provider-reported `TokenUsage` onto our four buckets.
 * `inputTokens` is the cache-miss input count (the harness already separates
 * cache reads out of it), so the mapping is 1:1 rather than derived.
 * @returns {{uncachedInput:number,cacheRead:number,cacheWrite:number,output:number}|null}
 *   null when the event carries no usable usage, so callers never invent counts.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const uncachedInput = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  if (uncachedInput === null || output === null) return null
  const cacheRead = usage.cacheReadTokens == null ? 0 : count(usage.cacheReadTokens)
  const cacheWrite = usage.cacheWriteTokens == null ? 0 : count(usage.cacheWriteTokens)
  if (cacheRead === null || cacheWrite === null) return null
  return { uncachedInput, cacheRead, cacheWrite, output }
}

/**
 * Build one stored row from one settled model call.
 * The id is the dedupe key: one attempt settles once, so re-delivery is a no-op.
 */
export function makeRow(input) {
  const {
    ts,
    sessionId,
    provider,
    model,
    turn,
    step,
    usage,
    src = 'live',
    timeZone = LOCAL_TZ,
  } = input
  const buckets = normalizeUsage(usage)
  if (buckets === null) return null
  return {
    id: src === 'backfill' ? `${sessionId}:backfill` : `${sessionId}:${turn}:${step}`,
    ts,
    day: dayKey(ts, timeZone),
    sessionId,
    provider: provider || 'unknown',
    model: model || 'unknown',
    turn: turn ?? null,
    step: step ?? null,
    src,
    ...buckets,
  }
}

/** Sum the four buckets across rows. */
export function sumBuckets(rows) {
  const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const row of rows) {
    for (const key of BUCKETS) totals[key] += row[key] ?? 0
  }
  return totals
}

/**
 * Rates derived from aggregate counts.
 * Every rate divides pooled totals — averaging per-group rates would let a
 * tiny session outvote a huge one.
 */
export function metricsOf(totals) {
  const uncachedInput = totals.uncachedInput ?? 0
  const cacheRead = totals.cacheRead ?? 0
  const cacheWrite = totals.cacheWrite ?? 0
  const output = totals.output ?? 0

  const total = uncachedInput + cacheRead + cacheWrite + output
  const inputTotal = uncachedInput + cacheRead + cacheWrite
  const promptSide = cacheRead + uncachedInput
  const structure = {
    miss: uncachedInput + cacheWrite,
    hit: cacheRead,
    output,
  }
  const structureTotal = structure.miss + structure.hit + structure.output
  const share = (value) => (structureTotal > 0 ? value / structureTotal : 0)

  return {
    total,
    inputTotal,
    hitRate: promptSide > 0 ? cacheRead / promptSide : null,
    outputShare: total > 0 ? output / total : 0,
    inputOutputRatio: output > 0 ? inputTotal / output : 0,
    structure,
    shares: {
      miss: share(structure.miss),
      hit: share(structure.hit),
      output: share(structure.output),
    },
  }
}

/** Group rows into the three report dimensions plus the overall totals. */
export function rollup(rows) {
  const byKey = (keyOf) => {
    const groups = new Map()
    for (const row of rows) {
      const key = keyOf(row)
      const group = groups.get(key) ?? { rows: [], count: 0 }
      group.rows.push(row)
      group.count += 1
      groups.set(key, group)
    }
    return [...groups.entries()]
      .map(([key, { rows: groupRows, count: groupCount }]) => ({
        key,
        count: groupCount,
        totals: sumBuckets(groupRows),
        metrics: metricsOf(sumBuckets(groupRows)),
        rows: groupRows,
      }))
      .sort((left, right) => right.metrics.total - left.metrics.total || left.key.localeCompare(right.key))
  }

  const models = byKey((row) => `${row.provider}/${row.model}`).map((group) => ({
    provider: group.rows[0].provider,
    model: group.rows[0].model,
    count: group.count,
    totals: group.totals,
    metrics: group.metrics,
  }))
  const providers = byKey((row) => row.provider).map((group) => ({
    provider: group.rows[0].provider,
    count: group.count,
    totals: group.totals,
    metrics: group.metrics,
  }))

  const days = new Map()
  for (const row of rows) {
    const day = days.get(row.day) ?? []
    day.push(row)
    days.set(row.day, day)
  }
  const byDay = [...days.entries()]
    .map(([day, dayRows]) => {
      const totals = sumBuckets(dayRows)
      return { day, count: dayRows.length, totals, metrics: metricsOf(totals) }
    })
    .sort((left, right) => left.day.localeCompare(right.day))

  const totals = sumBuckets(rows)
  return { count: rows.length, totals, metrics: metricsOf(totals), byModel: models, byProvider: providers, byDay }
}

/** Keep rows on or after the cutoff day (inclusive). */
export function pruneRows(rows, cutoff) {
  if (!ISO_DAY.test(String(cutoff))) throw new Error(`cutoff must be YYYY-MM-DD, got ${cutoff}`)
  return rows.filter((row) => row.day >= cutoff)
}

/** The earliest day a `days`-long inclusive window starting today still keeps. */
export function cutoffDay(nowTs, days, timeZone = LOCAL_TZ) {
  const today = dayKey(nowTs, timeZone)
  const [year, month, date] = today.split('-').map(Number)
  const start = Date.UTC(year, month - 1, date) - (Math.max(1, days) - 1) * 86_400_000
  const startDate = new Date(start)
  const pad = (value) => String(value).padStart(2, '0')
  return `${startDate.getUTCFullYear()}-${pad(startDate.getUTCMonth() + 1)}-${pad(startDate.getUTCDate())}`
}

/** Compact number for the tab and the model-facing report. */
export function formatTokens(value) {
  const number = Math.max(0, Number(value) || 0)
  if (number < 1_000) return String(Math.round(number))
  if (number < 1_000_000) return `${(number / 1_000).toFixed(2)}K`
  return `${(number / 1_000_000).toFixed(1)}M`
}
