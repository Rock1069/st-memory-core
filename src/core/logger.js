import { Bus, clone } from './util.js';

const sensitive = /^(authorization|proxy_password|api[_-]?key|password|token|cookie|key|secret)$/i;
const bodies = /^(messages|prompt|content|body|response)$/i;

export class Logger {
  #entries = [];
  #secrets = new Set();
  #bus = new Bus();
  constructor({ capacity = 200, logBodies = false } = {}) { this.capacity = capacity; this.logBodies = logBodies; }
  registerSecret(secret) { if (secret) this.#secrets.add(String(secret)); }
  redact(value, depth = 0) {
    if (depth > 15) return '[嵌套省略]';
    if (typeof value === 'string') {
      let result = value.replace(/(Bearer\s+)[^\s"',]+/gi, '$1[已隐藏]').replace(/([?&](?:key|api_key|token|password)=)[^&\s]+/gi, '$1[已隐藏]');
      for (const secret of this.#secrets) result = result.split(secret).join('[已隐藏]');
      return result;
    }
    if (Array.isArray(value)) return value.map(child => this.redact(child, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitive.test(key) ? '[已隐藏]' : bodies.test(key) && !this.logBodies ? '[正文日志未启用]' : this.redact(child, depth + 1)]));
    return value ?? null;
  }
  write(level, code, message, details = {}) {
    const entry = this.redact({ at: Date.now(), level, code, message, details });
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) this.#entries.shift();
    this.#bus.emit({ type: 'log.added', entry });
    return clone(entry);
  }
  error(error) { return this.write('error', error.code ?? 'UNEXPECTED', error.message ?? String(error), error.details ?? {}); }
  entries({ level } = {}) { return clone(this.#entries.filter(entry => !level || entry.level === level)); }
  clear() { this.#entries = []; this.#bus.emit({ type: 'log.cleared' }); }
  subscribe(listener) { return this.#bus.subscribe(listener); }
}
