import { Bus, clone, Mutex, requireThat, textId } from './util.js';
import { normalizeP1, p1Defaults } from './p1-config.js';

export const SETTINGS_KEY = 'st_memory_core';
export const MODULES = Object.freeze({ core: true, memory: false, retrieval: false, tables: false, rpg: false, plot: false, agent: false, continuation: false, simulation: false });
export const AVAILABLE_MODULES = Object.freeze(['core', 'memory']);
export function defaults() {
  return { schemaVersion: 1, enabled: true, logBodies: false, modules: { ...MODULES }, ...p1Defaults(), channels: [], routing: { default: 'main' }, characterOverrides: {}, chatOverrides: {} };
}
export function validateSettings(raw) {
  const config = clone(raw);
  requireThat(config && typeof config === 'object' && !Array.isArray(config), 'INVALID_SETTINGS', '配置必须为对象');
  const allowed = Object.keys(defaults());
  requireThat(Object.keys(config).every(key => allowed.includes(key)), 'INVALID_SETTINGS', '配置包含未知字段');
  requireThat(config.schemaVersion === 1, 'SETTINGS_VERSION', '不支持此配置版本');
  requireThat(typeof config.enabled === 'boolean' && typeof config.logBodies === 'boolean', 'INVALID_SETTINGS', '开关值无效');
  requireThat(config.modules && !Array.isArray(config.modules) && Object.keys(config.modules).every(module => Object.hasOwn(MODULES, module)) && Object.keys(MODULES).every(module => typeof config.modules[module] === 'boolean') && config.modules.core, 'INVALID_SETTINGS', '模块开关无效');
  normalizeP1(config);
  requireThat(Array.isArray(config.channels) && config.channels.length <= 50, 'INVALID_SETTINGS', '渠道列表无效');
  const channelIds = new Set(['main']);
  for (const channel of config.channels) {
    requireThat(channel && typeof channel === 'object' && !Array.isArray(channel), 'INVALID_SETTINGS', '渠道配置必须为对象');
    requireThat(Object.keys(channel).every(key => ['id', 'name', 'model', 'endpoint', 'timeoutMs', 'retries','temperature','maxTokens','stream','omitParameters'].includes(key)), 'SECRET_IN_CONFIG', '渠道配置包含未知字段或凭据');
    textId(channel.id); textId(channel.name); textId(channel.model);
    requireThat(!channelIds.has(channel.id), 'INVALID_SETTINGS', '渠道 ID 重复'); channelIds.add(channel.id);
    let url;
    try { url = new URL(channel.endpoint); } catch { requireThat(false, 'INVALID_SETTINGS', 'API 地址无效'); }
    requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'INVALID_SETTINGS', '端点必须为无内嵌凭据的 HTTP 地址');
    requireThat(Number.isFinite(channel.timeoutMs) && channel.timeoutMs >= 1000 && channel.timeoutMs <= 600000 && Number.isInteger(channel.retries) && channel.retries >= 0 && channel.retries <= 5, 'INVALID_SETTINGS', '渠道超时或重试参数无效');
    requireThat(!Object.hasOwn(channel, 'key') && !Object.hasOwn(channel, 'apiKey'), 'SECRET_IN_CONFIG', '凭据不能写入共享配置');
    if (channel.temperature !== undefined) requireThat(Number.isFinite(channel.temperature) && channel.temperature >= 0 && channel.temperature <= 2, 'INVALID_SETTINGS', '温度须为 0–2');
    if (channel.maxTokens !== undefined) requireThat(Number.isInteger(channel.maxTokens) && channel.maxTokens >= 1 && channel.maxTokens <= 100000, 'INVALID_SETTINGS', '渠道输出限制无效');
    if (channel.stream !== undefined) requireThat(typeof channel.stream === 'boolean', 'INVALID_SETTINGS', '流式开关无效');
    if (channel.omitParameters !== undefined) requireThat(Array.isArray(channel.omitParameters) && channel.omitParameters.every(key => ['temperature','max_tokens','stream'].includes(key)), 'INVALID_SETTINGS', '排除参数无效');
  }
  for (const overrides of [config.characterOverrides, config.chatOverrides]) requireThat(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'INVALID_SETTINGS', '覆盖配置必须为对象');
  requireThat(config.routing && channelIds.has(config.routing.default), 'CHANNEL_MISSING', '缺少有效的默认渠道');
  for (const layer of [config.routing, ...Object.values(config.characterOverrides), ...Object.values(config.chatOverrides)]) {
    requireThat(layer && typeof layer === 'object' && !Array.isArray(layer), 'INVALID_SETTINGS', '配置作用域无效');
    for (const channelId of Object.values(layer)) requireThat(channelIds.has(channelId), 'CHANNEL_MISSING', '路由引用了不存在的渠道');
  }
  return config;
}

export class Settings {
  #value;
  #bus = new Bus();
  #mutex = new Mutex();
  constructor(storage) { this.storage = storage; }
  async load() {
    const raw = await this.storage.load();
    if (!raw) this.#value = defaults();
    else if (raw.schemaVersion === 0) {
      // Only this explicitly defined legacy format is supported, with a preserved recovery copy.
      await this.storage.backup?.(clone(raw));
      this.#value = validateSettings({ ...defaults(), enabled: raw.enabled ?? true });
      await this.storage.save(clone(this.#value));
    } else this.#value = validateSettings(raw);
    return this.snapshot();
  }
  snapshot() { return clone(this.#value); }
  enabled(module) { return this.#value.enabled && AVAILABLE_MODULES.includes(module) && this.#value.modules[module]; }
  subscribe(listener) { return this.#bus.subscribe(listener); }
  update(patch) {
    return this.#mutex.run(async () => {
      const candidate = validateSettings({ ...this.#value, ...clone(patch) });
      await this.storage.save(clone(candidate)); this.#value = candidate;
      this.#bus.emit({ type: 'settings.changed' });
      return this.snapshot();
    });
  }
  route(task, { characterKey = '', chatKey = '', scopeKey = '' } = {}) {
    chatKey ||= scopeKey;
    return this.#value.chatOverrides[chatKey]?.[task] ?? this.#value.characterOverrides[characterKey]?.[task] ?? this.#value.routing[task] ?? this.#value.routing.default;
  }
  channel(channelId) {
    if (channelId === 'main') return { id: 'main', name: '酒馆主 API', timeoutMs: 120000, retries: 0 };
    const channel = this.#value.channels.find(item => item.id === channelId);
    requireThat(channel, 'CHANNEL_MISSING', 'API 渠道不存在');
    return clone(channel);
  }
}

export class CredentialVault {
  #values = new Map();
  constructor(logger) { this.logger = logger; }
  set(channelId, secret) { textId(channelId); this.#values.set(channelId, String(secret)); this.logger?.registerSecret(secret); }
  get(channelId) { return this.#values.get(channelId) ?? ''; }
  clear() { this.#values.clear(); }
  has(channelId) { return this.#values.has(channelId) && this.#values.get(channelId).length > 0; }
}
