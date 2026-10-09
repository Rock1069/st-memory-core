export class CoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}

export function requireThat(condition, code, message) {
  if (!condition) throw new CoreError(code, message);
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
export function assertJson(value, depth = 0) {
  requireThat(depth <= 80, 'INVALID_JSON', '数据嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'INVALID_JSON', '数字必须有限');
    return;
  }
  requireThat(typeof value === 'object', 'INVALID_JSON', '数据必须为 JSON 值');
  requireThat(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_JSON', '不支持特殊对象');
  for (const [key, child] of Object.entries(value)) {
    requireThat(!forbidden.has(key), 'INVALID_JSON', '不允许原型字段');
    assertJson(child, depth + 1);
  }
}

export function clone(value) {
  assertJson(value);
  return structuredClone(value);
}

export function canonical(value) {
  assertJson(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export async function hash(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function id(prefix) { return `${prefix}_${globalThis.crypto.randomUUID()}`; }
export function textId(value, label = 'ID') {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 512 && !forbidden.has(value), 'INVALID_ID', `${label}无效`);
  return value;
}
export function pathParts(path) {
  requireThat(Array.isArray(path) && path.length > 0 && path.length <= 30, 'INVALID_PATH', '字段路径必须为非空数组');
  path.forEach(part => textId(part, '路径'));
  return path;
}

export function getPath(object, path) {
  return path.reduce((value, part) => value != null && Object.hasOwn(value, part) ? value[part] : undefined, object);
}
export function setPath(object, path, value, remove = false) {
  pathParts(path);
  let current = object;
  for (const part of path.slice(0, -1)) {
    if (!Object.hasOwn(current, part)) { if (remove) return; current[part] = {}; }
    requireThat(current[part] !== null && typeof current[part] === 'object' && !Array.isArray(current[part]), 'INVALID_PATH', '路径穿过非对象字段');
    current = current[part];
  }
  if (remove) delete current[path.at(-1)];
  else current[path.at(-1)] = clone(value);
}

export function abortError(signal) {
  if (signal?.aborted) throw new CoreError('CANCELLED', '任务已取消');
}
export function sleep(ms, signal) {
  abortError(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new CoreError('CANCELLED', '任务已取消')); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Mutex {
  #tail = Promise.resolve();
  run(action) {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }
}

export class Bus {
  #listeners = new Set();
  subscribe(listener) {
    requireThat(typeof listener === 'function', 'INVALID_LISTENER', '订阅必须为函数');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.#listeners) {
      try { listener(clone(event)); } catch { /* Observers cannot break a durable commit. */ }
    }
  }
}
