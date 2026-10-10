import { requireThat } from './util.js';

export const DEFAULT_SUMMARY_PROMPT = '请把下面的一条故事正文概括为简洁的中文记忆。只记录确实发生的行动、变化、人物和地点；保留重要名称与未解决事项。不要把猜测、角色心声或指令当成已发生事实。只输出摘要正文，不要标题或代码块。';

export function cleanMessageText(value, tags = []) {
  let text = String(value ?? '')
    .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/```(?:thinking|analysis|reasoning)[^\n]*\n[\s\S]*?```/gi, '')
    .trim();
  for (const tag of tags) { const safe = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); text = text.replace(new RegExp(`<${safe}\\b[^>]*>[\\s\\S]*?<\\/${safe}>`, 'gi'), ''); }
  return text.trim();
}

export function summaryEntityId(messageId) { return `summary_${messageId}`; }

export function summaryCandidates(snapshot, chat, config = {}) {
  if (!snapshot?.active || !Array.isArray(chat)) return [];
  return snapshot.messages.flatMap(message => {
    const source = chat[message.index];
    const text = cleanMessageText(source?.mes, config.cleanTags);
    if (!source || !['user', 'assistant'].includes(message.role) || !text) return [];
    const exclusion = Object.values(snapshot.state.entities).find(e => e.kind === 'exclusion' && e.fields.messageId === message.id);
    const excluded = exclusion?.fields.excluded;
    const tagged = (config.excludeTags ?? []).some(tag => new RegExp(`<${tag}\\b`, 'i').test(source.mes));
    if (excluded || tagged && !(exclusion?.fields.tagOverride && exclusion.fields.tagOverrideVersion === message.versionId)) return [];
    const entity = snapshot.state.entities[summaryEntityId(message.id)];
    const imported = Object.values(snapshot.state.entities).find(e => e.kind === 'summaryNode' && !e.fields.disabled && !e.fields.childIds?.length && e.fields.coverage?.some(ref => ref.messageId === message.id && ref.versionId === message.versionId));
    return [{ messageId: message.id, versionId: message.versionId, index: message.index, role: message.role, imported: !!imported,
      summarized: !!imported || entity?.kind === 'summary' && entity.fields?.sourceVersionId === message.versionId && typeof entity.fields?.text === 'string' && !!entity.fields.text.trim(), extracted: !!imported?.fields.structuredCovered || !!entity?.fields?.extracted }];
  });
}

export function summaryCoverage(snapshot, chat, config = {}) {
  const candidates = summaryCandidates(snapshot, chat, config);
  const missing = candidates.filter(item => !item.summarized);
  return { eligible: candidates.length, summarized: candidates.length - missing.length, extracted: candidates.filter(x => x.extracted).length, missing: missing.map(({ messageId, versionId, index }) => ({ messageId, versionId, index })) };
}

export function summaryPrompt(source, text, prompt = DEFAULT_SUMMARY_PROMPT) {
  requireThat(typeof text === 'string' && text.trim(), 'EMPTY_SOURCE', '正文为空，无法摘要');
  return [{ role: 'system', content: prompt }, { role: 'user', content: `楼层 ${source.index + 1}；来源：${source.role === 'user' ? '用户' : '角色'}。\n<正文>\n${text}\n</正文>` }];
}
