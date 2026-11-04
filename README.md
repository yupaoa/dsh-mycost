# dsh-mycost

[![license](https://img.shields.io/github/license/yupaoa/dsh-mycost.svg)](LICENSE)
[![repo](https://img.shields.io/badge/GitHub-yupaoa%2Fdsh--mycost-181717.svg)](https://github.com/yupaoa/dsh-mycost)

**看一眼就知道 token 花在哪**

DeepSeek Harness 的 token 用量统计插件：把最近 30 天的用量按**模型**和**提供商**拆开，
分别统计**缓存命中输入 / 缓存未命中输入 / 输出**三个桶，给出缓存命中率与用量结构，
今天、7 天、30 天随时切换。只数字，不折算金额。

> Token usage for DeepSeek Harness: cache-hit input, cache-miss input and output tokens,
> split by model and provider over the last 30 days, with hit rate and usage structure.
> Numbers only — no money.

[English](README.en.md) · **中文**

> **环境要求**：DSH `>= 0.2.1-rc.2`，Node `^22.19.0 || >=24.0.0`。

## 它能做什么

- 📊 **三个恒定的桶**：缓存命中输入（`cacheRead`）、缓存未命中输入（含缓存写）、输出。
  三者永远分列，不合并成含糊的「总 token」。
- 🧮 **缓存命中率**：`cacheRead / (cacheRead + uncachedInput)`，对**聚合后的总量**再相除，
  不是对各分组的比率取平均——否则一次小会话能盖过百万 token 的大会话。
- 🧱 **用量结构**：命中 : 未命中 : 输出 归一化到输出为 1，另给输入 : 输出总比例。
- 🗂️ **按模型 / 按提供商**：各自一张表，带条形占比、调用次数、命中率。
- 🗓️ **今天 / 7 天 / 30 天**：窗口在**每次请求时**用当前日期现算，跨天自动翻页，
  老数据随时间自然滑出；30 天不用，三页全部归零。
- ⚡ **实时增量**：发一条消息，今天的数字就动——哪怕会话是昨天开的。
  采集走「当前投影总量 − 已入库总量」，只记差值。
- 🧾 **历史回填**：装上就能看到过去的用量，无需先聊几轮。
- 🔁 **重新扫描**：数据源卡片和标题栏的 `↻` 都能立刻重扫历史并刷新。
- 🖥️ **设置页独立一栏**：设置 → **Token 用量**，左侧带自己的柱状图标。
- 🛠️ **`usage_report` 工具**：让模型自己回答「我用了多少 token」，可指定天数与模型。
- 🔒 **只读不写模型状态**：不声明工具、技能或模型选择，只读取用量投影。

### 它刻意不做什么

| 不做 | 原因 |
|---|---|
| 折算金额 | 各家价格与折扣变动频繁，插件只给 token 原始口径 |
| 读平台内部缓存或会话文件 | 只通过 `sessions` / `sessionProjections` / `sessionQuery` 的公开读取接口取值 |
| 逐次调用的精确历史 | 回填是按会话的最后一次使用归因的近似值（见「已知限制」） |
| 跨设备同步 | 数据只落在本机 `DSH_HOME` 下，不外发任何请求 |

## 统计口径

| 桶 | 含义 | 来源 |
|---|---|---|
| `uncachedInput` | 缓存**未命中**的输入 token | `usage.inputTokens` |
| `cacheRead` | 缓存**命中**的输入 token | `usage.cacheReadTokens` |
| `cacheWrite` | 写入缓存的 token | `usage.cacheWriteTokens` |
| `output` | 输出 token | `usage.outputTokens` |

- **命中率** = `cacheRead / (cacheRead + uncachedInput)`，分母为 0 显示 `—`。
- **用量结构**三分：未命中（含缓存写）/ 命中 / 输出，三者占比之和为 1。
- `inputTokens` 在 DSH 的用量协议里本身就是**已剔除缓存命中**的输入量
  （`dsh-token-meter` 的投影写着 `uncachedInputTokens: usage.inputTokens`），
  所以四个桶是直接映射，不做减法。
- 页面上「未命中」显示的是 `uncachedInput + cacheWrite`，因为两者都是没吃到缓存的输入。

## 数据落在哪

`<DSH_HOME>/my-cost/usage.v1.jsonl`（默认 `~/.dsh/my-cost/`）。

这是插件**自己的文件**，格式自己维护：追加写入、读取时跳过坏行、裁剪时写临时文件再原子 rename。

### 两路采集

| 来源 | `src` | 时刻 | 说明 |
|---|---|---|---|
| 历史回填 | `backfill` | 会话最后一次使用 | 每个会话**只导入一次**，写入它当时的总量 |
| 实时增量 | `live` | 写入当刻 | `当前投影总量 − 已入库总量`，只记差值 |

增量不需要额外保存 baseline：已入库的那几行本身就是 baseline。所以重复扫描、进程重启、
写坏一行都会自愈——下一轮算出的差值自然把缺的补回来，而不会重复计数。

触发来自两张网：

- `sessionProjections.onChanged`（该构建提供时）——投影一变就置脏，700ms 防抖后写一次；
- 每 20 秒轮询 `sessions.list()` + `stateOf(session, 'tokenUsage')`——不依赖事件，始终有效。

`session/event` 只作为触发器，不直接写行：事件里的 `usage` 是单次调用量，与增量口径混用会重复计数。

### 基线账本

回填行是**基线**，因此：

1. 每个会话只有一条，即使它的日子超出保留期也不会被 prune 删除——删了 baseline 就没了，
   下一轮增量会把整个会话算成今天；
2. 超出窗口的老会话同样会导入一条基线行，它的 `day` 在过去，所以不出现在任何窗口里。

`live` 行按 `retentionDays` 正常过期。

## 安装

**本插件未发布到 npm**，请从 GitHub 安装。

### 方式一：手动链接（推荐，任何 DSH 版本都可用）

1. 克隆到任意位置（追 `main` 或锁定某个 tag）：

```powershell
git clone https://github.com/yupaoa/dsh-mycost.git $env:USERPROFILE\dsh-plugins\dsh-mycost
# 国内网络可走镜像：git clone https://gh-proxy.com/https://github.com/yupaoa/dsh-mycost.git ...
```

2. 在 profile 的 `package.json` 里加依赖，并把插件挂进 bundle 列表：

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

3. 在 profile 目录下执行 `pnpm install`，然后**重启 DSH**。

### 方式二：宿主支持 git 规格时

```bash
dsh plugin --profile desktop add github:yupaoa/dsh-mycost
```

若提示找不到包，说明你用的版本不支持 git 规格，请改用方式一。

### 安装后

宿主侧代码只在启动时加载，**改完必须重启 DSH**。插件由宿主半 + 客户端半组成，
两半都不需要构建：宿主读 `index.js`，客户端读 `client.js`（由 `package.json` 的
`dsh.client` 声明）。版本历史见 [Releases](https://github.com/yupaoa/dsh-mycost/releases)。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `retentionDays` | `30` | 保留天数，1–365。超过的行会被裁剪 |
| `timeZone` | `Asia/Shanghai` | 计算「今天」与日界用的时区 |

## 已知限制

- **回填是近似口径**：整会话的量算在它最后一次使用的那天。若会话跨了好几天，
  早期用量也会落在最后那天；**之后新增的部分**由增量精确归到当天。
- **`onChanged` 不一定存在**：某些构建不提供该钩子，此时实时性退化为 20 秒轮询
  （启动日志会写明）。
- **导航图标是 DOM 替换**：设置页左栏图标由外壳按 id 决定，第三方 id 只有默认齿轮。
  本插件在导航渲染后用 `MutationObserver` 换成自己的图标，外壳若改结构，
  最坏结果是**退回齿轮**，不影响功能。
- **冷会话需要有投影缓存**：进程没打开过、且 `sessionProjectionCache` 里也没有记录的会话
  会被跳过，而不是按 0 计。
- **页面刷新间隔 60 秒**：跨零点最迟一分钟后翻页；后台刷新失败不会顶掉已有数字。

## 开发

```bash
node --test test/*.test.js
```

56 个测试，覆盖纯聚合（`wire.js`）、存储（`store.js`）、宿主（回填 / 增量 / RPC / 工具）
与客户端（设置页渲染、窗口切换、重新扫描、导航图标替换）。无外部服务、无网络。

## 许可

MIT
