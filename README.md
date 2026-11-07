# dsh-providers-hub-lite（精简版）

> DeepSeek Harness 插件。本分支是重构后的精简实现：只保留 **OpenCode 免费档桥**、
> **魔搭社区官方接入** 与 **自定义供应商**，不再包含多渠道账号池、签到积分与聚合路由。
>
> ⚠️ 不要与 `dsh-providers-hub` / 旧版本同时启用：注册的 provider id 会冲突。
>
> ⚠️ **从 `dsh-providers-hub-plus` 升级**：本包已改名为 `dsh-providers-hub-lite`。
> DSH 按包名字符串寻址 bundle，老 profile 的 `package.json` 里
> `dependencies` 的键与 `dsh.profile.bundles[]` 的条目**两处都还是旧名**，
> 必须一起改：只改一处会静默失效（宿主报 `N entry did not activate` 并把插件
> 自动禁用，或整个 bundle 被跳过且不加载）。推荐用 `dsh plugin --profile <name>`
> 的 `remove` / `add` 各走一遍，让工具自己写这两处。

## 渠道

| 渠道 | 接入方式 | 说明 |
|---|---|---|
| `opencode` | 本机 `opencode serve` 桥 | 只承接 OpenCode Zen **免费档**模型；插件不配 Key、不构造推理请求，认证与额度由本机官方客户端负责 |
| `modelscope` | 官方 API | 静态 API Key + 标准 OpenAI 兼容接口，`https://api-inference.modelscope.cn/v1` |
| 自定义供应商 | 用户自建 | 每个实例一条路由，支持 OpenAI Chat Completions（默认）/ OpenAI Responses / Anthropic Messages |

另附**本机 OpenAI 兼容网关**，按已注册路由动态枚举模型，供其它客户端复用。

### 为什么 opencode 只走桥

实测（2026-11-06）：插件自造 HTTP 请求直连 OpenCode Zen 一律返回
`429 FreeUsageLimitError`，网关只放行**真实 opencode 客户端进程**发出的连接；
替换 TLS 指纹、全套官方请求头、真实 session id、原报文都无效。
`session.generate` 与 `/api/experimental/generate` 在免费档固定 503，
只有 `session.prompt` + 自定义 agent 循环可用。因此本插件：

- 自 spawn 本机 `opencode serve`（需本机安装 OpenCode 2.x，或设 `OPENCODE_BIN`）；
- 模型目录取双源：`https://opencode.ai/zen/v1/models`（在供 id）+
  `https://models.opencode.ai/api.json`（免费判定与能力，不可达时回退 `models.dev`）；
- 默认只列出免费模型，下架与弃用模型需显式开关才显示；
- 本机客户端自身登录态决定免费额度档位，token 不参与对话请求。

## 安装

在目标 profile 的 `package.json` 中：

```jsonc
{
  "dependencies": { "dsh-providers-hub-lite": "link:/绝对路径/到/本仓库" },
  "dsh": { "profile": { "bundles": [ …, "dsh-providers-hub-lite" ] } }
}
```

执行 `pnpm install` 后重启 DSH。包名必须与 `cordis.patch.yml` 加载行逐字相同；
从旧包名 `dsh-codearts-auth` 升级时，`dependencies` 与 `dsh.profile.bundles` 两处都要改。

⚠️ `pnpm add git+…` 走 `prepare` 自动构建，不会跑测试。pnpm 10 / 11 需在 profile 的
`pnpm-workspace.yaml` 放行依赖构建脚本。

## 设置页

打开 Jet Hub 设置页，四个分区：

1. **OpenCode 免费模型** —— 逐模型启停、立即同步目录、显示弃用/下架；支持供应商级与单模型级连通性测试；
2. **魔搭社区** —— 粘贴 API Key（页面只显示打码值）、逐模型启停；支持供应商级与单模型级连通性测试；
3. **自定义供应商** —— 新增/编辑/删除实例，填 id、展示名、baseURL、API Key、模型列表与接口类型；已保存实例可测试供应商或指定模型，草稿区可测试连通性或自动拉取 `/models`；
4. **本机网关** —— 查看状态与启停。

连通性测试分两级：**供应商级**自动挑第一个可用模型发一次最小请求，**单模型级**把指定模型 id 写进请求体。结果含成功状态、HTTP 状态码、耗时与脱敏后的服务端原文；测试不落盘、不修改配置。OpenCode 的测试会向本机客户端发送一次最小对话，可能消耗免费档额度。

配置存于插件自有状态文档 `$DSH_HOME/jet-hub/lite-state.json`，明文 Key 不写日志、
不进会话历史。settings 表单形状由插件 `Config`（schemastery）声明。

## 本机 OpenAI 网关

| 项 | 默认 |
|---|---|
| 监听地址 | `127.0.0.1`（`DSH_OPENAI_GATEWAY_HOST` 可配，拒绝通配地址） |
| 端口 | `8326` |
| 启停 | 设置页开关，或 `DSH_OPENAI_GATEWAY_ENABLED` |
| 模型 id 形状 | `<provider>/<model>` |

## 开发

```sh
npm run typecheck        # 宿主侧类型检查
npm run typecheck:tests  # 测试侧类型检查
npm test                 # vitest 单测
npm run build:all        # tsc + 资产 + 客户端 bundle + bootstrap 同步
```

`lib/` 是构建产物，`tsc` 不会删除旧文件：删除源文件后需清空 `lib/` 再构建。
客户端 `plugin-src/client/jet-hub.js` 改动后必须重跑 `build:client` 并硬刷新浏览器。

实现细节与不可回退的判据见 `AGENTS.md`。

> 使用声明：本项目仅供学习研究使用，请遵守各服务提供方的服务条款。
