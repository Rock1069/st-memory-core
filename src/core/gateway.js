import { abortError, clone, CoreError, hash, requireThat } from './util.js';

export function normalizeApiEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint ?? '').trim()); }
  catch { throw new CoreError('INVALID_ENDPOINT', '请填写有效的 API 基础地址'); }
  requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'INVALID_ENDPOINT', 'API 地址须为 HTTP/HTTPS，且不能包含账号、密码、查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  return url.toString().replace(/\/$/, '');
}

export async function readStream(response, signal) {
  requireThat(response.body?.getReader, 'API_CONTRACT', '服务未返回可读取的流');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''; let text = '';
  const parse = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    let payload; try { payload = JSON.parse(data); } catch { throw new CoreError('API_CONTRACT', '流式返回包含无效 JSON'); }
    if (payload.error) throw new CoreError('API_REJECTED', '流式服务返回错误');
    text += payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text ?? '';
  };
  try {
    while (true) { abortError(signal); const { done, value } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(parse); }
    pending += decoder.decode(); if (pending.trim()) parse(pending); return text;
  } finally { await reader.cancel().catch(() => {}); }
}

export class ModelGateway {
  constructor({ host, settings, vault, scheduler, logger, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { host, settings, vault, scheduler, logger, fetchImpl });
  }
  async discoverModels({ endpoint, secret = '', signal, timeoutMs = 30000 }) {
    const base = normalizeApiEndpoint(endpoint);
    requireThat(typeof secret === 'string', 'INVALID_CREDENTIAL', 'API Key 格式无效');
    requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'INVALID_TIMEOUT', '获取模型的超时设置无效');
    const context = this.host.context();
    requireThat(typeof context?.getRequestHeaders === 'function', 'API_UNAVAILABLE', '酒馆代理接口不可用');
    abortError(signal);
    const key = secret.trim(); this.logger.registerSecret(key);
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false; let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new CoreError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? '获取模型超时，请检查连接后重试' : '获取模型已取消'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      // Use the host proxy so provider CORS rules do not block model discovery.
      const query = async () => {
        let result;
        try {
          result = await this.fetchImpl('/api/backends/chat-completions/status', {
            method: 'POST', headers: context.getRequestHeaders(), signal: controller.signal, cache: 'no-store',
            body: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: base, proxy_password: key }),
          });
        } catch { abortError(controller.signal); throw new CoreError('NETWORK_ERROR', '获取模型连接失败，请检查酒馆连接后重试'); }
        abortError(controller.signal);
        if (!result.ok) {
          const message = [401, 403].includes(result.status) ? '获取模型被拒绝，请检查 API Key 或访问权限' : result.status === 404 ? '模型列表接口不存在，请检查 API 地址或手动填写模型名' : `获取模型失败（HTTP ${result.status}），请检查地址和服务状态`;
          throw new CoreError('API_REJECTED', message, { status: result.status });
        }
        let payload;
        try { payload = await result.json(); }
        catch { abortError(controller.signal); throw new CoreError('API_CONTRACT', '模型列表不是有效 JSON，请检查 API 地址或手动填写模型名'); }
        abortError(controller.signal);
        requireThat(!payload?.error, 'API_REJECTED', '无法获取模型，请检查 API 地址、Key 及服务是否支持 /models');
        const rows = Array.isArray(payload) ? payload : payload?.data;
        requireThat(Array.isArray(rows), 'API_CONTRACT', '服务未返回兼容的模型列表，可以手动填写模型名');
        const models = [...new Set(rows.map(row => typeof row === 'string' ? row : row?.id).filter(value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)).map(value => value.trim()))].sort((a, b) => a.localeCompare(b));
        requireThat(models.length > 0, 'EMPTY_MODEL_LIST', '服务未返回可用模型，请检查 Key 权限或手动填写模型名');
        return models;
      };
      const models = await Promise.race([query(), aborted]);
      abortError(controller.signal);
      this.logger.write('info', 'API_MODELS_LOADED', `已获取 ${models.length} 个模型`, { count: models.length });
      return models;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', onAbort);
    }
  }
  async request({ task = 'diagnostic', module = 'core', key, messages, lease, assertCurrent, maxTokens = 128, channelOverride = null }) {
    messages = clone(messages);
    requireThat(Array.isArray(messages) && messages.length > 0 && messages.every(message => message && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string'), 'INVALID_PROMPT', '模型消息格式无效');
    requireThat(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 100000, 'INVALID_PROMPT', '输出限制无效');
    const channelId = channelOverride ?? this.settings.route(task, lease.identity);
    const channel = this.settings.channel(channelId);
    requireThat(channelId !== 'main' || this.host.capabilities().mainApi, 'API_UNAVAILABLE', '酒馆主 API 未就绪');
    const requestKey = `${key ?? task}:${channelId}:${await hash({ messages, maxTokens, channel })}`;
    assertCurrent();
    const job = this.scheduler.submit({
      key: requestKey, module, scope: lease.scope, isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
      timeoutMs: channel.timeoutMs, retries: channel.retries,
      retryable: error => ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMIT', 'UPSTREAM_ERROR'].includes(error.code),
      run: async ({ signal, assertCurrent: guard }) => {
        guard(); this.logger.write('info', 'API_STARTED', `${task} 调用 ${channel.name}`, { channelId, task, messages });
        let response;
        if (channelId === 'main') {
          // Memory extraction uses a complete final user turn, never an assistant prefill.
          response = await this.host.context().generateRaw({ prompt: messages, responseLength: maxTokens, prefill: '' });
        } else {
          const context = this.host.context();
          requireThat(typeof context?.getRequestHeaders === 'function', 'API_UNAVAILABLE', '酒馆代理接口不可用');
          let result;
          const body = { chat_completion_source: 'openai', model: channel.model, messages, stream: channel.stream ?? false, max_tokens: Math.min(maxTokens, channel.maxTokens ?? maxTokens), reverse_proxy: normalizeApiEndpoint(channel.endpoint), proxy_password: this.vault.get(channelId) };
          if (channel.temperature !== undefined) body.temperature = channel.temperature;
          if (/(?:^|[/:])gemini-3\.8-flash(?:$|[-:@])/i.test(channel.model) && Object.hasOwn(body, 'temperature')) {
            delete body.temperature;
            this.logger.write('info', 'API_PARAMETERS_ADAPTED', 'Gemini 3.8 Flash 请求已按模型要求省略温度参数', { channelId, model: channel.model });
          }
          for (const parameter of channel.omitParameters ?? []) delete body[parameter];
          try {
            result = await this.fetchImpl('/api/backends/chat-completions/generate', {
              method: 'POST', headers: context.getRequestHeaders(), signal,
              body: JSON.stringify(body),
            });
          } catch (error) { abortError(signal); throw new CoreError('NETWORK_ERROR', '模型连接失败'); }
          if (!result.ok) {
            const error = new CoreError(result.status === 429 ? 'RATE_LIMIT' : result.status >= 500 ? 'UPSTREAM_ERROR' : 'API_REJECTED', `模型请求返回 ${result.status}`, { status: result.status });
            const retryAfter = result.headers?.get?.('retry-after');
            if (retryAfter) {
              const seconds = Number(retryAfter);
              const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
              if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay);
            }
            throw error;
          }
          response = body.stream ? await readStream(result, signal) : (await result.json())?.choices?.[0]?.message?.content;
          requireThat(typeof response === 'string', 'API_CONTRACT', '模型返回了无法解析的正文');
        }
        abortError(signal); guard();
        requireThat(typeof response === 'string', 'API_CONTRACT', '模型返回格式无效');
        this.logger.write('info', 'API_COMPLETED', `${task} 渠道 ${channel.name} 已返回`, { response, channelId, task });
        return response;
      },
    });
    try { return await job.promise; }
    catch (error) {
      if (channelId !== 'main' && !channelOverride && this.settings.snapshot().api.fallbackToMain && ['TIMEOUT','NETWORK_ERROR','UPSTREAM_ERROR','RATE_LIMIT'].includes(error.code)) {
        assertCurrent(); this.logger.write('warn', 'API_EXPLICIT_FALLBACK', `${task} 按已开启策略回退主 API`, { channelId });
        return this.request({ task, module, key: `${key}:fallback`, messages, lease, assertCurrent, maxTokens, channelOverride: 'main' });
      }
      throw error;
    }
  }
}
