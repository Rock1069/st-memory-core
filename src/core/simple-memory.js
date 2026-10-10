import { requireThat } from './util.js';

const tasks = ['summary', 'extraction', 'compression'];

function channelPatch(config, channelId, identity = {}) {
  const routes = Object.fromEntries(tasks.map(task => [task, channelId]));
  const patch = { routing: { ...config.routing, ...routes } };
  // An explicit choice on the home page must also take effect in this chat.
  for (const [section, key] of [['characterOverrides', identity.characterKey], ['chatOverrides', identity.scopeKey]]) {
    if (key && config[section][key]) patch[section] = { ...config[section], [key]: { ...config[section][key], ...routes } };
  }
  return patch;
}

export async function selectMemoryChannel(runtime, channelId, extra = {}) {
  if (!extra.channels?.some(channel => channel.id === channelId)) runtime.settings.channel(channelId);
  const config = runtime.settings.snapshot();
  return runtime.settings.update({ ...extra, ...channelPatch(config, channelId, runtime.getSnapshot().scope) });
}

export async function enableSimpleMemory(runtime, channelId) {
  await runtime.sync();
  requireThat(runtime.getSnapshot().active, 'CHAT_UNAVAILABLE', '请先打开一个聊天，再开启自动记忆');
  runtime.settings.channel(channelId);
  const capabilities = runtime.host.capabilities();
  requireThat(channelId === 'main' ? capabilities.mainApi : capabilities.customApi, 'API_UNAVAILABLE', '当前 API 未就绪，请先连接 API');
  const config = runtime.settings.snapshot();
  return runtime.settings.update({
    ...channelPatch(config, channelId, runtime.getSnapshot().scope), enabled: true,
    modules: { ...config.modules, memory: true },
    memory: { ...config.memory, autoSummarize: true, requireReview: false, autoCompress: true, floorThreshold: 1, tokenThreshold: 0 },
    prompt: { ...config.prompt, enabled: true }, ui: { ...config.ui, mode: 'light' },
  });
}

export async function pauseSimpleMemory(runtime) {
  const config = runtime.settings.snapshot();
  await runtime.settings.update({ memory: { ...config.memory, autoSummarize: false } });
  runtime.p1.stop();
}

export async function fillMemoryHistory(runtime) {
  requireThat(runtime.settings.enabled('memory'), 'MODULE_DISABLED', '请先开启自动记忆，再补齐历史记忆');
  requireThat(runtime.p1.progress.status !== 'running', 'MEMORY_BUSY', '正在整理记忆，请等待完成或先暂停');
  return runtime.p1.range({ limit: 1000, missingOnly: true, review: false });
}
