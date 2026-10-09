# 记忆中枢

版本 `0.1.3`。重新编写的 SillyTavern 记忆管理扩展底座，后续按本项目清单接入 Horae、shujuku、柏宝书的功能。

0.1.3 将界面改为记忆档案馆风格：深墨绿、暖金和薄荷色，配合记忆联结图案、真实变更时间线与档案卡片。功能分为「记忆概览」「档案管理」「API 渠道」「任务与日志」四个页签；切换页签和关闭重开不会清空尚未提交的表单。

目前已实现统一事实库、稳定消息身份、来源版本校验、事务与幂等、状态重放、字段锁、任务队列、API 渠道、备份恢复、脱敏日志和只读接口。记忆提取、摘要、检索、RPG、表格和旧插件数据迁移仍在后续阶段。

## 安装与使用

1. 解压 `artifacts/st-memory-core-0.1.3.zip`，得到 `st-memory-core` 文件夹。
2. 将整个文件夹放入酒馆当前用户的 `extensions` 目录。默认用户通常为 `SillyTavern/data/default-user/extensions/st-memory-core`；自定义数据目录或其他用户使用对应目录。
3. 刷新酒馆，点击左下角「魔法棒」→「记忆中枢」，直接打开面板弹窗。也可在顶部积木图标的扩展设置中展开「记忆中枢」，点击「打开面板」。如果宿主没有常用设置容器，设置入口会显示在右下角。
4. 打开一个聊天，检查当前聊天名称、消息数和版本。可以创建检查点、导出备份、查看任务与日志。
5. API 默认跟随酒馆主 API。独立渠道目前支持 OpenAI Chat Completions 兼容服务，填写基础地址、模型和密钥后选择默认渠道。

从 0.1.0 / 0.1.1 / 0.1.2 升级：将包内文件覆盖到原来的 `st-memory-core` 扩展文件夹，再刷新页面；电脑上可用 `Ctrl+F5` 强制刷新。确认 `manifest.json` 和面板显示版本 0.1.3。直接覆盖文件，不必删除扩展配置或聊天数据。事实库、备份和配置 schema 仍为版本 1。

概览显示当前聊天的消息片段数、事实实体数与档案版本。「记忆轨迹」来自真实同步和事实变更日志；自动记忆提取仍待后续阶段接入。备份恢复与配置导入在「档案管理」，独立渠道表单在「API 渠道」，后台任务和日志在「任务与日志」。

界面使用局部样式和内置 SVG，无需下载字体或图片。窄面板采用单列卡片，按钮保留 44px 触控高度，关闭按钮固定在弹窗顶部。0.1.3 的浏览器截图和手机布局检查尚未完成；本次浏览器测试运行请求被拒绝，未将旧版检查结果计作新版通过。

菜单弹窗可点击「关闭」、点击遮罩或按 Escape 收起。面板内尚未提交的表单输入在关闭、重开后保留。菜单延迟创建或被宿主重建时会重新挂载入口；禁用插件会移除入口和弹窗。

0.1.2 修复了两处启动兼容问题：酒馆原生事件解绑使用 `removeListener`，旧代码错误地要求 `off`；通过 `http://局域网 IP` 访问时，浏览器不提供 `crypto.randomUUID` 和 `crypto.subtle`。现在 UUID 使用 `getRandomValues` 生成，SHA-256 提供兼容实现，摘要结果与安全上下文一致，已有消息版本和备份可以继续使用。无需为打开本插件改用 HTTPS。依据：[酒馆事件接口源码](https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/lib/eventemitter.js)、[randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)、[SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle)。

入口会在等待宿主时挂载。启动失败后仍能通过魔法棒打开面板，看到版本、访问方式、错误码和「重试启动」按钮；解决宿主问题后可直接重试。如果连入口都没有，确认安装包没有多套一层目录、扩展已启用、已覆盖完整 `src` 文件夹，并在浏览器控制台查看脚本加载或模块 404 错误。扩展管理列表可见只表示 manifest 被发现。

点击「测试默认渠道」才会发送诊断请求，可能产生模型费用。**独立渠道密钥仅保存在当前浏览器会话内，刷新后重新填写。** 导出配置与备份不包含凭据库。

P0 不会自动读取其他插件的私有状态，也不会自动提取记忆。要验证完整的正文记忆闭环，需要后续 P1/P2。

关闭「后台任务」会取消在途任务并阻止新任务，身份同步、只读查询和备份仍可使用。通过酒馆原生扩展管理禁用插件时会完整解绑事件。

扩展使用浏览器原生 ES 模块，无第三方运行依赖。安装时不需要 `npm install` 或构建步骤。宿主接口以 [SillyTavern 扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/) 为依据；实际酒馆版本兼容性仍需实机确认。

## 备份与恢复

- 「导出备份」包含当前聊天事实库、来源版本、事件记录、检查点和无凭据配置；不包含原始聊天正文文件。
- 「恢复事实库」只支持同一聊天、同一组正文版本的备份。校验失败会拒绝恢复。聊天分支使用新的事实库 ID，不能直接恢复父聊天的备份。
- 恢复事实库不会同时更换 API 配置；需要时另用「导入配置」。
- 检查点是事件重放的校验快照。P0 支持通过完整备份恢复；界面中的任意历史点恢复留待后续归档界面实现。
- 事实库与消息 ID 分别通过酒馆的元数据和正文保存接口落盘。两份宿主文件没有跨文件原子事务。

事实变更在单个运行实例内串行提交，保存失败会回退内存中的候选状态。宿主保存接口不提供服务端 CAS，因此不承诺多设备或多个浏览器标签同时编辑的隔离性。主 API 的取消会停止等待并丢弃迟到结果，宿主底层请求可能继续；独立渠道使用 `AbortSignal` 取消请求。

## 开发与验证

以下命令在完整源码工作区执行；安装包只包含扩展运行文件和说明。开发需要 Node.js 22 或更新版本，无需安装依赖。

```powershell
npm test
npm run check
npm run verify
npm run package
```

`npm run verify` 将测试结果和源码哈希写入 `artifacts/p0-validation.json`。`npm run package` 使用 Windows PowerShell，将 `manifest.json`、入口、样式、源码和说明打包；研究仓库、开发测试和本地凭据不会装入扩展。

可选浏览器验收：在可使用 Playwright 的开发环境执行 `npm run test:ui`。`MEMORY_CORE_BROWSER_PACKAGES` 可指定包含 Playwright 的 `node_modules` 目录，`MEMORY_CORE_BROWSER_EXECUTABLE` 可指定浏览器可执行文件；未设置时使用本项目依赖目录与 Playwright 默认 Chromium。该项不影响无依赖的底座测试或扩展安装。检查在模拟酒馆页面执行，包含原生 `removeListener` 接口、普通 HTTP 环境、下载备份校验、失败重试、关闭/启停、菜单延迟加载和窄屏；不访问真实模型。普通 HTTP 测试将 `memory-core.test` 解析到本地测试服务器，并检查 `isSecureContext === false`，避免把 localhost 测试当作局域网测试。

浏览器脚本已扩展为 17 项检查，新增页签键盘操作与草稿保留、真实数据概览与时间线，以及 320px / 390px 各页签的横向溢出检查。0.1.2 的 14 项结果是历史记录，0.1.3 的 17 项尚未运行。可执行 `npm run preview:ui` 生成 `artifacts/ui-redesign-preview.html`：预览嵌入实际 UI 代码和示例数据，无需运行服务器，不连接模型或保存聊天；打开后可以切换页签。生成预览只检查脚本语法，不代替浏览器布局验收。

- [P0 实现与验收记录](docs/P0-实现与验收.md)：18 条 P0 项目的实现证据及待执行的实机步骤。
- [底座接口约定](docs/底座接口约定.md)：数据协议、事务、任务和模块接入方式。
- [功能覆盖清单](功能覆盖清单.md)：完整功能范围与后续阶段。

## 只读接口

加载完成后提供 `window.STMemoryCore`，通过 `st-memory-core:ready` 浏览器事件通知就绪。

```javascript
const api = window.STMemoryCore;
const current = api.getSnapshot();
console.log(current.coverage); // P0 会明确说明尚未提取记忆
const history = api.getHistory({ after: 0, limit: 100 });
const unsubscribe = api.subscribe(event => console.log(event.type));
// 不再订阅时调用 unsubscribe()
```

返回值是复制出的 JSON 数据，不泄露内部可变引用。公共接口没有直接写入函数；新模块通过内部运行时的统一事务提交。旧插件第三方写入接口的兼容属于 P5。
