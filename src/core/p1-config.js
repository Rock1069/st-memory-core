import { DEFAULT_SUMMARY_PROMPT } from './memory.js';
import { EXTRACTION_PROMPT } from './domain.js';
import { GREGORIAN, validateCalendar } from './story-time.js';
import { clone, requireThat } from './util.js';

export function p1Defaults() {
  return {
    memory: { autoSummarize: false, maxTokens: 1200, maxMessagesPerRun: 4, prompt: DEFAULT_SUMMARY_PROMPT, extractionPrompt: EXTRACTION_PROMPT, compressionPrompt: '压缩以下有来源的摘要，只保留重要行动、变化和未解决事项。不得添加新事实。只输出摘要正文。', detail: 'brief', summaryOnly: false, extract: { character: true, item: true, scene: true, relation: true, fact: true, knowledge: true, milestone: true, thread: true, timeline: true, clock: true }, floorThreshold: 1, tokenThreshold: 0, keepRecent: 4, hideCovered: false, userAction: 'intent', cleanTags: ['think','thinking','analysis','reasoning'], excludeTags: ['side_story','小剧场','番外'], requireReview: true, autoCompress: false, compressThreshold: 12 },
    story: { calendar: clone(GREGORIAN), completeTimeBeforeSend: false },
    prompt: { enabled: true, sections: { summaries: true, characters: true, items: true, scenes: true, relations: true, knowledge: true, timeline: true, threads: true, rpg: false, settings: false }, actorIds: [], language: '中文', template: '{{memory}}', recentWindow: 4, maxChars: 24000 },
    worldbook: { enabled: false, bound: true, books: [], selectedEntries: [], excludedEntries: [], scanDepth: 8 },
    ui: { mode: 'light', homeVersion: 1, entries: { menu: true, top: false, bottom: false, input: false, floating: false, floor: false } },
    api: { fallbackToMain: false },
  };
}
export function normalizeP1(config) {
  const defaults = p1Defaults();
  const legacyHome = config.ui && !Object.hasOwn(config.ui, 'homeVersion');
  for (const section of Object.keys(defaults)) {
    const raw = config[section] ?? {};
    requireThat(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key => Object.hasOwn(defaults[section], key)), 'INVALID_SETTINGS', `${section} 配置包含未知字段`);
    config[section] = { ...defaults[section], ...raw };
  }
  if (legacyHome) config.ui.mode = 'light';
  config.memory.extract = { ...defaults.memory.extract, ...config.memory.extract };
  config.prompt.sections = { ...defaults.prompt.sections, ...config.prompt.sections };
  config.ui.entries = { ...defaults.ui.entries, ...config.ui.entries };
  const m = config.memory;
  for (const key of ['autoSummarize','summaryOnly','hideCovered','requireReview','autoCompress']) requireThat(typeof m[key] === 'boolean', 'INVALID_SETTINGS', '记忆开关无效');
  for (const [key, min, max] of [['maxTokens',64,8192],['maxMessagesPerRun',1,100],['floorThreshold',1,100],['tokenThreshold',0,100000],['keepRecent',0,1000],['compressThreshold',2,1000]]) requireThat(Number.isInteger(m[key]) && m[key] >= min && m[key] <= max, 'INVALID_SETTINGS', `记忆参数 ${key} 无效`);
  for (const key of ['prompt','extractionPrompt','compressionPrompt']) requireThat(typeof m[key] === 'string' && m[key].trim().length >= 10 && m[key].length <= 20000, 'INVALID_SETTINGS', '任务提示词无效');
  requireThat(['brief','detailed'].includes(m.detail) && ['intent','settled'].includes(m.userAction), 'INVALID_SETTINGS', '摘要档位或用户行动模式无效');
  for (const key of ['cleanTags','excludeTags']) requireThat(Array.isArray(m[key]) && m[key].every(x => typeof x === 'string' && /^[\p{L}\w-]{1,40}$/u.test(x)), 'INVALID_SETTINGS', '标签名无效');
  for (const [value, expected] of [[m.extract,defaults.memory.extract],[config.prompt.sections,defaults.prompt.sections],[config.ui.entries,defaults.ui.entries]]) requireThat(Object.keys(value).every(key => Object.hasOwn(expected, key)) && Object.values(value).every(x => typeof x === 'boolean'), 'INVALID_SETTINGS', '分项开关无效');
  config.story.calendar = validateCalendar(config.story.calendar);
  requireThat(typeof config.story.completeTimeBeforeSend === 'boolean' && typeof config.prompt.enabled === 'boolean' && typeof config.api.fallbackToMain === 'boolean', 'INVALID_SETTINGS', '提示配置无效');
  requireThat(Array.isArray(config.prompt.actorIds) && config.prompt.actorIds.every(x => typeof x === 'string') && typeof config.prompt.template === 'string' && config.prompt.template.includes('{{memory}}') && typeof config.prompt.language === 'string', 'INVALID_SETTINGS', '注入模板须包含 {{memory}}');
  requireThat(Number.isInteger(config.prompt.recentWindow) && config.prompt.recentWindow >= 0 && Number.isInteger(config.prompt.maxChars) && config.prompt.maxChars >= 1000 && config.prompt.maxChars <= 200000, 'INVALID_SETTINGS', '注入范围无效');
  requireThat(['light','advanced','full'].includes(config.ui.mode), 'INVALID_SETTINGS', '界面模式无效');
  requireThat(config.ui.homeVersion === 1, 'INVALID_SETTINGS', '首页配置版本无效');
  const w = config.worldbook;
  requireThat(typeof w.enabled === 'boolean' && typeof w.bound === 'boolean' && ['books','selectedEntries','excludedEntries'].every(key => Array.isArray(w[key]) && w[key].every(x => typeof x === 'string')) && Number.isInteger(w.scanDepth) && w.scanDepth >= 1 && w.scanDepth <= 100, 'INVALID_SETTINGS', '世界书配置无效');
  return config;
}
