import { canonical, clone, CoreError, hash, id, requireThat, sleep } from '../core/util.js';
import { MESSAGE_KEY, STORAGE_KEY } from '../core/protocol.js';
import { SETTINGS_KEY } from '../core/settings.js';
import { scanEntries } from '../core/worldbook.js';

function eventRemoval(source) {
  if (typeof source?.removeListener === 'function') return source.removeListener.bind(source);
  if (typeof source?.off === 'function') return source.off.bind(source);
  return null;
}

export function classifyGeneration(type) {
  if (type === 'quiet') return 'internal';
  if (type === 'impersonate') return 'user';
  if (type === 'continue') return 'continue';
  if (type === 'swipe' || type === 'regenerate') return 'revision';
  return ['normal', '', undefined].includes(type) ? 'reply' : 'unknown';
}

export class SillyTavernHost {
  constructor(getContext = () => globalThis.SillyTavern?.getContext?.() ?? null) { this.getContext = getContext; }
  context() { try { return this.getContext(); } catch { return null; } }
  async ready(signal, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const context = this.context();
      if (typeof context?.eventSource?.on === 'function' && eventRemoval(context.eventSource) && Array.isArray(context.chat) && context.chatMetadata && context.extensionSettings) return context;
      await sleep(100, signal);
    }
    throw new CoreError('HOST_UNAVAILABLE', '等待酒馆运行接口超时，请检查酒馆是否加载完成后重试');
  }
  identity(context = this.context()) {
    const chatId = context?.getCurrentChatId?.();
    if (!chatId) return null;
    const groupId = context.groupId === '' ? null : context.groupId ?? null;
    const characterKey = groupId !== null ? `group:${groupId}` : `character:${context.characters?.[Number(context.characterId)]?.avatar ?? context.characterId ?? 'unknown'}`;
    return { chatId: String(chatId), groupId, characterKey, scopeKey: canonical([characterKey, String(chatId)]) };
  }
  capture() {
    const context = this.context(); const identity = this.identity(context);
    return identity ? { context, identity, chat: context.chat, metadata: context.chatMetadata } : null;
  }
  isCurrent(capture) {
    const context = this.context();
    return !!capture && context?.chat === capture.chat && context?.chatMetadata === capture.metadata && this.identity(context)?.scopeKey === capture.identity.scopeKey;
  }
  assertCurrent(capture) { requireThat(this.isCurrent(capture), 'STALE_SCOPE', '当前聊天已改变'); }
  signature(capture) {
    this.assertCurrent(capture);
    return canonical(capture.chat.map(message => [message[MESSAGE_KEY] ?? null, message.swipe_id ?? 0, message.is_user ?? false, message.is_system ?? false, message.extra?.type ?? null, message.mes ?? '']));
  }
  async messages(capture) {
    this.assertCurrent(capture);
    const seen = new Set(); const changes = [];
    let identitiesSaved = false;
    try {
      for (const message of capture.chat) {
        const previous = message[MESSAGE_KEY];
        if (typeof previous !== 'string' || previous.length > 512 || !previous.startsWith('message_') || seen.has(previous)) {
          message[MESSAGE_KEY] = id('message'); changes.push({ message, previous, assigned: message[MESSAGE_KEY] });
        }
        seen.add(message[MESSAGE_KEY]);
      }
      const signature = this.signature(capture);
      const result = await Promise.all(capture.chat.map(async (message, index) => {
        const role = message.is_user ? 'user' : message.is_system && message.extra?.type ? 'system' : 'assistant';
        const swipeId = message.swipe_id ?? 0;
        const contentHash = await hash({ text: message.mes ?? '', role });
        return { id: message[MESSAGE_KEY], versionId: `version_${swipeId}_${contentHash}`, contentHash, swipeId, role, index };
      }));
      this.assertCurrent(capture);
      requireThat(signature === this.signature(capture), 'SOURCE_CHANGED', '正文在读取时发生改变');
      if (changes.length) {
        requireThat(typeof capture.context.saveChat === 'function', 'HOST_CAPABILITY', '酒馆不支持保存稳定消息身份');
        try { await capture.context.saveChat(); }
        catch (error) { throw new CoreError('IDENTITY_SAVE_FAILED', '保存消息身份失败', { cause: error.message }); }
        identitiesSaved = true;
        this.assertCurrent(capture);
        requireThat(signature === this.signature(capture), 'SOURCE_CHANGED', '保存身份时正文发生改变');
      }
      return result;
    } catch (error) {
      if (!identitiesSaved) for (const change of changes) if (change.message[MESSAGE_KEY] === change.assigned) {
        if (change.previous === undefined) delete change.message[MESSAGE_KEY];
        else change.message[MESSAGE_KEY] = change.previous;
      }
      throw error;
    }
  }
  storage(capture) {
    return {
      key: capture.identity.scopeKey,
      load: async () => { this.assertCurrent(capture); return clone(capture.metadata[STORAGE_KEY] ?? null); },
      save: async (candidate, expectedRevision) => {
        this.assertCurrent(capture);
        const previous = capture.metadata[STORAGE_KEY];
        requireThat((previous?.revision ?? 0) === expectedRevision, 'REVISION_CONFLICT', '宿主事实库版本已改变');
        requireThat(typeof capture.context.saveMetadata === 'function', 'HOST_CAPABILITY', '酒馆不支持立即保存聊天数据');
        const installed = clone(candidate); capture.metadata[STORAGE_KEY] = installed;
        try { await capture.context.saveMetadata(); }
        catch (error) {
          if (capture.metadata[STORAGE_KEY] === installed) {
            if (previous === undefined) delete capture.metadata[STORAGE_KEY];
            else capture.metadata[STORAGE_KEY] = previous;
          }
          throw new CoreError('PERSIST_FAILED', '事实库保存失败', { cause: error.message });
        }
      },
    };
  }
  settingsStorage() {
    return {
      load: async () => clone(this.context()?.extensionSettings?.[SETTINGS_KEY] ?? null),
      save: async config => {
        const context = this.context();
        requireThat(context?.extensionSettings && typeof context.saveSettingsDebounced === 'function', 'HOST_CAPABILITY', '酒馆不支持保存扩展配置');
        context.extensionSettings[SETTINGS_KEY] = clone(config); context.saveSettingsDebounced();
      },
      backup: async raw => {
        const context = this.context();
        context.extensionSettings[`${SETTINGS_KEY}_migration_backup`] = clone(raw); context.saveSettingsDebounced?.();
      },
    };
  }
  setMemoryPrompt(text) {
    const context = this.context();
    if (typeof context?.setExtensionPrompt !== 'function') return false;
    context.setExtensionPrompt('st-memory-core', String(text), 1, 1, false, 0); return true;
  }
  async worldbookMaterials(config) {
    const context = this.context();
    const card = context?.characters?.[Number(context.characterId)];
    const names = new Set(config.books);
    if (config.bound) { if (card?.data?.extensions?.world || card?.world) names.add(card?.data?.extensions?.world || card.world); if (context.chatMetadata?.world_info) names.add(context.chatMetadata.world_info); }
    const settings = [{ id: 'character-card', origin: 'character-setting', text: [card?.description ?? card?.data?.description, card?.personality ?? card?.data?.personality, card?.scenario ?? card?.data?.scenario].filter(Boolean).join('\n') }, { id: 'persona', origin: 'user-setting', text: context?.powerUserSettings?.persona_description ?? '' }].filter(x => x.text);
    if (!config.enabled) return { materials: settings, entries: [], books: context?.getWorldInfoNames?.() ?? [], warnings: [], scanMode: 'disabled' };
    if (typeof context?.loadWorldInfo !== 'function') return { materials: settings, entries: [], books: [], warnings: ['宿主没有 loadWorldInfo，无法读取条目。请升级酒馆或关闭世界书读取。'], scanMode: 'unavailable' };
    const books = []; const warnings = [];
    for (const name of names) { const data = await context.loadWorldInfo(name); if (data) books.push({ name, data }); else warnings.push(`世界书「${name}」不存在或无法读取`); }
    const text = (context.chat ?? []).slice(-config.scanDepth).map(m => m.mes ?? '').join('\n');
    const result = scanEntries(books,config,text,value => typeof context.substituteParams === 'function' ? context.substituteParams(value) : value);
    return { ...result, warnings:[...warnings,...result.warnings,...(typeof context.substituteParams !== 'function' ? ['宿主没有模板宏接口，条目保留原文'] : [])], materials: [...settings,...result.materials], books: context.getWorldInfoNames?.() ?? [...names] };
  }
  async hideMessages(capture, allowedIds, restore = false) {
    this.assertCurrent(capture); const changes = [];
    for (const message of capture.chat) {
      if (!allowedIds.includes(message[MESSAGE_KEY])) continue;
      const marker = message.extra?.st_memory_core_hidden;
      if (restore) { if (marker?.owner === 'st-memory-core' && message.is_system === true) { changes.push({ message, previous: true, marker }); message.is_system = false; delete message.extra.st_memory_core_hidden; } }
      else if (!message.is_system) { message.extra ??= {}; changes.push({ message, previous: message.is_system ?? false, marker: null }); message.extra.st_memory_core_hidden = { owner: 'st-memory-core', version: message.swipe_id ?? 0 }; message.is_system = true; }
    }
    if (!changes.length) return 0;
    try { await capture.context.saveChat(); this.assertCurrent(capture); }
    catch (error) { for (const change of changes) { change.message.is_system = change.previous; if (change.marker) change.message.extra.st_memory_core_hidden = change.marker; else delete change.message.extra.st_memory_core_hidden; } throw error; }
    for (const change of changes) { const index = capture.chat.indexOf(change.message); globalThis.document?.querySelector(`.mes[mesid="${index}"]`)?.setAttribute('is_system',String(change.message.is_system)); if (typeof capture.context.updateMessageBlock === 'function') capture.context.updateMessageBlock(index,change.message,{rerenderMessage:false}); }
    if (capture.context.swipe?.refresh) capture.context.swipe.refresh(); else capture.context.refreshSwipeButtons?.();
    return changes.length;
  }
  bind(callback) {
    const context = this.context(); const types = context.eventTypes ?? context.event_types;
    const removeListener = eventRemoval(context.eventSource);
    requireThat(types && typeof context.eventSource?.on === 'function' && removeListener, 'HOST_CAPABILITY', '酒馆事件接口不完整');
    const bindings = [];
    for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED']) {
      if (!types[name]) continue;
      const listener = (...args) => callback(name, args);
      context.eventSource.on(types[name], listener); bindings.push([types[name], listener]);
    }
    return () => { for (const [event, listener] of bindings) removeListener(event, listener); };
  }
  capabilities() {
    const context = this.context();
    return { metadata: typeof context?.saveMetadata === 'function', messagePersistence: typeof context?.saveChat === 'function', mainApi: typeof context?.generateRaw === 'function', mainApiAbort: false, customApi: typeof context?.getRequestHeaders === 'function', promptInjection: typeof context?.setExtensionPrompt === 'function', generationBeforePrompt: !!(context?.eventTypes ?? context?.event_types)?.GENERATION_AFTER_COMMANDS, worldbookRead: typeof context?.loadWorldInfo === 'function', worldbookNames: typeof context?.getWorldInfoNames === 'function', macros: typeof context?.substituteParams === 'function', tools: context?.isToolCallingSupported?.() ?? false, mainApiSampling: 'host-settings', mainApiStreaming: false };
  }
}
