import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dayKey,
  normalizeUsage,
  makeRow,
  sumBuckets,
  rollup,
  metricsOf,
  pruneRows,
  cutoffDay,
  formatTokens,
} from '../wire.js'

const TZ = 'Asia/Shanghai'
const row = (over) => ({
  id: `s:${Math.random()}`,
  ts: Date.parse('2026-11-03T04:00:00Z'),
  day: '2026-11-03',
  sessionId: 's',
  provider: 'chatecnu',
  model: 'ecnu-max',
  turn: 1,
  step: 1,
  src: 'live',
  uncachedInput: 100,
  cacheRead: 900,
  cacheWrite: 0,
  output: 50,
  ...over,
})

test('dayKey uses the local calendar day, not UTC', () => {
  // 16:30Z is 00:30 next day in Shanghai.
  assert.equal(dayKey(Date.parse('2026-11-03T16:30:00Z'), TZ), '2026-11-04')
  assert.equal(dayKey(Date.parse('2026-11-03T15:59:00Z'), TZ), '2026-11-03')
})

test('normalizeUsage maps provider usage to the four buckets and defaults caches to 0', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 12, outputTokens: 3 }), {
    uncachedInput: 12,
    cacheRead: 0,
    cacheWrite: 0,
    output: 3,
  })
  assert.deepEqual(
    normalizeUsage({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 400, cacheWriteTokens: 7 }),
    { uncachedInput: 12, cacheRead: 400, cacheWrite: 7, output: 3 },
  )
})

test('normalizeUsage rejects a usage without a numeric input/output count', () => {
  assert.equal(normalizeUsage(undefined), null)
  assert.equal(normalizeUsage({ outputTokens: 3 }), null)
  assert.equal(normalizeUsage({ inputTokens: Number.NaN, outputTokens: 3 }), null)
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 3 }), null)
})

test('makeRow derives day and id from the event coordinates', () => {
  const r = makeRow({
    ts: Date.parse('2026-11-03T16:30:00Z'),
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    turn: 2,
    step: 5,
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 90 },
    src: 'live',
    timeZone: TZ,
  })
  assert.equal(r.day, '2026-11-04')
  assert.equal(r.id, 's1:2:5')
  assert.equal(r.uncachedInput, 10)
  assert.equal(r.cacheRead, 90)
  assert.equal(r.output, 4)
})

test('makeRow returns null when the event carries no usable usage', () => {
  const base = { ts: 1, sessionId: 's', provider: 'p', model: 'm', turn: 1, step: 1, src: 'live' }
  assert.equal(makeRow({ ...base, usage: undefined }), null)
  assert.equal(makeRow({ ...base, usage: { inputTokens: 0, outputTokens: 0 } }).id, 's:1:1')
})

test('sumBuckets adds every bucket field', () => {
  assert.deepEqual(sumBuckets([row({}), row({ uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4 })]), {
    uncachedInput: 101,
    cacheRead: 902,
    cacheWrite: 3,
    output: 54,
  })
})

test('rollup groups by model, provider and day while keeping raw buckets', () => {
  const rows = [
    row({ model: 'a', provider: 'p1', day: '2026-11-01' }),
    row({ model: 'a', provider: 'p1', day: '2026-11-02' }),
    row({ model: 'b', provider: 'p2', day: '2026-11-02', uncachedInput: 5, cacheRead: 5, output: 10 }),
  ]
  const r = rollup(rows)
  assert.equal(r.count, 3)
  assert.equal(r.totals.uncachedInput, 205)
  assert.equal(r.byModel.length, 2)
  assert.equal(r.byModel[0].model, 'a')
  assert.equal(r.byModel[0].count, 2)
  assert.equal(r.byProvider.length, 2)
  assert.deepEqual(r.byDay.map((d) => d.day), ['2026-11-01', '2026-11-02'])
})

test('hit rate is pooled from totals, never an average of per-group rates', () => {
  // Group A: 10 read / (10+990) = 1%; group B: 100 read / (100+0) = 100%.
  const a = { uncachedInput: 990, cacheRead: 10, cacheWrite: 0, output: 1 }
  const b = { uncachedInput: 0, cacheRead: 100, cacheWrite: 0, output: 1 }
  const pooled = metricsOf(
    ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'].reduce(
      (acc, k) => ({ ...acc, [k]: a[k] + b[k] }),
      {},
    ),
  )
  const naiveAverage = (10 / 1000 + 100 / 100) / 2
  assert.equal(pooled.hitRate, 110 / 1100)
  assert.notEqual(pooled.hitRate, naiveAverage)
})

test('structure shares cover miss, hit and output and add up to one', () => {
  const m = metricsOf({ uncachedInput: 300, cacheRead: 600, cacheWrite: 100, output: 1000 })
  assert.equal(m.structure.miss, 400) // uncached input + cache write
  assert.equal(m.structure.hit, 600)
  assert.equal(m.structure.output, 1000)
  const sum = m.shares.miss + m.shares.hit + m.shares.output
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`)
})

test('metrics degrade to null instead of NaN when a denominator is empty', () => {
  const m = metricsOf({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 7 })
  assert.equal(m.hitRate, null)
  assert.equal(m.inputOutputRatio, 0)
})

test('pruneRows drops rows before the cutoff day and keeps the cutoff day itself', () => {
  const rows = [row({ day: '2026-10-04' }), row({ day: '2026-10-05' }), row({ day: '2026-11-03' })]
  assert.deepEqual(pruneRows(rows, '2026-10-05').map((r) => r.day), ['2026-10-05', '2026-11-03'])
})

test('cutoffDay is inclusive: 30 days of data starts 29 days before today', () => {
  const now = Date.parse('2026-11-03T12:00:00Z') // 2026-11-03 20:00 in Shanghai
  assert.equal(cutoffDay(now, 30, TZ), '2026-10-05')
})

test('formatTokens keeps report numbers readable', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1234), '1.23K')
  assert.equal(formatTokens(671601149), '671.6M')
})
