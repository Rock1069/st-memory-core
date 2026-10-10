import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryJson } from '../src/core/memory-json.js';
import { enableSimpleMemory, fillMemoryHistory, pauseSimpleMemory } from '../src/core/simple-memory.js';
import { defaults } from '../src/core/settings.js';
import { fixture, waitFor } from './helpers.js';

const memory = { summary: { text: '旅人在港口拿到地图。', visibility: 'public', audienceIds: [] }, changes: [], storyTime: null };
const json = JSON.stringify(memory);
const wrap = text => `<think>推理中的示例：${JSON.stringify({ ...memory, summary: { text: '未经确认的猜测' } })}</think>\n提取结果如下：\n\`\`\`json\n${text}\n\`\`\`\n以上仅记录正文事实。`;

test('memory JSON accepts final answers with reasoning, fences, prose and BOM', () => {
  for (const response of [json, `\uFEFF  ${json}`, `\`\`\`JSON\n${json}\n\`\`\``, wrap(json), `说明 {并非 JSON}：${json}\n完成。`, `<THINKING>准备</THINKING>\n${json}`, `<analysis>准备</analysis><reasoning>准备</reasoning>${json}`, `\`\`\`reasoning\n${json}\n\`\`\`\n${json}`, `<think><analysis>${json}</analysis>${json}</think>${json}`]) assert.deepEqual(parseMemoryJson(response), memory);
});

test('memory JSON keeps quoted braces, escapes and literal reasoning tags inside facts', () => {
  const value = { ...memory, summary: { ...memory.summary, text: '门上刻有 {港口}、"地图"、\\路径和 <think>字样</think>。' } };
  assert.deepEqual(parseMemoryJson(wrap(JSON.stringify(value))), value);
});

test('memory JSON rejects incomplete, hidden, ambiguous and non-object results', () => {
  for (const response of [json.slice(0, -1), `{"summary":${json}`, `<think>${json}`, `\`\`\`thinking\n${json}`, `<think>${json}</think>`, `${json}\n${json}`, `说明：${JSON.stringify([memory])}`, '没有输出 JSON', '']) assert.throws(() => parseMemoryJson(response), error => error.code === 'EXTRACTION_JSON');
  assert.throws(() => parseMemoryJson(JSON.stringify([memory])), error => error.code === 'EXTRACTION_CONTRACT');
});

test('memory JSON preserves privacy defaults and rejects invalid structured contracts', () => {
  const result = parseMemoryJson('{"summary":{"text":"仅保存的内容"},"changes":[]}');
  assert.equal(result.summary.visibility, 'narrator'); assert.deepEqual(result.summary.audienceIds, []);
  for (const value of [{ summary: '正文', changes: [] }, { summary: { text: '' }, changes: [] }, { ...memory, changes: {} }, { ...memory, changes: [null] }, { ...memory, summary: { ...memory.summary, visibility: 'public|private|narrator' } }]) assert.throws(() => parseMemoryJson(JSON.stringify(value)), error => error.code === 'EXTRACTION_CONTRACT');
});

test('memory JSON rejects unsafe prototype fields without hiding validation errors', () => {
  for (const response of ['{"summary":{"text":"正文","__proto__":{}},"changes":[]}', '说明：{"summary":{"text":"正文"},"changes":[],"constructor":{}}']) assert.throws(() => parseMemoryJson(response), error => error.code === 'INVALID_JSON');
});

test('automatic memory saves wrapped final JSON once and injects only the final facts', async t => {
  const config = defaults(); config.prompt.recentWindow = 0;
  const f = await fixture({ config, response: () => wrap(json) }); t.after(() => f.runtime.stop());
  await enableSimpleMemory(f.runtime, 'main'); await waitFor(() => f.runtime.p1.progress.status === 'completed');
  assert.equal(f.calls, 1); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
  assert.match(f.context.prompt, /旅人在港口拿到地图/); assert.doesNotMatch(f.context.prompt, /未经确认的猜测|think|提取结果如下/);
});

test('format repair uses original evidence, preserves output limits and commits only valid memory', async t => {
  const requests = []; const config = defaults(); config.memory.maxTokens = 777;
  const f = await fixture({ config }); t.after(() => f.runtime.stop());
  f.setResponse(request => { requests.push(request); return f.calls === 1 ? '不能被当作事实的坏输出' : wrap(json); });
  await fillMemoryHistory(f.runtime);
  assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
  assert.equal(Object.values(f.runtime.getSnapshot().state.entities).filter(entity => entity.kind === 'summary').length, 1);
  assert.equal(requests[1].responseLength, 777); assert.match(requests[1].prompt[0].content, /上次输出不符合/);
  assert.equal(requests[0].prompt[1].content, requests[1].prompt[1].content); assert.match(requests[1].prompt[1].content, /旅人在港口拿到地图/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /不能被当作事实的坏输出/);
  assert.equal(f.runtime.logger.entries().filter(entry => entry.code === 'EXTRACTION_FORMAT_RETRY').length, 1);
  assert.doesNotMatch(JSON.stringify(f.runtime.logger.entries()), /不能被当作事实的坏输出/);
});

test('invalid summary contracts get one repair attempt and repeated failures remain unsaved', async t => {
  const f = await fixture({ response: () => '{"summary":"不合格格式","changes":[]}' }); t.after(() => f.runtime.stop());
  await assert.rejects(fillMemoryHistory(f.runtime), error => error.code === 'EXTRACTION_CONTRACT' && /自动重试一次/.test(error.message));
  assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 0);
  assert.equal(Object.values(f.runtime.getSnapshot().state.entities).filter(entity => entity.kind === 'draft').length, 0);
  assert.equal(f.runtime.p1.progress.errorCode, 'EXTRACTION_CONTRACT'); assert.equal(f.runtime.p1.progress.formatRetry, false);
});

test('stopping during format repair rejects late results and does not save a draft', async t => {
  let finish; const f = await fixture(); t.after(() => f.runtime.stop());
  f.setResponse(() => f.calls === 1 ? 'bad-json' : new Promise(resolve => { finish = resolve; }));
  await enableSimpleMemory(f.runtime, 'main'); await waitFor(() => !!finish);
  assert.equal(f.runtime.p1.progress.formatRetry, true); await pauseSimpleMemory(f.runtime); finish(json);
  await waitFor(() => f.runtime.p1.progress.status === 'stopped');
  assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 0); assert.equal(f.runtime.p1.progress.formatRetry, false);
});

test('source edits during format repair invalidate the old result', async t => {
  let finish; const f = await fixture(); t.after(() => f.runtime.stop());
  f.setResponse(() => f.calls === 1 ? 'bad-json' : new Promise(resolve => { finish = resolve; }));
  const pending = fillMemoryHistory(f.runtime); const rejected = assert.rejects(pending, error => ['STALE_SCOPE', 'CANCELLED'].includes(error.code));
  await waitFor(() => !!finish); f.context.chat[0].mes = '正文已变成另一段。'; await f.runtime.sync(); finish(json); await rejected;
  assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 0);
});

test('unsafe JSON is not retried and pure summaries keep their text contract', async t => {
  const f = await fixture({ response: () => '{"summary":{"text":"正文","__proto__":{}},"changes":[]}' }); t.after(() => f.runtime.stop());
  await assert.rejects(fillMemoryHistory(f.runtime), error => error.code === 'INVALID_JSON'); assert.equal(f.calls, 1);
  const config = f.runtime.settings.snapshot(); await f.runtime.settings.update({ memory: { ...config.memory, summaryOnly: true } });
  f.setResponse(request => { assert.doesNotMatch(request.prompt[0].content, /最终回复只输出一个完整 JSON/); return '普通摘要正文。'; });
  await fillMemoryHistory(f.runtime); assert.equal(f.calls, 2); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized, 1);
});
