# 本 fork 的 Codex 自定义服务补丁

## 固定来源与范围

基础是 `kelai141/dsh-mobile-apk@f6af65d23c81013d786855637e8758c587fe356b`
（`v0.14.11`）中的 `vendor/dsh-plugin-subscriptions@0.9.12`，保留 MIT 许可全文及该基线已有
Android 适配。包版本保持供应商版本，fork 增量在此文件独立记录。没有修改只读 Harness 上游。

新增文件：`lib/codex-custom.js`、`lib/client/CodexCustomService.js`、
`lib/client/codex-custom-locales.js`、`scripts/sync-codex-custom-client.mjs`、
`test/codex-custom.test.mjs`、`test/codex-custom-ui.test.mjs`。
接线修改：`lib/index.js`、`lib/auth/rpc.js`、`lib/client/SubscriptionsSection.js`、
`lib/client/locales.js`、实际发货的 `lib/client.js`。

## 使用与协议

入口在设置的“订阅”页 Codex 卡，原登录按钮旁新增“自定义服务”。表单只有 Base URL、API Key、
模型三个字段。配置写入 `llm-pi-ai.providers.codex-custom`，显示名为“Codex 自定义服务”，
协议固定 `openai-responses`。地址保留 `/gateway/v1` 等路径前缀；SDK 最终向基址追加
`/responses`。只支持提供普通 Responses API 的平台；没有把普通 key 放入要求 JWT 与 accountId
的 `openai-codex-responses` 流程。

模型 ID 按输入保存，未命中本地目录不会阻止配置。不调用模型发现接口，也不把本地内置目录作为外部
平台的可用性证明。保存成功只表示配置提交成功，使用时在模型选择器选独立的 `codex-custom`。
这条 LLM 路由不复用订阅账号配额查询、快速档、图片/视频/搜索工具或订阅插件内部代理配置。

## 凭据与保存边界

- 使用现有 `connection.fetch` 认证 `/api` carrier，新增两个端点：
  `subscriptions-auth.codexCustomGet` 与 `subscriptions-auth.codexCustomSet`。没有另开 HTTP 监听器。
- 新 key 写入随机的 `SUBSCRIPTIONS_CODEX_CUSTOM_<32位十六进制>_API_KEY` 私有凭据引用。
  读取只返回地址、模型、路由名、revision 与 keyConfigured，不返回 key 或引用名。
  服务不调用凭据 resolve/readRecord，也不读写订阅 `auth.json` 或 `llm-pi-ai/openai-codex` 的记录。
- 同地址留空保留已保存引用；未配置 key 时明确拒绝。换地址要求新 key，并清除旧平台的自定义请求头，
  避免高级设置里的认证 header 随地址变更被发送。既有其他 provider 配置保持原值。
- 先暂存新独立引用，再以读取时的 settings revision 提交单路由变更。已被其他视图修改时拒绝覆盖。
  一个服务实例内的保存按顺序处理；重复旧 revision 不能覆盖较新的结果。
- mutate 异常后读回活动配置。若目标已实际提交则返回成功；只有可读、revision 未变且活动配置不引用
  新 key 时才清理暂存引用。读回不可得时保留引用，返回明确的“保存结果待确认”。
  成功后刷新视图失败也返回 saved=true 与 refreshRequired，避免成功被误报成失败。
- 旧私有引用保留供历史配置快照和回退使用，不读取旧 key。客户端每次提交后清空密码字段；未知网络结果
  或配置冲突时禁用保存，必须显式重新读取。底层错误文本不会原样进入该表单，避免异常包含 key 时回显。

## 验证

在仓库根执行；前端回归使用既有 `dsh-client-ui-responsive` 的锁定 React/jsdom 依赖，先完成该目录
`npm ci`。它直接加载发货 `lib/client.js` 的真实设置槽，点击 Codex 卡并输入、提交、读回配置。
jsdom 只补齐其缺失的原生 dialog open/close API，不代替新表单或保存服务。

```sh
node vendor/dsh-plugin-subscriptions/scripts/sync-codex-custom-client.mjs --check
node --test vendor/dsh-plugin-subscriptions/test/codex-custom*.test.mjs
npm --prefix scripts/tests/codex-protocol-runtime ci --ignore-scripts
npm --prefix scripts/tests/codex-protocol-runtime run prepare-runtime
node scripts/tests/codex-custom-protocol.test.mjs
```

协议脚本也接受 `--engine-root <包含 node_modules 的目录>`，要求相同锁定版本和补丁。真实协议回归使用锁定的
Harness `0.2.2-rc.1` / pi-ai `1.3.0`，将本 helper 实际写出的 `{ id }` 模型配置交给真实
Harness adapter，再用 loopback HTTP 服务验证完整路径、Bearer key、原样模型 ID 和 SSE 文本。
验证不读取用户凭据，不调用外部模型；缺 key 不出网，官方两种 OAuth 存储保持不变。

单元回归覆盖首次配置、同地址编辑、换地址、非法输入、路由占用、私有凭据失败、revision 冲突、
提交后异常、未知提交结果与读回重试。客户端回归覆盖登录保留、三字段保存、密钥不回显、换地址要求
新 key、未知网络结果以及读取失败/冲突后的恢复。上述测试不等同 Android 实机布局或平台账号实测。
