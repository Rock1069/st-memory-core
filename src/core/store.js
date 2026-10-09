import { Bus, canonical, clone, hash, id, Mutex, requireThat } from './util.js';
import { applyOperations, currentMessages, emptyDocument, project, validateChanges, validateDocument, validateMessages } from './protocol.js';

export class FactStore {
  #document;
  #mutex = new Mutex();
  #bus = new Bus();
  constructor(storage, { assertActive = () => {}, now = Date.now } = {}) {
    this.storage = storage;
    this.assertActive = assertActive;
    this.now = now;
  }
  async open() {
    const raw = await this.storage.load();
    this.assertActive();
    this.#document = raw ? validateDocument(raw) : emptyDocument(id('chat'), this.storage.key ?? 'memory');
    if (!raw) await this.#save(this.#document, 'initialize');
    if (this.storage.key && this.#document.scopeKey !== this.storage.key) {
      const ancestor = this.#document.storeId;
      this.#document = { ...this.#document, storeId: id('chat'), scopeKey: this.storage.key, forkedFrom: ancestor };
      await this.#save(this.#document, 'fork');
    }
    return this.snapshot();
  }
  get storeId() { return this.#document.storeId; }
  get revision() { return this.#document.revision; }
  subscribe(listener) { return this.#bus.subscribe(listener); }
  snapshot(revision = this.revision) { return clone(project(this.#document, revision)); }
  history({ after = 0, limit = 100 } = {}) {
    requireThat(Number.isInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'INVALID_QUERY', '历史查询参数无效');
    return clone(this.#document.journal.filter(entry => entry.revision > after).slice(0, limit));
  }
  document() { return clone(this.#document); }
  async #save(candidate, reason, guard = () => {}) {
    this.assertActive(); guard();
    await this.storage.save(clone(candidate), this.revision);
    this.#document = candidate;
    // If a chat switched while a save was in flight, publish neither a stale result nor a misleading success event.
    this.assertActive(); guard();
    this.#bus.emit({ type: 'store.changed', reason, storeId: this.storeId, revision: this.revision });
    return this.snapshot();
  }
  reconcile(messages, guard = () => {}) {
    return this.#mutex.run(async () => {
      this.assertActive(); guard(); validateMessages(messages);
      if (canonical(messages) === canonical(currentMessages(this.#document))) return this.snapshot();
      const candidate = this.document();
      candidate.journal.push({ id: id('event'), kind: 'messages', revision: ++candidate.revision, createdAt: this.now(), messages: clone(messages) });
      return this.#save(candidate, 'messages', guard);
    });
  }
  commit(request, guard = () => {}) {
    return this.#mutex.run(async () => {
      this.assertActive(); guard();
      const change = clone({ ...request, evidence: request.evidence ?? [], dependsOn: request.dependsOn ?? [] });
      validateChanges(change);
      const fingerprint = await hash({ origin: change.origin, ops: change.ops, evidence: change.evidence, dependsOn: change.dependsOn });
      this.assertActive(); guard();
      const previous = this.#document.journal.find(entry => entry.idempotencyKey === change.idempotencyKey);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应不同变更');
        return { duplicate: true, eventId: previous.id, snapshot: this.snapshot() };
      }
      requireThat(change.baseRevision === this.revision, 'REVISION_CONFLICT', '事实版本已改变，请重新读取');
      const active = new Map(currentMessages(this.#document).map(message => [message.id, message.versionId]));
      requireThat(change.evidence.every(ref => active.get(ref.messageId) === ref.versionId), 'SOURCE_INACTIVE', '正文依据已经改变或删除');
      const before = this.snapshot();
      requireThat(change.dependsOn.every(dependency => before.appliedEventIds.includes(dependency)), 'DEPENDENCY_INACTIVE', '依赖记录已失效');
      const event = { ...change, id: id('event'), kind: 'changes', fingerprint, revision: this.revision + 1, createdAt: this.now() };
      applyOperations(before.state, event);
      const candidate = this.document(); candidate.revision++; candidate.journal.push(event);
      const snapshot = await this.#save(candidate, 'commit', guard);
      return { duplicate: false, eventId: event.id, snapshot };
    });
  }
  checkpoint() {
    return this.#mutex.run(async () => {
      const candidate = this.document();
      const point = { id: id('checkpoint'), revision: this.revision, createdAt: this.now(), snapshot: this.snapshot() };
      candidate.checkpoints.push(point);
      await this.#save(candidate, 'checkpoint');
      return clone(point);
    });
  }
  async exportArchive(config) {
    const payload = { format: 'st-memory-core-archive', version: 1, createdAt: this.now(), document: this.document(), config: clone(config) };
    return { ...payload, checksum: await hash(payload) };
  }
  restore(archive) {
    return this.#mutex.run(async () => {
      this.assertActive();
      const raw = clone(archive); const { checksum, ...payload } = raw;
      requireThat(payload.format === 'st-memory-core-archive' && payload.version === 1 && await hash(payload) === checksum, 'INVALID_ARCHIVE', '备份格式或校验值无效');
      const candidate = validateDocument(payload.document);
      requireThat(candidate.storeId === this.storeId && candidate.scopeKey === this.#document.scopeKey, 'ARCHIVE_SCOPE', '此备份属于其他聊天；跨聊天导入将在迁移模块提供');
      requireThat(canonical(currentMessages(candidate)) === canonical(currentMessages(this.#document)), 'ARCHIVE_MESSAGES', '聊天正文版本与备份不一致，无法直接恢复');
      await this.#save(candidate, 'restore');
      return this.snapshot();
    });
  }
}
