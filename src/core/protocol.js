import { canonical, clone, CoreError, getPath, pathParts, requireThat, setPath, textId } from './util.js';
import { validateReferences } from './domain.js';

export const DOCUMENT_VERSION = 1;
export const STORAGE_KEY = 'st_memory_core';
export const MESSAGE_KEY = 'st_memory_core_id';
const origins = new Set(['human', 'model', 'system', 'import']);

export function emptyDocument(storeId, scopeKey = 'memory') {
  return { schemaVersion: DOCUMENT_VERSION, storeId, scopeKey, revision: 0, journal: [], checkpoints: [] };
}
export function emptyState() { return { entities: {}, locks: {} }; }

export function validateMessages(messages) {
  requireThat(Array.isArray(messages), 'INVALID_MESSAGES', '消息列表无效');
  const seen = new Set();
  messages.forEach((message, index) => {
    textId(message.id); textId(message.versionId); textId(message.contentHash);
    requireThat(!seen.has(message.id), 'INVALID_MESSAGES', '消息身份重复');
    seen.add(message.id);
    requireThat(message.index === index && Number.isInteger(message.swipeId) && message.swipeId >= 0, 'INVALID_MESSAGES', '消息位置或回复页无效');
    requireThat(['user', 'assistant', 'system'].includes(message.role), 'INVALID_MESSAGES', '消息角色无效');
  });
}

export function validateChanges(change) {
  textId(change.idempotencyKey, '幂等键');
  requireThat(origins.has(change.origin), 'INVALID_CHANGE', '变更来源无效');
  requireThat(Array.isArray(change.ops) && change.ops.length > 0 && change.ops.length <= 1000, 'INVALID_CHANGE', '变更操作为空或过多');
  requireThat(Array.isArray(change.evidence) && Array.isArray(change.dependsOn), 'INVALID_CHANGE', '变更依据无效');
  if (change.origin === 'model') requireThat(change.evidence.length > 0, 'MISSING_EVIDENCE', '模型写入需要正文版本依据');
  change.evidence.forEach(ref => { textId(ref.messageId); textId(ref.versionId); });
  change.dependsOn.forEach(eventId => textId(eventId));
  for (const op of change.ops) {
    textId(op.entityId);
    requireThat(['create', 'remove', 'set', 'unset', 'increment', 'lock', 'unlock', 'rename'].includes(op.type), 'INVALID_OPERATION', '操作类型无效');
    if (op.entityId.startsWith('exclusion_')) requireThat(change.origin === 'human', 'EXCLUSION_PERMISSION', '排除规则只能由人工修改');
    if (op.type === 'create') {
      textId(op.entityKind, '实体类型');
      textId(op.name, '名称');
      requireThat(Array.isArray(op.aliases ?? []), 'INVALID_OPERATION', '别名必须为数组');
      (op.aliases ?? []).forEach(alias => textId(alias, '别名'));
      requireThat(op.fields && typeof op.fields === 'object' && !Array.isArray(op.fields), 'INVALID_OPERATION', '实体字段必须为对象');
    }
    if (!['create', 'remove','rename'].includes(op.type)) pathParts(op.path);
    if (op.type === 'rename') { requireThat(change.origin === 'human', 'RENAME_PERMISSION', '名称由人工维护'); textId(op.name); requireThat(Array.isArray(op.aliases), 'INVALID_OPERATION', '别名须为数组'); op.aliases.forEach(alias => textId(alias)); }
    if (op.type === 'set') requireThat(Object.hasOwn(op, 'value'), 'INVALID_OPERATION', '缺少字段值');
    if (op.type === 'increment') requireThat(Number.isFinite(op.amount), 'INVALID_OPERATION', '增量必须为有限数字');
    if (['lock', 'unlock'].includes(op.type)) requireThat(change.origin === 'human', 'LOCK_PERMISSION', '只有人工操作可以修改锁');
  }
  clone(change);
}

export function validateDocument(raw) {
  const document = clone(raw);
  requireThat(document.schemaVersion === DOCUMENT_VERSION, 'SCHEMA_VERSION', '不支持此事实库版本');
  textId(document.storeId);
  textId(document.scopeKey, '聊天作用域');
  if (document.forkedFrom !== undefined) textId(document.forkedFrom, '父事实库 ID');
  requireThat(Array.isArray(document.journal) && Array.isArray(document.checkpoints), 'INVALID_DOCUMENT', '缺少变更记录或检查点');
  requireThat(Number.isInteger(document.revision) && document.revision === document.journal.length, 'INVALID_DOCUMENT', '事实库版本不连续');
  const ids = new Set(); const keys = new Set();
  document.journal.forEach((entry, index) => {
    textId(entry.id);
    requireThat(entry.revision === index + 1 && !ids.has(entry.id), 'INVALID_DOCUMENT', '记录版本或身份重复');
    ids.add(entry.id);
    requireThat(Number.isFinite(entry.createdAt), 'INVALID_DOCUMENT', '记录时间无效');
    if (entry.kind === 'messages') validateMessages(entry.messages);
    else {
      requireThat(entry.kind === 'changes', 'INVALID_DOCUMENT', '未知记录类型');
      validateChanges(entry);
      requireThat(entry.baseRevision === index && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint), 'INVALID_DOCUMENT', '变更前置版本或指纹无效');
      requireThat(!keys.has(entry.idempotencyKey), 'INVALID_DOCUMENT', '幂等键重复');
      keys.add(entry.idempotencyKey);
    }
  });
  // Checkpoints are derived: imports cannot substitute unchecked state for the journal.
  const checkpointIds = new Set();
  for (const point of document.checkpoints) {
    textId(point.id);
    requireThat(!checkpointIds.has(point.id) && Number.isFinite(point.createdAt), 'INVALID_DOCUMENT', '检查点身份或时间无效');
    checkpointIds.add(point.id);
    requireThat(Number.isInteger(point.revision) && point.revision >= 0 && point.revision <= document.revision, 'INVALID_DOCUMENT', '检查点版本无效');
    requireThat(canonical(point.snapshot) === canonical(project(document, point.revision)), 'INVALID_CHECKPOINT', '检查点与事件重放不一致');
  }
  return document;
}

export function currentMessages(document, revision = document.revision) {
  return document.journal.filter(entry => entry.kind === 'messages' && entry.revision <= revision).at(-1)?.messages ?? [];
}
export function lockKey(entityId, path) { return canonical([entityId, path]); }
function pathsOverlap(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((part, index) => part === right[index]);
}

export function applyOperations(state, change, { replay = false } = {}) {
  const next = clone(state);
  for (const op of change.ops) {
    const entity = Object.hasOwn(next.entities, op.entityId) ? next.entities[op.entityId] : null;
    if (op.type === 'create') {
      requireThat(!entity, 'ENTITY_EXISTS', '实体 ID 已存在');
      next.entities[op.entityId] = { id: op.entityId, kind: op.entityKind, name: op.name, aliases: clone(op.aliases ?? []), fields: clone(op.fields) };
      continue;
    }
    requireThat(entity, 'ENTITY_MISSING', '变更目标实体不存在');
    if (!replay && change.origin !== 'human') {
      const locked = Object.values(next.locks).some(lock => lock.entityId === op.entityId && (op.type === 'remove' || pathsOverlap(lock.path, op.path)));
      requireThat(!locked, 'FIELD_LOCKED', '字段已被人工锁定');
    }
    if (op.type === 'rename') { entity.name = op.name; entity.aliases = clone(op.aliases); }
    else if (op.type === 'remove') {
      delete next.entities[op.entityId];
      for (const [key, lock] of Object.entries(next.locks)) if (lock.entityId === op.entityId) delete next.locks[key];
    } else if (op.type === 'lock') next.locks[lockKey(op.entityId, op.path)] = { entityId: op.entityId, path: clone(op.path), eventId: change.id };
    else if (op.type === 'unlock') delete next.locks[lockKey(op.entityId, op.path)];
    else if (op.type === 'increment') {
      const current = getPath(entity.fields, op.path);
      requireThat(typeof current === 'number' && Number.isFinite(current + op.amount), 'INVALID_INCREMENT', '目标必须为数字且结果有限');
      setPath(entity.fields, op.path, current + op.amount);
    } else setPath(entity.fields, op.path, op.value ?? null, op.type === 'unset');
  }
  return next;
}

export function project(document, revision = document.revision) {
  requireThat(Number.isInteger(revision) && revision >= 0 && revision <= document.revision, 'INVALID_REVISION', '查询版本无效');
  const messages = clone(currentMessages(document, revision));
  const active = new Map(messages.map(message => [message.id, message.versionId]));
  const applied = new Set(); const skipped = [];
  let controls = emptyState();
  for (const entry of document.journal) {
    if (entry.revision > revision || entry.kind !== 'changes' || entry.origin !== 'human') continue;
    const ops = entry.ops.filter(op => op.entityId.startsWith('exclusion_'));
    if (ops.length) { try { controls = applyOperations(controls, { ...entry, ops }, { replay: true }); } catch { /* A malformed legacy control does not affect sources. */ } }
  }
  const excluded = new Set(Object.values(controls.entities).filter(e => e.kind === 'exclusion' && e.fields.excluded).map(e => e.fields.messageId));
  let state = emptyState();
  for (const entry of document.journal) {
    if (entry.revision > revision || entry.kind !== 'changes') continue;
    let reason = null;
    if (entry.evidence.some(ref => excluded.has(ref.messageId))) reason = 'SOURCE_EXCLUDED';
    else if (entry.evidence.some(ref => active.get(ref.messageId) !== ref.versionId)) reason = 'SOURCE_INACTIVE';
    else if (entry.dependsOn.some(dependency => !applied.has(dependency))) reason = 'DEPENDENCY_INACTIVE';
    if (!reason) {
      try { const next = applyOperations(state, entry, { replay: true }); validateReferences(next.entities); state = next; applied.add(entry.id); }
      catch (error) { if (!(error instanceof CoreError)) throw error; reason = error.code; }
    }
    if (reason) skipped.push({ eventId: entry.id, reason });
  }
  return { revision, messages, state, appliedEventIds: [...applied], skipped };
}
