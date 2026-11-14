# dsh-mycost

[![license](https://img.shields.io/github/license/yupaoa/dsh-mycost.svg)](LICENSE)
[![repo](https://img.shields.io/badge/GitHub-yupaoa%2Fdsh--mycost-181717.svg)](https://github.com/yupaoa/dsh-mycost)

**See at a glance where your tokens went.**

Token accounting for DeepSeek Harness: split the last 30 days of usage by **model** and
**provider** into three permanent buckets — **cache-hit input, cache-miss input, output** —
with cache hit rate and usage structure, switchable between today, 7 days and 30 days.
Numbers only, no money.

> Token 用量统计：按模型与提供商拆分最近 30 天的缓存命中、未命中与输出 token，
> 含缓存命中率与用量结构，今天 / 7 天 / 30 天随时切换。

**English** · [中文](README.md)

> **Requirements**: DSH `>= 0.2.1-rc.2`, Node `^22.19.0 || >=24.0.0`.

## What it does

- 📊 **Three permanent buckets**: cache-hit input (`cacheRead`), cache-miss input
  (cache writes included) and output. Never merged into an opaque "total tokens".
- 🧮 **Cache hit rate**: `cacheRead / (cacheRead + uncachedInput)`, computed on the
  **pooled totals**, never by averaging per-group rates — a tiny session must not
  outweigh a million-token one.
- 🧱 **Usage structure**: hit : miss : output normalised so output is 1, plus the
  overall input : output ratio.
- 🗂️ **By model / by provider**: one table each, with share bars, call counts and hit rate.
- 🗓️ **Today / 7 days / 30 days**: windows are recomputed from the current date on
  **every request**, so midnight rolls the page over and old days slide out on their
  own. Leave it unused for 30 days and all three pages read zero.
- ⚡ **Real-time top-up**: send one message and today's number moves — even when the
  session was opened yesterday. Collection is `current projection total − already
  stored`, so only the delta is recorded.
- 🧾 **History backfill**: past usage is visible right after install, no chatting required.
- 🔁 **Rescan**: the data-source card and the `↻` in the header both re-scan history
  and refresh immediately.
- 🖥️ **Its own Settings section**: Settings → **Token 用量**, with its own bar-chart
  glyph in the left nav.
  The window you looked at last is remembered and reopened next time.
- 🛠️ **`usage_report` tool**: lets the model answer "how many tokens did I use",
  optionally filtered by days and model.
- 🔒 **Read-only towards model state**: declares no tools, skills or model selection;
  it only reads usage projections.

### What it deliberately does not do

| Not done | Why |
|---|---|
| Convert to money | Prices and discounts move constantly; this plugin reports raw tokens |
| Read host-internal caches or session files | Everything comes through the public read APIs of `sessions` / `sessionProjections` / `sessionQuery` |
| Exact per-call history | Backfill attributes a whole session to its last use (see *Known limits*) |
| Cross-device sync | Data stays in the local `DSH_HOME`; the plugin sends no network requests |

## Metric definitions

| Bucket | Meaning | Source |
|---|---|---|
| `uncachedInput` | Cache **miss** input tokens | `usage.inputTokens` |
| `cacheRead` | Cache **hit** input tokens | `usage.cacheReadTokens` |
| `cacheWrite` | Tokens written to the cache | `usage.cacheWriteTokens` |
| `output` | Output tokens | `usage.outputTokens` |

- **Hit rate** = `cacheRead / (cacheRead + uncachedInput)`; shows `—` when the
  denominator is zero.
- **Usage structure** is a three-way split (miss incl. writes / hit / output) whose
  shares sum to 1.
- In the DSH usage protocol `inputTokens` already **excludes** cache hits
  (`dsh-token-meter`'s projection says `uncachedInputTokens: usage.inputTokens`), so
  the four buckets are mapped directly with no subtraction.
- The page shows `uncachedInput + cacheWrite` as "miss", because neither of them
  benefited from the cache.

## Where the data lives

`<DSH_HOME>/my-cost/usage.v1.jsonl` (default `~/.dsh/my-cost/`).

The file belongs to this plugin and its format is ours to keep: append-only writes, a
reader that skips a broken line, and an atomic rewrite when pruning.

### Two collection paths

| Source | `src` | Timestamp | Notes |
|---|---|---|---|
| History backfill | `backfill` | Session's last use | Imported **once** per session, with the totals it had at that moment |
| Real-time delta | `live` | The moment of writing | `current projection total − already stored`, delta only |

The delta needs no separate baseline: the rows already on disk *are* the baseline.
Repeated scans, process restarts and a lost row all heal themselves — the next pass
recomputes the missing difference and never double counts.

Two triggers keep it fresh:

- `sessionProjections.onChanged` (when the build provides it) — a projection change
  marks the state dirty and a write follows after a 700 ms debounce;
- a 20-second poll of `sessions.list()` + `sessionProjections.snapshot(session, ['tokenUsage'])` — no event
  plumbing involved, always effective.

`session/event` is only a trigger now; it never writes rows. The `usage` inside an
event is a single call's amount, and mixing it with the delta model would double count.

### The baseline ledger

Backfill rows are the **baseline**, therefore:

1. Each session has exactly one, and it is never pruned even when its day falls outside
   the retention window — dropping it would erase the baseline and the next delta pass
   would count the whole session as if it happened today;
2. Old sessions that sit outside every window still get a baseline row. Their `day` is
   in the past, so they never appear in "today / 7 days / 30 days".

### Baseline of a forked session

A session forked from another one (DSH marks it `isSeeded: true` with a `parentSession`)
**inherits the parent's cumulative usage**, so it does not start at zero: a
`src: 'seeded'` baseline row is written first (the parent's already-stored amount, capped
by what the child holds), and only what comes after belongs to the fork. `seeded` rows
are **never aggregated** — they are a baseline — and, like backfill rows, they are never pruned.

Early versions missed this and counted a fork's whole inherited history again. To repair a
store written back then:

```bash
node scripts/purge-seeded.mjs --dry-run   # see what would go
node scripts/purge-seeded.mjs             # apply (takes a backup first)
```

`live` rows expire normally according to `retentionDays`.

## Install

**This plugin is not published to npm.** Install it from GitHub.

### Option 1: manual link (recommended, works on any DSH version)

1. Clone it anywhere (track `main`, or pin a tag):

```powershell
git clone https://github.com/yupaoa/dsh-mycost.git $env:USERPROFILE\dsh-plugins\dsh-mycost
# Behind the GFW? use the mirror:
# git clone https://gh-proxy.com/https://github.com/yupaoa/dsh-mycost.git ...
```

2. Add the dependency to your profile's `package.json` and list the plugin as a bundle:

```json
{
  "dependencies": {
    "dsh-mycost": "link:C:/Users/<you>/dsh-plugins/dsh-mycost"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-mycost"] }
  }
}
```

3. Run `pnpm install` inside the profile directory, then **restart DSH**.

### Option 2: when your host accepts git specs

```bash
dsh plugin --profile desktop add github:yupaoa/dsh-mycost
```

If it reports that the package cannot be found, your build does not support git specs —
use option 1.

### After install

Host-side code loads only at boot, so **restart DSH after every change**. The plugin has
a host half and a client half and neither needs a build step: the host reads `index.js`,
the client reads `client.js` (declared through `dsh.client` in `package.json`).
Version history lives in [Releases](https://github.com/yupaoa/dsh-mycost/releases).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `retentionDays` | `30` | Days kept, 1–365. Older rows are pruned |
| `timeZone` | `Asia/Shanghai` | Time zone used to define "today" and day boundaries |

## Known limits

- **Backfill is approximate**: a whole session is attributed to its last-use day. If a
  session spans several days, the earlier usage lands on that last day too; everything
  **after** the import is attributed precisely by the delta path.
- **`onChanged` may be absent**: some builds do not expose the hook, in which case
  real-time granularity degrades to the 20-second poll (the boot log says which path is
  in use).
- **The nav icon comes from a slot**: the shell renders each row's glyph through
  `renderSlot('settings.section.icon', { size, active }, { only: row.id })`, so this plugin
  registers an entry with `id: 'my-cost'` and never touches the DOM. On a build without
  that slot the worst case is **the default gear** — functionality is unaffected.
- **Cold sessions need a projection cache**: a session this process never opened and
  that `sessionProjectionCache` has no record of is skipped rather than counted as zero.
- **The page refreshes every 60 seconds**: a day rollover shows up at most a minute
  late; a failed background tick never replaces the numbers already on screen.

## Development

```bash
node --test test/*.test.js
```

56 tests covering pure aggregation (`wire.js`), storage (`store.js`), the host half
(backfill / delta / RPC / tool) and the client half (settings render, window switching,
rescan, nav icon replacement). No external services, no network.

## License

MIT
