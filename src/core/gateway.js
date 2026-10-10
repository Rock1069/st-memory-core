import { abortError, clone, CoreError, hash, requireThat } from './util.js';

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
          response = await this.host.context().generateRaw({ prompt: messages, responseLength: maxTokens });
        } else {
          const context = this.host.context();
          requireThat(typeof context?.getRequestHeaders === 'function', 'API_UNAVAILABLE', '酒馆代理接口不可用');
          let result;
          const body = { chat_completion_source: 'openai', model: channel.model, messages, stream: channel.stream ?? false, max_tokens: Math.min(maxTokens, channel.maxTokens ?? maxTokens), reverse_proxy: channel.endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, ''), proxy_password: this.vault.get(channelId) };
          if (channel.temperature !== undefined) body.temperature = channel.temperature;
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
