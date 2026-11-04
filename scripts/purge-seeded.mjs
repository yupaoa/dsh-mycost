#!/usr/bin/env node
/**
 * One-off repair for stores written before seeded sessions were understood.
 *
 * A fork (`isSeeded: true` + `parentSession`) starts with the parent's
 * cumulative projection, so early versions imported that as fresh usage and
 * counted a whole history twice. This script finds every seeded session on disk
 * and drops the rows it produced, so the plugin can re-establish the baseline
 * from the parent on the next sync.
 *
 * Usage: node scripts/purge-seeded.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const buckets = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']

const seeded = new Set()
const sessionsRoot = join(home, 'sessions')
if (existsSync(sessionsRoot)) {
  for (const workspace of readdirSync(sessionsRoot)) {
    const workspacePath = join(sessionsRoot, workspace)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const session of readdirSync(workspacePath)) {
      const file = join(workspacePath, session, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      try {
        const [first] = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')
        const head = JSON.parse(first)
        if (head?.isSeeded === true) seeded.add(head.id)
      } catch {
        /* an unreadable session is not a reason to stop */
      }
    }
  }
}
console.log(`seeded sessions: ${seeded.size}`)

const usageFile = join(home, 'my-cost', 'usage.v1.jsonl')
if (!existsSync(usageFile) || seeded.size === 0) process.exit(0)

const lines = readFileSync(usageFile, 'utf8').split('\n').filter(Boolean)
const kept = []
const dropped = new Map()
for (const line of lines) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    kept.push(line)
    continue
  }
  if (!seeded.has(row.sessionId)) {
    kept.push(line)
    continue
  }
  dropped.set(row.sessionId, (dropped.get(row.sessionId) ?? 0) + buckets.reduce((a, k) => a + (row[k] ?? 0), 0))
}

for (const [id, total] of dropped) console.log(`  drop ${id}: ${(total / 1e6).toFixed(2)}M tokens`)
if (dryRun || dropped.size === 0) {
  console.log(dryRun ? 'dry run: nothing written' : 'nothing to do')
  process.exit(0)
}

const backup = `${usageFile}.bak-${Date.now()}`
writeFileSync(backup, `${lines.join('\n')}\n`)
writeFileSync(`${usageFile}.tmp`, `${kept.join('\n')}\n`)
renameSync(`${usageFile}.tmp`, usageFile)
console.log(`backup: ${backup}`)
console.log(`rows kept: ${kept.length}`)
