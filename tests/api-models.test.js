import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiEndpoint } from '../src/core/gateway.js';
import { fixture } from './helpers.js';

test('model discovery validates the base URL and keeps provider paths', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop());
  for (const [input, expected] of [
    [' https://provider.example/api/v1/ ', 'https://provider.example/api/v1'],
    ['https://provider.example/v1/chat/completions///', 'https://provider.example/v1'],
    ['http://localhost:1234/v1/models/', 'http://localhost:1234/v1'],
    ['https://provider.example', 'https://provider.example'],
  ]) assert.equal(normalizeApiEndpoint(input), expected);
  let calls = 0; f.runtime.gateway.fetchImpl = async () => { calls++; };
  for (const endpoint of ['', 'bad-url', 'file:///api', 'https://user:key@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#secret']) {
    await assert.rejects(f.runtime.gateway.discoverModels({ endpoint }), error => error.code === 'INVALID_ENDPOINT');
  }
  assert.equal(calls, 0);
  delete f.context.getRequestHeaders;
  await assert.rejects(f.runtime.gateway.discoverModels({ endpoint: 'https://provider.example/v1' }), error => error.code === 'API_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('discovery uses the host proxy and unsaved credentials without a chat or generation', async t => {
  const f = await fixture({ chat: [] }); t.after(() => f.runtime.stop());
  f.context.getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'host-csrf' });
  const before = f.runtime.settings.snapshot(); let request;
  f.runtime.gateway.fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }, null, {}, { id: '' }, { id: 'bad\nmodel' }] }));
  };
  assert.deepEqual(await f.runtime.gateway.discoverModels({ endpoint: 'https://provider.example/v1/chat/completions', secret: ' session-only-key ' }), ['a-model', 'z-model']);
  assert.equal(request.url, '/api/backends/chat-completions/status');
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['X-CSRF-Token'], 'host-csrf');
  assert.deepEqual(JSON.parse(request.options.body), { chat_completion_source: 'openai', reverse_proxy: 'https://provider.example/v1', proxy_password: 'session-only-key' });
  assert.deepEqual(f.runtime.settings.snapshot(), before); assert.equal(f.calls, 0);
  f.runtime.logger.write('warn', 'TEST', 'session-only-key');
  assert.doesNotMatch(JSON.stringify(f.runtime.logger.entries()), /session-only-key/);
  f.runtime.gateway.fetchImpl = async () => new Response(JSON.stringify(['one-model', 'one-model']));
  assert.deepEqual(await f.runtime.gateway.discoverModels({ endpoint: 'http://localhost:1234/v1' }), ['one-model']);
});

test('discovery reports HTTP, proxy, malformed and empty lists without exposing response bodies', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop());
  const cases = [
    [() => new Response('private-upstream-body', { status: 401 }), 'API_REJECTED', /Key/],
    [() => new Response('private-upstream-body', { status: 404 }), 'API_REJECTED', /接口不存在/],
    [() => new Response('private-upstream-body', { status: 500 }), 'API_REJECTED', /500/],
    [() => new Response(JSON.stringify({ error: { message: 'private-upstream-body' }, data: [] })), 'API_REJECTED', /地址、Key/],
    [() => new Response('private-upstream-body'), 'API_CONTRACT', /JSON/],
    [() => new Response('{}'), 'API_CONTRACT', /模型列表/],
    [() => new Response('{"data":[]}'), 'EMPTY_MODEL_LIST', /可用模型/],
    [() => { throw new Error('private-upstream-body'); }, 'NETWORK_ERROR', /连接失败/],
  ];
  for (const [response, code, message] of cases) {
    f.runtime.gateway.fetchImpl = async () => response();
    await assert.rejects(f.runtime.gateway.discoverModels({ endpoint: 'https://provider.example/v1', secret: 'unsaved-key' }), error => {
      assert.equal(error.code, code); assert.match(error.message, message);
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /private-upstream-body|unsaved-key/);
      return true;
    });
  }
});

test('discovery settles on timeout and cancellation even when a transport ignores abort', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop());
  let calls = 0; let receivedSignal; let finish;
  f.runtime.gateway.fetchImpl = async (_, options) => { calls++; receivedSignal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const input = { endpoint: 'https://provider.example/v1' };
  await assert.rejects(f.runtime.gateway.discoverModels({ ...input, timeoutMs: 5 }), error => error.code === 'TIMEOUT');
  assert.equal(receivedSignal.aborted, true); finish(new Response('{"data":[{"id":"late-model"}]}'));
  const controller = new AbortController();
  const pending = f.runtime.gateway.discoverModels({ ...input, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(receivedSignal.aborted, true); finish(new Response('{"data":[{"id":"cancelled-model"}]}'));
  await assert.rejects(f.runtime.gateway.discoverModels({ ...input, signal: controller.signal }), error => error.code === 'CANCELLED');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2); assert.equal(f.runtime.logger.entries().filter(entry => entry.code === 'API_MODELS_LOADED').length, 0);
});

test('a discovered model and normalized endpoint are used by independent generation', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop()); const bodies = [];
  f.runtime.gateway.fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify(url.endsWith('/status') ? { data: [{ id: 'selected-model' }] } : { choices: [{ message: { content: '渠道可用' } }] }));
  };
  const [model] = await f.runtime.gateway.discoverModels({ endpoint: 'https://provider.example/v1/models', secret: 'selected-key' });
  await f.runtime.settings.update({ channels: [{ id: 'discovered', name: '获取的渠道', endpoint: 'https://provider.example/v1/models/', model, timeoutMs: 1000, retries: 0 }] });
  f.runtime.vault.set('discovered', 'selected-key');
  assert.equal(await f.runtime.testChannel('discovered'), '渠道可用');
  assert.equal(bodies[1].model, 'selected-model'); assert.equal(bodies[1].reverse_proxy, 'https://provider.example/v1'); assert.equal(bodies[1].proxy_password, 'selected-key');
});
