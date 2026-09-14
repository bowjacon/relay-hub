# Relay Hub

一个面向 AI Agent CLI 的 API 中转聚合控制台。当前实现包含：

- Web 控制台：来源列表、状态检查、启停、删除、新增来源、Agent 路由切换、活动日志。
- 模型目录：OpenAI、Claude / Anthropic、DeepSeek 的后台目录下拉选择；填写来源 API Key 后可从官方 `/models` 接口刷新当前账号可用模型，后台每 6 小时自动刷新。
- 调用指标：每个来源记录模型调用次数、成功率、平均/最近延迟、健康检查可达率和最近调用时间。
- 模型探测：可对来源下的每个模型发起最小探测请求，记录模型可达率、探测延迟、连续失败次数和最近错误；后台每 5 分钟自动探测启用来源。
- OpenAI-compatible API：`/v1/chat/completions`、`/v1/models`。
- Codex CLI 入口：`/v1/responses`。
- Claude CLI 入口：`/v1/messages`。
- `dry_run=true` 或 `x-relay-dry-run: true` 可在没有上游凭据时验证选路。
- API 来源支持 OpenAI、DeepSeek、Claude 官方 API，以及自定义协议和地址的第三方中转站；官方来源的协议和地址由后台自动填充。
- 第三方 OpenAI-compatible / Anthropic 来源如果只填写域名（例如 `https://gateway.example.com`），后台会自动补全 `/v1`；转发时会校验上游响应必须是有效 JSON，若对方返回首页 HTML 或空内容，会明确返回 502，而不是把错误伪装成 HTTP 200。
- Claude CLI 对第三方 OpenAI-compatible 来源发起流式请求时，后台会将上游非流式 JSON 转换为 Anthropic Messages SSE 事件，避免把 OpenAI SSE 直接透传造成“HTTP 200 但响应格式错误”。
- 长对话转发默认超时为 180 秒（最大 600 秒），旧版状态文件中的 30 秒超时会在升级后自动提升；可通过 `.env` 的 `REQUEST_TIMEOUT_MS` 调整。请求日志会记录请求体大小、上游状态和响应类型，但不会记录对话正文或密钥。
- 每个 API 来源可单独开启本机 HTTP 代理；开启后优先使用设置页保存的地址、端口和协议，设置留空时回退到服务进程的 `http_proxy`（兼容大写 `HTTP_PROXY`）环境变量。
- 运行日志按 JSONL 写入 `logs/`，默认按 20MB 单文件轮转、保留 10 个文件并清理 14 天前日志；不会记录完整 prompt、响应正文或认证密钥。
- 设置页支持配置当前服务器的 HTTP 代理地址、端口和协议；来源只有开启代理开关后才使用该代理。代理设置属于本机运行环境，不会随迁移配置导出。
- 设置页支持导出/导入 JSON 配置；默认导出脱敏配置，另有明确确认后的含凭据导出。配置文件可直接拖入网页输入框，导入不会包含日志、调用统计或代理设置。服务会把来源、路由和 Agent Key 持久化到本机 `data/relay-hub-state.json`，重启不会更换已生成的 Key；该目录已加入忽略规则且不在发布白名单内。
- 管理后台需要登录；首次启动默认用户名为 `root`、密码为 `admin`。登录后请立即在“设置 → 账户安全”修改密码。密码以加盐哈希保存在本机状态文件中，配置导入/导出不会覆盖密码；后台会话使用 HttpOnly Cookie，连续登录失败会临时限流。`/v1/*` 仍使用各 Agent 专属 API Key，不依赖后台网页登录。

## 启动

```bash
npm run dev
```

浏览器打开 <http://localhost:4173>。

生产环境请在反向代理后启用 HTTPS，再开放管理页面；否则登录密码会通过明文 HTTP 传输。不要将 `data/relay-hub-state.json`、`.env` 或含凭据导出文件提交到仓库。

当前发布仓库：<https://github.com/bowjacon/relay-hub>

其他服务器可直接执行下面的一条命令部署（默认安装到 `$HOME/relay-hub`，首次运行会创建 `.env`，不会覆盖已有 `data/`、`logs/` 或 `.env`）：

```bash
curl -fsSL https://raw.githubusercontent.com/bowjacon/relay-hub/main/deploy.sh | bash
```

也可以指定安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/bowjacon/relay-hub/main/deploy.sh | APP_DIR=/opt/relay-hub bash
```

脚本要求 Node.js 18+、npm 和 Git；它会执行 `npm install --omit=dev` 并后台启动服务。网页打开 `http://服务器地址:4173`。首次启动后在网页中添加来源、配置当前服务器代理，再按需导入配置文件。仓库忽略 `data/`、`logs/`、`.env` 和 `relay-hub-config*.json`，不要把含凭据导出文件提交到 Git。

部署脚本会实时显示 Git 拉取、npm 安装、停止旧服务和启动检查的进度，并为各阶段设置超时：Git 默认 180 秒、npm 默认 300 秒、停止服务和启动服务默认 30 秒。默认命令会先拉取远程更新；如果只想使用服务器当前代码直接部署，不拉取 Git，使用：

```bash
bash deploy.sh --direct
```

需要更新代码时使用：

```bash
DEPLOY_TIMEOUT_GIT=300 DEPLOY_TIMEOUT_NPM=600 RELAY_HUB_RESTART=1 bash deploy.sh --update
```

只重启当前版本、不安装依赖可使用 `bash deploy.sh --restart`。首次部署时目标目录不存在，`--direct` 会先克隆仓库再完成安装和启动。

超过超时后脚本会终止当前阶段并输出 `logs/console.log` 最近 30 行。脚本默认禁止 Git 凭据交互、npm 依赖重试一次并关闭 audit/fund；需要代理下载时，先设置 `http_proxy` 和 `https_proxy`。

设置页的“检查更新”会比较 GitHub `main` 分支；通过本脚本启动的服务点击“立即升级”后会自动拉取、安装依赖并重启，同时保留 `data/relay-hub-state.json` 中的 API 来源、来源 Key、Agent Key、路由和状态。命令行更新可执行：

```bash
cd "$HOME/relay-hub"
RELAY_HUB_RESTART=1 bash deploy.sh
```

如果服务不是通过 `deploy.sh` 启动，更新接口会只更新文件并提示手动重启；不要删除 `data/` 目录。

## CLI 接入

把控制台 Agent 路由页生成的专属 API Key 和对应 API 地址填入 CLI。每个 Agent 的 Key 只允许访问自己的协议入口：

```text
DSH                http://localhost:4173/v1/chat/completions
Codex CLI          http://localhost:4173/v1/responses
Claude Code        http://localhost:4173/v1/messages
```

路由页的“生成 / 轮换 Key”会立即使旧 Key 失效；明文 Key 只在轮换响应中返回一次，页面随后仅显示掩码。

Claude Code 的 `ANTHROPIC_BASE_URL` 必须填写中转根地址（不要附加 `/v1/messages`）；若上游是 DeepSeek 或其他 OpenAI-compatible 来源，需同时设置 `ANTHROPIC_CUSTOM_MODEL_OPTION` 为路由页选择的上游模型。中转会将 Claude Messages 请求及工具定义转换为上游格式，并把响应转换回 Claude 格式。

## 上游与生产化

来源、路由、Agent Key 和来源状态会保存到本机 `data/relay-hub-state.json`；请求日志仍按日志轮转策略单独保存。生产部署时建议将它替换为 SQLite/PostgreSQL，并增加：密钥加密、用户级 Relay API key、请求鉴权、限流、预算、真实 `/models` 健康探测，以及针对 OpenAI Responses 与 Anthropic Messages 的完整协议转换。

模型目录接口：

```text
GET  /api/models/catalog?provider=openai|anthropic|deepseek
POST /api/models/refresh
GET  /api/runtime-logs?channel=request|app|error|audit&limit=100
DELETE /api/runtime-logs
GET  /api/config/export?includeSecrets=false
POST /api/config/import
GET  /api/update/check
POST /api/update/apply
GET  /api/auth/session
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/password
```

`POST /api/models/refresh` 可传 `sourceId` 使用已保存来源的 Key，也可传 `provider`、`apiKey`、`baseUrl` 临时刷新。官方接口不可用时返回最近一次成功缓存或内置目录，不会清空已有模型。

模型状态接口：

```text
POST /api/sources/:id/models/check       # 探测该来源的全部模型
POST /api/sources/:id/models/check       # body: { "model": "gpt-5" } 只探测一个模型
GET  /api/sources/:id/models/status      # 读取逐模型状态与统计
```

探测请求使用 `max_tokens: 1` 和 `temperature: 0`，OpenAI-compatible 来源调用 `/chat/completions`，Anthropic 来源调用 `/messages`。模型状态会区分 `available`、`degraded`、`unavailable`、`unknown`，与实际业务调用成功率分开统计。

目录刷新使用官方模型接口：[OpenAI Models](https://platform.openai.com/docs/api-reference/models/list)、[Anthropic Models](https://docs.anthropic.com/en/api/models-list)、[DeepSeek Models](https://api-docs.deepseek.com/api/list-models)。

本项目的路由设计参考了 GitHub 上的 [CrossLink](https://github.com/HotRiceNoodles/CrossLink)、[freeport](https://github.com/ReallyArtificial/freeport)、[ImBIOS/relay](https://github.com/ImBIOS/relay) 和 [codex-relay](https://github.com/metafars/codex-relay)；它们分别覆盖多协议转换、管理后台、Agent 热切换与 Codex Responses 兼容等场景。
