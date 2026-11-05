# 生图、搜索与回复链路增强

本文记录本项目（个人 Fork）新增的生图、搜索服务商选择，以及为稳定性补上的
回复与配置修复。配置优先级与运行时热更新机制见
[`runtime-settings.md`](runtime-settings.md)。

> 本文只写变量名和占位符，不保存任何真实 Key、管理员密码或内网地址。

## 1. 功能总览

| 功能 | 当前行为 |
|------|----------|
| 图片生成工具 | 机器人可在对话中调用 `generate_image`，生成图片并在文字回复后发送到微信 |
| 搜索服务商 | 管理面板可选 `gateway`、Exa、Tavily、Firecrawl 或完整自定义链接 |
| 温度配置 | `LLM_TEMPERATURE` 已接入平台 LLM 和视觉客户端，不再被固定成 0.8 |
| JSON 残渣防护 | 模型在正文后追加 `{"messages":...}` 时，截掉残片并尽量保留净新增文本 |
| 管理面板 | 生图总开关、密钥“已设置”提示、恢复默认、暗色主题下拉框可读性 |

## 2. 图片生成

### 2.1 调用链路

1. `ChatService` 读取 `imageGenEnabled`、`imageGenModel`、`imageApiBaseUrl`、
   `imageApiKey`，四项满足后才会把 `generate_image` 加入本轮工具白名单。
2. 系统提示词加入生图规则；用户本轮消息命中画图意图时，再追加一条当轮强制提醒，
   要求模型先调用工具，不能只回复“马上画”。
3. 模型调用 `generate_image(prompt, size)`，由
   `packages/core/src/image-gen.ts` 请求 OpenAI 兼容的
   `POST {IMAGE_API_BASE_URL}/images/generations`。
4. 生成结果先缓存在本轮 `images` 数组；LLM 调用结束后再收集，避免拿到空数组。
5. worker 先发送文字气泡，再逐张调用 iLink `sendImage` 发送图片。图片发送失败
   只记录日志，不吞掉已经发出的文字回复。

每轮最多生成 **2 张**图片。主动联系消息会移除 `generate_image`，避免机器人主动
发图刷屏。Chatflow 人设当前不经过这条普通聊天链路，因此暂不提供 `generate_image`。

### 2.2 生图 API 契约

请求：

```http
POST {IMAGE_API_BASE_URL}/images/generations
Authorization: Bearer <IMAGE_API_KEY>
Content-Type: application/json
```

```json
{
  "model": "gpt-image-2-1k",
  "prompt": "画面描述",
  "n": 1,
  "size": "1024x1024"
}
```

实现兼容两种返回：

- `data[0].b64_json`：直接解码为图片；
- `data[0].url`：再下载该 URL，下载超时 60 秒。

生成请求默认超时 **180 秒**，单张图片上限 **20 MB**。未传 `size` 时使用
`1024x1024`；工具参数允许模型传入 `1024x1536`、`1536x1024` 等尺寸。

`IMAGE_API_BASE_URL` 应填 **API 根地址**（通常以 `/v1` 结尾），代码会自行追加
`/images/generations`。不要在这里重复填写完整的 `/images/generations` 路径。

### 2.3 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `IMAGE_GEN_ENABLED` | `true` | 生图总开关；设为 `false` 后即使模型和 Key 已填也不提供工具 |
| `IMAGE_GEN_MODEL` | 空 | OpenAI 兼容生图模型名；为空时关闭工具 |
| `IMAGE_API_BASE_URL` | 跟随 `LLM_BASE_URL` | 生图 API 根地址，可指向独立服务 |
| `IMAGE_API_KEY` | 跟随 `LLM_API_KEY` | 生图 API Key，可独立配置 |

管理面板对应运行时键：

- `imageGenEnabled`
- `imageGenModel`
- `imageApiBaseUrl`
- `imageApiKey`

面板行为：

- 生图组有“启用生图工具”复选框；
- 地址和密钥会显示当前生效值，密钥只显示“已设置”，不返回明文；
- 密钥留空表示不修改，输入 `-` 表示清空并回落到平台 LLM Key；
- “恢复默认”会删除 Redis 覆盖，重新使用 `.env` 的生效值。

### 2.4 日志与排查

关键日志：

```text
[image-gen] start model=... prompt=...
[image-gen] done bytes=... in ...ms
[image-gen] failed after ...ms: ...
[worker] sent generated image peer=... bytes=...
[worker] generated image send failed peer=...: ...
```

| 现象 | 优先检查 |
|------|----------|
| 模型只回复“马上画”，没有图片 | 生图总开关、模型是否非空、`generate_image` 是否出现在工具列表 |
| 工具报 `not configured` | `IMAGE_GEN_MODEL` 或 API Key 为空 |
| HTTP 404 | `IMAGE_API_BASE_URL` 是否错填了完整 `/images/generations`，或服务不支持 OpenAI 兼容路径 |
| 生成超时 | 上游生图耗时超过 180 秒，查看 `[image-gen] failed` |
| 文字到了、图片没到 | 查看 `[worker] generated image send failed`，重点看 iLink 发送失败原因 |
| 返回非 JSON | 上游不是 OpenAI 兼容响应，或代理返回了 HTML 错误页 |

## 3. 搜索服务商

### 3.1 支持的服务商

`SEARCH_PROVIDER` 可选：

| 值 | 面板名称 | 请求地址 | 认证方式 |
|----|----------|----------|----------|
| `gateway` | 自建工具网关（HF tools） | `TOOLS_BASE_URL`，裸地址自动补 `/v1/web-search` | `Authorization: Bearer <Key>` |
| `exa` | Exa — 只填 Key | `https://api.exa.ai/search` | `x-api-key` |
| `tavily` | Tavily — 只填 Key | `https://api.tavily.com/search` | `Authorization: Bearer <Key>` |
| `firecrawl` | Firecrawl — 只填 Key | `https://api.firecrawl.dev/v1/search` | `Authorization: Bearer <Key>` |
| `other` | 其他 — 填完整链接 | `TOOLS_BASE_URL` 原样使用 | 默认 `Authorization: Bearer <Key>` |

请求体和结果字段：

| 服务商 | 请求体关键字段 | 结果列表 | 摘要字段 |
|--------|----------------|----------|----------|
| `gateway` / `other` | `query`、`max_results` | `results` | `snippet`，兼容 `content` / `text` / `description` / `markdown` |
| Exa | `query`、`numResults`、`contents.text.maxCharacters=500` | `results` | `text` / `content` 等 |
| Tavily | `query`、`max_results` | `results` | `content` / `snippet` 等 |
| Firecrawl | `query`、`limit` | `data` | `description` / `markdown` / `content` 等 |

统一结果结构为：

```json
{
  "query": "查询词",
  "results": [
    {
      "title": "标题",
      "url": "https://example.com",
      "snippet": "摘要"
    }
  ]
}
```

### 3.2 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `SEARCH_PROVIDER` | `gateway` | 搜索 API 契约 |
| `TOOLS_BASE_URL` | 空 | `gateway` 填网关裸地址；`other` 填完整 API 链接；内置服务商可留空 |
| `TOOLS_API_KEY` | 空 | 网关密钥或对应服务商的 API Key |
| `TOOLS_TIMEOUT_MS` | `60000` | 搜索请求超时 |
| `WEB_SEARCH_ENABLED` | `false` | 全局联网搜索开关 |
| `WEB_SEARCH_MAX_RESULTS` | `5` | 默认结果条数，范围 1–10 |

管理面板对应运行时键：`searchProvider`、`toolsBaseUrl`、`toolsApiKey`、
`toolsTimeoutMs`、`webSearchEnabled`、`webSearchMaxResults`。

选择 Exa、Tavily 或 Firecrawl 时，面板会隐藏“工具网关地址”，只需填写 Key。
选择“其他”时才会显示地址框，并要求填写完整链接。这个 UI 行为与实际请求逻辑一致，
避免用户误以为内置服务商还需要填网关地址。

### 3.3 完整链接规则

`resolveSearchEndpoint()` 的规则：

```text
http://gateway:7860
  → http://gateway:7860/v1/web-search

https://api.tavily.com/search
  → https://api.tavily.com/search
```

即：

- **裸地址 / 根路径**用于自建网关，自动补 `/v1/web-search`；
- **带非根路径的完整链接**原样直连；
- “其他”模式应填写完整链接，不依赖自动拼接。

搜索工具只在“全局 `WEB_SEARCH_ENABLED` 打开”且“当前人设的联网开关打开”时生效。
只开全局、不开人设，机器人仍然不会搜索。

### 3.4 快速验证

1. 在 `/admin#settings` 选择 `Tavily — 只填 Key`；
2. 在“工具网关密钥”填写 Key，保存；
3. 打开全局联网搜索，并确认目标人设已启用联网；
4. 在微信里问一个需要最新信息的问题；
5. 如果失败，先看日志中的 HTTP 状态和响应前 200 个字符。

## 4. 配套修复

### 4.1 `LLM_TEMPERATURE`

此前 `.env` 中的 `LLM_TEMPERATURE` 虽然会被读取，但平台 LLM 调用没有传入该值，
实际一直使用客户端默认温度。现在：

- `apps/api/src/config.ts` 读取 `llmTemperature`；
- 平台 LLM 与视觉客户端创建时都传入 `temperature`；
- `LLM_TEMPERATURE` 仍属于只能通过 `.env` 修改的启动配置，改后需重启进程。

默认值为 `0.8`，可按模型行为调整。如果上游返回 400 并提示 temperature 超范围，
先检查该模型支持的区间。

### 4.2 `messages` JSON 残渣

模型有时会正常输出正文，又追加一段被截断的
`{"messages":["..."]}`。这段内容原本会被当作文字气泡发到微信。

`packages/core/src/reply-format.ts` 现在会：

- 识别正文之后的 `{"messages": ...}` 残片并截掉；
- 从残片中提取正文没有的净新增字符串，避免丢失模型实际补充的内容；
- 在最终气泡清洗和 worker 发送前再执行一次兜底清理；
- 如果是完整的 JSON 信封，仍交给正常解析器处理，不会误删合法多气泡回复。

### 4.3 管理面板

- 生图组增加总开关，关闭后不再向模型注入 `generate_image`；
- 生图 API 地址和 Key 显示生效值，密钥以“已设置”占位符呈现；
- 生图地址和 Key 支持“恢复默认”，清空后回落到平台 LLM 配置；
- 暗色主题下为原生 `select option/optgroup` 固定主题背景色和文字色，
  解决下拉选项白底白字不可读的问题。

## 5. 代码位置

| 路径 | 职责 |
|------|------|
| `packages/llm/src/client.ts` | 内置工具定义、工具执行、搜索服务商适配、完整链接解析 |
| `packages/core/src/image-gen.ts` | OpenAI 兼容生图请求、超时与大小校验 |
| `packages/core/src/chat-service.ts` | 生图门控、工具注入、每轮图片收集、运行时配置应用 |
| `packages/core/src/prompt.ts` | 生图提示词、画图意图当轮提醒 |
| `packages/core/src/reply-format.ts` | 多气泡解析、JSON 残渣清理、表情 JSON 兜底 |
| `apps/api/src/worker.ts` | 文字气泡之后发送生成图片，记录发送日志 |
| `apps/api/src/runtime-settings-spec.ts` | 管理面板设置项、中文标签、默认值与提示 |
| `apps/api/public/admin.html` | 设置页 UI、暗色下拉框、密钥与恢复默认交互 |

## 6. 验收清单

代码改动后至少执行受影响包的类型检查和测试：

```powershell
Set-Location F:\zhangwei\AI\WeChat-AI
pnpm --filter @wechat-ai/llm typecheck
pnpm --filter @wechat-ai/llm test
pnpm --filter @wechat-ai/core typecheck
pnpm --filter @wechat-ai/core test
pnpm --filter @wechat-ai/api typecheck
pnpm --filter @wechat-ai/api test
```

手工验收：已完成（2026-11-05）

- [x] 管理面板打开生图总开关，模型非空，微信请求画图后收到文字和图片；
- [x] 关闭生图总开关，模型不再调用 `generate_image`；
- [x] 四种搜索服务商分别用正确的 Key / 链接验证，选择内置服务商时不需要填地址；
- [x] 开启全局联网但关闭某个人设联网时，该人设不搜索；
- [x] 生图 API 返回 404、超时、非 JSON 时，日志能定位到具体阶段；
- [x] 回复正文后追加 `{"messages":...}` 时，微信端只看到正文和净新增文本；
- [x] 暗色主题下展开搜索服务商下拉框，选项文字可见。
