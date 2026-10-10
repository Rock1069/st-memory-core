import { abortError, Bus, clone, CoreError, id, Mutex, requireThat } from './core/util.js';
import { FactStore } from './core/store.js';
import { Logger } from './core/logger.js';
import { AVAILABLE_MODULES, CredentialVault, Settings } from './core/settings.js';
import { TaskScheduler } from './core/scheduler.js';
import { ModelGateway } from './core/gateway.js';
import { classifyGeneration } from './host/sillytavern.js';
import { PLUGIN_VERSION } from './core/version.js';
import { cleanMessageText, summaryCandidates, summaryCoverage, summaryEntityId, summaryPrompt } from './core/memory.js';
import { P1Service } from './core/p1-service.js';

export class MemoryRuntime {
  #bus = new Bus();
  #sync = new Mutex();
  #epoch = 0;
  #unbind;
  #controller;
  #session;
  #autoRunning = false;
  #autoQueued = false;
  #generating = false;
  #unsubscribers = [];
  constructor(host) {
    this.host = host;
    this.logger = new Logger();
    this.settings = new Settings(host.settingsStorage());
    this.vault = new CredentialVault(this.logger);
    this.scheduler = new TaskScheduler({ moduleEnabled: module => this.settings.enabled(module) });
    this.gateway = new ModelGateway({ host, settings: this.settings, vault: this.vault, scheduler: this.scheduler, logger: this.logger });
    this.p1 = new P1Service(this);
  }
  subscribe(listener) { return this.#bus.subscribe(listener); }
  notify(event) { this.#bus.emit(event); }
  stopMemoryTasks() { this.#autoQueued = false; }
  sourceData() { this.capture(); return { chat: this.#session.capture.chat.map(message => ({ mes: String(message.mes ?? '') })) }; }
  async start() {
    if (this.#controller) return;
    this.#controller = new AbortController();
    const controller = this.#controller;
    const assertStarting = () => { abortError(controller.signal); requireThat(this.#controller === controller, 'RUNTIME_STOPPED', '底座启动已经取消'); };
    try {
      await this.host.ready(controller.signal); assertStarting();
      await this.settings.load();
      assertStarting();
      this.logger.logBodies = this.settings.snapshot().logBodies;
      this.#unsubscribers.push(this.settings.subscribe(() => {
        this.logger.logBodies = this.settings.snapshot().logBodies;
        this.scheduler.cancelWhere(task => !this.settings.enabled(task.module));
        this.#bus.emit({ type: 'settings.changed' });
        if (!this.settings.enabled('memory') && this.#session && this.host.hideMessages) void this.p1.hideCovered(true).catch(error => this.logger.error(error));
        void this.p1.refreshPrompt().catch(error => this.logger.error(error));
        this.#queueAutoSummary();
      }), this.scheduler.subscribe(event => this.#bus.emit(event)), this.logger.subscribe(event => this.#bus.emit(event)));
      this.#unbind = this.host.bind((name, args) => this.#event(name, args));
      await this.sync();
      assertStarting();
      this.logger.write('info', 'CORE_READY', '记忆底座已就绪');
    } catch (error) { this.logger.error(error); if (this.#controller === controller) this.stop(); throw error; }
  }
  stop() {
    this.p1.stop(); this.host.setMemoryPrompt?.('');
    const hiddenCapture = this.host.capture();
    if (hiddenCapture && this.host.hideMessages) void this.host.hideMessages(hiddenCapture,hiddenCapture.chat.map(m => m.st_memory_core_id),true).catch(error => this.logger.error(error));
    this.#epoch++; this.#controller?.abort(); this.#controller = null;
    this.#unbind?.(); this.#unbind = null;
    this.#session?.unsubscribe?.(); this.#session = null;
    this.scheduler.cancelWhere(() => true);
    this.#autoQueued = false;
    this.#unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
    this.vault.clear(); this.#bus.emit({ type: 'runtime.stopped' });
  }
  #event(name, args) {
    if (name === 'GENERATION_STARTED') {
      const type = classifyGeneration(args[0]);
      this.#bus.emit({ type: 'generation.started', generationType: type });
      if (type === 'internal' || type === 'user' || type === 'unknown') return;
      this.#generating = true;
      if (!this.host.capabilities().generationBeforePrompt) return this.p1.beforeGenerate().catch(error => { this.host.setMemoryPrompt?.(''); this.logger.error(error); });
    }
    if (name === 'GENERATION_AFTER_COMMANDS') {
      if (['internal','user','unknown'].includes(classifyGeneration(args[0])) || args[2]) return;
      return this.p1.beforeGenerate().catch(error => { this.host.setMemoryPrompt?.(''); this.logger.error(error); this.#bus.emit({ type: 'runtime.error', code: error.code ?? 'UNEXPECTED' }); });
    }
    if (name === 'GENERATION_ENDED') this.#generating = false;
    if (name === 'GENERATION_STOPPED') { this.#generating = false; this.p1.stop(); this.scheduler.cancelWhere(() => true); return; }
    // Invalidate synchronously before any await, even when a previous reconciliation is in flight.
    if (name === 'CHAT_CHANGED') {
      this.#epoch++; this.scheduler.cancelWhere(() => true);
      this.host.setMemoryPrompt?.(''); this.p1.lastBundle = null; this.p1.materials = { entries: [], materials: [], warnings: [], books: [], scanMode: 'unread' }; this.#generating = false;
      this.#session?.unsubscribe?.(); this.#session = null;
    }
    return this.sync().then(() => { if (name === 'GENERATION_ENDED') this.#queueAutoSummary(); }).catch(error => {
      this.logger.error(error); this.#bus.emit({ type: 'runtime.error', code: error.code ?? 'UNEXPECTED' });
    });
  }
  sync() {
    return this.#sync.run(async () => {
      abortError(this.#controller?.signal);
      requireThat(this.#controller, 'RUNTIME_STOPPED', '底座已停止');
      const capture = this.host.capture();
      if (!capture) {
        if (this.#session) { this.#epoch++; this.scheduler.cancelWhere(() => true); this.#session.unsubscribe?.(); this.#session = null; }
        this.#bus.emit({ type: 'chat.empty' }); return null;
      }
      if (!this.#session || !this.host.isCurrent(this.#session.capture)) {
        const epoch = ++this.#epoch;
        this.host.setMemoryPrompt?.(''); this.p1.lastBundle = null; this.p1.currentBundle = null; this.p1.materials = { entries: [], materials: [], warnings: [], books: [], scanMode: 'unread' };
        this.scheduler.cancelWhere(() => true); this.#session?.unsubscribe?.();
        const store = new FactStore(this.host.storage(capture), { assertActive: () => { requireThat(epoch === this.#epoch && this.#controller, 'STALE_SCOPE', '会话已失效'); this.host.assertCurrent(capture); } });
        await store.open();
        this.#session = { capture, store, epoch, unsubscribe: store.subscribe(event => this.#bus.emit(event)) };
      }
      const session = this.#session;
      const firstSync = session.signature === undefined;
      const previousRevision = session.store.revision;
      const messages = await this.host.messages(capture);
      requireThat(session === this.#session && session.epoch === this.#epoch, 'STALE_SCOPE', '消息同步已失效');
      const signature = this.host.signature(capture);
      let snapshot = await session.store.reconcile(messages, () => {
        requireThat(this.host.signature(capture) === signature, 'SOURCE_CHANGED', '正文在同步时发生改变');
      });
      session.signature = signature;
      const tagOps = this.p1.tagOperations(snapshot,session.capture.chat);
      if (tagOps.length) { await this.commit({ idempotencyKey: id('tag_rules'), origin: 'human', ops: tagOps },this.capture()); snapshot = session.store.snapshot(); }
      if (this.host.hideMessages) { const valid = new Set(summaryCandidates({...snapshot,active:true},capture.chat,this.settings.snapshot().memory).filter(s => s.summarized).map(s => s.messageId)); const restore = messages.filter(m => !this.settings.enabled('memory') || !valid.has(m.id)).map(m => m.id); await this.host.hideMessages(capture,restore,true); session.signature = this.host.signature(capture); }
      void this.p1.refreshPrompt().catch(error => this.logger.error(error));
      if (firstSync || previousRevision !== snapshot.revision) {
        this.#bus.emit({ type: 'chat.ready', storeId: session.store.storeId, revision: snapshot.revision });
        this.#queueAutoSummary();
      }
      return snapshot;
    });
  }
  capture() {
    const session = this.#session;
    requireThat(session && this.host.isCurrent(session.capture), 'CHAT_UNAVAILABLE', '请先打开一个聊天');
    const signature = this.host.signature(session.capture);
    requireThat(signature === session.signature, 'SOURCE_UNSYNCED', '正文已改变，请先完成消息同步');
    return { scope: `${session.capture.identity.scopeKey}:${session.store.storeId}:${session.epoch}`, epoch: session.epoch, baseRevision: session.store.revision, identity: clone(session.capture.identity), signature, storeId: session.store.storeId };
  }
  assertLease(lease) {
    const current = this.capture();
    requireThat(current.scope === lease.scope && current.signature === lease.signature && current.baseRevision === lease.baseRevision, 'STALE_SCOPE', '任务聊天、正文或事实版本已改变');
  }
  async commit(request, lease, signal) {
    abortError(signal); this.assertLease(lease);
    // Store validates its own revision; the post-save lease guard must not compare the just-advanced revision.
    const result = await this.#session.store.commit({ ...request, baseRevision: lease.baseRevision }, () => {
      abortError(signal);
      const current = this.capture();
      requireThat(current.scope === lease.scope && current.signature === lease.signature, 'STALE_SCOPE', '任务来源已经改变');
    });
    await this.p1.refreshPrompt().catch(error => this.logger.error(error)); return result;
  }
  getSnapshot({ revision } = {}) {
    const session = this.#session;
    if (!session || !this.host.isCurrent(session.capture)) return { active: false, coverage: { complete: false, reason: 'NO_CHAT' }, state: { entities: {}, locks: {} } };
    const snapshot = session.store.snapshot(revision ?? session.store.revision);
    const synchronized = session.signature === this.host.signature(session.capture);
    const historical = revision !== undefined && revision !== session.store.revision;
    const summary = historical || !synchronized ? null : summaryCoverage({ ...snapshot, active: true }, session.capture.chat,this.settings.snapshot().memory);
    const complete = !!summary && summary.missing.length === 0 && (this.settings.snapshot().memory.summaryOnly || summary.extracted === summary.eligible);
    return { active: true, storeId: session.store.storeId, scope: clone(session.capture.identity), ...snapshot, coverage: { complete, reason: historical ? 'HISTORICAL_REVISION' : !synchronized ? 'SOURCE_UNSYNCED' : complete ? 'COVERED' : summary.missing.length ? 'SUMMARY_GAPS' : 'EXTRACTION_GAPS', summary, inactiveEventCount: snapshot.skipped.length } };
  }
  #queueAutoSummary() {
    if (!this.#controller || !this.#session || this.#generating || !this.settings.enabled('memory') || !this.settings.snapshot().memory.autoSummarize || !this.p1.automaticReady()) return;
    this.#autoQueued = true;
    if (this.#autoRunning) return;
    this.#autoRunning = true;
    void Promise.resolve().then(async () => {
      while (this.#autoQueued) {
        this.#autoQueued = false;
        try { await this.p1.range({ limit: this.settings.snapshot().memory.maxMessagesPerRun }); }
        catch (error) { this.logger.error(error); this.#bus.emit({ type: 'runtime.error', code: error.code ?? 'UNEXPECTED' }); }
      }
    }).finally(() => { this.#autoRunning = false; if (this.#autoQueued) this.#queueAutoSummary(); });
  }
  async summarizeMissing({ limit = 20, newest = false } = {}) {
    requireThat(this.settings.enabled('memory'), 'MODULE_DISABLED', '请先开启故事记忆模块');
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_QUERY', '批量摘要上限无效');
    await this.sync();
    const selected = summaryCandidates(this.getSnapshot(), this.#session.capture.chat,this.settings.snapshot().memory).filter(item => !item.summarized);
    if (newest) selected.reverse();
    let completed = 0;
    for (const source of selected.slice(0, limit)) {
      const lease = this.capture();
      const current = this.getSnapshot().messages.find(message => message.id === source.messageId);
      requireThat(current?.versionId === source.versionId, 'SOURCE_CHANGED', '待摘要的正文版本已改变');
      const text = cleanMessageText(this.#session.capture.chat[source.index]?.mes);
      if (!text) continue;
      const config = this.settings.snapshot().memory;
      const response = await this.gateway.request({ task: 'summary', module: 'memory', key: `summary:${source.messageId}:${source.versionId}`, messages: summaryPrompt(source, text, config.prompt), lease, assertCurrent: () => this.assertLease(lease), maxTokens: config.maxTokens });
      const summary = response.trim();
      requireThat(summary.length > 0, 'EMPTY_SUMMARY', '模型返回了空摘要');
      await this.commit({ idempotencyKey: `summary:${source.messageId}:${source.versionId}:v1`, origin: 'model', evidence: [{ messageId: source.messageId, versionId: source.versionId }], ops: [{ type: 'create', entityId: summaryEntityId(source.messageId), entityKind: 'summary', name: `第 ${source.index + 1} 楼`, fields: { text: summary, sourceVersionId: source.versionId, sourceIndex: source.index, role: source.role, method: 'model' } }] }, lease);
      completed++;
    }
    return { completed, remaining: this.getSnapshot().coverage.summary.missing.length };
  }
  async saveSummary(messageId, text) {
    requireThat(typeof text === 'string' && text.trim().length > 0 && text.length <= 20000, 'INVALID_SUMMARY', '摘要正文不能为空或过长');
    await this.sync();
    const lease = this.capture();
    const source = summaryCandidates(this.getSnapshot(), this.#session.capture.chat,this.settings.snapshot().memory).find(item => item.messageId === messageId);
    requireThat(source, 'SOURCE_INACTIVE', '所选楼层已不存在或没有有效正文');
    const entityId = summaryEntityId(messageId);
    const existing = this.getSnapshot().state.entities[entityId];
    const ops = existing ? [
      { type: 'set', entityId, path: ['text'], value: text.trim() },
      { type: 'set', entityId, path: ['method'], value: 'human' },
      { type: 'lock', entityId, path: ['text'] },
    ] : [
      { type: 'create', entityId, entityKind: 'summary', name: `第 ${source.index + 1} 楼`, fields: { text: text.trim(), sourceVersionId: source.versionId, sourceIndex: source.index, role: source.role, method: 'human' } },
      { type: 'lock', entityId, path: ['text'] },
    ];
    return this.commit({ idempotencyKey: id('manual_summary'), origin: 'human', evidence: [{ messageId, versionId: source.versionId }], ops }, lease);
  }
  summaryItems() {
    const snapshot = this.getSnapshot();
    if (!snapshot.active || !snapshot.coverage.summary) return [];
    return summaryCandidates(snapshot, this.#session.capture.chat,this.settings.snapshot().memory).map(item => {
      const text = snapshot.state.entities[summaryEntityId(item.messageId)]?.fields?.text;
      return { ...item, text: typeof text === 'string' ? text : '' };
    });
  }
  getHistory(options) { return this.#session && this.host.isCurrent(this.#session.capture) ? this.#session.store.history(options) : []; }
  capabilities() {
    return { apiVersion: 1, pluginVersion: PLUGIN_VERSION, modules: [...AVAILABLE_MODULES], host: this.host.capabilities(), storage: { schemaVersion: 1, commitAtomicity: 'single-runtime-chat-metadata', multiDeviceCAS: false }, summaryExtraction: true, memoryExtraction: true, retrieval: false };
  }
  status() { return { capabilities: this.capabilities(), snapshot: this.getSnapshot(), tasks: this.scheduler.snapshot(), settings: this.settings.snapshot(), memory: this.p1.snapshot() }; }
  async checkpoint() { await this.sync(); this.capture(); return this.#session.store.checkpoint(); }
  async backup() { await this.sync(); this.capture(); return this.#session.store.exportArchive(this.settings.snapshot()); }
  async restore(archive) {
    await this.sync(); this.capture();
    this.scheduler.cancelWhere(() => true);
    const result = await this.#session.store.restore(archive);
    // Reopen creates a fresh lease epoch after restoring an older journal revision.
    this.#epoch++; this.#session.unsubscribe?.(); this.#session = null;
    await this.sync(); return result;
  }
  async testChannel(channelOverride = null) {
    await this.sync(); const lease = this.capture();
    return this.gateway.request({ key: id('diagnostic'), task: 'diagnostic', channelOverride, messages: [{ role: 'user', content: '请只回复 OK。' }], lease, assertCurrent: () => this.assertLease(lease), maxTokens: 32 });
  }
  publicApi() {
    return Object.freeze({ apiVersion: 1, pluginVersion: PLUGIN_VERSION, getCapabilities: () => clone(this.capabilities()), getSnapshot: options => clone(this.getSnapshot(options)), getHistory: options => clone(this.getHistory(options)), getSettings: () => this.settings.snapshot(), subscribe: listener => this.subscribe(listener) });
  }
}
