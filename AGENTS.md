# 项目指令：dsh-providers-hub-lite（0.3.2 单渠道版）

> 本分支（`lite`）只保留 **OpenCode 免费档桥**。魔搭、自定义供应商框架、本机 OpenAI 兼容网关及其专属协议层已整体移除；不要再引入任何新渠道或反代。

## 包名 = 插件身份（四处必须逐字相同）

`package.json` 的 `name` / `cordis.patch.yml` 加载行 `name:` / `plugin-src/client/build.mjs` 产物注册 id / `plugin-src/client/jet-hub-styles.js` 的 `PLUGIN_ID` 四处必须一致，缺一处即启动报 `N entry did not activate` 并被自动禁用。安装期闸门在 `plugin-src/client/registration-id-check.mjs`；客户端 `plugins.bundle.config` 槽的 key 同样必须等于包名。当前包名：`dsh-providers-hub-lite`。

profile 条目 id `codearts-auth` 是 `cordis.patch.yml` 与其它补丁引用的**稳定锚点**，与包名无关，不得改动。

## 架构

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主入口 | `src/index.ts` | Config schema、注册 opencode 适配器、接线 RPC |
| 状态 | `src/plugin-state.ts` / `src/jet-hub-store.ts` | 自有状态文档（原子写）、DSH home 解析 |
| 清单 | `src/provider-registry.ts` | 单条渠道元数据，零 import，宿主/浏览器共用 |
| RPC | `src/jet-hub-rpc.ts` | `connection.fetch.register('/api/jet-hub')` 单一端点 |
| opencode | `src/opencode-{bridge,discovery,product,adapter,account}.ts` | 自 spawn `opencode serve` + `session.prompt`；双源目录；只列免费 |
| 探活 | `src/probe.ts` | 供应商级 / 单模型级连通性测试，只服务 opencode |
| 兼容层 | `src/llm-register-compat.ts` / `src/settings-compat.ts` | 适配器幂等注册、settings 契约适配 |
| 客户端 | `plugin-src/client/index.js` / `jet-hub.js` | 单分区设置页与槽位注册 |

## 不可回退的坑位

1. **Cordis Context 是代理对象**：插件配置只能从 `apply(ctx, config)` 的**第二个参数**取；`ctx.config` 未注入，读取即抛 `cannot get property "config" without inject`。服务能力一律用 `ctx.get(name)` 惰性取，**禁止**在 ctx 上做 `typeof ctx.xxx` 能力探测——同样会抛错。
2. **包装适配器必须包 `prepareCall`**，不是 `stream`：宿主调用链走 `call.stream`。
3. **额度错误码必须字面量 `'QUOTA_EXCEEDED'`**，不能用 harness 常量；`AUTH` 码会连 message 一起吞掉，涉及「文案本身是出路」的错误一律避开。
4. **判「某个 id 在不在目录里」时两个目录来源必须取并集**：逐模型停用只过滤 `listModels()`，全量目录 `listAllModels()` / `catalogRows()` 必须保留条目，否则停用会被误判成「不存在」。
5. **产物与源码一一对应**：`scripts/sync-bootstrap-lib.mjs` 已删除；`build:all` 只做 `tsc` + 资源 + 客户端打包。删除源码后必须清空 `lib/` 再构建，否则旧产物会残留。
6. `session.generate` 与 `/api/experimental/generate` 在免费档固定 503，唯一可用通路是 `session.prompt` + 自定义 agent。
7. 客户端 `notice` 类状态必须是**对象形状**（或 null），裸字符串历史上导致整页白屏。

## 验证门禁

```bash
npm run typecheck && npm run typecheck:tests && npm test && npm run build:all
```

单测用行为级守卫（真实 Cordis Context 加载、真实请求体、状态文档读写），不用源码文本断言。产物注册 id 由 `plugin-src/client/build.mjs` 从 `package.json` 读取。
