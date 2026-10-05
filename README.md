# 表单字段暂存（纯本地 · Chrome Manifest V3）

无后端、无通配站点权限的 Chrome 扩展。用户**主动点击扩展图标并明确授权当前页**后，
才向**顶层文档**编程注入内容脚本；手动勾选普通文本字段保存为“修订”，需要时经**预览 + 二次确认**恢复。
所有数据仅存放在浏览器本地 IndexedDB，service worker 终止/唤醒不丢状态。

## 目录结构

```
extension/                 可直接“加载已解压的扩展程序”
├── manifest.json          MV3 清单：permissions 仅 activeTab/scripting/alarms，host_permissions 为空
├── background/
│   ├── service-worker.js  消息路由、注入、组合校验、闹钟清理（无进程内权威状态）
│   └── db.js              IndexedDB 事务层（令牌 / 修订）
├── inject/
│   ├── policy.js          纯策略：字段准入/排除、指纹、恢复校验、信封校验（无 DOM/chrome 依赖）
│   ├── route-hook.js      MAIN world：仅包裹 history API 发路由事件，不碰页面数据
│   └── content.js         ISOLATED world：面板 UI、选择/保存/预览恢复、SPA 与表单替换检测
├── popup/                 工具栏弹窗：授权、撤回、过期清理
└── icons/
test-site/                 本地测试表单（多表单 / SPA / 导航 + 测试钩子）
tools/
├── serve.js               零依赖静态服务器（http://127.0.0.1:8765）
├── check.js               静态安全/语法检查
└── make-icons.js          生成图标
test/                      Node 单元 + SW 消息层集成测试（39 项）
```

## 安装与运行

```bash
npm test          # 32 项单元/集成测试
npm run check     # manifest 权限审计、JS 语法、网络外发面扫描
npm run serve     # 启动测试站点 http://127.0.0.1:8765/index.html
```

加载扩展：Chrome 打开 `chrome://extensions` → 开启“开发者模式” → “加载已解压的扩展程序” → 选择 `extension/`。

使用：
1. 打开任意普通 http(s) 页面（先用测试站点）；
2. 点击工具栏扩展图标 → “授权并注入当前页”；页面右上角出现面板；
3. 选择带唯一 `id` 的表单 → 勾选字段（≤20）→ “保存所选为新草稿修订”；
4. 恢复：草稿卡片 → “恢复预览” → 逐字段查看“当前值 → 草稿值” → 勾选确认 → “确认恢复”；
5. 提交表单确认完成后，点“我已提交完成，删除此修订”——**只删除这一份**修订。

## 安全模型（对应需求逐条）

| 要求 | 实现 |
| --- | --- |
| 仅点击 + activeTab 后注入顶层文档 | 无 `content_scripts`/`host_permissions`；弹窗按钮调用 `chrome.scripting.executeScript({target:{tabId, allFrames:false}})`，MAIN world 只注入路由钩子，功能脚本在 ISOLATED world |
| 不读 iframe | 注入 `allFrames:false`；消息处理拒绝 `sender.frameId !== 0` |
| 仅唯一 id 表单 | `scanForms()` 统计文档内 `form[id]` 重复，重复整个排除；无 id 表单不列出 |
| 表单内唯一 id 或唯一 name 的普通文本字段 | `policy.analyze`：id 重复排除；无 id 时要求 name 在该表单唯一；类型白名单 text/search/url/tel/email/number + textarea |
| 始终排除 password/file/hidden/OTP/支付 | 类型白名单天然排除 password/file/hidden/checkbox 等；OTP（`one-time-code`、otp/2fa/mfa/sms+code、验证码）与支付（`cc-*`/`transaction-*`、card/cvv/expiry、卡号/有效期/安全码）启发式排除，另排除 disabled/readonly |
| 最多 20 项 | UI 勾选上限 + `buildEnvelope` 服务端式再校验 `too-many-fields`；另有单值 64KiB、总值 256KiB |
| 选择 / 草稿 / 恢复预览三段面板，恢复前再确认 | 面板第 1/2/3 区；恢复覆盖层展示逐字段当前值→草稿值，勾选框是第二次确认，未勾选按钮禁用 |
| origin + 完整路由 + 表单身份隔离 | 索引键 `scopeKey = origin + ' ' + fullRoute`（pathname+search+hash）；表单身份 = formId + 全字段 FNV-1a 指纹 |
| 重新授权产生新文档令牌 | `HELLO` 在**单个 IndexedDB 读写事务**内把同 tab 旧 active 令牌置 `superseded` 并 add 新令牌 |
| 结合 sender.documentId 验证 | 每条带令牌消息：库内令牌 + `sender.tab.id` + **浏览器提供的 `sender.documentId`** + `origin` 组合校验，消息自报身份一律不采信 |
| 旧页迟到保存不能覆盖新页草稿 | 旧令牌已 `superseded` → `SAVE_DRAFT` 返回 `superseded-token`；写入前还用 sender 的 URL 覆盖信封 route，页面无法把保存投放到别的路由桶 |
| IndexedDB 事务维护修订与令牌，SW 唤醒可续 | 全部权威状态在 `tokens`/`revisions` 两个 store；无缓存 Map。闹钟每 30 分钟清理；onStartup/onInstalled 也触发 |
| SPA 换路由暂停绑定 | MAIN world 包裹 pushState/replaceState/popstate/hashchange → ISOLATED 监听自定义事件；`fullRoute` 变化即清空选择并显示暂停横幅，要求重新选择表单 |
| 表单被替换暂停绑定 | `MutationObserver` 检测所选 form `!isConnected` → `paused-form`；字段集合变化则 `fieldsStale`，禁止保存/恢复直到重新勾选 |
| 恢复时身份或类型变化就拒绝，不猜相近输入框 | 单修订与多修订都在写入前重新抓实时 DOM，比对 key/kind/id/name、原控件对象、原 form 对象和整表指纹；失败时**一项都不写** |
| 多修订冲突必须显式选择 | `batch.js` 对相同值自动合并；不同值要求选择具体 revisionId，计划记录来源；确认时重新鉴权并重取修订，当前值/路由/控件/form/授权任一变化即整组拒绝 |
| 完成清理只删确认过的修订，期间新增保留 | `CONSUME_REVISION` 按 id + origin + route 定位，单条 `delete`；每次保存都是独立修订（append-only），互不影响 |
| 不采集完整 DOM、不上传 | 扫描仅取候选控件的属性与被选字段的值；check.js 扫描确认扩展代码无 fetch/XHR/WebSocket/sendBeacon |

## 手动验证清单（配合 test-site）

`npm run serve` 后，建议按下列剧本走一遍。带 `?fsp_test=1` 的页面才会显示测试钩子。

### 1. 授权范围
- 打开 `http://127.0.0.1:8765/index.html`，未授权前页面左下角提示“未注入”；
- 弹窗点击授权 → 面板出现；在 DevTools Console 执行 `document.querySelector('iframe')` 场景：本扩展从不向 frame 发消息（可在 SW 日志看到非 frameId 0 拒绝，对应单测 `iframe（frameId!==0）消息一律拒绝`）；
- 打开 `chrome://extensions/` 点扩展：弹窗显示“不支持注入”，GRANT 返回 `unsupported-url`。

### 2. 排除规则（index 页）
- `form#profile` 可保存字段应为 6 个：fullname/username/email/phone/age/bio；
- 排除摘要包含：password/file/hidden、OTP（两个）、支付（三个）、disabled、readonly、checkbox；
- `form#settings` 仅 2 个 name-only 字段；重复 `dup_group` 被排除；
- 无 id 表单与重复 id 的第二个 `form#profile` 不出现在下拉框。

### 3. 草稿隔离与恢复确认
- 在 profile 保存一份；改名再保存第二份（列表按时间倒序，各有独立尾号）；
- 清空字段 → “恢复预览”：逐字段显示当前值→草稿值；不点勾选时“确认恢复”禁用；
- 恢复后修改页面字段类型（DevTools 把 email 的 `type` 改成 password，或删除某字段）再预览：红色拒绝清单，且页面字段**完全没被改动**。

### 3.1 多历史草稿合并恢复
- 勾选同一 `form#profile` 的 2～8 份修订，点击“合并已选修订”；不同表单身份的草稿不可勾选；
- 合并预览逐字段列出当前值与各来源值：各修订值相同会标记“同值”并可直接合并；值不同必须点选一个修订尾号，不会自动用最新草稿覆盖；
- 取消勾选某个字段后确认：只有勾选字段恢复，未选字段保持原值，一次最多 20 个字段；
- 确认前/确认后在 DevTools 修改任一已预览字段当前值、替换某个控件、替换整个 form，或切换路由：确认恢复必须整组拒绝，页面字段完全不变；
- 在弹窗撤回授权或等待令牌失效后确认：后台重新鉴权失败，整组拒绝；只有重新授权后的新流程可恢复；
- 只有实际提供了至少一个最终恢复字段（同值来源也计入）的修订，才会显示该修订的提交后清理按钮；未选字段所属修订与未采用的冲突来源保留，原“恢复预览 → 单修订恢复”流程仍可继续使用。

### 4. SPA 路由与表单替换（spa.html）
- 授权并在 `form#contact` 保存草稿；
- 点 `pushState → #/view/contact`：黄色横幅“路由变化，已暂停绑定”，选择被清空（令牌未失效，草稿按新路由隔离）；
- 回到原路由可见原草稿；点“原地替换表单（billing 版本）”：字段指纹变化，保存按钮禁用，旧草稿预览显示“字段已消失 / 表单字段集合变化”，不会把值写进 invoice-* 输入框；
- “替换成另一个 id 的表单” / “移除表单”：进入 `paused-form`，要求重新选择。

### 5. 授权撤回、导航、迟到保存（navigate.html?fsp_test=1）
- 授权 → 保存；弹窗点“撤回本页授权”：面板消失，旧令牌立即失效（SW 集成测试覆盖 revoke 后保存被拒）；
- 重新授权 → 保存 → 再次点图标“重新授权（旧令牌立即失效）” → 点页面上的“用上一个令牌尝试迟到保存”：
  结果必须是 `{"ok":false,"error":"superseded-token"}`，新页草稿不被覆盖（列表仍是 1 份有效修订 + 新页保存正常）；
- 点“去多表单页”再浏览器后退（bfcache）：`pageshow.persisted` 触发重新握手，面板重新可用；
- 整页“重载”后：旧内容脚本消失，弹窗状态显示令牌存在但未绑定，需重新授权；`documentId` 变化时旧令牌保存返回 `token-context-mismatch`。

### 6. 后台重启
- `chrome://extensions` → 本扩展的 “Service Worker” 点“停止”；
- 回到页面保存/列表/恢复：SW 自动唤醒，数据来自 IndexedDB，历史修订与令牌状态延续（单测 `SW “重启”后状态全部从库恢复`）。

### 7. 过期清理
- 默认：令牌 TTL 12h、修订 TTL 7d，闹钟每 30 分钟自动清；弹窗“测试工具 → 立即运行过期清理”按真实 TTL 执行；
- 快速验证：在 `?fsp_test=1` 页面打开弹窗，勾选“测试模式：TTL 视为 0”后立即清理（仅该类页面允许此按钮功能），应删除所有修订/令牌；非 fsp_test 页面勾选会返回 `test-mode-requires-fsp-test-tab`。

## 自动化测试

```bash
$ npm test
# tests 39
# pass 39
```

- `test/policy.test.js`（12）：准入/排除、指纹、恢复拒绝、信封约束、路由；
- `test/batch.test.js`（6）：多修订同值合并、冲突显式选择、预览后上下文变化整组拒绝、清理来源；
- `test/db.test.js`（10）：同事务作废旧令牌、组合校验、TTL、隔离、只删确认修订、SW 重启；
- `test/sw.test.js`（11）：伪造 chrome 事件 API 跑真实 SW 源码，覆盖 GRANT 注入形状、iframe 拒绝、documentId 不匹配、SPA 路由桶、迟到保存、撤回推送、过期授权、PRUNE 权限门。


新增多修订合并恢复：面板选中同一当前表单的 2～8 个修订，最多合并 20 个可选字段。相同字段同值可合并，不同值必须由用户明确选择已选修订来源，不能自动以时间覆盖。确认预览保留当前值、字段种类、原控件及原表单对象、路由和授权令牌；确认后任一条件变化均拒绝整组写入。非选中字段不改，按成功恢复的具体修订进行后续清理。保留原单修订功能和安全字段策略。
