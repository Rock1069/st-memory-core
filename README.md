# 记忆中枢 · P0

版本 `0.1.0`。重新编写的 SillyTavern 记忆管理扩展底座，后续按本项目清单接入 Horae、shujuku、柏宝书的功能。

目前已实现统一事实库、稳定消息身份、来源版本校验、事务与幂等、状态重放、字段锁、任务队列、API 渠道、备份恢复、脱敏日志和只读接口。记忆提取、摘要、检索、RPG、表格和旧插件数据迁移仍在后续阶段。

## 安装与使用

1. 解压 `artifacts/st-memory-core-0.1.0.zip`，得到 `st-memory-core` 文件夹。
2. 将整个文件夹放入酒馆当前用户的 `extensions` 目录。默认用户通常为 `SillyTavern/data/default-user/extensions/st-memory-core`；自定义数据目录或其他用户使用对应目录。
3. 刷新酒馆，在扩展设置中展开「记忆中枢 · P0」。如果宿主没有常用设置容器，面板会显示在右下角。
4. 打开一个聊天，检查当前聊天名称、消息数和版本。可以创建检查点、导出备份、查看任务与日志。
5. API 默认跟随酒馆主 API。独立渠道目前支持 OpenAI Chat Completions 兼容服务，填写基础地址、模型和密钥后选择默认渠道。

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
