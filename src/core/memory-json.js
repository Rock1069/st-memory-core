import { clone, CoreError, requireThat } from './util.js';

export const MEMORY_JSON_INSTRUCTION = '最终回复只输出一个完整 JSON 对象，不要解释、思考过程或 Markdown。格式示例：{"summary":{"text":"有正文依据的简短摘要","visibility":"narrator","audienceIds":[]},"storyTime":null,"changes":[]}。visibility 只取 public、private、narrator 之一；changes 只写有依据的变化及实际改变的字段，不要复制完整档案或字段模板。优先保证摘要和 JSON 完整，未知时间为 null，无变化为 []。';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const formatError = message => new CoreError('EXTRACTION_JSON', message);

function validate(value) {
  const result = clone(value);
  requireThat(record(result) && record(result.summary) && typeof result.summary.text === 'string' && result.summary.text.trim() && Array.isArray(result.changes ?? []) && (result.changes?.length ?? 0) <= 100, 'EXTRACTION_CONTRACT', '模型提取结果缺少有效摘要或变更列表');
  result.summary = { visibility: 'narrator', audienceIds: [], ...result.summary };
  requireThat(['public', 'private', 'narrator'].includes(result.summary.visibility) && Array.isArray(result.summary.audienceIds) && result.summary.audienceIds.every(value => typeof value === 'string') && (result.changes ?? []).every(record), 'EXTRACTION_CONTRACT', '模型提取结果的可见范围或变更格式无效');
  return result;
}

// Scan outer objects only. Never salvage an inner object from truncated JSON,
// and never treat JSON in a reasoning block as the model's final answer.
function candidates(text) {
  const values = []; const stack = []; let start = -1; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!stack.length) {
      if (char === '<') {
        const tag = text.slice(i).match(/^<(think|thinking|analysis|reasoning)\b[^>]*>/i);
        if (tag) {
          const tags = /<(\/?)(think|thinking|analysis|reasoning)\b[^>]*>/ig; tags.lastIndex = i + tag[0].length;
          const reasoning = [tag[1].toLowerCase()]; let ending;
          while ((ending = tags.exec(text))) {
            if (!ending[1]) reasoning.push(ending[2].toLowerCase());
            else if (reasoning.at(-1) === ending[2].toLowerCase()) reasoning.pop();
            if (!reasoning.length) break;
          }
          if (reasoning.length) throw formatError('模型只返回了未结束的思考内容，未找到完整记忆 JSON');
          i = ending.index + ending[0].length - 1; continue;
        }
      }
      if (char === '`' && (i === 0 || /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i)))) {
        const fence = text.slice(i).match(/^```(?:think|thinking|analysis|reasoning)[ \t]*\r?\n/i);
        if (fence) {
          const close = /^[ \t]*```[ \t]*(?:\r?$)/gm; close.lastIndex = i + fence[0].length;
          const ending = close.exec(text);
          if (!ending) throw formatError('模型只返回了未结束的思考内容，未找到完整记忆 JSON');
          i = ending.index + ending[0].length - 1; continue;
        }
      }
      if (char !== '{' && char !== '[') continue;
      start = i; quoted = false; escaped = false;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      stack.pop();
      if (!stack.length) {
        try { values.push(JSON.parse(text.slice(start, i + 1))); } catch { /* Explanatory text may contain non-JSON braces. */ }
      }
    }
  }
  if (stack.length) throw formatError('模型输出可能被截断，记忆 JSON 不完整');
  return values;
}

export function parseMemoryJson(response) {
  requireThat(typeof response === 'string' && response.length <= 1_000_000, 'EXTRACTION_JSON', '模型记忆输出为空或过长');
  const text = response.replace(/^\uFEFF/, '').trim();
  let value;
  try { value = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (value !== undefined) return validate(value);
  const results = candidates(text).filter(value => record(value) && Object.hasOwn(value, 'summary'));
  requireThat(results.length === 1, 'EXTRACTION_JSON', results.length ? '模型返回了多份记忆 JSON，无法确定应保存哪一份' : '模型未返回可识别的完整记忆 JSON');
  return validate(results[0]);
}
