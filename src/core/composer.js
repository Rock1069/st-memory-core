import { canonical, clone } from './util.js';
import { domainView } from './domain.js';

export const estimateTokens = text => Math.ceil([...String(text)].reduce((sum, char) => sum + (/[\u3000-\u9fff]/.test(char) ? 1 : .28), 0));
export function nodeSignature(entity) { return canonical([entity.id, entity.fields.text ?? '', entity.fields.coverage ?? [], entity.fields.childIds ?? [], entity.fields.visibility ?? 'narrator', entity.fields.audienceIds ?? [], entity.fields.disabled ?? false]); }
export function summaryGraph(snapshot) {
  const nodes = Object.values(snapshot.state.entities).filter(e => ['summary','summaryNode'].includes(e.kind)).map(e => ({ ...clone(e), valid: true, reason: null }));
  const map = new Map(nodes.map(node => [node.id, node])); const active = new Map(snapshot.messages.map(m => [m.id,m.versionId])); const visiting = new Set(); const done = new Set();
  const visit = node => {
    if (done.has(node.id)) return node.valid;
    if (visiting.has(node.id)) { node.valid = false; node.reason = 'CYCLE'; return false; }
    visiting.add(node.id);
    const f = node.fields;
    if (f.disabled) { node.valid = false; node.reason = 'DISABLED'; }
    const coverage = f.coverage ?? (f.sourceVersionId ? [{ messageId: node.id.slice('summary_'.length), versionId: f.sourceVersionId }] : []);
    node.coverage = coverage;
    if (!coverage.length || coverage.some(ref => active.get(ref.messageId) !== ref.versionId)) { node.valid = false; node.reason = 'SOURCE_INACTIVE'; }
    for (const childId of f.childIds ?? []) {
      const child = map.get(childId);
      if (!child || !visit(child) || f.childSignatures?.[childId] !== nodeSignature(child)) { node.valid = false; node.reason = 'CHILD_CHANGED'; }
    }
    visiting.delete(node.id); done.add(node.id); return node.valid;
  };
  nodes.forEach(visit); return nodes;
}
export function compressionFrontier(snapshot) {
  const graph = summaryGraph(snapshot).filter(node => node.valid); const children = new Set(graph.flatMap(node => node.fields.childIds ?? [])); const covered = new Set(); const roots = [];
  for (const node of graph.filter(node => !children.has(node.id)).sort((a,b) => (b.fields.level ?? 0) - (a.fields.level ?? 0) || b.coverage.length - a.coverage.length)) if (!node.coverage.some(ref => covered.has(ref.messageId))) { roots.push(node); node.coverage.forEach(ref => covered.add(ref.messageId)); }
  return roots.sort((a,b) => Math.min(...a.coverage.map(ref => snapshot.messages.find(m => m.id === ref.messageId).index)) - Math.min(...b.coverage.map(ref => snapshot.messages.find(m => m.id === ref.messageId).index)));
}
export function visibleTo(fields, actors, entities, ownerId = null) {
  if (fields.visibility === 'public') return true;
  if (fields.visibility === 'narrator' || !actors.length) return false;
  return actors.every(actorId => actorId === ownerId || fields.audienceIds?.includes(actorId) || Object.values(entities).some(e => e.kind === 'knowledge' && e.fields.actorId === actorId && e.fields.factId === fields.factId && ['experienced','heard','suspected'].includes(e.fields.awareness)));
}
export function composePrompt(snapshot, settings, { actorIds = settings.prompt.actorIds, materials = [] } = {}) {
  const view = domainView(snapshot); const entities = snapshot.state.entities; const sections = []; const covered = new Set();
  if (!Array.isArray(actorIds) || actorIds.some(actor => entities[actor]?.kind !== 'character')) actorIds = [];
  const add = (kind, text, sourceIds) => { if (text) sections.push({ kind, text, sourceIds: [...new Set(sourceIds)] }); };
  const enabled = settings.enabled && settings.modules.memory && settings.prompt.enabled;
  if (enabled) {
    const p = settings.prompt.sections; const location = view.locationId;
    if (settings.story.completeTimeBeforeSend && view.time?.precision !== 'unknown' && view.time) add('time', `当前故事时间（不是保存时间）：${JSON.stringify(view.time)}`, ['story_clock']);
    if (p.characters) {
      for (const entity of view.characters.filter(e => e.fields.pinned || e.fields.starred || e.fields.rank === 'core' || ['present','following','nearby'].includes(e.presence))) {
        const self = actorIds.length === 1 && actorIds[0] === entity.id; const f = entity.fields;
        add('characters', `${entity.name} [${entity.id}]：${JSON.stringify({ identity: f.identity, appearance: f.profile.appearance, clothing: f.current.clothing, body: f.current.body, presence: entity.presence, locationId: f.current.locationId, age: entity.age, ...(self ? { personality: f.profile.personality, experiences: f.profile.experiences, emotion: f.current.emotion, lifeDetails: f.lifeDetails, innerAttitude: f.innerAttitude, outerAttitude: f.outerAttitude, affection: f.affection } : {}) })}`, [entity.id]);
      }
    }
    if (p.items) for (const e of view.items) if (e.fields.status === 'active' && e.fields.quantity > 0 && (e.fields.importance === 'critical' || e.fields.storage === 'carried' || location && e.fields.locationId === location) && visibleTo(e.fields,actorIds,entities,e.fields.ownerId)) add('items', `${e.name} [${e.id}]：${JSON.stringify(e.fields)}`, [e.id]);
    if (p.scenes && location) { let current = entities[location]; const seen = new Set(); while (current?.kind === 'scene' && !seen.has(current.id)) { seen.add(current.id); add('scenes', `${current.name}：${JSON.stringify(current.fields)}`,[current.id]); current = entities[current.fields.parentId]; } }
    if (p.relations) for (const e of Object.values(entities).filter(e => e.kind === 'relation')) if (visibleTo(e.fields,actorIds,entities)) add('relations', `${e.name}：${JSON.stringify(e.fields)}`,[e.id]);
    if (p.knowledge) for (const e of Object.values(entities).filter(e => e.kind === 'fact')) {
      const knows = actorIds.length && actorIds.every(actor => Object.values(entities).some(k => k.kind === 'knowledge' && k.fields.factId === e.id && k.fields.actorId === actor && k.fields.awareness !== 'unknown'));
      if (e.fields.visibility === 'public' || knows || visibleTo(e.fields,actorIds,entities)) add('knowledge', `${e.name}：${e.fields.text}（${actorIds.map(actor => Object.values(entities).find(k => k.kind === 'knowledge' && k.fields.factId === e.id && k.fields.actorId === actor)?.fields.awareness ?? '公开').join('、')}）`,[e.id]);
    }
    if (p.summaries) {
      const cutoff = snapshot.messages.length - settings.prompt.recentWindow;
      const nodes = summaryGraph(snapshot).filter(n => n.valid && visibleTo(n.fields,actorIds,entities) && n.coverage.every(ref => snapshot.messages.find(m => m.id === ref.messageId)?.index < cutoff)).sort((a,b) => (b.fields.level ?? 0) - (a.fields.level ?? 0) || b.coverage.length - a.coverage.length);
      for (const node of nodes) { if (node.coverage.some(ref => covered.has(ref.messageId))) continue; node.coverage.forEach(ref => covered.add(ref.messageId)); add('summaries', node.fields.text,[node.id,...node.coverage.map(ref => ref.messageId)]); }
    }
    if (p.timeline) for (const e of Object.values(entities).filter(e => e.kind === 'timeline')) if (!(e.fields.sourceMessageIds ?? []).some(id => covered.has(id)) && visibleTo(e.fields,actorIds,entities)) add('timeline', `${e.fields.importance}：${e.fields.text} ${e.fields.storyTime ? JSON.stringify(e.fields.storyTime) : ''}`,[e.id]);
    if (p.threads) for (const e of Object.values(entities).filter(e => e.kind === 'thread' && e.fields.status === 'open')) if (visibleTo(e.fields,actorIds,entities) || actorIds.length && actorIds.every(actor => e.fields.actorIds.includes(actor))) add('threads', `${e.fields.type}：${e.fields.text}；期限 ${e.fields.deadline ?? '未知'}`,[e.id]);
    if (p.settings) for (const material of materials) add('settings', `设定材料（不代表已发生剧情）：${material.text}`,[material.id]);
  }
  let used = 0; const accepted = []; const dropped = [];
  for (const section of sections) { if (used + section.text.length > settings.prompt.maxChars) dropped.push(...section.sourceIds); else { accepted.push(section); used += section.text.length; } }
  const memory = accepted.map(s => `[${s.kind}]\n${s.text}`).join('\n\n');
  const text = memory ? settings.prompt.template.replaceAll('{{memory}}',memory).replaceAll('{{storyTime}}',view.time?.raw ?? '未知').replaceAll('{{location}}',entities[view.locationId]?.name ?? '未知').replaceAll('{{language}}',settings.prompt.language) : '';
  return { revision: snapshot.revision, actorIds: clone(actorIds), text, sections: accepted, sourceIds: [...new Set(accepted.flatMap(s => s.sourceIds))], droppedSourceIds: dropped, tokenCount: estimateTokens(text), tokenCountKind: 'estimate', delivery: 'preview', privacy: actorIds.length ? 'actor-scoped' : 'public-only' };
}
