import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateSettings } from '../src/core/settings.js';
import { enableSimpleMemory, fillMemoryHistory, pauseSimpleMemory, selectMemoryChannel } from '../src/core/simple-memory.js';
import { fixture, waitFor } from './helpers.js';

test('fresh and legacy settings open the simple home without silently enabling model calls', () => {
  const config = defaults(); assert.equal(config.ui.mode, 'light'); assert.equal(config.memory.autoSummarize, false); assert.equal(config.modules.memory, false);
  const legacy = defaults(); delete legacy.ui.homeVersion; legacy.ui.mode = 'full'; legacy.ui.entries.floor = true; legacy.memory.maxTokens = 2048;
  const migrated = validateSettings(legacy); assert.equal(migrated.ui.mode, 'light'); assert.equal(migrated.ui.homeVersion, 1); assert.equal(migrated.ui.entries.floor, true); assert.equal(migrated.memory.maxTokens, 2048);
  migrated.ui.mode = 'advanced'; assert.equal(validateSettings(migrated).ui.mode, 'advanced');
});

test('one API selection updates the three memory tasks and the current overrides', async t => {
  const config = defaults(); config.channels = ['a', 'b'].map(id => ({ id, name: id, model: 'model', endpoint: 'https://example.com/v1', timeoutMs: 1000, retries: 0 }));
  const f = await fixture({ config }); t.after(() => f.runtime.stop()); const identity = f.runtime.getSnapshot().scope;
  await f.runtime.settings.update({ characterOverrides: { [identity.characterKey]: { extraction: 'a', planning: 'a' } }, chatOverrides: { [identity.scopeKey]: { summary: 'a', compression: 'a' }, other: { summary: 'a' } } });
  await selectMemoryChannel(f.runtime, 'b'); const updated = f.runtime.settings.snapshot();
  for (const task of ['summary', 'extraction', 'compression']) assert.equal(f.runtime.settings.route(task, identity), 'b');
  assert.equal(updated.routing.default, 'main'); assert.equal(updated.characterOverrides[identity.characterKey].planning, 'a'); assert.equal(updated.chatOverrides.other.summary, 'a'); assert.equal(updated.memory.autoSummarize, false);
});

test('one-click start enables automatic commit and injection, and new replies update once', async t => {
  const config = defaults(); config.enabled = false; config.prompt.enabled = false; config.prompt.recentWindow = 0;
  const f = await fixture({ config, chat: [{ mes: '一', is_user: false }, { mes: '二', is_user: false }] }); t.after(() => f.runtime.stop());
  await f.runtime.settings.update({ modules: { ...f.runtime.settings.snapshot().modules, memory: false } });
  await enableSimpleMemory(f.runtime, 'main'); await waitFor(() => f.runtime.getSnapshot().coverage.summary?.summarized === 2 && f.runtime.p1.progress.status === 'completed');
  const updated = f.runtime.settings.snapshot(); assert.equal(updated.enabled, true); assert.equal(updated.modules.memory, true); assert.equal(updated.memory.requireReview, false); assert.equal(updated.memory.autoCompress, true); assert.equal(updated.prompt.enabled, true); assert.equal(updated.ui.mode, 'light');
  assert.equal(Object.values(f.runtime.getSnapshot().state.entities).filter(entity => entity.kind === 'draft' && entity.fields.status === 'pending').length, 0);
  assert.equal(f.calls, 2); assert.match(f.context.prompt, /旅人在港口拿到地图/);
  await f.events.emit('GENERATION_STARTED', 'normal'); await f.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false); assert.equal(f.runtime.p1.lastBundle.delivery, 'submitted-to-host');
  f.context.chat.push({ mes: '三', is_user: false }); await f.events.emit('GENERATION_ENDED');
  await waitFor(() => f.runtime.getSnapshot().coverage.summary?.summarized === 3 && f.runtime.p1.progress.status === 'completed');
  await f.runtime.sync(); assert.equal(f.calls, 3); assert.ok(f.saves > 0);
});

test('pause cancels a running model result, retains injection, and manual history fill can continue', async t => {
  const config = defaults(); config.prompt.recentWindow = 0;
  let finish; const f = await fixture({ config, response: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => f.runtime.stop());
  await enableSimpleMemory(f.runtime, 'main'); await waitFor(() => !!finish); await pauseSimpleMemory(f.runtime);
  finish(JSON.stringify({ summary: { text: '迟到内容', visibility: 'public' }, changes: [] }));
  await waitFor(() => f.runtime.p1.progress.status === 'stopped'); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 0);
  assert.equal(f.runtime.settings.snapshot().modules.memory, true); assert.equal(f.runtime.settings.snapshot().prompt.enabled, true); assert.equal(f.runtime.settings.snapshot().memory.autoSummarize, false);
  f.setResponse(() => JSON.stringify({ summary: { text: '手动补齐内容', visibility: 'public' }, changes: [] }));
  await fillMemoryHistory(f.runtime); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1); assert.equal(f.runtime.settings.snapshot().memory.autoSummarize, false); assert.match(f.context.prompt, /手动补齐内容/);
  await pauseSimpleMemory(f.runtime); assert.match(f.context.prompt, /手动补齐内容/);
});

test('start requires an active chat and an available API before changing configuration', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop()); const before = f.runtime.settings.snapshot();
  delete f.context.generateRaw; await assert.rejects(enableSimpleMemory(f.runtime, 'main'), error => error.code === 'API_UNAVAILABLE'); assert.deepEqual(f.runtime.settings.snapshot(), before);
  f.context.getCurrentChatId = () => null; await f.runtime.sync();
  await assert.rejects(enableSimpleMemory(f.runtime, 'main'), error => error.code === 'CHAT_UNAVAILABLE'); assert.deepEqual(f.runtime.settings.snapshot(), before); assert.equal(f.calls, 0);
});

test('history retry keeps committed floors and only completes the remaining gaps', async t => {
  const f = await fixture({ chat: [{ mes: '一', is_user: false }, { mes: '二', is_user: false }] }); t.after(() => f.runtime.stop());
  f.setResponse(() => f.calls === 2 ? 'invalid-json' : JSON.stringify({ summary: { text: '有效记忆', visibility: 'public' }, changes: [] }));
  await assert.rejects(fillMemoryHistory(f.runtime), error => error.code === 'EXTRACTION_JSON'); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
  await fillMemoryHistory(f.runtime); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 2); assert.equal(f.calls, 3); assert.equal(f.runtime.settings.snapshot().memory.autoSummarize, false);
});
