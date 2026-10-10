import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRuntime } from '../src/runtime.js';
import { defaults, validateSettings } from '../src/core/settings.js';
import { cleanMessageText } from '../src/core/memory.js';

class FakeHost {
  constructor(config = defaults()) {
    this.config = structuredClone(config);
    this.chat = [{ id: 'message_one', mes: '旅人在港口收到了地图。', swipe_id: 0, is_user: false }];
    this.document = null;
    this.calls = 0;
    this.generate = async () => '旅人在港口收到了地图。';
  }
  async ready() {}
  bind(callback) { this.callback = callback; return () => { this.callback = null; }; }
  emit(name) { this.callback?.(name, []); }
  capture() { return { chat: this.chat, identity: { chatId: 'test', characterKey: 'character:test', scopeKey: 'test-scope' } }; }
  isCurrent(capture) { return capture.chat === this.chat; }
  assertCurrent(capture) { assert.ok(this.isCurrent(capture)); }
  signature() { return JSON.stringify(this.chat.map(message => [message.id, message.mes, message.swipe_id])); }
  async messages() {
    return this.chat.map((message, index) => ({ id: message.id, versionId: `version_${message.swipe_id}_${message.mes}`, contentHash: `hash_${index}`, swipeId: message.swipe_id, role: message.is_user ? 'user' : 'assistant', index }));
  }
  storage() {
    return { key: 'test-scope', load: async () => structuredClone(this.document), save: async (candidate, expectedRevision) => {
      assert.equal(this.document?.revision ?? 0, expectedRevision);
      this.document = structuredClone(candidate);
    } };
  }
  settingsStorage() { return { load: async () => structuredClone(this.config), save: async config => { this.config = structuredClone(config); } }; }
  context() { return { generateRaw: async request => { this.calls++; return this.generate(request); } }; }
  capabilities() { return { mainApi: true }; }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('等待摘要任务超时');
}

test('old schema v1 settings gain safe summary defaults, and reasoning blocks are excluded', () => {
  const old = defaults(); delete old.memory;
  const current = validateSettings(old);
  assert.equal(current.memory.autoSummarize, false);
  assert.equal(current.modules.memory, false);
  assert.equal(cleanMessageText('<think>秘密推理</think>旅人到达港口。'), '旅人到达港口。');
});

test('manual summary follows the active message version and preserves human edits', async () => {
  const host = new FakeHost();
  const runtime = new MemoryRuntime(host);
  await runtime.start();
  assert.deepEqual(runtime.getSnapshot().coverage.summary.missing.map(item => item.messageId), ['message_one']);
  await runtime.saveSummary('message_one', '人工记录的地图');
  assert.equal(runtime.getSnapshot().coverage.summary.summarized, 1);
  assert.equal(runtime.summaryItems()[0].text, '人工记录的地图');
  assert.ok(Object.keys(runtime.getSnapshot().state.locks).length > 0);
  host.chat[0].mes = '旅人在港口收到了钥匙。';
  host.chat[0].swipe_id = 1;
  await runtime.sync();
  assert.equal(runtime.getSnapshot().coverage.summary.summarized, 0);
  assert.equal(runtime.getSnapshot().coverage.summary.missing.length, 1);
  await runtime.saveSummary('message_one', '这一版收到钥匙');
  assert.equal(runtime.summaryItems()[0].text, '这一版收到钥匙');
  runtime.stop();
});

test('auto summary records once per active version through the selected model channel', async () => {
  const config = defaults(); config.modules.memory = true; config.memory.autoSummarize = true; config.memory.summaryOnly = true; config.memory.requireReview = false;
  const host = new FakeHost(config);
  const runtime = new MemoryRuntime(host);
  await runtime.start();
  await waitFor(() => runtime.getSnapshot().coverage.summary.summarized === 1);
  assert.equal(host.calls, 1);
  await runtime.sync();
  assert.equal(host.calls, 1);
  host.chat[0].mes = '旅人在港口收到了钥匙。';
  host.chat[0].swipe_id = 1;
  host.emit('MESSAGE_SWIPED');
  await waitFor(() => runtime.getSnapshot().coverage.summary?.summarized === 1 && host.calls === 2);
  assert.equal(runtime.summaryItems()[0].text, '旅人在港口收到了地图。');
  runtime.stop();
});

test('a response from a changed message version cannot be committed', async () => {
  const config = defaults(); config.modules.memory = true;
  const host = new FakeHost(config);
  let finish;
  host.generate = () => new Promise(resolve => { finish = resolve; });
  const runtime = new MemoryRuntime(host);
  await runtime.start();
  const pending = runtime.summarizeMissing({ limit: 1 });
  await waitFor(() => typeof finish === 'function');
  host.chat[0].mes = '正文已经改写。';
  await runtime.sync();
  finish('过期摘要');
  await assert.rejects(pending, error => error.code === 'STALE_SCOPE' || error.code === 'SOURCE_UNSYNCED');
  assert.equal(runtime.getSnapshot().coverage.summary.summarized, 0);
  runtime.stop();
});
