# dsh-plugin-subscriptions（vendored）

本目录是第三方插件 **dsh-plugin-subscriptions@0.9.12** 的 vendored 副本。直接取自
`kelai141/dsh-mobile-apk` 的固定 `v0.14.11` 提交
`f6af65d23c81013d786855637e8758c587fe356b`，保留该版 Android 适配，再叠加本 fork 的
Codex 自定义服务功能。此次没有重新抓取浮动 npm 最新包；本地差异与验证命令见 `PATCHES.md`。

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/V1ki/dsh-plugin-subscriptions> |
| 发行版 | npm `dsh-plugin-subscriptions@0.9.12`（tarball shasum `a3aff899f615cec19f56b4bf11026a6cbf696382`，integrity `sha512-OHW6LsNjmfQ7gFZ734Lbz9iVtrPeWAaQz2sAzSezNDgyNGpEBzvLufGhzwffh1VgWz2TW8AMJ/JpgBec5Lscrg==`） |
| 上游 gitHead | `b8023110864494acefc6f5963c2a197d85dda20c`（package.json 的 `gitHead` 字段；无对应 tag 时以此为准） |
| 许可 | MIT（原文见本目录 `LICENSE`，随快照分发，见下「MIT 许可原文保留位置」） |
| 历史包规模 | 上游 npm 发布包 2,063,168 B / 143 文件；固定 Android 副本已裁剪源映射、类型声明与未提供的 provider。本 fork 新增文件见 `PATCHES.md`，当前体积以实际目录为准 |
| 定位 | ChatGPT(Codex)/Claude/Grok/Copilot 订阅在 Settings → Subscriptions 登录；Codex 卡另提供使用独立 API Key 的自定义 Responses 服务 |

## 为什么 vendor（而不是直接依赖 npm 版本）

上游的依赖声明与本平台栈**已经错位**：它把 `undici` 声明在 `dependencies` 且钉 `^7.0.0`，而本仓快照的引擎树自带
`undici@8.11.2`。这说明该包大概率停在旧 DSH 上、不会跟随我们的升级节奏。若直接跟随它的版本声明，我们要么
物化一份 7.x（1.5 MB / 195 文件，且与引擎内那份并存、锁两个版本），要么靠 8.x 去顶 `^7`——后者是**改对方契约**：
等它真用到 7→8 的差异时，我们会得到「看起来能用」的假活。

因此取 vendored 路线：**拿进来自己维护，依赖对齐我们的栈**，保留提供商授权协议，按 Android 宿主适配回环页。

## 与上游的差异（逐条）

第 1–17 项为固定 Android 基线继承的适配记录，其中 issue 与历史验证脚本属于该基线的维护记录；
第 18 项是本 fork 此次新增功能，回归测试位于本目录 `test/` 与根目录 `scripts/tests/`。

| # | 面 | 差异 | 理由 |
| --- | --- | --- | --- |
| 1 |  `package.json` | 删除 `devDependencies`、`scripts`、`packageManager`、`pnpm` 四个字段 | 本仓只消费**已构建的** `lib/`（npm 发布产物），不在此目录编译或安装。保留这些字段只会让 `check-contract.mjs` 的版本钉与构建期工具链产生无意义漂移（实测：21 条 `@deepseek-ai/dsh-*` devDep 钉在 `0.2.1-rc.2`，与本仓基线 `0.2.1-rc.3` 不符） |
| 2 |  `package.json` | `undici` 从 `dependencies: "^7.0.0"` 改为 `peerDependencies: ">=8.11.2"` | 由引擎提供同一份实例，不物化第二份（省 1.5 MB / 195 文件、省一份锁版本）。8.x 可用性见下「undici 7→8 判定」 |
| 3 |  `package.json` | `@deepseek-ai/dsh-{attachment,home-paths,llm,tools,web}` 的 peer 区间收窄为精确 `0.2.2-rc.1`；`@deepseek-ai/cordis` → `4.1.0`，`@deepseek-ai/schemastery` → `3.19.0` | 上游写的是 `>=0.2.0-rc.2 \|\| >=0.2.1-0` 这类**过宽区间**。本仓的 `check-contract.mjs` §6 要求注入集内每个包的 dsh peer 必须等于运行时版本（过宽区间 = 未判兼容），且宽区间在 pre-release 语义下也可能误判满足。收窄到运行时版本是既有约定（对照 `vendor/dshmarketplace-plugin` 的同款处置） |
| 4 |  文件面 | 删除 `lib/client.js.map`（283,738 B）与全部 68 个 `*.d.ts`（279,316 B） | 与快照既有裁剪口径一致：`slim.json` 的 `sourcemapDelete`（全树 `.map`）与 `extensionDelete`（引擎子树 `.d.ts`）。二者在运行期零消费者——Node 执行 `lib/*.js`，源映射与类型声明不参与；`inject-all.py` 本来也只注入 `lib/**` 且排除 `.map`。留在 vendor 里只会让「仓库体积」与「快照体积」两套数字各说一套 |
| 5 |  `lib/http.js`、`lib/index.js` | **代理面安全修（issue #1282）**：新增 `urlCredentials()`（从 URL userinfo 取凭据）与 `redactProxyUrl()`（剥掉 userinfo）；`proxyGetConfig` 回包不再带 URL 内嵌密码（直接剥掉而非打码），`passwordSet` 把 URL 内嵌密码也算作「已设置」；`normalizeConfig` 把 userinfo 提升为独立的 `username`/`password` 字段；`parseProxyUrl` 的错误文案改走 `redactProxyUrl` | 上游把密码当作配置里的一等字段，但**也接受**代理客户端通行的 `http://user:pass@host:port` 写法。后者的密码活在 `url` 里，于是同一条 `url` 被原样回给浏览器（页面输入框与状态行显示明文）、`passwordSet` 恒 `false`、校验失败的报错把整条 URL 连密码写进文案。属于**机密外泄**而非风格问题，故对上游运行时代码做最小改动；判据见 `scripts/subs-proxy-secrets.test.mjs`（随机串夹具 + 序列化后全舰搜索 0 命中） |
| 6 |  `lib/translate/sse.js`、`lib/translate/{chat-completions,responses,anthropic}.js`、`lib/providers/common.js`、`lib/providers/{claude,codex,copilot,grok}.js` | **SSE 面加固（issue #1284）**：① `parseSse` 增加 `MAX_PENDING_CHARS`（8 MiB，推导见该常量注释：上限由「单个合法帧」决定，而单个合法帧的上界是仓库的 5 MiB 附件上限的 base64 形态，不是响应总长度），超限即失败关闭并报出实收长度；② `idleWatchdog` 把「字节进展」与「帧进展」拆成两个时钟，新增 `progress()`/`event()`/`snapshot()`/`stallReport()`，`TIMEOUT` 错误带上现场快照并可区分 `idle`（零字节，中止）/`trickling`（有字节无帧，不中止但可观测）/`healthy`；③ EOF 时派发未以空行收尾的最后一帧（SSE 规范允许这种收尾） | ① 一条不换行的响应流能把宿主内存吃光，而「空闲超时」这道防线正好被同一股流量关掉（每 chunk 重置）；② 没有可观测事实时「慢但在走」与「真卡住」无法区分，改计时器也无法验收；③ 服务端以「末帧不补空行」收尾是规范允许的，原实现让整轮对话报 `STREAM_CLOSED` 且文案指向网络。三项都只在构造字节流上复现，判据见 `scripts/subs-sse-limits.test.mjs` |
| 7 |  `lib/client.js` | **竖屏可读性修（issue #1288 第 10、11 条）**：① 供应商卡标题前的状态点补 `aria-label`（新增 `dotState()` 三态映射 busy/linked/unlinked + 6 个文案键），颜色与尺寸**未改**；② 账号行溢出修：`accountHeader` 补 `minWidth:0` + `flexWrap:wrap`，`accountName` 补 `minWidth:0` + `overflowWrap:anywhere`，`accountRow` 补 `minWidth:0`。原本这三处都缺 flex 收缩，长邮箱与过期时间会把整页撞宽、`退出登录` 按钮被挤出卡片右边界 | ① 状态点本身有真实三态（黄=busy/绿=已登录/灰=未登录，见 `dotColor`），但它在无障碍树与肉眼上都只能靠颜色猜，用户报「看不懂这个点」；只是补语义，不改设计、不加图例。② 真因不是「文字太长」，是 flex 子项默认 `min-width:auto` 不可收缩 + 按钮 `flexShrink:0`，于是窄屏上整行按内容宽度铺开并撑宽容器（`scrollWidth > clientWidth`，整页可左右滑）。判据见 PR 正文 |
| 8 |  `lib/client.js`、`lib/client/index.js` | **宿主样式污染收窄（issue #1288 第 2/5/8 条）**：设置面板留白规则的裸选择器 `div[role="dialog"][aria-modal="true"]:has(> nav) { padding-top: 14px }` 收窄为 `html:not([data-dsh-mobile-form]) div[…]:has(> nav)`。两份打包副本同步改 | 原选择器特异性 (0,2,2)，会压过宿主 `dsh-client-ui-responsive` 手机形态的面板规则 (0,2,1)，把面板 `padding-top` 从真实顶部 inset（实测 24px）压成 **14px**。宿主手机形态的留白由 `--dsh-mobile-top-inset` 负责（`mobile-form.css.ts`），插件不该再插一手；后果是**二级页**顶部条（在正常流里）顶到状态栏下面只剩半截，而一级页顶部条是 `absolute` 不吃面板 padding 所以正常——正是用户报的「一级正常、二级异常」。收窄后桌面形态行为不变；另在宿主侧同时把该规则的特异性提到 (0,4,1) 作为第二道防线（插件若再回归也压不回去） |
| 9 |  `lib/client.js`、`lib/client/locales.js` | **命令标题本地化（本轮）**：给 `/fast` 的命令贡献补 `label: () => t("commandFastTitle")`，并在 zh/en 两份 locale 里各加一条 `commandFastTitle`（快速档 / Fast tier） | 上游只传了 `description`、没传 `label`，而 `ui-input-trigger` 的行标题是 `item.label ?? item.name`，于是「+」菜单里这一行显示的是命令 id `fast`（同屏其余行都是中文）。宿主命令目录的 `CommandDescriptor` 只有 `name` + `description`，没有标题钩子；贡献名与宿主命令重名又会在候选合成时抛错，所以只能在这一层补 |
| 10 |  `lib/http.js`、`lib/index.js` | **代理凭据优先级修（issue #1308）**：① `proxySetConfig` 增加分流——`input.url` 带 userinfo 时**不播种** `current.password`（粘贴进来的凭据是新事实，旧值没有资格顶替它）；② `normalizeConfig` 的 userinfo 提升分支改为**回填**而非恒定胜出，优先级 = 显式输入 > URL userinfo > 无；③ 新增内部标记 `passwordCleared`，让「显式清空」与「没给密码」可区分，否则清空会被 userinfo 回填复活、用户永远删不掉凭据。两份打包副本同步改 | #1282 把 userinfo 剥出 `url` 并提升为独立字段是对的，但它同时让「调用方没给 password」等同于「沿用上一份配置」，于是**粘贴** `http://bob:new@host/` 时新密码先被剥出 url（唯一记录点）、再被播种值顶替——两侧都丢，而 `passwordSet` 还报 true（那是旧密码）；用户以为换了密码，实际仍用旧的，清空后更退化成 407 且无诊断。判据见 `scripts/subs-proxy-secrets.test.mjs`（观测点是 `new ProxyAgent(url)` 实际收到的凭据，3 条正控 + 2 组负控） |
| 11 |  `lib/translate/sse.js`、`lib/index.js` | **SSE 边界回归修（issue #1309）**：① `dispatch()` 对「无 `data:` 行的帧」改为**不派发**（只清 event 名缓冲），符合 WHATWG「dispatch the event」；② `MAX_PENDING_CHARS` 的判据从「扫描换行前量本次 read」改为「扫描后量**尚未闭合的那一帧**」（`pending` + 已消费的 `dataLines` 之和），错误文案同步改为指名帧长度。两份打包副本同步改 | ① #1284 的修法让 `event: ping\n\n` 这类保活帧变成 `{ data: '' }`，三条 wire 的 `JSON.parse('')` 直接抛 `MALFORMED_RESPONSE` —— 一条心跳打掉整条 chat 流；② 该常量的推导（见 sse.js 头注）依据的是「**一个**合法帧能有多大」，而判据量的是「这次 read 带来多少字节」：一次 read 送 9.4 MiB 的 943,719 个完整小帧会被拒（错误文案还说是「没有换行」，与输入不符），同样的字节按 64 KiB 分片则全过。判据见 `scripts/subs-sse-limits.test.mjs`（4 条正控 + 分片一致性 + 2 条负控） |
| 12 |  `lib/translate/sse.js`、`lib/index.js` | **SSE 上限判据补到派发口（issue #1340）**：`dispatch()` 内新增「本帧已累计字符数」判据——帧变成事件的唯一出口就在此处，超限即失败关闭、不产出事件；扫描后的「未闭合帧」判据保留，两条分工明确（闭合帧由 `dispatch()` 判，未闭合帧由扫描后判据判）。两份打包副本同步改 | #1309 ② 把上限挪到扫描之后，但只量了「未闭合的帧」。扫描会把已闭合的帧就地派发，于是「一次 read 送来完整帧」走派发路径，长度判据根本没机会看到它：9.4 MiB 单帧直接进 `JSON.parse`（9,437,184 字符），而同样的字节按 64 KiB 分块则被拒。同一份字节、同一个帧、两种结论——上限仍是「网络分片形状」的属性，只是方向反了。判据见 `scripts/subs-sse-limits.test.mjs`（3 条正控 + 1 条负控） |
| 13 |  `lib/http.js`、`lib/index.js` | **代理用户名优先级修（issue #1341）**：`proxySetConfig` 把 userinfo 的账号提到与密码同一条规则——URL 带 userinfo 且传入的 username **未被改动**（等于已存值，即设置对话框的预填）时，userinfo 胜出；用户显式改过则仍以显式输入为准。两份打包副本同步改 | #1308 只修了密码半区，用户名半区仍让位给显式输入。而设置对话框**总是**发送预填的 username（`lib/client.js` 从已存配置预填、无条件提交），于是粘贴 `http://alice:NEWPASS@host/` 实际生效 `bob:NEWPASS`——旧账号配新密码，凭据被拆到两个账号上，视图仍显示 `bob`、`passwordSet` 仍 true、无任何诊断；认证失败时用户只看到 407，无从判断是账号还是密码错。判据见 `scripts/subs-proxy-secrets.test.mjs`（3 条正控 + 1 条负控） |
| 14 |  `lib/providers/common.js`、`lib/index.js` | **登出与在途刷新竞态修（issue #1588）**：① `TokenManager` 新增 `generation` 代次与 `invalidate()`；`doRefresh` 在发起刷新前记下代次、落盘前再比一次，变了就抛 `MISSING_CREDENTIAL` 且**不落盘、不返回会话**；`session()` 的 catch 里 `MISSING_CREDENTIAL` 优先于「transient 失败但旧 token 仍有效就沿用」的兜底。② `AccountTokenManager` 新增 `invalidate(account)`（按 manager 去重，只作废已存在的缓存项）。③ `SubscriptionsAuthController` 新增 `invalidateTokens` 回调，`logout()` 在 `deleteAccountSession` **之前**调用它。两份打包副本同步改 | 登出只删存储、不等也不作废在途刷新。刷新是一次网络往返（几百 ms 到数秒），期间用户点登出就会撞上：刷新返回后无条件 `save(next)`，把刚登出的账号连**新的** access/refresh token 一起写回磁盘，下一次 `status` 轮询又列出来；因 refresh token 已轮换，这份残留是**可用的**。判据取代次而不是「重读 store 看条目在不在」：登录与刷新走同一个 `saveAccountSession`，重读只能看到「现在有没有」、看不到「这期间删过又建过」，且把判据放在 store 层会把首次登录一起拒掉（空 store 里 entry 本来就是 undefined） |
| 15 |  `lib/index.js`（`TokenManager` 内联副本） | **打包副本与源模块对齐（0.14.11）**：`TokenManager` 补 `generation` 与 `invalidate()`，`doRefresh` 加代次比对、`session()` catch 早退 `MISSING_CREDENTIAL`。`lib/index.js` 是运行期真正被加载的打包产物，`TokenManager` 在其中内联；#1588 只改了 `lib/providers/common.js` 的源模块，登出因此报 `cached.invalidate is not a function`（真机 2026-11-07 实锤：红色小字一闪而过、账号退不掉） | 源模块与打包产物是两份代码，只改前者等于没改。判据是行为面：登出要真的把账号从列表里去掉 |
| 16 |  `lib/index.js` | **手机回跳页与兑换超时（0.14.11）**：① 回调页改走 `callbackReceivedPage()`，手机形态给出「返回 DeepCode」按钮与 `intent://oauth-return#Intent;scheme=com.dsharnessmobile.shell` 链接，桌面形态保持原文案。② `SubscriptionsAuthController.complete` 的授权码兑换加 30s 上限（`withExchangeDeadline`），超时按 `AUTH` 失败落进 `lastError` | ① 手机上的标签页是系统浏览器，原文案「关闭此标签页」不会把人送回应用；且 `intent://` 当时在 manifest 里没有对应 scheme，系统只能弹「打开方式」。② `auth.openai.com` 在 VPN 下可能停在等首字节，`busy` 恒为 true，设置页永远显示「登录中…」 |
| 17 |  `lib/auth/oauth-flow.js`、`lib/index.js` | Android 回环页区分收到授权与账号连接完成，提供指向 DeepCode 的返回按钮；响应不缓存、不传 Referer | 浏览器收到授权码时应用仍在换取令牌。返回链接不含授权码、state 或账号信息，两份打包副本同步改 |
| 18 | `lib/codex-custom.js`、`lib/auth/rpc.js`、`lib/index.js`、`lib/client/CodexCustomService.js`、`lib/client/codex-custom-locales.js`、`lib/client/SubscriptionsSection.js`、`lib/client/locales.js`、`lib/client.js` | Codex 登录旁增加 Base URL / API Key / 模型表单，经既有认证 `/api` carrier 的 `codexCustomGet` / `codexCustomSet` 端点生成独立 `llm-pi-ai.providers.codex-custom`，明确使用普通 `openai-responses` | 普通平台 API Key 不能通过 Codex 专用协议的 JWT/accountId 检查。自定义路由需独立协议、独立凭据，保留地址前缀与手填模型，同时避免向新地址转发账号令牌。事务、未知结果读回、客户端行为及真实 HTTP 回归见 `PATCHES.md` |

**本 fork 相对固定 Android 基线的边界**：运行时代码仅修改第 18 项所列文件；新增测试和同步脚本另见
`PATCHES.md`。现有 provider 实现、OAuth 交换和 token 存储路径
`~/.dsh/plugins/subscriptions/auth.json` 及其 0600 权限保持基线实现，`cordis.patch.yml` 与 `LICENSE`
逐字节保留。README 增加本 fork 的自定义服务说明，不再声称整个客户端未改动。

## 我们删了什么、为什么

**删除了上游的第五家 provider（Google Antigravity）及其全部实现。**

| 面 | 具体删除 |
| --- | --- |
| 独立模块 | `lib/providers/antigravity.js`、`lib/providers/antigravity-oauth-client.js`、`lib/translate/antigravity.js`、`lib/translate/antigravity-schema.js`、`lib/translate/antigravity-thinking.js` |
| 打包副本 | `lib/index.js` / `lib/client.js` 内对应的 5 个 `//#region` 段（translate ×3 + oauth-client + provider）及其全部调用点 |
| 注册与能力声明 | `PROVIDER_IDS` 列表项、`providerIdSchema` 联合项、`Config.providers` 默认值、`models` 目录项、`PROVIDER_TOOLS` 项、适配器注册分支、OAuth flow/exchange 分支、用量抓取分支、配置 schema 段 |
| 客户端 | `ProviderAccountManager` 的 provider 列表项、`PROVIDER_NAMES` 显示名、用量徽标的按模型窗口逻辑、`usage-window-filter` 的模型可见性分支 |
| 文档 | `README.md` 的 provider 表行与相关段落 |

**为什么删（三条，按权重）**

1. **不发这个 provider**。本仓只需要 ChatGPT(Codex) / Claude / Grok / Copilot；Antigravity 不在产品盘子里，带进来只有维护成本。
2. **上游在这条路由里嵌入了 Google OAuth 应用级凭据**（客户端 ID + 客户端 Secret 两个常量，硬编码在 `antigravity-oauth-client` 段）。它们确实不是用户 token，但**放进本仓历史就等于我们永久背这个包袱**：GitHub Push Protection 会阻断每一次包含该提交历史的推送，后续只能靠「允许该 secret」或关闭仓库规则来维持——那是把安全闸门长期放宽去换一个我们本来就不需要的功能。
3. **不解除阻断、不改登录流程**。两条替代路径都被否掉：点 unblock 链接 = 把仓库规则长期放宽；改成纯配置注入 = 改动面最大且让该 provider 开箱不可用。

**影响面：其余四家 provider 不受影响**——Codex / Claude / Grok / Copilot 的模块、OAuth 流程、token 存储、用量抓取、客户端设置页全部保留原样；它们各自只有**公开 client_id**（PKCE/设备流的标准做法，无 secret），不属于需要裁剪的嵌入式凭据。

**追版注意**：上游若继续发 Antigravity，追版时必须重做本节裁剪，否则 Push Protection 会再次阻断。裁剪步骤：删上述 5 个模块 → 删 `lib/index.js`/`lib/client.js` 的对应 region → 清注册表/配置 schema/客户端列表 → `grep -ri antigravity` 归零。

## undici 7→8 判定（为什么 peer 到 8.11.2 是安全的）

插件实际用到的 undici API 只有两处导出、五种调用：

| 位置 | 用法 |
| --- | --- |
| `lib/http.js:16`、`lib/index.js:6` | `import { ProxyAgent, fetch as undiciFetch } from 'undici'` |
| `lib/http.js:197`、`lib/index.js:410` | `new ProxyAgent(url.toString())` —— **只传 URL 字符串** |
| `lib/http.js:216,293,427` | `agent.close().catch(...)` |
| `lib/http.js:362` | `fetch(url, { ...init, dispatcher })` |

`Agent` **不直接使用**（源码里两处 "Agent" 均为 `User-Agent` 注释）。

对照实测（node v24.17.0，undici 8.11.2 vs 7.30.1）：

- 导出面一致：`fetch` / `ProxyAgent` / `Agent` 均为 `function`；
- `ProxyAgent` 的 `#getUrl` 两版**逐字节相同**，字符串入参均受支持；8.x 新增的 `connectTimeout` / `proxyServername` 皆可选，不传即旧行为；
- `close()` 两版均返回 Promise；
- `dispatcher` 路由：8.11.2 实测通（本地假代理收到请求并回 `200 via-proxy`）；HTTPS 目标两版都走 `CONNECT`；
- engines：8.x 要求 `>=22.19.0`，设备 node 为 `v24.18.0` ✓。

**唯一的 7→8 语义差异**（`lib/dispatcher/proxy-agent.js`）：

- 7.x：`const { proxyTunnel = true } = opts` —— 默认**总是**隧道；
- 8.x：`const { proxyTunnel } = opts` + `shouldProxyTunnel(reqProto, t) = t === true \|\| reqProto !== 'http:'` —— 默认 **http 目标不隧道**、https 仍隧道。

插件**从不传** `proxyTunnel`，且全部请求目标为 https（Anthropic / ChatGPT / x.ai / GitHub Copilot），落到的分支两版等价。**逆转条件**：若日后要支持 http 代理目标，需显式传 `proxyTunnel: true`。

## 装配与解析（本仓侧如何让它跑起来）

- 注入：`scripts/plugin-dirs.json` 的 `externals` → `scripts/inject-all.py --external` → `home/.dsh/profiles/{web,headless}/node_modules/dsh-plugin-subscriptions/`；
- 挂载：`scripts/profile-web.cordis.patch.yml` 的 `- insert: { id: llm-subscriptions, name: dsh-plugin-subscriptions }`；
- 依赖解析：Node 从插件位置向上只能到达 `profiles/node_modules`（共享农场），到不了引擎树。故 `build-snapshot-013.mjs` 的「8a3b. profile 共享农场补齐」按 `PROFILE_SHARED_LINKS` **幂等**建相对链
  `home/.dsh/profiles/node_modules/undici -> ../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici`；
  目标每次按 `ENGINE_NM_STAGE` 现算，引擎目录换代自动跟随。
- 门禁：`scripts/check-profile-undici-resolution.mjs`（从 profile 锚点 `require.resolve('undici')`，断言 ≥ 8.11.2、落在快照树内而非仓库根 devDependency、且来自引擎树；`--negative-control` 移走该链后必须判红）。

## MIT 许可原文保留位置

上游 MIT 许可**全文**随本目录分发于 `vendor/dsh-plugin-subscriptions/LICENSE`（1061 B），并经注入链进入快照
`home/.dsh/profiles/{web,headless}/node_modules/dsh-plugin-subscriptions/LICENSE`（`inject-all.py` 的
`EXT_INCLUDE_FILES` 显式包含 `LICENSE`，不会因裁剪而丢失）。

## 当前 client UI 入口与本 fork 扩展

设置页继续使用基线订阅卡。Codex 卡保留原有登录和账户管理，并添加自定义服务按钮与内联表单；
其他 provider 卡沿用基线行为。来源模块与真正发货的 `lib/client.js` 同步维护：

| 面 | 路径 | 说明 |
| --- | --- | --- |
| 客户端 bundle 入口 | `lib/client.js`（由 `lib/client/index.js` 构建） | package.json `exports["./client"]` + `dsh.client.platform = "web"` |
| Settings 页主体 | `lib/client/SubscriptionsSection.js` | 「订阅」卡片/入口；仅 Codex 卡新增自定义服务展开入口 |
| 自定义 Responses 表单 | `lib/client/CodexCustomService.js`、`codex-custom-locales.js` | 三个必需配置字段、密钥只写、保存状态与显式读回；同步到真实 bundle 的脚本为 `scripts/sync-codex-custom-client.mjs` |
| 账户管理/模型编辑 | `lib/client/ProviderAccountManager.js`、`ProviderModelEditor.js` | 现有账号管理与订阅模型编辑，未作为自定义 API Key 的存储位置 |
| 用量徽标 | `lib/client/SubscriptionUsageBadge.js`、`usage-badge-preferences.js` | 侧栏徽标 |
| 样式 | `lib/client/provider-settings-styles.js` | 移动端布局适配的落点 |
| 客户端 RPC | `lib/client/subscriptions-rpc.js` | 与宿主半的 `auth/rpc.js` 对应 |

自定义表单的模块是维护真源；同步脚本只生成其明确标记的 bundle 区域，不重打包其他基线客户端模块。
修改后运行同步脚本，再以 `--check` 检查一致性。入口接线同时保留在主体模块和 bundle 中，客户端回归
直接挂载真正的发货 bundle，并操作 Codex 卡的按钮和表单。

## 追版须知

追版时按上表逐条重新判定差异是否仍需要（上游可能已自己修好）。逐字节比对的基准是
`npm pack dsh-plugin-subscriptions@<ver>` 的解包结果；本 fork 当前增量则以本文件开头的固定 Android
提交为基准。不能用未修改 npm 包替换本目录，否则会丢失已继承的 Android 适配与第 18 项功能。
