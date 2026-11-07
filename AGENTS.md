# 项目指令：dsh-providers-hub-lite（精简版）

> 本分支（`lite`）是重构后的精简实现：只保留 **OpenCode 免费档桥**、**魔搭社区官方接入**
> 与**自定义供应商**三类渠道，其余多渠道反代、账号池、积分/签到/聚合体系已整体移除。

## 包名 = 插件身份（四处必须逐字相同）

`package.json` 的 `name` / `cordis.patch.yml` 加载行 `name:` / `plugin-src/client/build.mjs`
产物注册 id / `plugin-src/client/jet-hub-styles.js` 的 `PLUGIN_ID` 四处必须一致，
缺一处即启动报 `N entry did not activate` 并被自动禁用。安装期闸门在
`plugin-src/client/registration-id-check.mjs`，客户端 `plugins.bundle.config` 槽的 key
同样必须等于包名。当前包名：`dsh-providers-hub-lite`（由 `dsh-providers-hub-plus`
改名而来；老 profile 的 `dependencies` 键与 `dsh.profile.bundles[]` 两处需同步迁移，
缺一处即静默失效）。

## 架构

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主入口 | `src/index.ts` | Config schema、注册三条腿、RPC、网关挂载 |
| 状态 | `src/plugin-state.ts` / `src/jet-hub-store.ts` | 自有状态文档（原子写）、DSH home 解析 |
| 清单 | `src/provider-registry.ts` | 三类渠道元数据，零 import，宿主/浏览器共用 |
| RPC | `src/jet-hub-rpc.ts` | `connection.fetch.register('/api/jet-hub')` 单一端点 |
| opencode | `src/opencode-{bridge,discovery,product,adapter,account}.ts` | 自 spawn `opencode serve` + `session.prompt`；双源目录；只列免费 |
| 魔搭 | `src/modelscope{,-product,-messages,-adapter}.ts` | 静态 API Key + 标准 OpenAI 兼容 |
| 自定义 | `src/custom-provider-{types,protocols,adapter,store}.ts` | 多实例、三种 wire 协议、schemastery 配置 |
| 共享协议 | `src/openai-compat.ts` / `sse.ts` / `message-shape.ts` | 消息序列化与 SSE 解帧的唯一实现 |
| 网关 | `src/openai-gateway/` | 本机 OpenAI 兼容网关，动态枚举 `llm.listProviders()` |
| 客户端 | `plugin-src/client/index.js` / `jet-hub.js` / `panel-entry.js` | 设置页四分区 + 槽位注册 |

## 不可回退的判据

1. **opencode 只能走本机客户端桥**。插件直连 Zen 已被实测判定恒 429；`session.generate`
   与 `/api/experimental/generate` 在免费档固定 503，只有 `session.prompt` + 自定义 agent
   循环可用。不得恢复 Bun TLS 指纹、官方提示词注入、出口代理、账号 Key 直连。
2. **模型目录双源**：`zen/v1/models` 决定在供 id，`models.opencode.ai/api.json`
   （fallback `models.dev`）决定免费与能力；免费判定是 `cost.input===0 && cost.output===0`。
   静态兜底表只在双源都不可达且无缓存时使用。
3. **只列免费模型**，不因本机客户端登录态放开付费模型；登录态只影响免费额度档位，
   token 不参与对话请求。
4. **额度错误码必须是字面量 `'QUOTA_EXCEEDED'`**；避开 `AUTH` / `QUOTA` 等会被客户端
   替换掉 message 的码。错误文案本身就是出路时尤其重要。
5. **RPC 的 catch 不得把失败包成 `ok:true`**；未知方法返回 `ok:false` 并带 code。
6. **包装适配器包 `prepareCall` 返回的 `call.stream`，不是裸 `stream`**；`prepareCall`
   里的 stream 必须箭头绑定实例。
7. **判据打在行为上**，不要用源码文本正则当守卫；历史上多次出现「代码确实抛错、
   文本断言全绿」的假绿。
8. **`notice` 类状态必须是对象形状或 null**，不能是裸字符串（渲染期取属性会整页白屏）。
9. **注入的 `<style>` 必须署名 `data-plugin`**，否则会被别的插件连带删除。
10. 自定义供应商 id 必须 `^[a-z][a-z0-9]*$`，且不得占用 `opencode` / `modelscope` /
    `aggregate`。设置页回传打码 Key 时，宿主必须识别为「保留原值」而非写回掩码串。
11. `lib/` 是构建产物，`tsc` 不会删除旧文件；删源后必须清空 `lib/` 再构建。
12. 未经明确指示禁止 `git commit`；改仓库结构（建分支、init、删分支）先确认。

## 开发

```sh
npm run typecheck        # 宿主侧类型检查
npm run typecheck:tests  # 测试侧类型检查
npm test                 # vitest 单测
npm run build:all        # tsc + 资产 + 客户端 bundle + bootstrap 同步
```

客户端 `jet-hub.js` 改动后必须重跑 `build:client`，只重启进程不会更新产物。
