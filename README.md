# dsh-providers-hub-lite（OpenCode 单渠道版）

> DeepSeek Harness 插件。**0.3.2 起只保留 OpenCode 免费档桥**。魔搭社区接入、自定义供应商框架、本机 OpenAI 兼容网关，以及多渠道账号池、签到积分、聚合路由与专属协议层均已整体移除。

## 唯一渠道

| id | 出网路径 | 说明 |
|---|---|---|
| `opencode` | 本机 `opencode serve` 桥 | 只承接 OpenCode Zen **免费档**模型；插件不配 API Key、不构造推理 HTTP 请求，认证与额度由本机官方客户端负责 |

插件注册清单只有一条 `PROVIDER_REGISTRY` 条目；模型选择器里不会出现其它渠道。

## 为什么只走桥

插件自造 HTTP 请求直连 OpenCode Zen 一律返回 `429 FreeUsageLimitError`，上游只放行真实 opencode 客户端进程的连接态。因此本插件自 spawn 本机客户端：

- `opencode serve --port <空闲端口> --hostname 127.0.0.1`，`OPENCODE_CLIENT=desktop`、私有 `XDG_CONFIG_HOME`、随机 Basic 密码、`NO_PROXY` 固定回环；
- 进程启动前写好自定义 agent（纯文本、工具权限拒绝）；`/api/session` 与 `/session` 前缀按客户端版本自适应；
- 用 `session.prompt` + 自定义 agent 发起一轮对话，轮询 idle 并拒绝全部权限请求。`session.generate` 与 `/api/experimental/generate` 在免费档固定 503，不可使用；
- 本机客户端自身的登录态决定免费额度档位，登录 token 不参与对话请求。

## 模型目录

- 双源：`https://opencode.ai/zen/v1/models`（在供 id）+ `https://models.opencode.ai/api.json`（`cost.input === 0 && cost.output === 0` 判免费，另取窗口、output 上限、reasoning、弃用状态），不可达时回退 `models.dev`。
- 默认只列免费模型；下架与弃用模型需显式开关才显示；新出现的 `-free` 模型立即纳入。
- 任一源不可达时沿用上次结论，目录缓存落盘；冷启动时保守假定在供。

## 设置页

Jet Hub 设置页只有一个分区：

1. 目录加载与「立即同步」，显示上次同步时间与降级原因；
2. 逐模型启停（停用只影响显示列表，全量目录仍保留条目）；
3. 「显示弃用 / 已下架模型」开关；
4. 两级连通性测试：**供应商级**自动取第一个承接模型，**单模型级**把指定模型 id 传进真实请求；结果显示成功状态、耗时与根因文案。

连通性测试会向本机 OpenCode 客户端发送一次最小对话，可能消耗免费档额度，只由主动点击触发；测试不落盘、不修改配置。

配置存于插件自有状态文档 `$DSH_HOME/jet-hub/lite-state.json`，只包含 `opencodeDisabledModels` 与 `opencodeIncludeDeprecated`。旧版本留下的多余字段会被忽略，升级无需迁移。

## 安装

```bash
pnpm add dsh-providers-hub-lite
```

需要本机已安装 OpenCode 2.x 客户端（可通过 `OPENCODE_BIN` 指定路径）。`pnpm-workspace.yaml` 需放行依赖构建脚本。

### 从旧包名升级

本包原名 `dsh-codearts-auth`，`0.2.0-rc.11` 起改为 `dsh-providers-hub-plus`，`0.3.0` 起改为 `dsh-providers-hub-lite`。老 profile 里 `dependencies` 的键与 `dsh.profile.bundles[]` 条目**两处都必须**改成当前包名；只改一处会静默失效（启动报 `N entry did not activate` 并自动禁用，或整个 bundle 被跳过）。推荐走一遍 `dsh plugin --profile <name>` 的 `remove` / `add`。

⚠️ 不要与旧版本同时启用：注册的 provider id 会冲突。

## 开发

```bash
npm run typecheck        # 宿主侧类型检查
npm run typecheck:tests  # 测试侧类型检查
npm test                 # 单元测试（含前置类型检查）
npm run build:all        # tsc + 资源 + 客户端 esbuild 打包
```

产物在 `lib/`；客户端 bundle 的注册 id 由 `plugin-src/client/build.mjs` 从 `package.json` 读取，必须与包名逐字一致。
