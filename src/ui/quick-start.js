import { canonical } from '../core/util.js';
import { enableSimpleMemory, fillMemoryHistory, pauseSimpleMemory, selectMemoryChannel } from '../core/simple-memory.js';
import { icon } from './icons.js';

const node = (tag, text, className) => { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; };

export function mountQuickStart(container, runtime, { onConnect, onView, onAdvanced, report }) {
  const card = node('section', undefined, 'memory-core-card memory-core-quick-start');
  const heading = node('div', undefined, 'memory-core-quick-heading'); const copy = node('div');
  copy.append(node('h3', '开启记忆，继续聊天'), node('p', '选好 API，点一次开启。后续自动整理、保存，回复时自动带上记忆。', 'memory-core-muted'));
  const badge = node('span', '尚未开启', 'memory-core-badge'); heading.append(copy, badge); card.append(heading);
  const chat = node('p', undefined, 'memory-core-muted'); card.append(chat);
  const connection = node('div', undefined, 'memory-core-quick-connection'); const field = node('label', '记忆使用的 API', 'memory-core-field');
  const channel = node('select'); channel.setAttribute('aria-label', '记忆使用的 API'); field.append(channel); connection.append(field);
  const button = (parent, label, iconName, handler, primary = false) => {
    const result = node('button', undefined, `menu_button memory-core-button${primary ? ' memory-core-primary' : ''}`); result.type = 'button';
    if (iconName) result.append(icon(iconName)); result.append(node('span', label)); parent.append(result);
    result.addEventListener('click', async () => { result.disabled = true; try { await handler(); } catch (error) { runtime.logger.error(error); report(runtime.logger.redact(error.message), true); } finally { result.disabled = false; render(); } }); return result;
  };
  button(connection, '连接独立 API', 'connection', onConnect); card.append(connection);
  channel.addEventListener('change', async () => { channel.disabled = true; try { await selectMemoryChannel(runtime, channel.value); } catch (error) { runtime.logger.error(error); report(error.message, true); } finally { render(); } });
  const controls = node('div', undefined, 'memory-core-quick-controls'); card.append(controls);
  const toggle = button(controls, '开启自动记忆', 'spark', async () => {
    const config = runtime.settings.snapshot();
    if (config.enabled && config.modules.memory && config.memory.autoSummarize) { await pauseSimpleMemory(runtime); report('自动整理已暂停，已有记忆继续用于回复。'); }
    else { await enableSimpleMemory(runtime, channel.value); report('自动记忆已开启。现在可以继续聊天，结果会自动保存。'); }
  }, true);
  const fill = button(controls, '补齐历史记忆', 'refresh', async () => {
    const result = await fillMemoryHistory(runtime); const summary = runtime.getSnapshot().coverage.summary;
    const config = runtime.settings.snapshot(); const remaining = runtime.p1.candidates().filter(item => !item.imported && (!item.summarized || !config.memory.summaryOnly && !item.extracted)).length;
    report(remaining ? `已整理 ${result.completed} 楼，剩余 ${remaining} 楼可继续补齐。` : `历史记忆已补齐，共记住 ${summary?.summarized ?? 0} 楼。`);
  });
  const stop = button(controls, '停止整理', 'close', () => { runtime.p1.stop(); report('整理已停止，已保存的记忆保留。'); }); stop.hidden = true;
  const notice = node('p', '开启后会调用所选 API，并直接保存整理结果。', 'memory-core-muted'); card.append(notice);
  const status = node('p', '', 'memory-core-quick-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); card.append(status);
  const totals = node('div', undefined, 'memory-core-quick-totals'); const metrics = {};
  for (const [key, label] of [['summaries', '已记住的楼层'], ['characters', '人物'], ['items', '物品']]) { const tile = node('div'); metrics[key] = node('strong', '0'); tile.append(metrics[key], node('span', label)); totals.append(tile); } card.append(totals);
  const tools = node('div', undefined, 'memory-core-quick-links'); card.append(tools);
  button(tools, '查看记忆', 'book', onView); button(tools, '高级设置', 'settings', onAdvanced);
  const recent = node('div', undefined, 'memory-core-quick-recent'); card.append(recent); container.prepend(card);
  let channelSignature; let recentSignature;
  function render() {
    const config = runtime.settings.snapshot(); const snapshot = runtime.getSnapshot(); const progress = runtime.p1.progress;
    const automatic = config.enabled && config.modules.memory && config.memory.autoSummarize;
    const memoryEnabled = config.enabled && config.modules.memory;
    const busy = progress.status === 'running' || runtime.scheduler.snapshot().some(task => task.module === 'memory' && ['queued', 'running', 'retrying'].includes(task.status));
    const routes = ['summary', 'extraction', 'compression'].map(task => runtime.settings.route(task, snapshot.scope));
    const signature = canonical([config.channels, routes]);
    if (channelSignature !== signature) {
      channelSignature = signature; channel.replaceChildren();
      for (const entry of [{ id: 'main', name: '跟随酒馆主 API（推荐）' }, ...config.channels]) { const option = node('option', entry.name); option.value = entry.id; channel.append(option); }
      channel.value = routes[1];
    }
    channel.disabled = busy; chat.textContent = snapshot.active ? `当前聊天：${snapshot.scope.chatId}` : '先在酒馆打开一个聊天。';
    toggle.querySelector('span').textContent = automatic ? '暂停自动记忆' : '开启自动记忆'; toggle.disabled = !snapshot.active || !automatic && busy;
    fill.disabled = !snapshot.active || !config.enabled || !config.modules.memory || busy;
    stop.hidden = !busy;
    badge.textContent = automatic ? '自动记忆已开启' : memoryEnabled ? '自动整理已暂停' : '尚未开启';
    const entities = Object.values(snapshot.state.entities); const summary = snapshot.coverage.summary;
    metrics.summaries.textContent = String(summary?.summarized ?? 0); metrics.characters.textContent = String(entities.filter(entity => entity.kind === 'character').length); metrics.items.textContent = String(entities.filter(entity => entity.kind === 'item').length);
    let scope; try { scope = runtime.capture().scope; } catch { scope = null; }
    const currentProgress = progress.scope === scope;
    delete status.dataset.tone;
    if (!snapshot.active) status.textContent = '打开聊天后，选择 API 并点击「开启自动记忆」。';
    else if (busy) status.textContent = currentProgress ? `${progress.formatRetry ? '模型输出格式不合格，正在自动重试一次' : '正在整理记忆'} · ${progress.completed}/${progress.total} 楼。可点击「停止整理」，已保存的结果会保留。` : '正在结束上一项记忆任务…';
    else if (currentProgress && progress.status === 'failed') {
      status.dataset.tone = 'error';
      const hint = ['EXTRACTION_JSON', 'EXTRACTION_CONTRACT'].includes(progress.errorCode) ? '已保存的记忆保留。点击「补齐历史记忆」可重试；若反复失败，可在高级设置提高输出上限或更换记忆模型。' : '已保存的记忆保留。处理上述问题后，点击「补齐历史记忆」重试。';
      status.textContent = runtime.logger.redact(`整理失败：${progress.error}。${hint}`);
    }
    else if (entities.some(entity => entity.kind === 'draft' && entity.fields.status === 'pending')) status.textContent = '有之前留下的待审阅结果，可在高级设置的「分析与审阅」中确认。';
    else if (!memoryEnabled) status.textContent = '直接跟随酒馆主 API，再点击「开启自动记忆」。';
    else if (!automatic) status.textContent = '自动整理已暂停。点击开启后恢复，已有记忆仍用于回复。';
    else if (!config.prompt.enabled) status.textContent = '自动整理已开启；回复中的记忆注入已在高级设置关闭。';
    else if (summary && !snapshot.coverage.complete) status.textContent = '自动记忆已开启；旧聊天还可点击「补齐历史记忆」，一次整理已有缺口。';
    else status.textContent = '记忆已跟上当前聊天。继续聊天即可自动更新。';
    notice.textContent = `开启后会调用所选 API，并直接保存整理结果。${routes.some(route => route !== routes[1]) ? '摘要、提取和压缩将统一使用这里选的 API。' : ''}`;
    const items = runtime.summaryItems().filter(item => item.summarized).slice(-3).reverse(); const nextRecent = canonical(items);
    if (recentSignature !== nextRecent) { recentSignature = nextRecent; recent.replaceChildren(); if (items.length) recent.append(node('h4', '最近记住的内容')); for (const item of items) { const row = node('details'); row.append(node('summary', `第 ${item.index + 1} 楼 · ${item.text.slice(0, 45)}${item.text.length > 45 ? '…' : ''}`), node('p', item.text)); recent.append(row); } }
  }
  return { render };
}
