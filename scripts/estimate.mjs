/**
 * Dev-only cross-check — NOT shipped (it is not in `package.json#files`).
 *
 * Predicts what the plugin's history backfill will show, by reading the same
 * projection cache the harness itself reads. The plugin never touches these
 * files: this script exists so an install can be verified against an
 * independent path, then it stays out of the runtime.
 *
 *   node scripts/estimate.mjs [days]
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { cutoffDay, dayKey, makeRow, rollup, formatTokens } from '../wire.js'

const days = Number(process.argv[2] ?? 30)
const timeZone = 'Asia/Shanghai'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const dir = join(home, 'storages', 'session_projcache', 'sessions')
const floor = cutoffDay(Date.now(), days, timeZone)

const files = await readdir(dir).catch(() => [])
const rows = []
let withUsage = 0
let withModel = 0
let outsideWindow = 0

for (const file of files.filter((name) => name.endsWith('.json'))) {
  let record
  try {
    record = JSON.parse(await readFile(join(dir, file), 'utf8'))?.record
  } catch {
    continue
  }
  const projections = record?.rows ?? {}
  const usage = projections.tokenUsage?.val?.totals
  const route = projections.modelSelection?.val?.lastUsed
  if (!usage) continue
  withUsage += 1
  if (!route) continue
  withModel += 1
  const ts = projections.sessionListMetadata?.val?.lastPromptAt ?? record?.identity?.createdAt ?? Date.now()
  if (dayKey(ts, timeZone) < floor) {
    outsideWindow += 1
    continue
  }
  const row = makeRow({
    ts,
    sessionId: file.replace(/^session-|\.json$/g, ''),
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
  if (row) rows.push(row)
}

const snapshot = rollup(rows)
console.log(`窗口 ${floor} .. ${dayKey(Date.now(), timeZone)}（${days} 天）`)
console.log(`缓存里的会话 ${files.length} 个，有 tokenUsage 的 ${withUsage} 个，有模型的 ${withModel} 个，窗口内 ${rows.length} 个，窗口外跳过 ${outsideWindow} 个`)
console.log(
  `合计 ${formatTokens(snapshot.totals.uncachedInput + snapshot.totals.cacheRead + snapshot.totals.cacheWrite + snapshot.totals.output)}` +
    ` = 未命中 ${formatTokens(snapshot.totals.uncachedInput)} + 缓存读 ${formatTokens(snapshot.totals.cacheRead)} + 缓存写 ${formatTokens(snapshot.totals.cacheWrite)} + 输出 ${formatTokens(snapshot.totals.output)}`,
)
console.log(`缓存命中率 ${(snapshot.metrics.hitRate * 100).toFixed(1)}%`)
console.log('')
for (const group of snapshot.byModel.slice(0, 10)) {
  const total = group.metrics.total
  console.log(
    `  ${group.provider}/${group.model}`.padEnd(42) +
      formatTokens(total).padStart(9) +
      `   命中 ${(group.metrics.hitRate * 100).toFixed(1)}%`.padStart(16),
  )
}
