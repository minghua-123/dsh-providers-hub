# 发布手册（dsh-providers-hub-plus）

本仓库是 [iJetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub) 的个人再发布版：
包名 `dsh-providers-hub-plus`，与上游包**并存但不兼容同时启用**（两者注册同一套 provider id）。

> 包名 = 插件身份。`package.json` 的 `name`、`plugin-src/client/jet-hub-styles.js` 的 `PLUGIN_ID`、
> `cordis.patch.yml` 的加载行 `name:`、以及构建产物里注册的 id **四处必须逐字相同**。
> 少一处不会报错，只会静默失效：卡片不渲染或 `entry did not activate`。
> 构建闸门（`plugin-src/client/registration-id-check.mjs`）会拦住前三处，所以**每次改包名后都要跑一次构建**。

## 0. 分支模型

| 分支 | 作用 | 规则 |
| --- | --- | --- |
| `master` | 上游镜像 | 只做 `merge --ff-only upstream/master`，不提交自己的改动 |
| `dist` | 发布分支 | 改名、版本范围、`publishConfig`、本文件等自有改动都提交在这里 |

远程：

```
origin    https://github.com/minghua-123/dsh-providers-hub.git   # 自己的 fork，推送目标
upstream  https://github.com/iJetLi/dsh-providers-hub.git        # 上游，pushurl 已设为 no_push
```

## 1. 同步上游

```bash
git fetch upstream
git switch master
git merge --ff-only upstream/master      # pull.ff 已设为 only
git switch dist
git rebase master                        # 冲突面只有改名那几行
pnpm install                             # 上游可能改了依赖
```

上游新增 provider 时，`dist` 的改名补丁通常无需调整；若上游也改了包名或注册 id，rebase 时**以本仓库的四处一致为准**。

## 2. 改版本号

```bash
git switch dist
npm version patch --no-git-tag-version    # 或 minor / major
```

同时更新 `package.json` 里 `@deepseek-ai/dsh-*` 的 peer 范围，让它**覆盖当前 DSH 宿主版本**。
当前宿主是 `0.2.2-rc.1`，所以范围结尾保留了 `|| ^0.2.2-rc.1`：宿主升级后若插件报 peer 不匹配，
就在这里追加新的区间，不要删掉旧区间（会断掉老用户）。

## 3. 构建与自检（缺一不可）

```bash
pnpm install
node plugin-src/client/build.mjs          # 必须打印 registered id: dsh-providers-hub-plus
npm pack --dry-run                        # 确认 files 里含 lib/、cordis.patch.yml、locale/
```

关键守卫用例（改名或动客户端接线后必跑）：

```bash
npx vitest run tests/unit/client-registration-id.spec.ts \
                tests/unit/jet-hub-styles-ownership.spec.ts \
                tests/unit/index-entry-wiring.spec.ts \
                tests/unit/jet-hub-structure-ast.spec.ts
```

冒烟安装（确认包里没有缺文件）：

```bash
cd "$(mktemp -d)" && npm install <仓库路径>/dsh-providers-hub-plus-<版本>.tgz --ignore-scripts
```

## 4. 发布到 npm

```bash
npm publish --registry=https://registry.npmjs.org/
```

- 账号开了 auth-and-writes 双因素，非交互发布会报 `EOTP`；在真终端里发布会打印一条
  `https://www.npmjs.com/auth/cli/<id>` 链接，浏览器里点授权即可，随后输出
  `Your package is being processed...`。
- 发布后 registry 会先出现一个占位版本 `0.0.0-stage`（`stub: true`），几分钟后才出现真实版本。
  这是延迟 2FA 的机制，**不是失败**；`npm stage list` 为空也属正常。
- 验证：

```bash
npm view dsh-providers-hub-plus version dist-tags
npm view dsh-providers-hub-plus@<版本> dist.fileCount dist.unpackedSize
```

## 5. 发 GitHub Release

```bash
git tag -a v<版本> -m "dsh-providers-hub-plus <版本>"
git push origin dist v<版本>
gh release create v<版本> dsh-providers-hub-plus-<版本>.tgz \
  --target dist --title "dsh-providers-hub-plus <版本>" --notes-file <说明文件>
```

Release 说明建议写三段：本次改了什么、升级方式（`npm i dsh-providers-hub-plus@<版本>` 或插件市场安装）、
以及「不要与原包 `dsh-providers-hub` 同时启用」。

## 6. 本机安装 / 升级

插件市场安装，或在 profile 目录手动装：

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-providers-hub-plus@<版本>
```

装完确认三件事：`dsh.profile.bundles` 里有 `dsh-providers-hub-plus`；
`node_modules/dsh-providers-hub-plus/package.json` 版本正确；**旧包 `dsh-providers-hub` 已从 dependencies 移除**。
升级后需要重启 DSH 才会加载新的客户端产物。

## 7. 常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| `git push` 报 `Could not connect to server` / `connection abort` | 走代理：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push ...` |
| `npm login` 完却没登上 npmjs | `~/.npmrc` 的默认 `registry` 是 `registry.npmmirror.com`，登录是登录到镜像站；登录时必须带 `--registry=https://registry.npmjs.org/` |
| `EOTP` | 账号开了 2FA 且 npm 已限制「绕过 2FA 的 token 直接发布」，只能走浏览器授权 |
| 装完插件卡片不显示、也没有报错 | 客户端产物里的槽位 `key` / `data-plugin` 没跟着包名改（构建闸门管不到这两处） |
| pnpm 安装 git 依赖报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 这是上游包 git 安装的老问题；本包走 npm 安装就是为了绕开它，`allowBuilds` 的键含 commit hash，每次变 |
| 面板里出现重复的 provider | 新旧两个包同时启用；删掉旧的 `dsh-providers-hub` 依赖并重启 |

## 8. 回滚

- npm 侧不能覆盖已发布版本：修好问题后发新的 patch 版本；确需下架用 `npm deprecate`（`unpublish` 24 小时后受限）。
- 仓库侧：`git revert <提交>` 或 `git reset --hard <上一个 tag>` 后重新发布，**不要**强推 `dist`。
- 本机回滚：profile 里把依赖版本改回旧版并重启 DSH。
