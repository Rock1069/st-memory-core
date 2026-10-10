import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitFor } from './helpers.js';
import { defaults } from '../src/core/settings.js';
import { domainView } from '../src/core/domain.js';
import { compressionFrontier, summaryGraph } from '../src/core/composer.js';
import { GREGORIAN, ageAt, elapsedDays, parseStoryTime, shiftDays, validateCalendar } from '../src/core/story-time.js';

test('structured analysis is reviewed atomically and records linked entities with source versions', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop());
  f.setResponse(() => JSON.stringify({summary:{text:'旅人取得地图并承诺送信。',visibility:'public'},storyTime:'2026-10-10 09:30',changes:[
    {kind:'scene',id:'port',name:'港口',fields:{fixedFeatures:'石制码头'}},
    {kind:'character',id:'hero',name:'旅人',fields:{identity:'protagonist',current:{presence:'present',locationId:'port',clothing:'斗篷'},rank:'core'}},
    {kind:'character',id:'npc',name:'信使',fields:{current:{presence:'nearby',locationId:'port'}}},
    {kind:'item',id:'map',name:'地图',fields:{quantity:1,unit:'张',ownerId:'hero',storage:'carried',importance:'critical',visibility:'public'}},
    {kind:'relation',id:'friend',name:'旅人与信使',fields:{fromId:'hero',toId:'npc',relation:'委托',visibility:'public'}},
    {kind:'fact',id:'secret',name:'密信',fields:{text:'密信交给旅人',audienceIds:['hero']}},
    {kind:'knowledge',id:'knows',name:'旅人亲历',fields:{actorId:'hero',factId:'secret',awareness:'experienced'}},
    {kind:'thread',id:'promise',name:'送信',fields:{type:'promise',text:'送信给城主',actorIds:['hero']}},
    {kind:'milestone',id:'growth',name:'第一次受托',fields:{actorId:'hero',text:'承担送信任务'}},
    {kind:'timeline',id:'event',name:'取得地图',fields:{text:'取得地图',importance:'important',visibility:'public'}},
  ]}));
  await f.runtime.p1.range({start:1,end:1,review:true});
  const draft = Object.values(f.runtime.getSnapshot().state.entities).find(e => e.kind === 'draft');
  assert.ok(draft); assert.equal(domainView(f.runtime.getSnapshot()).characters.length,0);
  await f.runtime.p1.accept([draft.id]); const view = domainView(f.runtime.getSnapshot());
  assert.equal(view.characters.length,2); assert.equal(view.items[0].fields.quantity,1); assert.equal(view.time.hour,9);
  assert.equal(view.characters.find(e => e.name === '旅人').presence,'present'); assert.equal(f.runtime.getSnapshot().coverage.complete,true);
  await f.runtime.p1.range({start:1,end:1,review:false}); assert.equal(f.calls,1);
  f.context.chat[0].mes = '本页现在没有地图。'; await f.runtime.sync();
  assert.equal(domainView(f.runtime.getSnapshot()).items.length,0); assert.equal(f.runtime.getSnapshot().coverage.complete,false);
});

test('summary-only mode and user intent cannot create structured facts', async t => {
  const config = defaults(); config.memory.summaryOnly = true; const f = await fixture({config}); t.after(() => f.runtime.stop()); f.setResponse(() => '简明摘要');
  await f.runtime.p1.range({review:false}); assert.equal(domainView(f.runtime.getSnapshot()).characters.length,0);
  await f.runtime.settings.update({memory:{...f.runtime.settings.snapshot().memory,summaryOnly:false}});
  f.context.chat.push({mes:'我要拿走地图。',is_user:true}); await f.runtime.sync();
  await f.runtime.p1.range({start:2,end:2,review:false}); assert.equal(domainView(f.runtime.getSnapshot()).items.length,0);
});

test('field switches suppress extraction, one observation cannot create a habit, and locks block models', async t => {
  const config = defaults(); config.memory.extract.item = false; const f = await fixture({config}); t.after(() => f.runtime.stop());
  f.setResponse(() => JSON.stringify({summary:{text:'看见地图',visibility:'public'},changes:[{kind:'item',id:'map',name:'地图',fields:{quantity:2}}]}));
  await f.runtime.p1.range({review:false}); assert.equal(domainView(f.runtime.getSnapshot()).items.length,0);
  await f.runtime.p1.saveEntity({kind:'character',id:'hero',name:'旅人',fields:{current:{clothing:'人工斗篷'}}},{lock:true});
  f.context.chat.push({mes:'旅人换衣服。',is_user:false}); await f.runtime.sync();
  f.setResponse(() => JSON.stringify({summary:{text:'换衣服'},changes:[{kind:'character',id:'hero',name:'旅人',fields:{current:{clothing:'模型衣服'}}}]}));
  await assert.rejects(f.runtime.p1.range({start:2,end:2,review:false}),e => e.code === 'FIELD_LOCKED');
  assert.equal(f.runtime.getSnapshot().state.entities.hero.fields.current.clothing,'人工斗篷');
  f.setResponse(() => JSON.stringify({summary:{text:'一次行为'},changes:[{kind:'character',id:'new',name:'新人',fields:{lifeDetails:{habits:[{text:'喝茶',observations:1}]}}}]}));
  await assert.rejects(f.runtime.p1.range({start:2,end:2,review:false}),e => e.code === 'HABIT_EVIDENCE');
});

test('multi-level compression invalidates when a child is edited and rejects overlapping coverage', async t => {
  const f = await fixture({chat:[{mes:'第一事件',is_user:false},{mes:'第二事件',is_user:false},{mes:'第三事件',is_user:false}]}); t.after(() => f.runtime.stop());
  for (const message of f.runtime.getSnapshot().messages) await f.runtime.saveSummary(message.id,`摘要 ${message.index + 1}`);
  f.setResponse(() => '合并摘要'); const leaves = summaryGraph(f.runtime.getSnapshot()); const draft = await f.runtime.p1.compress(leaves.slice(0,2).map(e => e.id)); await f.runtime.p1.accept([draft.id]);
  const parent = summaryGraph(f.runtime.getSnapshot()).find(e => e.fields.childIds?.length); assert.equal(parent.valid,true);
  await assert.rejects(f.runtime.p1.compress([parent.id,leaves[0].id]),e => e.code === 'COMPRESSION_OVERLAP');
  const upper = await f.runtime.p1.compress([parent.id,leaves[2].id]); await f.runtime.p1.accept([upper.id]);
  assert.equal(compressionFrontier(f.runtime.getSnapshot()).length,1);
  await f.runtime.saveSummary(f.runtime.getSnapshot().messages[0].id,'人工修订');
  assert.equal(summaryGraph(f.runtime.getSnapshot()).filter(e => e.fields.childIds?.length && !e.valid).length,2);
  assert.equal(compressionFrontier(f.runtime.getSnapshot()).length,3);
});

test('exclusion removes prior state and summaries and restoration replays them', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop()); f.setResponse(() => JSON.stringify({summary:{text:'获得地图',visibility:'public'},changes:[{kind:'item',id:'map',name:'地图',fields:{visibility:'public'}}]}));
  await f.runtime.p1.range({review:false}); const message = f.runtime.getSnapshot().messages[0];
  await f.runtime.p1.setExcluded([message.id],true); assert.equal(domainView(f.runtime.getSnapshot()).items.length,0); assert.equal(f.runtime.getSnapshot().coverage.summary.eligible,0);
  await f.runtime.p1.setExcluded([message.id],false); assert.equal(domainView(f.runtime.getSnapshot()).items.length,1);
  f.context.chat[0].mes = '<side_story>番外事件</side_story>'; await f.runtime.sync(); assert.equal(f.runtime.getSnapshot().coverage.summary.eligible,0);
  await f.runtime.p1.setExcluded([message.id],false); assert.equal(f.runtime.getSnapshot().coverage.summary.eligible,1);
});

test('manual inventory operations are reversible and terminal threads cannot revive', async t => {
  const f = await fixture(); t.after(() => f.runtime.stop()); await f.runtime.p1.saveEntity({kind:'item',id:'item',name:'药水',fields:{quantity:3,unit:'瓶'}});
  await f.runtime.p1.saveEntity({kind:'item',id:'item',name:'药水',fields:{quantity:0,status:'consumed'}});
  const undo = Object.values(f.runtime.getSnapshot().state.entities).filter(e => e.kind === 'undo').at(-1); await f.runtime.p1.undo(undo.id); assert.equal(f.runtime.getSnapshot().state.entities.item.fields.quantity,3);
  await f.runtime.p1.saveEntity({kind:'thread',id:'promise',name:'旧约定',fields:{status:'completed'}});
  f.setResponse(() => JSON.stringify({summary:{text:'回忆约定'},changes:[{kind:'thread',id:'promise',name:'旧约定',fields:{status:'open'}}]}));
  await assert.rejects(f.runtime.p1.range({review:false}),e => e.code === 'THREAD_TERMINAL');
});

test('calendar parsing preserves unknowns, relative durations, leap days and ages', () => {
  const base = parseStoryTime('2024-02-28 09:00'); assert.equal(shiftDays(base,1).day,29); assert.equal(shiftDays(base,2).month,3);
  assert.equal(parseStoryTime('昨天',base).day,27); assert.equal(elapsedDays(base,parseStoryTime('2天后',base)),2);
  const calendar = validateCalendar({id:'fantasy',months:[{name:'霜月',days:20},{name:'花月',days:25}],leap:false}); const time = parseStoryTime('3年霜月20日',null,calendar);
  assert.equal(shiftDays(time,1,calendar).month,2); assert.equal(parseStoryTime('公历之外的未知日期',null,calendar).precision,'unknown'); assert.equal(parseStoryTime('昨天',null,calendar).precision,'unknown');
  assert.equal(ageAt(parseStoryTime('2000-10-11'),parseStoryTime('2026-10-10')),25); assert.equal(ageAt(null,base),null);
  assert.throws(() => parseStoryTime('2026-02-30'),e => e.code === 'INVALID_STORY_TIME');
});

test('batch interruption keeps accepted floors and can resume missing floors', async t => {
  const f = await fixture({chat:[{mes:'一',is_user:false},{mes:'二',is_user:false}]}); t.after(() => f.runtime.stop()); let finish;
  f.setResponse(() => f.calls === 1 ? JSON.stringify({summary:{text:'一',visibility:'public'},changes:[]}) : new Promise(resolve => {finish = resolve;}));
  const pending = f.runtime.p1.range({review:false}); await waitFor(() => typeof finish === 'function'); f.runtime.p1.stop(); finish(JSON.stringify({summary:{text:'二'},changes:[]})); await assert.rejects(pending);
  assert.equal(f.runtime.getSnapshot().coverage.summary.summarized,1); f.setResponse(() => JSON.stringify({summary:{text:'二'},changes:[]})); await f.runtime.p1.range({review:false}); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized,2);
});
