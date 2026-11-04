/**
 * Dev-only end-to-end replay — NOT shipped.
 *
 * Feeds the *real* projection cache of this machine through the shipped
 * `backfill()` path in `index.js` (fake Cordis context, temp DSH_HOME) and
 * prints the report the sidebar would render. Close as possible to the live
 * behaviour without restarting the harness.
 *
 *   node scripts/replay.mjs [days]
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { formatTokens } from '../wire.js'

const days = Number(process.argv[2] ?? 30)
const source = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions')

async function readSessions() {
  const files = (await readdir(source).catch(() => [])).filter((name) => name.endsWith('.json'))
  const sessions = []
  for (const file of files) {
    let record
    try {
      record = JSON.parse(await readFile(join(source, file), 'utf8'))?.record
    } catch {
      continue
    }
    const rows = record?.rows ?? {}
    const usage = rows.tokenUsage?.val
    const selection = rows.modelSelection?.val
    if (!usage) continue
    sessions.push({
      sessionId: file.replace(/^session-|\.json$/g, ''),
      updatedAt: rows.sessionListMetadata?.val?.lastPromptAt ?? record?.identity?.createdAt ?? Date.now(),
      projections: { values: { tokenUsage: usage, ...(selection === undefined ? {} : { modelSelection: selection }) } },
    })
  }
  return sessions
}

function fakeContext(sessions) {
  const registered = []
  const ctx = {
    logger: () => ({ warn: (message) => warnings.push(message) }),
    get: (key) => (key === 'sessionController' ? { list: async () => sessions } : undefined),
    on: () => () => {},
    effect: (fn) => (fn(), () => {}),
    inject: (_deps, callback) => callback({ get: (key) => (key === 'connection' ? { register: (...args) => registered.push(args) } : undefined), effect: () => {} }),
    tools: { register: () => {} },
  }
  const warnings = []
  return { ctx, registered, warnings }
}

const sessions = await readSessions()
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'mycost-replay-'))
const { ctx, registered, warnings } = fakeContext(sessions)
apply(ctx, { retentionDays: days, timeZone: 'Asia/Shanghai' })

// Let the boot-time prune → backfill chain settle.
await new Promise((resolve) => setTimeout(resolve, 300))

const [, channel, handler] = registered.at(-1) ?? []
if (!handler) throw new Error('the RPC channel never registered')

const result = await handler('backfill', {})
const report = await handler('report', { days })

console.log(`会话源 ${sessions.length} 个 · 回填 ${JSON.stringify(result)}`)
console.log(`覆盖 ${report.count} 条记录，其中回填 ${report.backfilled}；丢弃(无路由) ${report.droppedForMissingRoute}`)
console.log(
  `合计 ${formatTokens(report.metrics.total)} = 未命中 ${formatTokens(report.totals.uncachedInput)} + 缓存读 ${formatTokens(report.totals.cacheRead)} + 缓存写 ${formatTokens(report.totals.cacheWrite)} + 输出 ${formatTokens(report.totals.output)}`,
)
console.log(`缓存命中率 ${(report.metrics.hitRate * 100).toFixed(1)}% · 输入:输出 ${report.metrics.inputOutputRatio.toFixed(1)}:1`)
console.log('')
for (const row of report.byModel.slice(0, 6)) {
  console.log(`  ${row.provider}/${row.model}`.padEnd(42) + formatTokens(row.metrics.total).padStart(9) + `   命中 ${(row.metrics.hitRate * 100).toFixed(1)}%`.padStart(15))
}
if (warnings.length > 0) console.log(`\nwarnings:\n  ${warnings.join('\n  ')}`)
