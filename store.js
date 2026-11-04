// dsh-mycost — own-data store.
//
// This file format belongs to us (not to the harness), so the only promises we
// make are the ones we can keep: append-only writes, a tolerant reader that
// skips a broken line, and an atomic rewrite when pruning. No foreign
// dependencies — in particular no schema library, so the plugin loads even on a
// harness build that does not expose one.
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const isRow = (value) =>
  value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.day === 'string'

/**
 * @param {{file: string, onWarn?: (message: string) => void}} options
 */
export function createStore({ file, onWarn = () => {} }) {
  const rows = new Map()
  let loaded = false
  // Every mutation funnels through one promise chain: two model calls can settle
  // in the same tick, and interleaved appends would corrupt a line boundary.
  let queue = Promise.resolve()
  const serial = (work) => {
    const next = queue.then(work, work)
    queue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async function readAll() {
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') onWarn(`my-cost: cannot read ${file}: ${error}`)
      text = ''
    }
    let skipped = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        skipped += 1
        continue
      }
      if (!isRow(parsed)) {
        skipped += 1
        continue
      }
      rows.set(parsed.id, parsed)
    }
    if (skipped > 0) onWarn(`my-cost: skipped ${skipped} unreadable row(s) in ${file}`)
    loaded = true
    return [...rows.values()]
  }

  return {
    file,

    get size() {
      return rows.size
    },

    load() {
      return serial(async () => (loaded ? [...rows.values()] : readAll()))
    },

    /** Insert or replace one row by id; the newest write wins on reload. */
    upsert(row) {
      return serial(async () => {
        if (!loaded) await readAll()
        rows.set(row.id, row)
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
        return row
      })
    },

    /** Drop rows before `cutoff` (inclusive keep) and compact the file atomically. */
    prune(cutoff) {
      return serial(async () => {
        if (!loaded) await readAll()
        // Baseline rows (`backfill` and the `seeded` row of a forked session) are
        // the ledger: the next delta is measured from them. Dropping one would make
        // the following sync re-count a whole session as if it happened today.
        const kept = [...rows.values()].filter(
          (row) => row.day >= cutoff || row.src === 'backfill' || row.src === 'seeded',
        )
        const removed = rows.size - kept.length
        if (removed === 0) return 0
        const body = kept.map((row) => `${JSON.stringify(row)}\n`).join('')
        const temporary = `${file}.tmp`
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, file)
        rows.clear()
        for (const row of kept) rows.set(row.id, row)
        return removed
      })
    },
  }
}
