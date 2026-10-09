import { abortError, Bus, clone, CoreError, id, Mutex, requireThat } from './core/util.js';
import { FactStore } from './core/store.js';
import { Logger } from './core/logger.js';
import { AVAILABLE_MODULES, CredentialVault, Settings } from './core/settings.js';
import { TaskScheduler } from './core/scheduler.js';
import { ModelGateway } from './core/gateway.js';
import { classifyGeneration } from './host/sillytavern.js';

export class MemoryRuntime {
  #bus = new Bus();
  #sync = new Mutex();
  #epoch = 0;
  #unbind;
  #controller;
  #session;
  #unsubscribers = [];
  constructor(host) {
    this.host = host;
    this.logger = new Logger();
    this.settings = new Settings(host.settingsStorage());
    this.vault = new CredentialVault(this.logger);
    this.scheduler = new TaskScheduler({ moduleEnabled: module => this.settings.enabled(module) });
    this.gateway = new ModelGateway({ host, settings: this.settings, vault: this.vault, scheduler: this.scheduler, logger: this.logger });
  }
  subscribe(listener) { return this.#bus.subscribe(listener); }
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
      }), this.scheduler.subscribe(event => this.#bus.emit(event)), this.logger.subscribe(event => this.#bus.emit(event)));
      this.#unbind = this.host.bind((name, args) => this.#event(name, args));
      await this.sync();
      assertStarting();
      this.logger.write('info', 'CORE_READY', '记忆底座已就绪');
    } catch (error) { this.logger.error(error); if (this.#controller === controller) this.stop(); throw error; }
  }
  stop() {
    this.#epoch++; this.#controller?.abort(); this.#controller = null;
    this.#unbind?.(); this.#unbind = null;
    this.#session?.unsubscribe?.(); this.#session = null;
    this.scheduler.cancelWhere(() => true);
    this.#unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
    this.vault.clear(); this.#bus.emit({ type: 'runtime.stopped' });
  }
  #event(name, args) {
    if (name === 'GENERATION_STARTED') {
      const type = classifyGeneration(args[0]);
      this.#bus.emit({ type: 'generation.started', generationType: type });
      if (type === 'internal' || type === 'user' || type === 'unknown') return;
    }
    if (name === 'GENERATION_STOPPED') { this.scheduler.cancelWhere(() => true); return; }
    // Invalidate synchronously before any await, even when a previous reconciliation is in flight.
    if (name === 'CHAT_CHANGED') {
      this.#epoch++; this.scheduler.cancelWhere(() => true);
      this.#session?.unsubscribe?.(); this.#session = null;
    }
    void this.sync().catch(error => {
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
      const snapshot = await session.store.reconcile(messages, () => {
        requireThat(this.host.signature(capture) === signature, 'SOURCE_CHANGED', '正文在同步时发生改变');
      });
      session.signature = signature;
      if (firstSync || previousRevision !== snapshot.revision) this.#bus.emit({ type: 'chat.ready', storeId: session.store.storeId, revision: snapshot.revision });
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
    return this.#session.store.commit({ ...request, baseRevision: lease.baseRevision }, () => {
      abortError(signal);
      const current = this.capture();
      requireThat(current.scope === lease.scope && current.signature === lease.signature, 'STALE_SCOPE', '任务来源已经改变');
    });
  }
  getSnapshot({ revision } = {}) {
    const session = this.#session;
    if (!session || !this.host.isCurrent(session.capture)) return { active: false, coverage: { complete: false, reason: 'NO_CHAT' }, state: { entities: {}, locks: {} } };
    const snapshot = session.store.snapshot(revision ?? session.store.revision);
    const synchronized = session.signature === this.host.signature(session.capture);
    return { active: true, storeId: session.store.storeId, scope: clone(session.capture.identity), ...snapshot, coverage: { complete: false, reason: synchronized ? 'P0_NO_MEMORY_EXTRACTION' : 'SOURCE_UNSYNCED', inactiveEventCount: snapshot.skipped.length } };
  }
  getHistory(options) { return this.#session && this.host.isCurrent(this.#session.capture) ? this.#session.store.history(options) : []; }
  capabilities() {
    return { apiVersion: 1, pluginVersion: '0.1.0', modules: [...AVAILABLE_MODULES], host: this.host.capabilities(), storage: { schemaVersion: 1, commitAtomicity: 'single-runtime-chat-metadata', multiDeviceCAS: false }, memoryExtraction: false, retrieval: false };
  }
  status() { return { capabilities: this.capabilities(), snapshot: this.getSnapshot(), tasks: this.scheduler.snapshot(), settings: this.settings.snapshot() }; }
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
  async testChannel() {
    await this.sync(); const lease = this.capture();
    return this.gateway.request({ key: id('diagnostic'), task: 'diagnostic', messages: [{ role: 'user', content: '请只回复 OK。' }], lease, assertCurrent: () => this.assertLease(lease), maxTokens: 32 });
  }
  publicApi() {
    return Object.freeze({ apiVersion: 1, pluginVersion: '0.1.0', getCapabilities: () => clone(this.capabilities()), getSnapshot: options => clone(this.getSnapshot(options)), getHistory: options => clone(this.getHistory(options)), getSettings: () => this.settings.snapshot(), subscribe: listener => this.subscribe(listener) });
  }
}
