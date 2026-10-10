import { applyOperations } from './protocol.js';
import { canonical, clone, CoreError, hash, id, Mutex, requireThat } from './util.js';
import { DOMAIN_DEFAULTS, entityOperations, validateReferences } from './domain.js';
import { cleanMessageText, summaryCandidates, summaryEntityId } from './memory.js';
import { composePrompt, compressionFrontier, estimateTokens, nodeSignature, summaryGraph } from './composer.js';
import { parseStoryTime, validateStoryTime } from './story-time.js';
import { MEMORY_JSON_INSTRUCTION, parseMemoryJson } from './memory-json.js';

const evidenceOf = sources => sources.map(source => ({ messageId: source.messageId, versionId: source.versionId }));
const fieldSet = (entityId,key,value) => ({ type: 'set', entityId, path: [key], value });
function signature(entity) { return entity ? canonical(entity) : null; }
function referencedIds(value,key = '') { return Array.isArray(value) ? value.flatMap(v => referencedIds(v,key)) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name,v]) => referencedIds(v,name)) : typeof value === 'string' && /^(entityId|.*Ids?)$/.test(key) ? [value] : []; }
export class P1Service {
  constructor(runtime) { this.runtime = runtime; this.mutex = new Mutex(); this.batchController = null; this.progress = { status: 'idle', completed: 0, total: 0, nextIndex: null }; this.lastBundle = null; this.currentBundle = null; this.materials = { entries: [], materials: [], warnings: [], books: [], scanMode: 'unread' }; }
  snapshot() { return { progress: clone(this.progress), lastBundle: this.lastBundle ? clone(this.lastBundle) : null, materials: clone(this.materials) }; }
  stop() { this.runtime.stopMemoryTasks(); this.batchController?.abort(); this.runtime.scheduler.cancelWhere(task => task.module === 'memory'); }
  candidates() { return summaryCandidates(this.runtime.getSnapshot(),this.runtime.sourceData().chat,this.runtime.settings.snapshot().memory); }
  async range({ start = 1, end = Number.MAX_SAFE_INTEGER, limit = 100, missingOnly = true, review = this.runtime.settings.snapshot().memory.requireReview } = {}) {
    requireThat(Number.isInteger(start) && start >= 1 && Number.isInteger(end) && end >= start && Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_RANGE', '楼层范围或批次上限无效');
    requireThat(this.runtime.settings.enabled('memory'), 'MODULE_DISABLED', '请先启用故事记忆模块');
    return this.mutex.run(async () => {
      await this.runtime.sync(); await this.readMaterials(); const scope = this.runtime.capture().scope;
      const config = this.runtime.settings.snapshot().memory;
      const candidates = this.candidates().filter(s => s.index + 1 >= start && s.index + 1 <= end && (!missingOnly || !s.imported && (!s.summarized || !config.summaryOnly && !s.extracted))).slice(0,limit);
      const controller = new AbortController(); this.batchController = controller; this.progress = { status: 'running', completed: 0, total: candidates.length, nextIndex: candidates[0]?.index ?? null, scope };
      let proposedState = this.runtime.getSnapshot().state; const priorDraftIds = [];
      this.runtime.notify({ type: 'memory.progress' });
      try {
        for (const source of candidates) {
          requireThat(!controller.signal.aborted, 'CANCELLED', '批量分析已停止，可以从剩余缺口继续');
          requireThat(this.runtime.capture().scope === scope, 'STALE_SCOPE', '聊天已切换');
          const draft = await this.analyze(source,review ? { proposedState, priorDraftIds } : {});
          if (!review) await this.accept([draft.id]);
          else { const saved = this.runtime.getSnapshot().state.entities[draft.id]; proposedState = applyOperations(proposedState,{origin:'model',id:'batch-preview',ops:saved.fields.ops}); priorDraftIds.push(draft.id); }
          this.progress.completed++; this.progress.nextIndex = source.index + 1; this.runtime.notify({ type: 'memory.progress' });
        }
        this.progress.status = review ? 'awaiting-review' : 'completed';
        if (!review && config.hideCovered) await this.hideCovered();
        if (!review && config.autoCompress) { const nodes = compressionFrontier(this.runtime.getSnapshot()); if (nodes.length >= config.compressThreshold) { const draft = await this.compress(nodes.slice(0,config.compressThreshold).map(n => n.id)); await this.accept([draft.id]); } }
        return clone(this.progress);
      } catch (error) { this.progress.status = error.code === 'CANCELLED' ? 'stopped' : 'failed'; this.progress.error = error.message; this.progress.errorCode = error.code ?? 'UNEXPECTED'; throw error; }
      finally { this.progress.formatRetry = false; if (this.batchController === controller) this.batchController = null; this.runtime.notify({ type: 'memory.progress' }); }
    });
  }
  dependencies(ops,snapshot) {
    const targets = new Set(referencedIds(ops).filter(entityId => snapshot.state.entities[entityId])); const latest = new Map();
    for (let after = 0; ;) { const entries = this.runtime.getHistory({after,limit:1000}); if (!entries.length) break; for (const entry of entries) if (entry.kind === 'changes' && snapshot.appliedEventIds.includes(entry.id)) for (const op of entry.ops) if (targets.has(op.entityId)) latest.set(op.entityId,entry.id); after = entries.at(-1).revision; }
    return [...new Set(latest.values())];
  }
  async analyze(source,{ proposedState = null, priorDraftIds = [] } = {}) {
    const r = this.runtime; const lease = r.capture(); const currentSnapshot = r.getSnapshot(); const snapshot = proposedState ? {...currentSnapshot,state:proposedState} : currentSnapshot; const config = r.settings.snapshot();
    const active = snapshot.messages.find(m => m.id === source.messageId); requireThat(active?.versionId === source.versionId, 'SOURCE_INACTIVE', '正文已改变');
    const text = cleanMessageText(r.sourceData().chat[source.index]?.mes,config.memory.cleanTags);
    const existingDraft = Object.values(snapshot.state.entities).find(e => e.kind === 'draft' && e.fields.status === 'pending' && e.fields.sourceKey === `${source.messageId}:${source.versionId}`);
    if (existingDraft) return existingDraft;
    const pure = config.memory.summaryOnly || source.role === 'user' && config.memory.userAction === 'intent';
    const state = Object.values(snapshot.state.entities).filter(e => Object.hasOwn(DOMAIN_DEFAULTS,e.kind));
    const prompt = pure ? config.memory.prompt : config.memory.extractionPrompt;
    const previous = snapshot.messages[source.index - 1];
    const contextText = previous?.role === 'user' ? cleanMessageText(r.sourceData().chat[previous.index]?.mes,config.memory.cleanTags) : '';
    const messages = [{ role: 'system', content: `${prompt}\n输出语言：${config.prompt.language}；摘要长度：${config.memory.detail === 'detailed' ? '详细' : '精简'}。字段契约：${pure ? '' : JSON.stringify(DOMAIN_DEFAULTS)}` }, { role: 'user', content: `${pure ? '' : `当前状态（已发生）：${JSON.stringify(state)}\n故事历法：${JSON.stringify(config.story.calendar)}\n设定材料（不是剧情）：${JSON.stringify(this.materials.materials)}\n上条用户输入仅为意图：${contextText}\n`}目标正文第 ${source.index + 1} 楼（${source.role}）：\n${text}` }];
    if (!pure) messages[0].content += `\n${MEMORY_JSON_INSTRUCTION}`;
    const batch = this.batchController;
    const assertCurrent = () => { r.assertLease(lease); requireThat(!batch?.signal.aborted, 'CANCELLED', '记忆整理已停止'); };
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const requestMessages = clone(messages);
      if (attempt) requestMessages[0].content += '\n上次输出不符合记忆格式。请重新依据原始正文提取，省略解释并缩短内容，确保 JSON 完整。';
      const response = await r.gateway.request({ task: pure ? 'summary' : 'extraction', module: 'memory', key: `analysis:${source.messageId}:${source.versionId}:${attempt}`, messages: requestMessages, lease, assertCurrent, maxTokens: config.memory.maxTokens });
      assertCurrent();
      try {
        result = pure ? { summary: { text: response.trim(), visibility: 'narrator', audienceIds: [] }, changes: [], storyTime: null } : parseMemoryJson(response);
        break;
      } catch (error) {
        if (!['EXTRACTION_JSON', 'EXTRACTION_CONTRACT'].includes(error.code)) throw error;
        if (attempt) throw new CoreError(error.code, `${error.message}；自动重试一次仍未成功`, { formatAttempts: 2 });
        this.progress.formatRetry = true; r.notify({ type: 'memory.progress' });
        r.logger.write('warn', 'EXTRACTION_FORMAT_RETRY', '模型记忆格式不合格，正在自动重试一次', { reason: error.code, responseChars: response.length });
      } finally { if (attempt || result) this.progress.formatRetry = false; }
    }
    requireThat(result.summary && typeof result.summary.text === 'string' && result.summary.text.trim() && Array.isArray(result.changes ?? []) && (result.changes?.length ?? 0) <= 100, 'EXTRACTION_CONTRACT', '提取结果缺少摘要或变更列表');
    const summary = { visibility: 'narrator', audienceIds: [], ...result.summary };
    requireThat(['public','private','narrator'].includes(summary.visibility) && Array.isArray(summary.audienceIds) && summary.audienceIds.every(x => typeof x === 'string'), 'EXTRACTION_CONTRACT', '摘要可见范围无效');
    const changes = pure ? [] : (result.changes ?? []).filter(change => config.memory.extract[change.kind]);
    const temp = new Map();
    for (const change of changes) {
      requireThat(Object.hasOwn(DOMAIN_DEFAULTS,change.kind) && typeof change.id === 'string' && change.id, 'EXTRACTION_CONTRACT', '变更需要类型与 ID');
      if (!snapshot.state.entities[change.id]) {
        if (change.kind === 'clock') {temp.set(change.id,'story_clock'); continue;}
        const reused = change.kind === 'scene' ? state.find(e => e.kind === 'scene' && e.fields.parentId === (change.fields?.parentId ?? null) && [e.name,...e.aliases].includes(change.name)) : null;
        temp.set(change.id,reused?.id ?? id(change.kind));
      }
    }
    for (let pass = 0; pass < changes.length; pass++) for (const change of changes.filter(c => c.kind === 'scene' && temp.has(c.id))) { const parent = temp.get(change.fields?.parentId) ?? change.fields?.parentId ?? null; const reused = state.find(e => e.kind === 'scene' && e.fields.parentId === parent && [e.name,...e.aliases].includes(change.name)); if (reused) temp.set(change.id,reused.id); }
    const remap = (value,key = '') => Array.isArray(value) ? value.map(v => remap(v,key)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name,v]) => [name,remap(v,name)])) : typeof value === 'string' && /^(id|.*Ids?)$/.test(key) && temp.has(value) ? temp.get(value) : value;
    const ops = []; let projected = snapshot.state;
    for (const input of changes) {
      const change = remap(input); change.id = temp.get(input.id) ?? input.id;
      if (change.kind === 'clock') { requireThat(Object.keys(change.fields ?? {}).every(key => key === 'locationId'), 'CLOCK_FIELDS', '模型只可通过 clock.locationId 更新地点；时间使用 storyTime'); if (result.storyTime?.sequence === 'flashback' || typeof result.storyTime === 'string' && /^(倒叙|回忆)[：:]/.test(result.storyTime)) continue; }
      change.fields = { ...(change.fields ?? {}), sourceMessageIds: [source.messageId] };
      const generated = entityOperations({ state: projected },change,{ origin: 'model', calendar: config.story.calendar });
      ops.push(...generated.ops); projected = applyOperations(projected,{ origin: 'model', id: 'preview', ops: generated.ops });
    }
    const automaticTag = text.match(/<(?:story_time|time)\b[^>]*>([^<]+)<\/(?:story_time|time)>/i)?.[1];
    if (!pure && config.memory.extract.clock && (result.storyTime || automaticTag)) {
      const current = projected.entities.story_clock?.fields ?? DOMAIN_DEFAULTS.clock;
      const timeValue = result.storyTime ?? automaticTag;
      const time = typeof timeValue === 'string' ? parseStoryTime(timeValue,current.time,config.story.calendar) : validateStoryTime(timeValue,config.story.calendar);
      if (time.precision !== 'unknown') {
        const fields = { ...current, history: [...current.history,{ time, messageId: source.messageId }], sourceMessageIds: [source.messageId] };
        if (time.sequence !== 'flashback') fields.time = time;
        const generated = entityOperations({ state: projected },{ kind: 'clock', id: 'story_clock', name: '当前故事', fields },{ origin: 'model', calendar: config.story.calendar }); ops.push(...generated.ops); projected = applyOperations(projected,{ origin: 'model', id: 'preview', ops: generated.ops });
      }
    }
    const summaryId = summaryEntityId(source.messageId); const old = projected.entities[summaryId];
    const fields = { text: summary.text.trim(), sourceVersionId: source.versionId, sourceIndex: source.index, role: source.role, method: 'model', visibility: summary.visibility, audienceIds: remap(summary.audienceIds,'audienceIds'), extracted: !config.memory.summaryOnly, coverage: evidenceOf([source]), level: 0 };
    if (old) {
      for (const [key,value] of Object.entries(fields)) { if (key === 'text' && Object.values(projected.locks).some(lock => lock.entityId === summaryId && lock.path[0] === 'text')) continue; ops.push(fieldSet(summaryId,key,value)); }
    } else ops.push({ type: 'create', entityId: summaryId, entityKind: 'summary', name: `第 ${source.index + 1} 楼`, fields });
    projected = applyOperations(snapshot.state,{ origin: 'model', id: 'preview', ops }); validateReferences(projected.entities);
    requireThat(fields.audienceIds.every(actor => projected.entities[actor]?.kind === 'character'), 'ENTITY_REFERENCE', '摘要可见角色不存在');
    const evidence = evidenceOf([source]); if (!pure && previous?.role === 'user') evidence.push({ messageId: previous.id, versionId: previous.versionId });
    return this.createDraft({ type: 'analysis', sourceKey: `${source.messageId}:${source.versionId}`, text: summary.text, ops, evidence, targets: [...new Set(ops.map(op => op.entityId))], snapshot, dependsOn: this.dependencies(ops,currentSnapshot), metadata: { priorDraftIds: [...priorDraftIds] } },lease);
  }
  async createDraft({ type, sourceKey = '', text, ops, evidence, targets, snapshot, dependsOn = [], metadata = {} },lease) {
    const draftId = id('draft');
    const result = await this.runtime.commit({ idempotencyKey: draftId, origin: 'model', evidence, dependsOn, ops: [{ type: 'create', entityId: draftId, entityKind: 'draft', name: `${type} 待审阅`, fields: { type, sourceKey, text, status: 'pending', ops, evidence, dependsOn, targetSignatures: Object.fromEntries(targets.map(target => [target,signature(snapshot.state.entities[target])])), metadata } }] },lease);
    return { id: draftId, eventId: result.eventId };
  }
  async accept(draftIds) {
    requireThat(Array.isArray(draftIds) && draftIds.length > 0, 'DRAFT_INACTIVE', '请选择审阅结果');
    const ordered = []; const visiting = new Set();
    const collect = draftId => { const draft = this.runtime.getSnapshot().state.entities[draftId]; requireThat(draft?.kind === 'draft' && ['pending','accepted'].includes(draft.fields.status), 'DRAFT_INACTIVE', '审阅结果已失效、被拒绝或已提交'); if (draft.fields.status === 'accepted' || ordered.includes(draftId)) return; requireThat(!visiting.has(draftId), 'DRAFT_CONFLICT', '审阅依赖形成循环'); visiting.add(draftId); for (const prior of draft.fields.metadata.priorDraftIds ?? []) collect(prior); visiting.delete(draftId); ordered.push(draftId); };
    await this.runtime.sync(); draftIds.forEach(collect); let result = {duplicate:true};
    for (const draftId of ordered) {
      await this.runtime.sync(); const snapshot = this.runtime.getSnapshot(); const lease = this.runtime.capture(); const draft = snapshot.state.entities[draftId]; requireThat(draft?.kind === 'draft' && draft.fields.status === 'pending', 'DRAFT_INACTIVE', '审阅结果已失效');
      for (const [target,expected] of Object.entries(draft.fields.targetSignatures)) requireThat(signature(snapshot.state.entities[target]) === expected, 'DRAFT_CONFLICT', '相关状态已变，请重新分析后审阅');
      if (draft.fields.type === 'compression') for (const [child,expected] of Object.entries(draft.fields.metadata.childSignatures)) requireThat(snapshot.state.entities[child] && nodeSignature(snapshot.state.entities[child]) === expected, 'DRAFT_CONFLICT', '子摘要已变化，请重新压缩');
      const ops = [...draft.fields.ops,fieldSet(draftId,'status','accepted')]; const state = applyOperations(snapshot.state,{ origin: 'model', id: 'preview', ops }); validateReferences(state.entities);
      const dependencies = [...new Set([...draft.fields.dependsOn,...this.dependencies(draft.fields.ops,snapshot)])];
      result = await this.runtime.commit({ idempotencyKey: `accept:${draftId}`, origin: 'model', evidence: draft.fields.evidence, dependsOn: dependencies, ops },lease);
    }
    if (!Object.values(this.runtime.getSnapshot().state.entities).some(e => e.kind === 'draft' && e.fields.status === 'pending') && this.progress.status === 'awaiting-review') {this.progress.status = 'completed'; this.runtime.notify({type:'memory.progress'});}
    return result;
  }
  async reject(draftId) { return this.manual([fieldSet(draftId,'status','rejected')],'拒绝审阅'); }
  async compress(nodeIds) {
    await this.runtime.sync(); const snapshot = this.runtime.getSnapshot(); const lease = this.runtime.capture(); const nodes = summaryGraph(snapshot).filter(n => nodeIds.includes(n.id));
    requireThat(nodes.length === nodeIds.length && nodes.length >= 2 && nodes.every(n => n.valid), 'COMPRESSION_RANGE', '选择至少两个有效摘要节点');
    const refs = nodes.flatMap(n => n.coverage); requireThat(new Set(refs.map(r => r.messageId)).size === refs.length, 'COMPRESSION_OVERLAP', '选择的摘要覆盖范围重叠');
    requireThat(!summaryGraph(snapshot).some(n => n.valid && n.fields.childIds?.length && canonical(n.coverage.map(r => r.messageId).sort()) === canonical(refs.map(r => r.messageId).sort())), 'COMPRESSION_DUPLICATE', '该范围已存在有效压缩节点');
    const config = this.runtime.settings.snapshot();
    const text = await this.runtime.gateway.request({ task: 'compression', module: 'memory', key: `compress:${await hash(nodes.map(nodeSignature))}`, messages: [{ role: 'system', content: config.memory.compressionPrompt }, { role: 'user', content: nodes.map(n => n.fields.text).join('\n\n') }], lease, assertCurrent: () => this.runtime.assertLease(lease), maxTokens: config.memory.maxTokens });
    requireThat(text.trim(), 'INVALID_SUMMARY', '压缩结果为空，未创建节点');
    const audience = nodes.filter(n => n.fields.visibility !== 'public').reduce((actors,n,index) => index === 0 ? n.fields.audienceIds ?? [] : actors.filter(actor => n.fields.audienceIds?.includes(actor)),[]);
    const childSignatures = Object.fromEntries(nodes.map(n => [n.id,nodeSignature(n)])); const nodeId = id('summaryNode');
    const fields = { text: text.trim(), coverage: refs, childIds: nodeIds, childSignatures, level: 1 + Math.max(...nodes.map(n => n.fields.level ?? 0)), disabled: false, visibility: nodes.every(n => n.fields.visibility === 'public') ? 'public' : nodes.some(n => n.fields.visibility === 'narrator' || !n.fields.visibility) ? 'narrator' : 'private', audienceIds: audience };
    return this.createDraft({ type: 'compression', text, ops: [{ type: 'create', entityId: nodeId, entityKind: 'summaryNode', name: `压缩 ${refs.length} 楼`, fields }], evidence: refs, targets: [nodeId], snapshot, metadata: { childSignatures } },lease);
  }
  async manual(ops,label = '人工更正',evidence = [],expected = null) {
    await this.runtime.sync(); const snapshot = this.runtime.getSnapshot(); const lease = this.runtime.capture();
    requireThat(ops.length > 0, 'EMPTY_CHANGE', '没有选定的变更');
    if (expected) for (const [target,value] of Object.entries(expected)) requireThat(signature(snapshot.state.entities[target]) === value, 'UNDO_CONFLICT', '目标已有后续修改');
    const after = applyOperations(snapshot.state,{ origin: 'human', id: 'preview', ops }); validateReferences(after.entities);
    const targets = [...new Set(ops.map(op => op.entityId))]; const inverse = [];
    for (const target of targets) {
      if (after.entities[target]) inverse.push({ type: 'remove', entityId: target });
      const before = snapshot.state.entities[target]; if (before) { inverse.push({ type: 'create', entityId: target, entityKind: before.kind, name: before.name, aliases: before.aliases, fields: before.fields }); for (const lock of Object.values(snapshot.state.locks).filter(l => l.entityId === target)) inverse.push({ type: 'lock', entityId: target, path: lock.path }); }
    }
    const undoId = id('undo');
    return this.runtime.commit({ idempotencyKey: undoId, origin: 'human', evidence, ops: [...ops,{ type: 'create', entityId: undoId, entityKind: 'undo', name: label, fields: { inverse, targets, afterSignatures: Object.fromEntries(targets.map(target => [target,signature(after.entities[target])])), used: false } }] },lease);
  }
  async undo(undoId) { const snapshot = this.runtime.getSnapshot(); const undo = snapshot.state.entities[undoId]; requireThat(undo?.kind === 'undo' && !undo.fields.used, 'UNDO_UNAVAILABLE', '没有可撤销的记录'); return this.manual([...undo.fields.inverse,fieldSet(undoId,'used',true)],`撤销 ${undo.name}`,[],undo.fields.afterSignatures); }
  async reviseDraft(draftId,text) { requireThat(typeof text === 'string' && text.trim(), 'INVALID_SUMMARY', '摘要不能为空'); const draft = this.runtime.getSnapshot().state.entities[draftId]; requireThat(draft?.kind === 'draft' && draft.fields.status === 'pending', 'DRAFT_INACTIVE', '结果已失效'); const ops = draft.fields.ops.map(op => op.type === 'create' && ['summary','summaryNode'].includes(op.entityKind) ? {...op,fields:{...op.fields,text:text.trim()}} : op.type === 'set' && op.entityId.startsWith('summary_') && op.path[0] === 'text' ? {...op,value:text.trim()} : op); return this.manual([fieldSet(draftId,'ops',ops),fieldSet(draftId,'text',text.trim())],'修订分析结果'); }
  async saveEntity(input,{ lock = false } = {}) { await this.runtime.sync(); const config = this.runtime.settings.snapshot(); const generated = entityOperations(this.runtime.getSnapshot(),input,{ calendar: config.story.calendar }); if (!generated.ops.length) return { unchanged: true }; if (lock) for (const key of Object.keys(input.fields ?? {})) generated.ops.push({ type: 'lock', entityId: generated.entityId, path: [key] }); return this.manual(generated.ops,`编辑 ${input.name}`); }
  async removeEntities(ids) { requireThat(ids.length > 0, 'INVALID_QUERY', '请选择记录'); return this.manual(ids.map(entityId => ({ type: 'remove', entityId })),'删除记录'); }
  async setExcluded(messageIds,excluded) {
    await this.runtime.sync(); const snapshot = this.runtime.getSnapshot();
    requireThat(messageIds.length > 0 && messageIds.every(messageId => snapshot.messages.some(m => m.id === messageId)), 'INVALID_RANGE', '没有选定有效正文');
    const ops = messageIds.flatMap(messageId => { const version = snapshot.messages.find(m => m.id === messageId).versionId; return snapshot.state.entities[`exclusion_${messageId}`] ? [fieldSet(`exclusion_${messageId}`,'excluded',excluded),fieldSet(`exclusion_${messageId}`,'manual',excluded),fieldSet(`exclusion_${messageId}`,'tagOverride',!excluded),fieldSet(`exclusion_${messageId}`,'tagOverrideVersion',version)] : [{ type: 'create', entityId: `exclusion_${messageId}`, entityKind: 'exclusion', name: '正文排除', fields: { messageId, excluded, manual: excluded, tag: false, tagOverride: !excluded, tagOverrideVersion: version } }]; });
    const result = await this.manual(ops,excluded ? '排除正文' : '恢复正文'); await this.refreshPrompt(); return result;
  }
  tagOperations(snapshot,chat) {
    const tags = this.runtime.settings.snapshot().memory.excludeTags; const ops = [];
    for (const message of snapshot.messages) {
      const tagged = tags.some(tag => new RegExp(`<${tag}\\b`,'i').test(chat[message.index]?.mes ?? '')); const entityId = `exclusion_${message.id}`; const current = snapshot.state.entities[entityId];
      if (current?.fields.tagOverride && current.fields.tagOverrideVersion === message.versionId) continue;
      if (!current && tagged) ops.push({ type: 'create', entityId, entityKind: 'exclusion', name: '标签排除', fields: { messageId: message.id, excluded: true, manual: false, tag: true, tagOverride: false } });
      else if (current && (!!current.fields.tag !== tagged || current.fields.tagOverride)) ops.push(fieldSet(entityId,'tag',tagged),fieldSet(entityId,'excluded',!!current.fields.manual || tagged),fieldSet(entityId,'tagOverride',false));
    }
    return ops.slice(0,900);
  }
  async hideCovered(restore = false) {
    await this.runtime.sync(); const snapshot = this.runtime.getSnapshot(); const config = this.runtime.settings.snapshot();
    const cutoff = snapshot.messages.length - config.memory.keepRecent; const ids = restore ? snapshot.messages.map(m => m.id) : this.candidates().filter(s => s.summarized && s.index < cutoff).map(s => s.messageId);
    requireThat(typeof this.runtime.host.hideMessages === 'function', 'HOST_CAPABILITY', '宿主无法维护隐藏归属'); const count = await this.runtime.host.hideMessages(this.runtime.host.capture(),ids,restore); await this.runtime.sync(); return count;
  }
  async readMaterials() { const lease = this.runtime.capture(); const config = this.runtime.settings.snapshot(); this.materials = typeof this.runtime.host.worldbookMaterials === 'function' ? await this.runtime.host.worldbookMaterials({...config.worldbook,enabled:this.runtime.settings.enabled('memory') && config.worldbook.enabled}) : { materials: [], entries: [], books: [], warnings: ['宿主不支持世界书读取'], scanMode: 'unavailable' }; this.runtime.assertLease(lease); this.runtime.notify({ type: 'materials.changed' }); return clone(this.materials); }
  actorIds() { const config = this.runtime.settings.snapshot(); if (config.prompt.actorIds.length) return config.prompt.actorIds; const context = this.runtime.host.context(); const key = this.runtime.capture().identity.characterKey; const name = context?.name2 ?? context?.characters?.[Number(context.characterId)]?.name; const matches = Object.values(this.runtime.getSnapshot().state.entities).filter(e => e.kind === 'character' && (e.fields.hostCharacterKey === key || name && e.name === name)); return matches.length === 1 ? [matches[0].id] : []; }
  previewPrompt() { const snapshot = this.runtime.getSnapshot(); if (!snapshot.active || snapshot.coverage.reason === 'SOURCE_UNSYNCED') return { text: '', delivery: 'unavailable', reason: snapshot.coverage.reason, sections: [], sourceIds: [], tokenCount: 0, tokenCountKind: 'estimate' }; return composePrompt(snapshot,this.runtime.settings.snapshot(),{ actorIds: this.actorIds(), materials: this.materials.materials }); }
  async refreshPrompt() { const bundle = this.previewPrompt(); const delivered = this.runtime.host.setMemoryPrompt?.(bundle.text ?? '') ?? false; this.currentBundle = { ...bundle, delivery: delivered ? 'registered' : 'unsupported' }; this.runtime.notify({ type: 'prompt.changed' }); return clone(this.currentBundle); }
  async beforeGenerate() { await this.runtime.sync(); await this.readMaterials(); const bundle = await this.refreshPrompt(); this.lastBundle = { ...bundle, delivery: bundle.delivery === 'registered' ? 'submitted-to-host' : bundle.delivery }; return clone(this.lastBundle); }
  migrationPreview(raw,{ start = 1, end = start, conflict = 'ask' } = {}) {
    const snapshot = this.runtime.getSnapshot(); const refs = snapshot.messages.filter(m => m.index + 1 >= start && m.index + 1 <= end).map(m => ({ messageId: m.id, versionId: m.versionId })); requireThat(refs.length && start >= 1 && end >= start, 'MIGRATION_RANGE', '请选择有效覆盖范围');
    const input = typeof raw === 'string' ? { summary: raw } : clone(raw);
    requireThat(input && typeof input === 'object' && !Array.isArray(input) && (typeof input.summary === 'string' && input.summary.trim() || Array.isArray(input.entities) && input.entities.length), 'MIGRATION_FORMAT', '导入需要非空总结文本或实体列表');
    requireThat(['public','private','narrator'].includes(input.visibility ?? 'narrator') && Array.isArray(input.audienceIds ?? []) && (input.audienceIds ?? []).every(x => typeof x === 'string'), 'VISIBILITY_FIELDS', '导入总结可见范围无效');
    const entities = Array.isArray(input.entities) ? input.entities : []; const known = ['summary','entities','visibility','audienceIds','format','version']; const unknown = Object.keys(input).filter(key => !known.includes(key));
    const conflicts = entities.filter(e => e.id && snapshot.state.entities[e.id]).map(e => e.id);
    return { input, refs, conflicts, conflict, unknownFields: unknown, uncoveredCount: snapshot.messages.length - refs.length, warning: '只有选定范围的最终总结，不包含完整逐楼历史；未知字段会保留在导入备份。', sourceRevision: snapshot.revision, sourceSignature: this.runtime.capture().signature };
  }
  async migrate(preview) {
    await this.runtime.sync(); requireThat(this.runtime.capture().signature === preview.sourceSignature && this.runtime.getSnapshot().revision === preview.sourceRevision, 'MIGRATION_STALE', '预览后数据已变化，请重新预览');
    requireThat(!preview.conflicts.length || ['keep','replace'].includes(preview.conflict), 'MIGRATION_CONFLICT', '请先选择保留或替换冲突');
    const snapshot = this.runtime.getSnapshot(); const ops = [];
    for (const input of preview.input.entities ?? []) { if (preview.conflicts.includes(input.id) && preview.conflict === 'keep') continue; ops.push(...entityOperations(snapshot,input,{ origin: 'import', calendar: this.runtime.settings.snapshot().story.calendar }).ops); }
    const proposed = applyOperations(snapshot.state,{origin:'human',id:'import-preview',ops});
    requireThat((preview.input.audienceIds ?? []).every(actor => proposed.entities[actor]?.kind === 'character'), 'ENTITY_REFERENCE', '导入总结可见角色不存在');
    if (typeof preview.input.summary === 'string' && preview.input.summary.trim()) ops.push({ type: 'create', entityId: id('summaryNode'), entityKind: 'summaryNode', name: '导入旧总结', fields: { text: preview.input.summary.trim(), coverage: preview.refs, childIds: [], level: 0, disabled: false, visibility: preview.input.visibility ?? 'narrator', audienceIds: preview.input.audienceIds ?? [], imported: true, structuredCovered: false } });
    ops.push({ type: 'create', entityId: id('importArchive'), entityKind: 'importArchive', name: '导入原始备份', fields: { raw: preview.input, unknownFields: preview.unknownFields, coverage: preview.refs, warning: preview.warning } });
    return this.manual(ops,'导入旧总结与状态',preview.refs);
  }
  diagnostics() { const snapshot = this.runtime.getSnapshot(); const graph = snapshot.active ? summaryGraph(snapshot) : []; return { revision: snapshot.revision ?? null, coverage: snapshot.coverage, staleNodes: graph.filter(n => !n.valid).map(n => ({ id: n.id, reason: n.reason })), inactiveEvents: snapshot.skipped ?? [], progress: clone(this.progress), index: { available: false, reason: 'P2 尚未启用向量索引；P1 使用摘要和结构化状态' }, host: this.runtime.host.capabilities() }; }
  automaticReady() {
    const config = this.runtime.settings.snapshot().memory; const sources = this.candidates().filter(s => !s.imported && (!s.summarized || !config.summaryOnly && !s.extracted)); const tokens = sources.reduce((sum,s) => sum + estimateTokens(this.runtime.sourceData().chat[s.index]?.mes ?? ''),0);
    return sources.length >= config.floorThreshold || config.tokenThreshold > 0 && tokens >= config.tokenThreshold;
  }
}
