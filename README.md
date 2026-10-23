# @hua03/dsh-llm-claude

在 DeepSeek Harness（DSH）里为**已有的 Claude 路由**加上 Claude Code 客户端兼容，面向 `claude-cli` 特征的 Anthropic 兼容网关。

它**不是**一个新的 provider：

- 不注册路由、不定义模型目录、不设置 API key；
- 复用 DSH 里已经配置好的 provider 路由（例如 `llm-pi-ai` 的 `gateway`）的 `baseURL`、`apiKeyEnv`、`headers`、模型 catalog 与凭据；
- 只在满足条件时接管请求：`model` 以 `claude-` 开头 **且** 该路由的 `api` 是 `anthropic-messages`；
- 其它模型、其它协议、未配置的路由、拿不到凭据的路由，全部原样交还给原插件（`next()`）。

```
DSH LlmRuntime.stream(GenerateOptions)
  └─ llm/stream waterfall
        ├─ 命中条件 → llm-claude: pi-ai 请求 + onPayload 伪装 → chunk 流
        └─ 其它     → 原 provider 插件（llm-pi-ai 等）原样处理
```

## 安装

包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把本包加入 `dsh.profile.bundles` 并应用默认配置——**不需要改 profile 的 yml、不需要新增 key、不需要新 route**：

```bash
dsh plugin --profile web add file:/Users/huahao/workspace/Project/github/dsh-llm-claude
# 重启 dsh web
```

前提：你的 profile 里已经有一条可复用的 Anthropic Messages 路由（本机即 `llm-pi-ai` 的 `gateway`，`apiKeyEnv: GATEWAY_API_KEY` 已在 `~/.dsh/.credentials.yaml` 中）。

## 触发规则

同时满足才接管：

| 条件 | 说明 |
|---|---|
| `config.enabled` | 默认 `true` |
| `model` 以 `claude-` 开头 | 非 Claude 模型一律不碰 |
| 路由 `api === 'anthropic-messages'` | 从 DSH loader 里读取该路由的配置；其它协议不碰 |
| 路由声明了 `models` 与 `apiKeyEnv` | 没有 catalog 或凭据引用时无法忠实复现，交还原插件 |
| 凭据能解析 | 解析不到时交还原插件，让它给出自己的缺凭据诊断 |
| 不在 `excludeProviders` / 在 `includeProviders` | 可选白/黑名单 |

接管后只改**将要发出的请求体**（pi-ai `onPayload`），不改 session log：

| 规则 | 说明 |
|---|---|
| 身份 system block | 最前面插入 pi 同款两句身份文本，按精确文本去重（幂等） |
| `metadata.user_id` | JSON 字符串：`{device_id, account_uuid:"", session_id}`；device_id 用 DSH anonymous user id |
| 工具名映射 | `read/write/edit/bash/grep/glob → Read/Write/Edit/Bash/Grep/Glob`；其它 → `mcp__dsh__<name>`；已有 `mcp__` 保持 |
| 历史一致 | 声明与历史 `tool_use` 同名同参；响应侧再还原成 harness 名字 |
| Bash 时间单位 | 对外 `timeout`(ms) ↔ harness `timeoutMs` |
| `toolSchema: claude-code` | Edit 换成 Claude Code schema（无 `replace_all`）、Bash 暴露 `timeout`、Grep 追加行为说明；默认 `names-only` 保留 harness 的 `workdir`/`sandbox_permissions` |
| thinking | 请求显式 `off` 或 `compat.thinking: off` 时强制 `thinking:{type:"disabled"}` 且不回传历史 thinking；否则沿用路由的 `reasoning` 默认（无则 `high`） |

**已知偏离**：网关要求 `User-Agent: claude-cli/...`，而 DSH 归因契约要求每个 provider 请求带 harness UA。接管时把 UA 让给网关，并用 `x-dsh-attribution` 头保留 harness 身份。

## 配置（可选）

默认值开箱可用；需要限制范围或调细节时，按 id 覆盖 bundle 插入的那一行：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: llm-claude-compat
  config:
    enabled: true
    includeProviders: [gateway]   # 空 = 所有可复用的 anthropic-messages 路由
    excludeProviders: []
    claudeCodeCompat:
      identityBlocks: true
      userAgent: "claude-cli/2.1.293 (external, cli)"
      headers:
        x-app: cli
      metadataUserId: true
      toolSchema: names-only        # names-only | claude-code
      thinking: auto                # auto | off
      unknownToolPrefix: mcp__dsh__
    maxRequestImagesBytes: 20971520
    debug: false
```

## 验证

```bash
node --test tests/*.test.mjs     # 37 个单元/集成测试（本地 mock SSE 全链路）
node scripts/smoke.mjs           # 打印接管后的真实请求体/头与 chunk
node scripts/smoke.mjs --thinking
```

覆盖：触发/透传判定、路由配置与凭据复用、compat 规则与幂等、replay 签名回放/降级、事件→chunk、错误分类、两轮工具往返、adaptive thinking、429 分类、图片 base64/预算/offload、`claude-code` schema 模式。

真机验证（需要网关 key；本机未内置）：

```bash
export GATEWAY_API_KEY=...   # 或复用已有 ref；见下
dsh headless --profile web "list files in the current directory"
```

> 接管用的是路由自己的 `apiKeyEnv`。若你的配置文件指向一个还没有值的 ref（例如新加 `GATEWAY_API_KEY`），把值放进 `~/.dsh/.env` 或启动环境即可；指向 `GATEWAY_API_KEY` 则无需任何新增。

## 已知限制

- 只接管 `anthropic-messages` 路由；其它协议（openai-completions 等）不处理。
- 路由必须显式声明 `models` 与 `apiKeyEnv`；只有环境登录/OAuth 的路由不接管。
- 不做 `registerConfigurableProviders` / 模型发现；不新增任何 UI 条目。
- 图片一律 inline base64；`imageRequestPricing` 未实现。
- 不声明 `toolUpdate`/`systemPromptUpdate`（沿用原路由行为）。
- 依赖 pi-ai 的 `onPayload`/`headers`/identity 行为；`tests/e2e.mock.test.mjs` 直接断言 wire body 作为升级门禁。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.js` | cordis 入口：`name/inject/Config/apply`，注册 `llm/stream` waterfall |
| `src/interceptor.js` | 触发判定 + 凭据解析 + 透传回退 |
| `src/routes.js` | 从 DSH loader 读取已有路由的 `providers` 配置 |
| `src/claude-stream.js` | 一次 Claude 请求：pi-ai 调用、headers/identity、idle 超时、chunk 翻译 |
| `src/compat.js` | Claude Code payload 转换与工具名/参数双向映射（纯函数） |
| `src/context.js` | DSH 历史 → pi-ai Context（system/toolResult/图片/replay） |
| `src/stream.js` | pi-ai events → `StreamChunk`，usage/finish/replayState |
| `src/replay.js` | thinking signature 的 replay envelope 与降级 |
| `src/errors.js` | provider 错误文本 → harness error code |
| `src/config.js` | interceptor 配置 schema 与校验 |
