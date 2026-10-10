import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/core/settings.js';
import { fillMemoryHistory } from '../src/core/simple-memory.js';
import { fixture } from './helpers.js';

const memory = JSON.stringify({ summary: { text: '旅人在港口拿到地图。', visibility: 'public', audienceIds: [] }, storyTime: null, changes: [] });
function assertFinalUser(messages) {
  assert.equal(messages.at(-1).role, 'user'); assert.ok(messages.at(-1).content.trim());
  assert.equal(messages.some(message => message.role === 'assistant'), false);
}

test('main API memory extraction and format repair explicitly disable assistant prefill', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop());
  f.setResponse(request => {
    assert.equal(request.prefill, ''); assertFinalUser(request.prompt);
    return f.calls === 1 ? '第一次格式错误' : memory;
  });
  await fillMemoryHistory(f.runtime); assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
});

for (const model of ['gemini-3.1-pro-preview', 'google/gemini-3.8-flash']) {
  test(`${model} uses complete user turns through an independent compatible API and format repair`, async t => {
    const config = defaults(); config.channels = [{ id: 'gemini', name: 'Gemini', endpoint: 'https://gemini.example/v1', model, timeoutMs: 5000, retries: 0, temperature: 0.7, maxTokens: 1600 }]; config.routing.default = 'gemini';
    const f = await fixture({ config }); t.after(() => f.runtime.stop()); let calls = 0;
    f.runtime.gateway.fetchImpl = async (url, options) => {
      calls++; const body = JSON.parse(options.body);
      assertFinalUser(body.messages); assert.equal(body.model, model); assert.equal(body.max_tokens, 1200);
      assert.equal(Object.hasOwn(body, 'prefill'), false); assert.equal(Object.hasOwn(body, 'assistant_prefill'), false);
      if (model.includes('3.8')) assert.equal(Object.hasOwn(body, 'temperature'), false);
      else assert.equal(body.temperature, 0.7);
      return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? '第一次格式错误' : `\`\`\`json\n${memory}\n\`\`\`` } }] }));
    };
    await fillMemoryHistory(f.runtime); assert.equal(calls, 2); assert.equal(f.calls, 0); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
    assert.equal(f.runtime.settings.snapshot().channels[0].temperature, 0.7);
  });
}
