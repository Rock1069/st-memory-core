import { canonical, id } from '../core/util.js';
import { MODULES } from '../core/settings.js';
import { mountNavigation } from './navigation.js';
import { PLUGIN_VERSION } from '../core/version.js';
import { normalizeApiEndpoint } from '../core/gateway.js';
import { icon, memoryMap } from './icons.js';
import { mountWorkbench } from './workbench.js';
import { mountExtraEntries } from './entries.js';
import { mountQuickStart } from './quick-start.js';
import { selectMemoryChannel } from '../core/simple-memory.js';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(label, iconName, className = '') {
  const element = node('button', undefined, `menu_button memory-core-button ${className}`); element.type = 'button';
  if (iconName) element.append(icon(iconName)); element.append(node('span', label)); return element;
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickJson() {
  return new Promise(resolve => {
    const input = node('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => { try { resolve(JSON.parse(await input.files[0].text())); } catch { resolve(null); } }, { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true }); input.click();
  });
}
function card(title, subtitle, iconName, className = '') {
  const section = node('section', undefined, `memory-core-card ${className}`);
  const heading = node('div', undefined, 'memory-core-card-heading'); const text = node('div');
  text.append(node('h3', title), node('p', subtitle, 'memory-core-muted')); heading.append(icon(iconName), text); section.append(heading); return section;
}
function emptyState(title, description, iconName = 'book') {
  const element = node('div', undefined, 'memory-core-empty'); element.append(icon(iconName), node('strong', title), node('p', description)); return element;
}
const moduleNames = { core: '事实底座', memory: '故事记忆', retrieval: '记忆检索', tables: '资料表格', rpg: '角色状态', plot: '剧情规划', agent: '智能 Agent', continuation: '智能续写', simulation: '世界推演' };
let activePanelDisposer;

function createShell() {
  const reopen = document.getElementById('st-memory-core-dialog')?.hasAttribute('open');
  activePanelDisposer?.(); document.getElementById('st-memory-core-panel')?.remove();
  const panel = node('section', undefined, 'memory-core-panel'); panel.id = 'st-memory-core-panel';
  const drawer = node('details'); drawer.append(node('summary', '记忆中枢'));
  const body = node('div', undefined, 'memory-core-body memory-core-shell'); drawer.append(body); panel.append(drawer);
  const openButton = button('打开面板', 'memory', 'memory-core-open-panel'); body.append(openButton);
  const hero = node('div', undefined, 'memory-core-hero'); const copy = node('div', undefined, 'memory-core-hero-copy');
  const eyebrow = node('div', undefined, 'memory-core-eyebrow'); eyebrow.append(node('span', '记忆档案'), node('span', 'MEMORY ARCHIVE'));
  copy.append(eyebrow, node('h2', '让故事留下痕迹。'), node('p', '收好每一个片段，串起下一段故事。'));
  const badges = node('div', undefined, 'memory-core-hero-badges'); const statusBadge = node('span', '正在连接', 'memory-core-badge memory-core-status-badge');
  badges.append(statusBadge, node('span', `v${PLUGIN_VERSION}`, 'memory-core-version')); copy.append(badges); hero.append(copy, memoryMap()); body.append(hero);
  return { panel, drawer, body, openButton, reopen, statusBadge };
}
function attachShell({ panel, drawer, openButton, reopen }, cleanup = () => {}) {
  const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
  if (target) target.append(panel); else { panel.classList.add('memory-core-floating'); document.body.append(panel); drawer.open = false; }
  const disposeNavigation = mountNavigation(panel, { drawer, openButton }); if (reopen) openButton.click();
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true; cleanup(); disposeNavigation(); panel.remove();
    if (activePanelDisposer === dispose) activePanelDisposer = null;
  };
  activePanelDisposer = dispose; return dispose;
}
function createTabs(body) {
  const nav = node('div', undefined, 'memory-core-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '记忆中枢功能');
  const content = node('div', undefined, 'memory-core-views'); const tabs = []; const views = {}; let active = 'overview';
  const definitions = [['overview', '记忆概览', 'book'], ['summaries', '楼层摘要', 'spark'], ['workbench','记忆工作台','memory'], ['archive', '档案管理', 'archive'], ['api', 'API 渠道', 'connection'], ['activity', '任务与日志', 'activity']];
  function select(key) {
    active = key;
    for (const item of tabs) { const selected = item.key === key; item.tab.setAttribute('aria-selected', String(selected)); item.tab.tabIndex = selected ? 0 : -1; views[item.key].hidden = !selected; }
  }
  for (const [key, label, iconName] of definitions) {
    const tab = button(label, iconName, 'memory-core-tab'); tab.id = `memory-core-tab-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `memory-core-view-${key}`);
    const view = node('div', undefined, 'memory-core-view'); view.id = `memory-core-view-${key}`; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-labelledby', tab.id); view.tabIndex = 0;
    tab.addEventListener('click', () => select(key));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
      const visible = tabs.filter(item => !item.tab.hidden); const index = visible.findIndex(item => item.key === key);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
      select(visible[next].key); visible[next].tab.focus({ preventScroll: true }); visible[next].tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    tabs.push({ key, tab }); views[key] = view; nav.append(tab); content.append(view);
  }
  const setMode = mode => {
    const light = mode === 'light';
    for (const item of tabs) { item.tab.hidden = light && ['summaries','archive','activity'].includes(item.key); item.tab.querySelector('span').textContent = item.key === 'overview' ? '记忆首页' : item.key === 'workbench' ? light ? '查看记忆' : '记忆工作台' : definitions.find(def => def[0] === item.key)[1]; }
    if (tabs.find(item => item.key === active)?.tab.hidden) select('overview');
  };
  body.append(nav, content); select('overview'); return { views, select, setMode };
}
export function mountStartupPanel(retry) {
  const shell = createShell(); shell.panel.dataset.state = 'starting';
  const message = card('连接你的故事', '入口已准备好，正在等待酒馆加载。', 'memory', 'memory-core-startup');
  const status = node('p', '正在等待酒馆加载并启动底座……'); status.setAttribute('role', 'status');
  const environment = node('p', `访问方式：${location.protocol} · 浏览器安全上下文：${globalThis.isSecureContext ? '是' : '否'}`, 'memory-core-muted');
  const errorText = node('p', '', 'memory-core-feedback'); errorText.setAttribute('role', 'alert');
  const retryButton = button('重试启动', 'refresh', 'memory-core-primary'); retryButton.hidden = true;
  retryButton.addEventListener('click', () => { retryButton.disabled = true; void retry(); }); message.append(status, environment, errorText, retryButton); shell.body.append(message);
  const dispose = attachShell(shell);
  return { dispose, fail(code, text) { shell.panel.dataset.state = 'failed'; shell.statusBadge.textContent = '连接中断'; status.textContent = '底座启动失败'; errorText.textContent = `${code}：${text}`; errorText.dataset.tone = 'error'; retryButton.hidden = false; } };
}
export function mountPanel(runtime) {
  const shell = createShell(); const { panel, body, statusBadge } = shell; panel.dataset.state = 'ready'; const { views, select, setMode } = createTabs(body);
  const feedback = node('p', '', 'memory-core-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const reportError = error => { runtime.logger.error(error); feedback.dataset.tone = 'error'; feedback.textContent = runtime.logger.redact(error.message ?? String(error)); };
  const workbench = mountWorkbench(views.workbench,runtime,(text,error = false) => { feedback.textContent = text; if (error) feedback.dataset.tone = 'error'; else delete feedback.dataset.tone; });
  const quickStart = mountQuickStart(views.overview, runtime, {
    onConnect: () => select('api'), onView: () => { select('workbench'); workbench.show('state'); },
    onAdvanced: async () => { const config = runtime.settings.snapshot(); await runtime.settings.update({ui:{...config.ui,mode:'advanced'}}); render(); select('workbench'); workbench.show('settings'); },
    report: (text, error = false) => { feedback.textContent = text; if (error) feedback.dataset.tone = 'error'; else delete feedback.dataset.tone; },
  });
  const action = (label, handler, target, options = {}) => {
    const element = button(label, options.icon, options.className);
    if (options.description) { element.classList.add('memory-core-action-card'); element.append(node('small', options.description), icon('arrow', 'memory-core-action-arrow')); }
    element.addEventListener('click', async () => {
      element.disabled = true; feedback.textContent = ''; delete feedback.dataset.tone;
      try { await handler(); } catch (error) { reportError(error); } finally { element.disabled = false; render(); }
    }); target.append(element); return element;
  };
  const update = patch => { void runtime.settings.update(patch).catch(error => { reportError(error); render(); }); };
  const createPoint = async () => { await runtime.checkpoint(); feedback.textContent = '检查点已保存。'; };
  const exportBackup = async () => download('memory-core-backup.json', await runtime.backup());
  const restoreBackup = async () => {
    const backup = await pickJson(); if (!backup) return;
    if (!globalThis.confirm('将当前聊天的事实库恢复到备份版本。原始正文保持当前状态；仅支持相同聊天、相同正文版本的备份。')) return;
    await runtime.restore(backup); feedback.textContent = '事实库已恢复。';
  };
  // Overview uses the committed projection and reports summary gaps separately from later structured extraction.
  const scope = node('div', undefined, 'memory-core-scope'); const scopeCopy = node('div'); scopeCopy.append(node('span', '当前故事', 'memory-core-overline'));
  const chatName = node('strong', '', 'memory-core-chat-name'); scopeCopy.append(chatName);
  const enabledLabel = node('label', undefined, 'memory-core-switch'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', '启用后台任务');
  const switchTrack = node('span', undefined, 'memory-core-switch-track'); switchTrack.setAttribute('aria-hidden', 'true'); enabledLabel.append(enabled, switchTrack, node('span', '后台任务')); scope.append(scopeCopy, enabledLabel); views.overview.append(scope);
  enabled.addEventListener('change', () => update({ enabled: enabled.checked }));
  const metrics = node('div', undefined, 'memory-core-metrics'); const metricValues = {};
  for (const [key, label, detail] of [['messages', '消息片段', '已同步的正文'], ['entities', '事实实体', '已记录的人物与物品'], ['revision', '档案版本', '当前事实库版本']]) {
    const metric = node('div', undefined, 'memory-core-metric'); const value = node('strong', '—'); value.dataset.metric = key;
    metric.append(node('span', label), value, node('small', detail)); metricValues[key] = value; metrics.append(metric);
  }
  views.overview.append(metrics);
  const overviewGrid = node('div', undefined, 'memory-core-overview-grid'); views.overview.append(overviewGrid);
  const traceCard = card('记忆轨迹', '最近的正文同步与事实变更', 'clock'); const timeline = node('ol', undefined, 'memory-core-timeline'); traceCard.append(timeline); overviewGrid.append(traceCard);
  const keepCard = card('为此刻留一份档案', '保存当前状态，让故事有迹可循。', 'archive', 'memory-core-keep-card');
  action('创建检查点', createPoint, keepCard, { icon: 'checkpoint', className: 'memory-core-primary' }); action('导出备份', exportBackup, keepCard, { icon: 'download' });
  const archiveLink = button('查看档案工具', 'arrow', 'memory-core-text-button'); archiveLink.addEventListener('click', () => select('archive')); keepCard.append(archiveLink); overviewGrid.append(keepCard);
  const coverage = node('div', undefined, 'memory-core-coverage'); coverage.append(icon('spark')); const coverageText = node('p'); coverage.append(coverageText); views.overview.append(coverage);
  const roadmap = node('details', undefined, 'memory-core-roadmap'); roadmap.append(node('summary', '更多记忆能力')); const modules = node('div', undefined, 'memory-core-modules');
  for (const module of Object.keys(MODULES).filter(module => !['core', 'memory'].includes(module))) { const item = node('span', undefined, 'memory-core-planned-module'); item.append(node('span', moduleNames[module]), node('small', '待接入')); modules.append(item); }
  roadmap.append(modules); views.overview.append(roadmap);

  const summaryIntro = node('div', undefined, 'memory-core-section-intro'); summaryIntro.append(node('h3', '逐楼留下摘要'), node('p', '摘要与当前正文版本绑定。编辑或切换回复页后，旧摘要会失效并显示缺口。状态提取、范围审阅与压缩在记忆工作台。')); views.summaries.append(summaryIntro);
  const summaryControls = card('摘要任务', '自动摘要默认关闭；启用后每轮按楼数上限处理最新缺口。手动补摘从最早缺口开始。', 'spark');
  const memoryLabel = node('label', undefined, 'memory-core-check-label'); const memoryEnabled = node('input'); memoryEnabled.type = 'checkbox'; memoryLabel.append(memoryEnabled, node('span', '启用故事记忆模块')); summaryControls.append(memoryLabel);
  memoryEnabled.addEventListener('change', () => { const config = runtime.settings.snapshot(); update({ modules: { ...config.modules, memory: memoryEnabled.checked } }); });
    const autoLabel = node('label', undefined, 'memory-core-check-label'); const autoSummary = node('input'); autoSummary.type = 'checkbox'; autoLabel.append(autoSummary, node('span', '按阈值自动分析正文（遵循工作台选项）')); summaryControls.append(autoLabel);
  autoSummary.addEventListener('change', () => { const config = runtime.settings.snapshot(); update({ memory: { ...config.memory, autoSummarize: autoSummary.checked } }); });
    const batchLabel = node('label', '自动分析每轮楼数上限', 'memory-core-field'); const batchLimit = node('input'); batchLimit.type = 'number'; batchLimit.min = '1'; batchLimit.max = '100';
  batchLabel.append(batchLimit); summaryControls.append(batchLabel);
  batchLimit.addEventListener('change', () => { const config = runtime.settings.snapshot(); update({ memory: { ...config.memory, maxMessagesPerRun: Number(batchLimit.value) } }); });
  const summaryRouteLabel = node('label', '摘要 API 渠道', 'memory-core-field'); const summaryRoute = node('select'); summaryRoute.setAttribute('aria-label', '摘要 API 渠道'); summaryRouteLabel.append(summaryRoute); summaryControls.append(summaryRouteLabel);
  summaryRoute.addEventListener('change', () => { const config = runtime.settings.snapshot(); update({ routing: { ...config.routing, summary: summaryRoute.value } }); });
  const summaryActions = node('div', undefined, 'memory-core-actions'); summaryControls.append(summaryActions);
  action('补摘前 20 个缺口', async () => { const result = await runtime.summarizeMissing({ limit: 20 }); feedback.textContent = `已补摘 ${result.completed} 楼，剩余 ${result.remaining} 个缺口。`; }, summaryActions, { icon: 'spark', className: 'memory-core-primary' });
  views.summaries.append(summaryControls);
  const summaryListCard = card('摘要与缺口', '显示最近 40 个有效楼层。可以手写或修订摘要；人工修订会锁定摘要正文。', 'book');
  const summaryCount = node('p', '', 'memory-core-muted'); const summaryList = node('div', undefined, 'memory-core-summary-list'); summaryListCard.append(summaryCount, summaryList); views.summaries.append(summaryListCard);

  const archiveIntro = node('div', undefined, 'memory-core-section-intro'); archiveIntro.append(node('h3', '把重要的此刻，妥善收藏。'), node('p', '管理当前聊天的检查点、事实库备份与扩展配置。')); views.archive.append(archiveIntro);
  const archiveTools = node('div', undefined, 'memory-core-archive-tools'); views.archive.append(archiveTools);
  action('创建检查点', createPoint, archiveTools, { icon: 'checkpoint', description: '保存可校验的当前事实快照', className: 'memory-core-primary' });
  action('导出备份', exportBackup, archiveTools, { icon: 'download', description: '下载当前聊天的完整事实档案' });
  action('恢复事实库', restoreBackup, archiveTools, { icon: 'upload', description: '从同一聊天、同一正文版本恢复' });
  action('刷新状态', () => runtime.sync(), archiveTools, { icon: 'refresh', description: '重新同步当前聊天的正文身份' });
  views.archive.append(node('p', '备份包含事实记录、来源版本和检查点，不包含原始聊天正文文件。', 'memory-core-muted'));
  const configCard = card('配置随行', '导入导出渠道与偏好，密钥单独填写。', 'lock'); const configTools = node('div', undefined, 'memory-core-actions'); configCard.append(configTools);
  action('导出配置', () => download('memory-core-settings.json', runtime.settings.snapshot()), configTools, { icon: 'download' });
  action('导入配置', async () => { const config = await pickJson(); if (!config) return; await runtime.settings.update(config.config ?? config); feedback.textContent = '配置已导入，凭据需单独填写。'; }, configTools, { icon: 'upload' }); views.archive.append(configCard);

  const routeCard = card('为故事选择一个渠道', '默认使用酒馆主 API，也可以连接独立模型。', 'connection');
  const routeLabel = node('label', '默认 API 渠道', 'memory-core-field'); const route = node('select'); route.setAttribute('aria-label', '默认 API 渠道'); routeLabel.append(route); routeCard.append(routeLabel);
  route.addEventListener('change', () => { const config = runtime.settings.snapshot(); update({ routing: { ...config.routing, default: route.value } }); });
  const routeTools = node('div', undefined, 'memory-core-actions'); routeCard.append(routeTools);
  action('测试默认渠道', async () => { const result = await runtime.testChannel(); feedback.textContent = `渠道已返回：${runtime.logger.redact(result).slice(0, 120)}`; }, routeTools, { icon: 'activity' }); routeCard.append(node('p', '测试会发送一次“回复 OK”的模型请求。', 'memory-core-muted')); views.api.append(routeCard);
  const apiGrid = node('div', undefined, 'memory-core-api-grid'); views.api.append(apiGrid);
  const formCard = card('连接独立渠道', '支持 OpenAI 兼容服务', 'connection'); const form = node('form', undefined, 'memory-core-form'); const inputs = {};
  const fetchModels = button('获取模型', 'refresh', 'memory-core-fetch-models'); fetchModels.title = '使用当前 API 地址和 Key 获取模型列表';
  for (const [key, label, type, placeholder] of [['name', '渠道名称', 'text', '例如：故事助手'], ['endpoint', 'API 基础地址（含 /v1 等路径）', 'url', 'https://api.example.com/v1'], ['secret', 'API Key（仅本次会话保存）', 'password', '输入 API Key'], ['model', '模型名称', 'text', '填写模型名，或一键获取']]) {
    const wrapper = node('div', undefined, 'memory-core-field'); const labelNode = node('label', label); const input = node('input'); input.id = `memory-core-channel-${key}`; labelNode.htmlFor = input.id;
    input.type = type; input.placeholder = key === 'name' ? '可留空，自动使用服务地址命名' : placeholder; input.autocomplete = key === 'secret' ? 'new-password' : 'off'; input.required = !['secret','name'].includes(key); wrapper.append(labelNode);
    if (key === 'model') { const row = node('div', undefined, 'memory-core-model-row'); row.append(input, fetchModels); wrapper.append(row); } else wrapper.append(input);
    form.append(wrapper); inputs[key] = input;
  }
  const modelChoices = node('label', '可用模型', 'memory-core-field'); modelChoices.hidden = true;
  const modelSelect = node('select'); modelSelect.setAttribute('aria-label', '可用模型'); modelChoices.append(modelSelect); form.append(modelChoices);
  const modelStatus = node('p', '填写 API 地址和 Key 后，点击「获取模型」。也可直接填写模型名。', 'memory-core-model-status');
  modelStatus.setAttribute('role', 'status'); modelStatus.setAttribute('aria-live', 'polite'); form.append(modelStatus);
  let modelLookup = null;
  const cancelModelLookup = () => { modelLookup?.abort(); modelLookup = null; fetchModels.disabled = false; fetchModels.removeAttribute('aria-busy'); fetchModels.querySelector('span').textContent = '获取模型'; };
  const clearModelChoices = () => { modelChoices.hidden = true; modelSelect.replaceChildren(); };
  for (const input of [inputs.endpoint, inputs.secret]) input.addEventListener('input', () => {
    cancelModelLookup(); clearModelChoices(); delete modelStatus.dataset.tone;
    modelStatus.textContent = '连接信息已更改，点击「获取模型」重新读取列表。';
  });
  inputs.model.addEventListener('input', () => { modelSelect.value = inputs.model.value; });
  modelSelect.addEventListener('change', () => { if (modelSelect.value) inputs.model.value = modelSelect.value; });
  fetchModels.addEventListener('click', async () => {
    if (modelLookup) return;
    const controller = new AbortController(); modelLookup = controller;
    const endpoint = inputs.endpoint.value; const secret = inputs.secret.value;
    clearModelChoices(); fetchModels.disabled = true; fetchModels.setAttribute('aria-busy', 'true'); fetchModels.querySelector('span').textContent = '获取中…';
    delete modelStatus.dataset.tone; modelStatus.textContent = '正在获取模型列表…';
    try {
      const models = await runtime.gateway.discoverModels({ endpoint, secret, signal: controller.signal });
      if (modelLookup !== controller || controller.signal.aborted || endpoint !== inputs.endpoint.value || secret !== inputs.secret.value) return;
      const placeholder = node('option', '请选择模型'); placeholder.value = ''; modelSelect.append(placeholder);
      for (const model of models) { const option = node('option', model); option.value = model; modelSelect.append(option); }
      const autoFill = models.length === 1 && !inputs.model.value.trim();
      if (autoFill) inputs.model.value = models[0];
      modelSelect.value = models.includes(inputs.model.value) ? inputs.model.value : ''; modelChoices.hidden = false;
      modelStatus.textContent = autoFill ? '已获取 1 个模型，已填入模型名称。' : `已获取 ${models.length} 个模型，可从列表选择或继续手动填写。`;
    } catch (error) {
      if (modelLookup !== controller || controller.signal.aborted) return;
      runtime.logger.error(error); modelStatus.dataset.tone = 'error'; modelStatus.textContent = runtime.logger.redact(error.message ?? String(error));
    } finally { if (modelLookup === controller) cancelModelLookup(); }
  });
  form.addEventListener('reset', () => { cancelModelLookup(); clearModelChoices(); delete modelStatus.dataset.tone; modelStatus.textContent = '填写 API 地址和 Key 后，点击「获取模型」。也可直接填写模型名。'; });
  const saveChannel = button('添加渠道', 'connection', 'memory-core-primary'); saveChannel.type = 'submit'; form.append(saveChannel); formCard.append(form); apiGrid.append(formCard);
  form.addEventListener('submit', async event => {
    event.preventDefault(); cancelModelLookup(); saveChannel.disabled = true; delete feedback.dataset.tone;
    try {
      const channelId = id('channel'); const config = runtime.settings.snapshot();
      const endpoint = normalizeApiEndpoint(inputs.endpoint.value); const patch = { channels: [...config.channels, { id: channelId, name: inputs.name.value.trim() || new URL(endpoint).hostname, endpoint, model: inputs.model.value.trim(), timeoutMs: 120000, retries: 2 }] };
      if (config.ui.mode === 'light') await selectMemoryChannel(runtime, channelId, patch); else await runtime.settings.update(patch);
      runtime.vault.set(channelId, inputs.secret.value.trim()); form.reset(); feedback.textContent = config.ui.mode === 'light' ? 'API 已连接。回到首页点击「开启自动记忆」即可。密钥仅在本次会话有效。' : '渠道已添加，密钥仅在本次会话有效。';
      if (config.ui.mode === 'light') select('overview');
    } catch (error) { reportError(error); } finally { saveChannel.disabled = false; render(); }
  });
  const channelsCard = card('我的渠道', '独立渠道的密钥在刷新后需重新填写。', 'lock'); const channels = node('div', undefined, 'memory-core-channel-list'); channelsCard.append(channels); apiGrid.append(channelsCard);

  const taskCard = card('任务队列', '查看后台任务的进度与结果', 'activity'); const taskList = node('div', undefined, 'memory-core-task-list'); taskCard.append(taskList); views.activity.append(taskCard);
  const logCard = card('运行日志', '回看每一次同步与操作', 'book'); const bodyLabel = node('label', undefined, 'memory-core-check-label'); const logBodies = node('input'); logBodies.type = 'checkbox'; bodyLabel.append(logBodies, node('span', '记录模型请求与回复正文'));
  logBodies.addEventListener('change', () => update({ logBodies: logBodies.checked })); logCard.append(bodyLabel, node('p', '正文日志默认关闭。开启后，导出的日志会包含聊天材料。', 'memory-core-muted'));
  const logToolbar = node('div', undefined, 'memory-core-log-toolbar'); const logFilter = node('select'); logFilter.setAttribute('aria-label', '日志等级');
  for (const [value, label] of [['', '所有等级'], ['info', '信息'], ['warn', '警告'], ['error', '错误']]) { const option = node('option', label); option.value = value; logFilter.append(option); }
  logToolbar.append(logFilter); logFilter.addEventListener('change', () => render());
  action('导出日志', () => download('memory-core-log.json', runtime.logger.entries({ level: logFilter.value || undefined })), logToolbar, { icon: 'download' }); action('清空日志', () => runtime.logger.clear(), logToolbar); logCard.append(logToolbar);
  const logs = node('pre', undefined, 'memory-core-log-output'); logCard.append(logs); views.activity.append(logCard);
  const footer = node('div', undefined, 'memory-core-footer'); footer.append(node('span', '每一个片段，都有来处。'), node('span', '记忆中枢')); body.append(feedback, footer);

  let timer; let channelsSignature; let routeSignature; let summaryRouteSignature; let timelineSignature; let summarySignature;
  const taskNames = { queued: '排队中', running: '运行中', retrying: '重试中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
  function render() {
    if (!panel.isConnected) return;
    const current = runtime.status(); const snapshot = current.snapshot; enabled.checked = current.settings.enabled; logBodies.checked = current.settings.logBodies;
    const light = current.settings.ui.mode === 'light'; panel.dataset.uiMode = current.settings.ui.mode; setMode(current.settings.ui.mode);
    for (const element of [scope, metrics, overviewGrid, coverage, roadmap, routeCard]) element.hidden = light;
    quickStart.render();
    statusBadge.textContent = snapshot.active ? '档案已连接' : '等待故事开启'; statusBadge.dataset.tone = snapshot.active ? 'ready' : 'idle';
    chatName.textContent = snapshot.active ? snapshot.scope.chatId : '还没有打开聊天'; chatName.title = chatName.textContent;
    metricValues.messages.textContent = snapshot.active ? String(snapshot.messages.length) : '—'; metricValues.entities.textContent = snapshot.active ? String(Object.keys(snapshot.state.entities).length) : '—'; metricValues.revision.textContent = snapshot.active ? String(snapshot.revision) : '—';
    const summaryCoverage = snapshot.coverage.summary;
    coverageText.textContent = snapshot.coverage.reason === 'SOURCE_UNSYNCED' ? '正文已改变，正在等待同步。' : summaryCoverage ? `楼层摘要 ${summaryCoverage.summarized}/${summaryCoverage.eligible}；状态提取 ${summaryCoverage.extracted}/${summaryCoverage.eligible}；缺口 ${summaryCoverage.missing.length}。${snapshot.coverage.complete ? '当前模式已覆盖。' : '可在记忆工作台继续分析。'}` : '打开聊天后可以查看摘要覆盖。';
    memoryEnabled.checked = current.settings.modules.memory; autoSummary.checked = current.settings.memory.autoSummarize; autoSummary.disabled = !memoryEnabled.checked; batchLimit.value = String(current.settings.memory.maxMessagesPerRun);
    summaryCount.textContent = summaryCoverage ? `有效楼层 ${summaryCoverage.eligible} · 已摘 ${summaryCoverage.summarized} · 待补 ${summaryCoverage.missing.length}` : '打开聊天后查看楼层摘要。';
    const summaryItems = runtime.summaryItems().slice(-40).reverse();
    const nextSummarySignature = canonical(summaryItems);
    if (summarySignature !== nextSummarySignature) {
      summarySignature = nextSummarySignature; summaryList.replaceChildren();
      if (!summaryItems.length) summaryList.append(emptyState('暂无可摘要楼层', '打开聊天并同步正文后，楼层会出现在这里。'));
      for (const item of summaryItems) {
        const row = node('div', undefined, 'memory-core-summary-row'); const heading = node('div', undefined, 'memory-core-summary-heading');
        heading.append(node('strong', `第 ${item.index + 1} 楼 · ${item.role === 'user' ? '用户' : '角色'}`), node('span', item.summarized ? '已摘要' : '待补摘', 'memory-core-badge')); row.append(heading);
        const editor = node('textarea'); editor.value = item.text; editor.rows = 3; editor.placeholder = '在这里手写摘要，或先使用补摘任务'; editor.setAttribute('aria-label', `第 ${item.index + 1} 楼摘要`); row.append(editor);
        action('保存人工摘要', async () => { await runtime.saveSummary(item.messageId, editor.value); feedback.textContent = `第 ${item.index + 1} 楼摘要已保存。`; }, row, { icon: 'checkpoint' });
        summaryList.append(row);
      }
    }
    const history = snapshot.active ? runtime.getHistory({ after: Math.max(0, snapshot.revision - 4), limit: 4 }).reverse() : []; const nextTimelineSignature = canonical(history);
    if (timelineSignature !== nextTimelineSignature) {
      timelineSignature = nextTimelineSignature; timeline.replaceChildren();
      if (!history.length) { const item = node('li', undefined, 'memory-core-timeline-empty'); item.append(emptyState('故事还未开始', '打开一个聊天，让片段在这里留下轨迹。')); timeline.append(item); }
      for (const entry of history) {
        const item = node('li'); const marker = node('span', undefined, 'memory-core-timeline-marker'); marker.setAttribute('aria-hidden', 'true'); const copy = node('div'); const heading = node('div', undefined, 'memory-core-timeline-heading');
        const title = entry.kind === 'messages' ? '正文版本已同步' : ({ human: '人工事实已更新', model: '模型事实已更新', system: '系统事实已更新', import: '事实已导入' }[entry.origin] ?? '事实已更新'); const time = node('time', new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(entry.createdAt).toISOString(); heading.append(node('strong', title), time);
        copy.append(heading, node('p', `${entry.kind === 'messages' ? `${entry.messages.length} 条消息片段` : `${entry.ops.length} 项事实变更`} · 档案版本 ${entry.revision}`)); item.append(marker, copy); timeline.append(item);
      }
    }
    const nextRouteSignature = canonical([current.settings.channels, current.settings.routing.default]);
    if (routeSignature !== nextRouteSignature) {
      routeSignature = nextRouteSignature; route.replaceChildren();
      for (const channel of [{ id: 'main', name: '酒馆主 API' }, ...current.settings.channels]) { const option = node('option', channel.name); option.value = channel.id; route.append(option); } route.value = current.settings.routing.default;
    }
    const nextSummaryRouteSignature = canonical([current.settings.channels, current.settings.routing.summary ?? null, current.settings.routing.default]);
    if (summaryRouteSignature !== nextSummaryRouteSignature) {
      summaryRouteSignature = nextSummaryRouteSignature; summaryRoute.replaceChildren();
      for (const channel of [{ id: 'main', name: '酒馆主 API' }, ...current.settings.channels]) { const option = node('option', channel.name); option.value = channel.id; summaryRoute.append(option); }
      summaryRoute.value = current.settings.routing.summary ?? current.settings.routing.default;
    }
    const nextChannelsSignature = canonical(current.settings.channels.map(channel => ({ ...channel, hasCredential: runtime.vault.has(channel.id) })));
    if (channelsSignature !== nextChannelsSignature) {
      channelsSignature = nextChannelsSignature; channels.replaceChildren();
      if (!current.settings.channels.length) channels.append(emptyState('暂未添加独立渠道', '主 API 已可使用。需要时，在左侧或上方添加一个渠道。', 'connection'));
      for (const channel of current.settings.channels) {
        const row = node('div', undefined, 'memory-core-channel'); const heading = node('div', undefined, 'memory-core-channel-heading'); heading.append(node('strong', channel.name), node('span', runtime.vault.has(channel.id) ? '密钥已填' : '未填密钥', 'memory-core-badge')); row.append(heading, node('p', channel.model, 'memory-core-muted'));
        const credential = node('input'); credential.type = 'password'; credential.placeholder = '重新填写 Key'; credential.autocomplete = 'new-password'; credential.setAttribute('aria-label', `${channel.name} 的 API Key`); row.append(credential); const tools = node('div', undefined, 'memory-core-actions'); row.append(tools);
        action('设置密钥', () => { runtime.vault.set(channel.id, credential.value); credential.value = ''; feedback.textContent = '密钥已更新。'; }, tools, { icon: 'lock' });
        action('删除渠道', async () => {
          const config = runtime.settings.snapshot(); const removeRoutes = routes => Object.fromEntries(Object.entries(routes).map(([key, value]) => [key, value === channel.id ? 'main' : value]));
          await runtime.settings.update({ channels: config.channels.filter(item => item.id !== channel.id), routing: removeRoutes(config.routing), characterOverrides: Object.fromEntries(Object.entries(config.characterOverrides).map(([key, value]) => [key, removeRoutes(value)])), chatOverrides: Object.fromEntries(Object.entries(config.chatOverrides).map(([key, value]) => [key, removeRoutes(value)])) }); runtime.vault.set(channel.id, '');
        }, tools, { className: 'memory-core-danger' }); channels.append(row);
      }
    }
    taskList.replaceChildren(); if (!current.tasks.length) taskList.append(emptyState('此刻，一切安静', '后台任务出现时，会在这里显示进度。', 'activity'));
    for (const task of current.tasks.slice(-12)) { const row = node('div', undefined, 'memory-core-task'); row.append(node('strong', moduleNames[task.module] ?? task.module), node('span', taskNames[task.status] ?? task.status, 'memory-core-badge'), node('small', `尝试 ${task.attempt}${task.errorCode ? ` · ${task.errorCode}` : ''}`)); if (['queued', 'running', 'retrying'].includes(task.status)) action('取消', () => runtime.scheduler.cancel(task.id), row); taskList.append(row); }
    logs.textContent = runtime.logger.entries({ level: logFilter.value || undefined }).slice(-30).map(entry => `${new Date(entry.at).toLocaleTimeString()} [${entry.level}] ${entry.code} ${entry.message}`).join('\n') || '暂无日志';
    workbench.render();
  }
  const unsubscribe = runtime.subscribe(() => { clearTimeout(timer); timer = setTimeout(render, 80); }); let disposeEntries = () => {}; const dispose = attachShell(shell, () => { clearTimeout(timer); cancelModelLookup(); unsubscribe(); workbench.dispose(); disposeEntries(); }); disposeEntries = mountExtraEntries(runtime,shell.openButton); render(); return dispose;
}
