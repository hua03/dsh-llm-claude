# @hua03/dsh-llm-claude

在 DeepSeek Harness（DSH）里接入 Claude，面向 **Claude Code 客户端特征的 Anthropic 兼容网关**。

- 传输层用 pi-ai 的 `anthropic-messages` 实现（DSH 的 `dsh-llm-pi-ai` 用的同一套），插件只做 DSH 词表 ↔ pi-ai 词表、认证/请求头、Claude Code payload 兼容，以及事件 → `StreamChunk`。
- 请求仍然完整经过 DSH 运行时：路由、`llm/stream` waterfall、`dsh-llm-retry`、超时、chunk 组装、session 落盘、工具历史/图片投影、replay 隔离都由 DSH 负责。
- 设计文档：`/Users/huahao/workspace/Project/design/dsh-llm-claude/DESIGN.md`（§15 解释了为什么不自写传输）。

```
DSH runtime (LlmRuntime)  →  ClaudeAdapter  →  pi-ai anthropic-messages  →  gateway
                               ├─ context.js   DSH 词表 → pi-ai Context
                               ├─ compat.js    onPayload: 身份块/工具名/metadata
                               ├─ adapter.js   认证、UA、beta、idle 超时
                               └─ stream.js    pi-ai events → StreamChunk + 工具名还原
```

## 安装

```bash
# 1. 安装包到 profile（普通插件包，只会作为依赖装上）
dsh plugin --profile web add file:/Users/huahao/workspace/Project/github/dsh-llm-claude

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 里 insert 一行（普通包不会自动挂载）
#    参考 cordis.patch.yml.example

# 3. 重启 dsh web
```

凭据放在环境或 credentials seam，配置里只写引用名：

```bash
# 启动前导出（DSH 的环境是启动快照，启动后再 export 不生效）
export GATEWAY_API_KEY=sk-...
dsh web
```

或写进 `~/.dsh/.env` / 项目的 `.env`（优先级：托管存储 > 启动环境快照 > 项目 .env > `$DSH_HOME/.env`）。

## 配置

```yaml
- insert:
    - id: llm-claude-gateway
      name: '@hua03/dsh-llm-claude'
      config:
        provider: claude-gateway
        displayName: 该网关 Claude
        baseURL: https://gateway.example.com/api
        apiKeyEnv: GATEWAY_API_KEY
        auth:
          header: x-api-key            # x-api-key | authorization-bearer
        claudeCodeCompat:
          mode: auto                   # auto | off
          identityBlocks: true
          userAgent: "claude-cli/2.1.293 (external, cli)"
          headers:
            x-app: cli
          metadataUserId: true
          toolSchema: names-only       # names-only | claude-code
          unknownToolPrefix: mcp__dsh__
        thinking:
          mode: auto                   # auto | off | adaptive | budget
        reasoningEffort: high
        cacheRetention: short          # none | short | long
        anthropicBeta: []              # 显式给出时独占 anthropic-beta 请求头
        maxTokens: 64000
        defaultContextWindow: 262144
        maxRequestImagesBytes: 20971520
        streamIdleTimeoutMs: 300000
        models:
          - id: claude-haiku-5-5
            name: Claude Haiku 5.5
            contextWindow: 200000
            maxTokens: 64000
            inputModalities: [text, image]
            reasoning: false
          - id: claude-opus-5-5
            name: Claude Opus 5.5
            contextWindow: 1000000
            maxTokens: 128000
            inputModalities: [text, image]
            reasoning: adaptive
            supportsTemperature: false
          - id: claude-sonnet-5-5
            name: Claude Sonnet 5.5
            contextWindow: 1000000
            maxTokens: 128000
            inputModalities: [text, image]
            reasoning: adaptive
```

`models` 省略时使用内置三款（haiku/opus/sonnet 5.5）。未列出的模型 id 仍可按核心路由透传（按纯文本、`defaultContextWindow` 处理），但不会出现在 GUI 模型选择器里。

### Claude Code 兼容层做了什么

仅在 `claudeCodeCompat.mode=auto` 且模型 id 以 `claude-` 开头时生效，只改将要发出的请求体（经 pi-ai 的 `onPayload`），不改 session log：

| 规则 | 说明 |
|---|---|
| 身份 system block | 在最前面插入 pi 同款两句身份文本，按精确文本去重（幂等） |
| `metadata.user_id` | JSON 字符串：`{device_id, account_uuid:"", session_id}`；device_id 用 DSH 的 anonymous user id |
| 工具名映射 | `read/write/edit/bash/grep/glob → Read/Write/Edit/Bash/Grep/Glob`；其它工具 → `mcp__dsh__<name>`；已有 `mcp__` 保持 |
| 历史一致 | 声明与历史 `tool_use` 用同一套名字；响应侧再还原成 harness 名字 |
| Bash 时间单位 | 对外 `timeout`(ms) ↔ harness `timeoutMs` |
| `claude-code` schema 模式 | Edit 换成 Claude Code schema（无 `replace_all`）、Bash 暴露 `timeout`、Grep 追加行为说明；默认 `names-only` 保留 harness 的 `workdir`/`sandbox_permissions` |
| thinking | `off` 时强制 `thinking:{type:"disabled"}` 且不回传历史 thinking；adaptive/budget 由 pi-ai 按模型 compat 决定 |

**已知偏离**：网关要求 `User-Agent: claude-cli/...`，而 DSH 归因契约要求每个 provider 请求带 harness 的 UA。本插件在 compat 模式下把 UA 让给网关，并用 `x-dsh-attribution` 头保留 harness 身份。只用官方 API 时可以 `mode: off`，回到正常归因。

## 验证

```bash
node --test tests/*.test.mjs     # 39 个单元/集成测试（含本地 mock SSE 全链路）
node scripts/smoke.mjs           # 打印真实请求体/头与 chunk，便于肉眼核对
node scripts/smoke.mjs --thinking
```

测试覆盖：compat 规则与幂等、配置校验、replay 签名回放/降级、pi-ai 事件 → chunk、错误分类、两轮工具往返、adaptive thinking、429 分类、compat 关闭。

真机验证（需要网关 key，本机未内置）：

```bash
export GATEWAY_API_KEY=...
dsh headless --profile web "list files in the current directory"
```

## 已知限制

- 未做 `registerConfigurableProviders` / `registerModelDiscovery`：不能从 Web 设置页“新增 provider”，也不会探测 `/v1/models`。
- 不支持 Claude 订阅 OAuth（`auth.header` 预留了 bearer）。
- 图片一律 inline base64，没有 Files API；`imageRequestPricing` 未实现（token 计费退回中性估算）。
- 不声明 `toolUpdate`/`systemPromptUpdate`：每轮下发完整工具声明，系统提示变化会重写首条 system 消息（Claude Messages 没有等价能力）。
- 中途工具增删（Anthropic tool-change beta）未实现。
- 依赖 pi-ai 的 `onPayload`/`headers`/identity 行为；`tests/e2e.mock.test.mjs` 直接断言 wire body 作为升级门禁。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.js` | cordis 入口（`name`/`inject`/`Config`/`apply`），credentials、adapter 注册、retry 变化时原子 replace |
| `src/config.js` | schemastery schema、默认 catalog、fail-loud 校验与解析 |
| `src/adapter.js` | `LlmAdapter` 实现：模型元数据、认证头、UA、pi-ai 调用、idle 超时 |
| `src/context.js` | DSH 历史 → pi-ai Context（system/toolResult/图片/replay） |
| `src/compat.js` | Claude Code payload 转换与工具名/参数双向映射（纯函数） |
| `src/stream.js` | pi-ai events → `StreamChunk`，usage/finish/replayState |
| `src/replay.js` | thinking signature 的 replay envelope 与降级 |
| `src/errors.js` | provider 错误文本 → harness error code |
