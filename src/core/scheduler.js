import { abortError, Bus, clone, CoreError, id, requireThat, sleep } from './util.js';

export class TaskScheduler {
  #tasks = new Map();
  #active = 0;
  #bus = new Bus();
  constructor({ concurrency = 2, moduleEnabled = () => true } = {}) {
    requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, 'INVALID_CONCURRENCY', '并发数必须为 1–8');
    this.concurrency = concurrency;
    this.moduleEnabled = moduleEnabled;
  }
  subscribe(listener) { return this.#bus.subscribe(listener); }
  snapshot() {
    return [...this.#tasks.values()].map(task => ({ id: task.id, key: task.key, module: task.module, scope: task.scope, status: task.status, attempt: task.attempt, errorCode: task.errorCode ?? null }));
  }
  submit({ key, module = 'core', scope, run, dependsOn = [], isCurrent = () => true, timeoutMs = 60000, retries = 0, retryDelayMs = 500, retryable = () => false }) {
    requireThat(typeof run === 'function' && typeof key === 'string' && typeof scope === 'string', 'INVALID_TASK', '任务参数无效');
    requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isInteger(retries) && retries >= 0 && retries <= 5, 'INVALID_TASK', '任务超时或重试参数无效');
    const previous = [...this.#tasks.values()].find(task => task.key === key && task.scope === scope && task.module === module && ['queued', 'running', 'retrying'].includes(task.status));
    if (previous) return { id: previous.id, promise: previous.promise, duplicate: true };
    requireThat(dependsOn.every(dependency => this.#tasks.has(dependency)), 'DEPENDENCY_MISSING', '任务依赖不存在');
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A task remains observable even when a caller only uses the ID to inspect it.
    promise.catch(() => {});
    const task = { id: id('task'), key, module, scope, run, dependsOn, isCurrent, timeoutMs, retries, retryDelayMs, retryable, promise, resolve, reject, controller: new AbortController(), status: 'queued', attempt: 0 };
    this.#tasks.set(task.id, task);
    this.#changed(); queueMicrotask(() => this.#pump());
    return { id: task.id, promise, duplicate: false };
  }
  #changed() { this.#bus.emit({ type: 'tasks.changed', tasks: this.snapshot() }); }
  #assert(task) {
    abortError(task.controller.signal);
    if (!task.isCurrent()) throw new CoreError('STALE_SCOPE', '任务聊天或正文版本已失效');
    if (!this.moduleEnabled(task.module)) throw new CoreError('MODULE_DISABLED', '模块未启用');
  }
  #fail(task, error) {
    task.errorCode = error.code ?? 'TASK_FAILED';
    task.status = ['CANCELLED', 'STALE_SCOPE', 'MODULE_DISABLED'].includes(task.errorCode) ? 'cancelled' : 'failed';
    task.reject(error); this.#changed();
  }
  #pump() {
    for (const task of this.#tasks.values()) {
      if (task.status !== 'queued') continue;
      try { this.#assert(task); } catch (error) { this.#fail(task, error); continue; }
      const dependencies = task.dependsOn.map(dependency => this.#tasks.get(dependency));
      if (dependencies.some(dependency => ['failed', 'cancelled'].includes(dependency.status))) {
        this.#fail(task, new CoreError('DEPENDENCY_FAILED', '前置任务未成功')); continue;
      }
      if (dependencies.some(dependency => dependency.status !== 'succeeded') || this.#active >= this.concurrency) continue;
      this.#active++; task.status = 'running'; this.#changed();
      void this.#execute(task).finally(() => { this.#active--; this.#pump(); });
    }
    // Keep completed diagnostics bounded; never evict a prerequisite of a pending task.
    if (this.#tasks.size > 200) {
      const needed = new Set([...this.#tasks.values()].filter(task => ['queued', 'running', 'retrying'].includes(task.status)).flatMap(task => task.dependsOn));
      for (const [taskId, task] of this.#tasks) {
        if (this.#tasks.size <= 200) break;
        if (['succeeded', 'failed', 'cancelled'].includes(task.status) && !needed.has(taskId)) this.#tasks.delete(taskId);
      }
    }
  }
  async #attempt(task) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    task.controller.signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, task.timeoutMs);
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new CoreError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? '任务超时' : '任务已取消'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      this.#assert(task);
      const result = await Promise.race([Promise.resolve().then(() => task.run({ signal: controller.signal, assertCurrent: () => { abortError(controller.signal); this.#assert(task); }, attempt: task.attempt })), cancelled]);
      abortError(controller.signal); this.#assert(task);
      return result;
    } finally {
      clearTimeout(timer);
      task.controller.signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  async #execute(task) {
    try {
      while (true) {
        task.attempt++;
        try {
          const result = await this.#attempt(task);
          task.status = 'succeeded'; task.resolve(result); this.#changed(); return;
        } catch (error) {
          this.#assert(task);
          if (task.attempt > task.retries || !task.retryable(error)) throw error;
          task.status = 'retrying'; this.#changed();
          await sleep(Math.min(error.retryAfterMs ?? task.retryDelayMs * 2 ** (task.attempt - 1), 30000), task.controller.signal);
          this.#assert(task); task.status = 'running'; this.#changed();
        }
      }
    } catch (error) { this.#fail(task, error); }
  }
  cancel(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task || !['queued', 'running', 'retrying'].includes(task.status)) return false;
    task.controller.abort();
    if (task.status === 'queued') this.#fail(task, new CoreError('CANCELLED', '任务已取消'));
    queueMicrotask(() => this.#pump()); return true;
  }
  cancelWhere(predicate) {
    for (const task of this.snapshot()) if (predicate(clone(task))) this.cancel(task.id);
  }
}
