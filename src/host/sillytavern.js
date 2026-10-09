import { canonical, clone, CoreError, hash, id, requireThat, sleep } from '../core/util.js';
import { MESSAGE_KEY, STORAGE_KEY } from '../core/protocol.js';
import { SETTINGS_KEY } from '../core/settings.js';

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
      if (context?.eventSource?.on && context.eventSource.off && Array.isArray(context.chat) && context.chatMetadata && context.extensionSettings) return context;
      await sleep(100, signal);
    }
    throw new CoreError('HOST_UNAVAILABLE', '等待酒馆运行接口超时，请刷新后重试');
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
  bind(callback) {
    const context = this.context(); const types = context.eventTypes ?? context.event_types;
    requireThat(types && context.eventSource?.off, 'HOST_CAPABILITY', '酒馆事件接口不完整');
    const bindings = [];
    for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED']) {
      if (!types[name]) continue;
      const listener = (...args) => callback(name, args);
      context.eventSource.on(types[name], listener); bindings.push([types[name], listener]);
    }
    return () => { for (const [event, listener] of bindings) context.eventSource.off(event, listener); };
  }
  capabilities() {
    const context = this.context();
    return { metadata: typeof context?.saveMetadata === 'function', messagePersistence: typeof context?.saveChat === 'function', mainApi: typeof context?.generateRaw === 'function', mainApiAbort: false, customApi: typeof context?.getRequestHeaders === 'function', promptInjection: typeof context?.setExtensionPrompt === 'function' };
  }
}
