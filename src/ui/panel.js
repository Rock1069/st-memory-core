import { canonical, id } from '../core/util.js';
import { MODULES } from '../core/settings.js';
import { mountNavigation } from './navigation.js';
import { PLUGIN_VERSION } from '../core/version.js';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickJson() {
  return new Promise(resolve => {
    const input = node('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      try { resolve(JSON.parse(await input.files[0].text())); } catch { resolve(null); }
    }, { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true }); input.click();
  });
}

const moduleNames = { core: '底座', memory: '记忆管理 · P1', retrieval: '记忆检索 · P2', tables: '表格 · P3', rpg: 'RPG · P3', plot: '剧情规划 · P4', agent: 'Agent · P4', continuation: '智能续写 · P4', simulation: '世界推演 · P4' };
let activePanelDisposer;

function createShell() {
  const reopen = document.getElementById('st-memory-core-dialog')?.hasAttribute('open');
  activePanelDisposer?.();
  document.getElementById('st-memory-core-panel')?.remove();
  const panel = node('section', undefined, 'memory-core-panel'); panel.id = 'st-memory-core-panel';
  const drawer = node('details'); drawer.append(node('summary', '记忆中枢 · P0'));
  const body = node('div', undefined, 'memory-core-body'); drawer.append(body); panel.append(drawer);
  const openButton = node('button', '打开面板', 'menu_button memory-core-open-panel'); openButton.type = 'button';
  body.append(openButton);
  body.append(node('p', `插件版本 ${PLUGIN_VERSION}`, 'memory-core-muted'));
  return { panel, drawer, body, openButton, reopen };
}

function attachShell({ panel, drawer, openButton, reopen }, cleanup = () => {}) {
  const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
  if (target) target.append(panel);
  else { panel.classList.add('memory-core-floating'); document.body.append(panel); drawer.open = false; }
  const disposeNavigation = mountNavigation(panel, { drawer, openButton });
  if (reopen) openButton.click();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; cleanup(); disposeNavigation(); panel.remove();
    if (activePanelDisposer === dispose) activePanelDisposer = null;
  };
  activePanelDisposer = dispose;
  return dispose;
}

// Navigation is available even while the host is loading or core startup fails.
export function mountStartupPanel(retry) {
  const shell = createShell(); shell.panel.dataset.state = 'starting';
  const status = node('p', '正在等待酒馆加载并启动底座……'); status.setAttribute('role', 'status');
  const environment = node('p', `访问方式：${location.protocol} · 浏览器安全上下文：${globalThis.isSecureContext ? '是' : '否'}`, 'memory-core-muted');
  const errorText = node('p', '', 'memory-core-feedback'); errorText.setAttribute('role', 'alert');
  const retryButton = node('button', '重试启动', 'menu_button'); retryButton.type = 'button'; retryButton.hidden = true;
  retryButton.addEventListener('click', () => { retryButton.disabled = true; void retry(); });
  shell.body.append(status, environment, errorText, retryButton);
  const dispose = attachShell(shell);
  return {
    dispose,
    fail(code, message) {
      shell.panel.dataset.state = 'failed'; status.textContent = '底座启动失败';
      errorText.textContent = `${code}：${message}`; retryButton.hidden = false;
    },
  };
}

export function mountPanel(runtime) {
  const shell = createShell(); const { panel, body } = shell; panel.dataset.state = 'ready';
  const status = node('p'); const notice = node('p', '底座已加载。记忆提取、检索和 RPG 将在后续阶段接入。', 'memory-core-muted');
  const feedback = node('p', '', 'memory-core-feedback'); feedback.setAttribute('role', 'status');
  const enabledLabel = node('label'); const enabled = node('input'); enabled.type = 'checkbox'; enabledLabel.append(enabled, document.createTextNode(' 启用后台任务'));
  body.append(status, notice, enabledLabel);
  const modules = node('div', undefined, 'memory-core-modules');
  for (const module of Object.keys(MODULES)) modules.append(node('span', moduleNames[module], module === 'core' ? 'available' : 'planned'));
  body.append(modules);

  const action = (label, handler, target = body) => {
    const button = node('button', label, 'menu_button'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true; feedback.textContent = '';
      try { await handler(); }
      catch (error) { runtime.logger.error(error); feedback.textContent = runtime.logger.redact(error.message ?? String(error)); }
      finally { button.disabled = false; render(); }
    }); target.append(button); return button;
  };
  enabled.addEventListener('change', () => { void runtime.settings.update({ enabled: enabled.checked }).catch(error => { runtime.logger.error(error); render(); }); });
  const tools = node('div', undefined, 'memory-core-actions'); body.append(tools);
  action('刷新状态', () => runtime.sync(), tools);
  action('创建检查点', async () => { await runtime.checkpoint(); feedback.textContent = '检查点已保存。'; }, tools);
  action('导出备份', async () => download('memory-core-backup.json', await runtime.backup()), tools);
  action('恢复事实库', async () => {
    const backup = await pickJson();
    if (!backup) return;
    if (!globalThis.confirm('将当前聊天的事实库恢复到备份版本。原始正文保持当前状态；仅支持相同聊天、相同正文版本的备份。')) return;
    await runtime.restore(backup); feedback.textContent = '事实库已恢复。';
  }, tools);

  const api = node('details'); api.append(node('summary', 'API 渠道'));
  const apiBody = node('div', undefined, 'memory-core-body'); api.append(apiBody); body.append(api);
  const route = node('select'); route.setAttribute('aria-label', '默认 API 渠道'); apiBody.append(route);
  route.addEventListener('change', () => { const config = runtime.settings.snapshot(); void runtime.settings.update({ routing: { ...config.routing, default: route.value } }).catch(error => runtime.logger.error(error)); });
  const form = node('form', undefined, 'memory-core-form');
  const inputs = {};
  for (const [key, label, type] of [['name', '渠道名称', 'text'], ['endpoint', 'API 基础地址（含 /v1 等路径）', 'url'], ['model', '模型名称', 'text'], ['secret', 'API Key（仅本次会话保存）', 'password']]) {
    const wrapper = node('label', label); const input = node('input'); input.type = type; input.autocomplete = key === 'secret' ? 'new-password' : 'off';
    input.required = key !== 'secret'; wrapper.append(input); form.append(wrapper); inputs[key] = input;
  }
  const saveChannel = node('button', '添加渠道', 'menu_button'); saveChannel.type = 'submit'; form.append(saveChannel); apiBody.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); saveChannel.disabled = true;
    try {
      const channelId = id('channel'); const config = runtime.settings.snapshot();
      await runtime.settings.update({ channels: [...config.channels, { id: channelId, name: inputs.name.value.trim(), endpoint: inputs.endpoint.value.trim(), model: inputs.model.value.trim(), timeoutMs: 120000, retries: 2 }] });
      runtime.vault.set(channelId, inputs.secret.value); form.reset(); feedback.textContent = '渠道已添加，密钥仅在本次会话有效。';
    } catch (error) { runtime.logger.error(error); feedback.textContent = runtime.logger.redact(error.message); }
    finally { saveChannel.disabled = false; render(); }
  });
  const channels = node('div', undefined, 'memory-core-channel-list'); apiBody.append(channels);
  action('测试默认渠道', async () => { const result = await runtime.testChannel(); feedback.textContent = `渠道已返回：${runtime.logger.redact(result).slice(0, 120)}`; }, apiBody);
  apiBody.append(node('p', '点击测试会向选定模型发送一次“回复 OK”的请求。刷新后需重新填写独立渠道的密钥。', 'memory-core-muted'));

  const configTools = node('div', undefined, 'memory-core-actions'); body.append(configTools);
  action('导出配置', () => download('memory-core-settings.json', runtime.settings.snapshot()), configTools);
  action('导入配置', async () => {
    const config = await pickJson(); if (!config) return;
    await runtime.settings.update(config.config ?? config); feedback.textContent = '配置已导入，凭据需单独填写。';
  }, configTools);

  const taskList = node('div'); const tasksDrawer = node('details'); tasksDrawer.append(node('summary', '任务队列'), taskList); body.append(tasksDrawer);
  const logsDrawer = node('details'); logsDrawer.append(node('summary', '运行日志'));
  const logBody = node('div', undefined, 'memory-core-body'); logsDrawer.append(logBody); body.append(logsDrawer);
  const bodyLabel = node('label'); const logBodies = node('input'); logBodies.type = 'checkbox'; bodyLabel.append(logBodies, document.createTextNode(' 记录模型请求与回复正文'));
  logBodies.addEventListener('change', () => { void runtime.settings.update({ logBodies: logBodies.checked }).catch(error => runtime.logger.error(error)); });
  logBody.append(bodyLabel, node('p', '正文日志默认关闭；主动开启后，导出日志会包含聊天材料。', 'memory-core-muted'));
  const logFilter = node('select'); logFilter.setAttribute('aria-label', '日志等级');
  for (const [value, label] of [['', '所有等级'], ['info', '信息'], ['warn', '警告'], ['error', '错误']]) { const option = node('option', label); option.value = value; logFilter.append(option); }
  logBody.append(logFilter); logFilter.addEventListener('change', () => render());
  action('导出日志', () => download('memory-core-log.json', runtime.logger.entries({ level: logFilter.value || undefined })), logBody);
  action('清空日志', () => runtime.logger.clear(), logBody);
  const logs = node('pre'); logBody.append(logs); body.append(feedback);

  let timer; let channelsSignature;
  function render() {
    if (!panel.isConnected) return;
    const current = runtime.status(); const snapshot = current.snapshot;
    enabled.checked = current.settings.enabled; logBodies.checked = current.settings.logBodies;
    status.textContent = snapshot.active ? `当前聊天：${snapshot.scope.chatId} · 版本 ${snapshot.revision} · ${snapshot.messages.length} 条消息 · ${Object.keys(snapshot.state.entities).length} 个实体` : '请打开一个聊天以使用备份、检查点和 API 测试。';
    route.replaceChildren();
    for (const channel of [{ id: 'main', name: '酒馆主 API' }, ...current.settings.channels]) { const option = node('option', channel.name); option.value = channel.id; route.append(option); }
    route.value = current.settings.routing.default;
    const nextChannelsSignature = canonical(current.settings.channels.map(channel => ({ ...channel, hasCredential: runtime.vault.has(channel.id) })));
    if (channelsSignature !== nextChannelsSignature) {
      channelsSignature = nextChannelsSignature;
      channels.replaceChildren();
      for (const channel of current.settings.channels) {
        const row = node('div'); row.append(node('span', `${channel.name} · ${channel.model} · ${runtime.vault.has(channel.id) ? '密钥已填' : '未填密钥'}`));
        const credential = node('input'); credential.type = 'password'; credential.placeholder = '重新填写 Key'; credential.autocomplete = 'new-password'; credential.setAttribute('aria-label', `${channel.name} 的 API Key`);
        row.append(credential);
        action('设置密钥', () => { runtime.vault.set(channel.id, credential.value); credential.value = ''; feedback.textContent = '密钥已更新。'; }, row);
        action('删除渠道', async () => {
          const config = runtime.settings.snapshot();
          const removeRoutes = routes => Object.fromEntries(Object.entries(routes).map(([key, value]) => [key, value === channel.id ? 'main' : value]));
          await runtime.settings.update({ channels: config.channels.filter(item => item.id !== channel.id), routing: removeRoutes(config.routing), characterOverrides: Object.fromEntries(Object.entries(config.characterOverrides).map(([key, value]) => [key, removeRoutes(value)])), chatOverrides: Object.fromEntries(Object.entries(config.chatOverrides).map(([key, value]) => [key, removeRoutes(value)])) });
          runtime.vault.set(channel.id, '');
        }, row); channels.append(row);
      }
    }
    taskList.replaceChildren();
    for (const task of current.tasks.slice(-12)) {
      const row = node('div', `${task.module} · ${task.status} · 尝试 ${task.attempt}`);
      if (['queued', 'running', 'retrying'].includes(task.status)) action('取消', () => runtime.scheduler.cancel(task.id), row);
      taskList.append(row);
    }
    logs.textContent = runtime.logger.entries({ level: logFilter.value || undefined }).slice(-30).map(entry => `${new Date(entry.at).toLocaleTimeString()} [${entry.level}] ${entry.code} ${entry.message}`).join('\n') || '暂无日志';
  }
  const unsubscribe = runtime.subscribe(() => { clearTimeout(timer); timer = setTimeout(render, 80); });
  const dispose = attachShell(shell, () => { clearTimeout(timer); unsubscribe(); });
  render();
  return dispose;
}
