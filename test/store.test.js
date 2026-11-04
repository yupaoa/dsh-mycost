import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../store.js'

const tmpFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mycost-'))
  return join(dir, 'usage.v1.jsonl')
}

const row = (id, over = {}) => ({
  id,
  ts: 1,
  day: '2026-11-03',
  sessionId: 's',
  provider: 'p',
  model: 'm',
  turn: 1,
  step: 1,
  src: 'live',
  uncachedInput: 1,
  cacheRead: 2,
  cacheWrite: 0,
  output: 3,
  ...over,
})

test('load returns an empty list when the file does not exist yet', async () => {
  const store = createStore({ file: await tmpFile() })
  assert.deepEqual(await store.load(), [])
  assert.equal(store.size, 0)
})

test('upsert is durable across a reload', async () => {
  const file = await tmpFile()
  const first = createStore({ file })
  await first.load()
  await first.upsert(row('a'))
  await first.upsert(row('b'))

  const second = createStore({ file })
  const rows = await second.load()
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'])
})

test('upserting the same id twice keeps one row and the newer values', async () => {
  const file = await tmpFile()
  const store = createStore({ file })
  await store.load()
  await store.upsert(row('a', { src: 'backfill', output: 10 }))
  await store.upsert(row('a', { src: 'live', output: 20 }))

  const reloaded = await createStore({ file }).load()
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].src, 'live')
  assert.equal(reloaded[0].output, 20)
})

test('a corrupt line is skipped instead of breaking the whole history', async () => {
  const file = await tmpFile()
  await writeFile(file, `${JSON.stringify(row('a'))}\n{not json\n${JSON.stringify(row('b'))}\n`, 'utf8')
  const rows = await createStore({ file }).load()
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'])
})

test('prune drops older days, keeps the cutoff day, and compacts the file', async () => {
  const file = await tmpFile()
  const store = createStore({ file })
  await store.load()
  await store.upsert(row('old', { day: '2026-10-01' }))
  await store.upsert(row('edge', { day: '2026-10-05' }))
  await store.upsert(row('new', { day: '2026-11-03' }))

  await store.prune('2026-10-05')

  const text = await readFile(file, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'the file should be rewritten, not appended to')
  assert.deepEqual((await createStore({ file }).load()).map((r) => r.id), ['edge', 'new'])
  assert.equal(store.size, 2)
})

test('prune keeps an expired backfill row, because it is the delta baseline', async () => {
  const file = await tmpFile()
  const store = createStore({ file })
  await store.load()
  await store.upsert(row('base', { day: '2026-09-01', src: 'backfill' }))
  await store.upsert(row('stale-live', { day: '2026-09-01', src: 'live' }))
  await store.upsert(row('keep', { day: '2026-10-20', src: 'live' }))

  await store.prune('2026-10-05')

  const ids = (await createStore({ file }).load()).map((r) => r.id)
  assert.deepEqual(ids, ['base', 'keep'], 'the baseline must survive while the expired delta goes')
})

test('prune writes nothing when there is nothing to drop', async () => {
  const file = await tmpFile()
  const store = createStore({ file })
  await store.load()
  await store.upsert(row('edge', { day: '2026-10-05' }))
  const before = await readFile(file, 'utf8')
  await store.prune('2026-10-05')
  assert.equal(await readFile(file, 'utf8'), before)
})
