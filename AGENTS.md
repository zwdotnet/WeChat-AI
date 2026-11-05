# AGENTS.md · WeChat-AI 项目入口

> 本文件是仓库级接手入口。新会话、新模型或新执行者进入本项目时，先读这里，
> 再按任务阅读 `docs/` 下的对应文档。代码、运行时状态和本文冲突时，以当前代码与
> 实际运行结果为准；不确定就重新观察，不要猜。

## 必须遵守

- **默认不提交、不推送 GitHub、不创建 PR、不发布 Release。** 用户明确说“上传/推送/提交”
  时才执行；普通改动只保留工作树，并按要求部署到 NAS 看效果。
- **不主动重构或修复无关问题。** 先完成用户指定的最小范围，再报告发现的旁支问题。
- **不把真实凭据写入仓库。** 管理员密码、Redis 密码、第三方 API Key 等只能通过
  `.env` 或运行时配置提供；文档、测试、日志和回复里只写变量名或占位符。
- **Windows 下使用 PowerShell 语法。** 路径含空格时必须使用引号或 `-LiteralPath`。
- **小改动定点测试。** 默认只跑受影响包的类型检查和测试，不为一次小修跑全量；
  只有跨包行为或用户明确要求时才扩大范围。
- **不要覆盖 NAS 上的 `.env`。** 同步代码时排除本地 `.env`、缓存和构建产物。
- **不要执行破坏性数据操作。** 未经明确授权，不运行 `docker compose down -v`、
  不清空 Redis、不迁移/删除生产数据、不改动无关容器。

## 项目是什么

WeChat-AI 是一个自托管的微信角色扮演聊天服务：腾讯 iLink 接入微信，
Redis 保存机器人、对话、人设、表情包和运行时配置，管理端和用户端由 Fastify 提供。
当前仓库是用户维护的个人 Fork，支持平台 LLM、用户自定义 OpenAI 兼容模型、
联网搜索、表情包、Chatflow、多节点 worker 和 NAS Docker 部署。

## 目录结构

| 路径 | 职责 |
|------|------|
| `apps/api/` | Fastify API、iLink worker、管理台/用户中心/Chatflow 前端、运行时配置 |
| `packages/core/` | 会话编排、人设与记忆、提示词、回复格式、图片生成、Chatflow 引擎 |
| `packages/llm/` | OpenAI 兼容聊天客户端、内置工具、搜索服务商适配 |
| `packages/db/` | Redis 仓储、seed、数据访问 |
| `packages/ilink/` | 腾讯 iLink HTTP 客户端 |
| `huggingface/wechat-ai-tools/` | 可选的用户自定义模型 / 搜索出站网关 |
| `cloudflare-worker/` | 主域名多源站负载均衡 |
| `docs/` | 部署、运维、接口、验收和功能说明 |
| `scripts/` | 构建、打包、验收脚本 |

## 配置与运行时

配置优先级：

```text
.env（启动默认值）
  ↓ 被覆盖
wa:settings:runtime（Redis JSON，管理面板写入）
  ↓
进程内生效配置
```

管理面板写入的配置最多约 5 秒传播到各节点。`LLM_BASE_URL`、`LLM_API_KEY`、
`LLM_MODEL`、`LLM_TEMPERATURE`、`LLM_PROVIDER_SECRET`、Redis 连接、监听端口、
OAuth 管理权限等属于启动级或权限根配置，只能改 `.env` 并重启。

当前新增功能的详细说明见
[`docs/image-gen-and-search.md`](docs/image-gen-and-search.md)，完整配置项见
[`docs/runtime-settings.md`](docs/runtime-settings.md)。

## 常用命令

从仓库根目录执行：

```powershell
Set-Location F:\zhangwei\AI\WeChat-AI

pnpm install
pnpm diag
pnpm db:seed
pnpm dev
```

类型检查与测试：

```powershell
pnpm --filter @wechat-ai/llm typecheck
pnpm --filter @wechat-ai/llm test
pnpm --filter @wechat-ai/core typecheck
pnpm --filter @wechat-ai/core test
pnpm --filter @wechat-ai/api typecheck
pnpm --filter @wechat-ai/api test
```

需要全仓检查时再运行：

```powershell
pnpm typecheck
pnpm test
```

## 本地与 NAS 部署

- 本地仓库：`F:\zhangwei\AI\WeChat-AI`
- NAS 部署目录：`/vol1/1000/NAS/Docker/wechat-ai`
- 常用 SSH 别名：`nas`
- 页面：`http://<NAS_HOST>:8790/`，管理台：`/admin`

NAS 上通常只重建应用服务：

```powershell
ssh nas "cd /vol1/1000/NAS/Docker/wechat-ai && docker compose build wechat-ai && docker compose up -d wechat-ai"
ssh nas "cd /vol1/1000/NAS/Docker/wechat-ai && docker compose ps"
```

部署后检查容器状态和 `/health`，再看应用日志：

```powershell
ssh nas "docker logs --tail 120 wechat-ai"
```

同步方式：

- 优先使用现有 SMB 挂载 `Z:\Docker\wechat-ai`；挂载掉线时不要强行等待，
  改用 `scp` 直传 `nas:` 目标路径。
- 只同步本次改动的源码/静态文件；不要上传 `node_modules`、`.git`、`.env` 或本地缓存。
- 文档改动（例如 `docs/*.md`、`AGENTS.md`）不需要重建或重启 NAS 服务。
- 用户要求“只部署看效果”时，不 commit、不 push，不把本地试验性提交当成交付。

## 当前重点功能

### 生图

- 工具名：`generate_image`
- 配置：`IMAGE_GEN_ENABLED`、`IMAGE_GEN_MODEL`、`IMAGE_API_BASE_URL`、`IMAGE_API_KEY`
- 生图 API 根地址会追加 `/images/generations`
- 每轮最多 2 张，文字气泡发送后再发图片
- 关键日志：`[image-gen] ...`、`[worker] sent generated image ...`

### 搜索

- provider：`gateway`、`exa`、`tavily`、`firecrawl`、`other`
- Exa/Tavily/Firecrawl 只需 Key；`gateway` 填网关裸地址；`other` 填完整链接
- 全局联网开关和当前人设联网开关必须同时打开

### 回复稳定性

- `LLM_TEMPERATURE` 必须传入平台 LLM 和视觉客户端
- `packages/core/src/reply-format.ts` 会清理正文后的 `{"messages":...}` 残片
- worker 发送前还有一次表情 JSON / 消息 JSON 兜底清理

## 文档索引

| 文档 | 用途 |
|------|------|
| `docs/image-gen-and-search.md` | 生图、搜索服务商、温度与 JSON 残渣修复 |
| `docs/runtime-settings.md` | 管理面板可配置项、优先级、热更新 |
| `docs/runbook.md` | 首次部署、运维与故障处理 |
| `docs/docker.md` | Docker / 多节点部署 |
| `docs/e2e-checklist.md` | 真机验收清单 |
| `docs/admin-api.md` | 管理 API |
| `docs/ai-gateway.md` | HF 工具网关 |
| `docs/chatflow.md` | Chatflow 编排 |

## 接手检查

1. 先看 `git status --short`，确认是否有未提交改动；不要顺手丢弃或覆盖它们。
2. 只读相关代码和文档，先确认当前实现，不根据旧提交或旧交接猜测。
3. 修改后先跑受影响包的类型检查和测试，再做必要的真机/面板验证。
4. 未经用户明确要求，不 commit、不 push、不发布。
5. 行为、配置或故障处理变化时同步更新 `docs/`；不要把临时排障过程写成长期规则。
