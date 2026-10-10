import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, waitFor } from './helpers.js';
import { defaults, validateSettings } from '../src/core/settings.js';
import { composePrompt, summaryGraph } from '../src/core/composer.js';
import { domainView } from '../src/core/domain.js';
import { scanEntries } from '../src/core/worldbook.js';
import { parseStoryTime } from '../src/core/story-time.js';

test('batch review uses prior proposed state and acceptance preserves per-floor dependencies',async t => {
  const f = await fixture({chat:[{mes:'得药三瓶',is_user:false},{mes:'消耗一瓶',is_user:false}]}); t.after(() => f.runtime.stop());
  f.setResponse(request => { const state = request.prompt[1].content; const known = state.match(/"id":"(item_[^"]+)"/); return JSON.stringify({summary:{text:f.calls === 1 ? '得药三瓶' : '消耗一瓶',visibility:'public'},changes:[{kind:'item',id:known?.[1] ?? 'potion',name:'药水',fields:{quantity:f.calls === 1 ? 3 : 2,unit:'瓶',visibility:'public'}}]}); });
  await f.runtime.p1.range({review:true}); const drafts = Object.values(f.runtime.getSnapshot().state.entities).filter(e => e.kind === 'draft');
  assert.equal(drafts.length,2); assert.equal(domainView(f.runtime.getSnapshot()).items.length,0); await f.runtime.p1.accept([drafts[1].id]);
  assert.equal(domainView(f.runtime.getSnapshot()).items.length,1); assert.equal(domainView(f.runtime.getSnapshot()).items[0].fields.quantity,2); await f.runtime.p1.accept([drafts[1].id]); assert.equal(f.calls,2);
  f.context.chat[0].mes = '没有药水'; await f.runtime.sync(); assert.equal(domainView(f.runtime.getSnapshot()).items.length,0); assert.ok(f.runtime.getSnapshot().skipped.some(x => x.reason === 'DEPENDENCY_INACTIVE'));
});

test('composer scopes private summaries, facts, inventory and character internals to known actors',async t => {
  const f = await fixture({chat:[{mes:'私密谈话',is_user:false},{mes:'近期正文',is_user:false}]}); t.after(() => f.runtime.stop());
  for (const input of [
    {kind:'scene',id:'port',name:'港口',fields:{}},{kind:'scene',id:'vault',name:'仓库',fields:{}},
    {kind:'character',id:'a',name:'甲',fields:{rank:'core',profile:{personality:'甲的内心秘密'},current:{emotion:'秘密情绪',locationId:'port'}}},
    {kind:'character',id:'b',name:'乙',fields:{current:{presence:'following'}}},
    {kind:'clock',id:'story_clock',name:'当前故事',fields:{time:parseStoryTime('2026-10-10'),locationId:'port'}},
    {kind:'fact',id:'secret',name:'秘密',fields:{text:'密令只给甲'}},
    {kind:'knowledge',id:'k',name:'甲认知',fields:{actorId:'a',factId:'secret',awareness:'heard',sourceActorId:'b'}},
    {kind:'item',id:'private_item',name:'私密物品',fields:{description:'甲藏着钥匙',ownerId:'a',storage:'carried'}},
    {kind:'item',id:'stored_item',name:'仓库物品',fields:{locationId:'vault',storage:'stored',visibility:'public'}},
    {kind:'item',id:'critical',name:'关键物品',fields:{locationId:'vault',storage:'stored',importance:'critical',visibility:'public'}},
    {kind:'timeline',id:'event',name:'同楼事件',fields:{text:'摘要已含事件',visibility:'public',sourceMessageIds:[f.runtime.getSnapshot().messages[0].id]}}
  ]) await f.runtime.p1.saveEntity(input);
  const message = f.runtime.getSnapshot().messages[0]; await f.runtime.saveSummary(message.id,'只有甲知道的谈话'); const summary = `summary_${message.id}`;
  await f.runtime.p1.manual([{type:'set',entityId:summary,path:['visibility'],value:'private'},{type:'set',entityId:summary,path:['audienceIds'],value:['a']}]);
  const config = f.runtime.settings.snapshot(); config.prompt.recentWindow = 1;
  const a = composePrompt(f.runtime.getSnapshot(),config,{actorIds:['a']}); assert.match(a.text,/只有甲知道/); assert.match(a.text,/密令只给甲（heard）/); assert.match(a.text,/甲藏着钥匙/); assert.match(a.text,/甲的内心秘密/); assert.match(a.text,/关键物品/); assert.doesNotMatch(a.text,/仓库物品|摘要已含事件/);
  const b = composePrompt(f.runtime.getSnapshot(),config,{actorIds:['b']}); assert.doesNotMatch(b.text,/只有甲知道|密令只给甲|甲藏着钥匙|甲的内心秘密|秘密情绪/);
  assert.doesNotMatch(composePrompt(f.runtime.getSnapshot(),config,{actorIds:[]}).text,/只有甲知道|密令只给甲/);
  const unknownActor = composePrompt(f.runtime.getSnapshot(),config,{actorIds:['a','unrecognized']}); assert.equal(unknownActor.privacy,'public-only'); assert.doesNotMatch(unknownActor.text,/只有甲知道|密令只给甲|甲藏着钥匙/);
  config.prompt.sections.characters = false; config.prompt.sections.items = false; assert.doesNotMatch(composePrompt(f.runtime.getSnapshot(),config,{actorIds:['a']}).text,/\[characters\]|\[items\]/); assert.equal(domainView(f.runtime.getSnapshot()).characters.length,2);
  config.prompt.maxChars = 1; const budget = composePrompt(f.runtime.getSnapshot(),config,{actorIds:['a']}); assert.equal(budget.text,''); assert.ok(budget.droppedSourceIds.length);
});

test('generation refreshes injection before host prompt assembly and retains the actual submitted bundle',async t => {
  const config = defaults(); config.prompt.recentWindow = 0; const f = await fixture({config}); t.after(() => f.runtime.stop());
  const message = f.runtime.getSnapshot().messages[0]; await f.runtime.saveSummary(message.id,'原摘要'); await f.runtime.p1.manual([{type:'set',entityId:`summary_${message.id}`,path:['visibility'],value:'public'}]);
  assert.equal(f.runtime.p1.lastBundle,null); await f.events.emit('GENERATION_STARTED','normal'); await f.events.emit('GENERATION_AFTER_COMMANDS','normal',{},false);
  assert.match(f.context.prompt,/原摘要/); assert.equal(f.runtime.p1.lastBundle.delivery,'submitted-to-host'); const submitted = f.runtime.p1.lastBundle.text;
  await f.runtime.saveSummary(message.id,'新摘要'); assert.equal(f.runtime.p1.lastBundle.text,submitted); assert.match(f.runtime.p1.previewPrompt().text,/新摘要/);
  await f.events.emit('GENERATION_AFTER_COMMANDS','quiet',{},false); assert.equal(f.runtime.p1.lastBundle.text,submitted);
  f.context.chatMetadata = {}; f.context.chat = [{mes:'另一聊天',is_user:false}]; f.context.getCurrentChatId = () => 'other'; await f.events.emit('CHAT_CHANGED');
  assert.equal(f.runtime.p1.lastBundle,null); assert.equal(f.context.prompt,''); assert.equal(Object.values(f.runtime.getSnapshot().state.entities).length,0);
});

test('worldbook selection and exclusions affect actual materials, with visible capability degradation',async t => {
  const config = defaults(); config.worldbook.enabled = true; config.worldbook.books = ['手选']; const f = await fixture({config}); t.after(() => f.runtime.stop()); f.context.characters[0].data = {extensions:{world:'绑定'}};
  let renders = 0; f.context.substituteParams = text => {renders++; return text.replaceAll('{{char}}','旅人');};
  f.context.loadWorldInfo = async name => ({entries:{0:{uid:0,constant:true,content:`${name}设定 {{char}}`},1:{uid:1,key:['港口'],content:'港口细节'},2:{uid:2,constant:true,vectorized:true,content:'高级条目'}}});
  let materials = await f.runtime.p1.readMaterials(); assert.ok(materials.materials.some(x => x.id === '绑定:0')); assert.ok(materials.materials.some(x => x.id === '手选:1')); assert.ok(materials.warnings.length);
  await f.runtime.settings.update({worldbook:{...f.runtime.settings.snapshot().worldbook,selectedEntries:['手选:0','绑定:0'],excludedEntries:['绑定:0']}}); materials = await f.runtime.p1.readMaterials(); assert.deepEqual(materials.materials.filter(x => x.origin === 'worldbook-setting').map(x => x.id),['手选:0']); assert.match(materials.materials.find(x => x.id === '手选:0').text,/旅人/);
  const before = renders; await f.runtime.settings.update({modules:{...f.runtime.settings.snapshot().modules,memory:false}}); await f.runtime.p1.readMaterials(); assert.equal(renders,before);
  await f.runtime.settings.update({modules:{...f.runtime.settings.snapshot().modules,memory:true}}); delete f.context.loadWorldInfo; materials = await f.runtime.p1.readMaterials(); assert.equal(materials.scanMode,'unavailable'); assert.match(materials.warnings.join(''),/loadWorldInfo/);
  const scan = scanEntries([{name:'x',data:{entries:{1:{uid:1,key:['cat'],matchWholeWords:true,content:'猫'},2:{uid:2,key:['/港.*/'],content:'港口'}}}}],{selectedEntries:[],excludedEntries:[]},'cats 港口'); assert.deepEqual(scan.materials.map(x => x.id),['x:2']);
});

test('old summary import shows conflicts, preserves unknown fields, covers only the chosen range and can undo',async t => {
  const config = defaults(); config.memory.summaryOnly = true; const f = await fixture({config,chat:[{mes:'一',is_user:false},{mes:'二',is_user:false},{mes:'三',is_user:false}]}); t.after(() => f.runtime.stop());
  await f.runtime.p1.saveEntity({kind:'item',id:'map',name:'当前地图',fields:{quantity:1}});
  const raw = {summary:'前两楼旧总结',visibility:'public',entities:[{kind:'item',id:'map',name:'旧地图',fields:{quantity:9}}],foreign:{kept:true}};
  let preview = f.runtime.p1.migrationPreview(raw,{start:1,end:2}); assert.deepEqual(preview.conflicts,['map']); assert.deepEqual(preview.unknownFields,['foreign']); assert.equal(preview.uncoveredCount,1);
  await assert.rejects(f.runtime.p1.migrate(preview),e => e.code === 'MIGRATION_CONFLICT'); preview = f.runtime.p1.migrationPreview(raw,{start:1,end:2,conflict:'keep'}); await f.runtime.p1.migrate(preview);
  assert.equal(f.runtime.getSnapshot().state.entities.map.fields.quantity,1); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized,2); assert.ok(Object.values(f.runtime.getSnapshot().state.entities).find(e => e.kind === 'importArchive').fields.raw.foreign.kept);
  f.setResponse(() => '三的摘要'); await f.runtime.p1.range({review:false}); assert.equal(f.calls,1);
  const undo = Object.values(f.runtime.getSnapshot().state.entities).find(e => e.kind === 'undo' && e.name === '导入旧总结与状态'); await f.runtime.p1.undo(undo.id); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized,1);
  preview = f.runtime.p1.migrationPreview('旧总结',{start:1,end:1}); f.context.chat[0].mes = '编辑后正文'; await assert.rejects(f.runtime.p1.migrate(preview),e => e.code === 'MIGRATION_STALE');
  assert.throws(() => f.runtime.p1.migrationPreview({summary:'x',visibility:'all'}),e => e.code === 'VISIBILITY_FIELDS');
});

test('hiding follows persisted coverage, preserves user hidden floors and rolls back on save failure',async t => {
  const config = defaults(); config.memory.keepRecent = 1; const f = await fixture({config,chat:[{mes:'未覆盖',is_user:false},{mes:'用户隐藏',is_user:false,is_system:true},{mes:'近期',is_user:false}]}); t.after(() => f.runtime.stop());
  assert.equal(await f.runtime.p1.hideCovered(),0); await f.runtime.saveSummary(f.runtime.getSnapshot().messages[0].id,'已存摘要'); assert.equal(await f.runtime.p1.hideCovered(),1); assert.equal(f.context.chat[0].is_system,true);
  assert.equal(await f.runtime.p1.hideCovered(true),1); assert.equal(f.context.chat[0].is_system,false); assert.equal(f.context.chat[1].is_system,true);
  const save = f.context.saveChat; f.context.saveChat = async () => {throw new Error('磁盘写入失败');}; await assert.rejects(f.runtime.p1.hideCovered(),/磁盘写入失败/); assert.equal(f.context.chat[0].is_system,false); f.context.saveChat = save;
  await f.runtime.p1.hideCovered(); await f.runtime.settings.update({modules:{...f.runtime.settings.snapshot().modules,memory:false}}); await waitFor(() => !f.context.chat[0].is_system); assert.equal(f.context.chat[1].is_system,true);
  await f.runtime.settings.update({modules:{...f.runtime.settings.snapshot().modules,memory:true}}); await f.runtime.p1.hideCovered(); f.context.chat[0].mes = '已修改但未摘'; await f.runtime.sync(); assert.equal(f.context.chat[0].is_system,false);
});

test('custom channels honor stream and omitted parameters; fallback is explicit and excludes permanent errors',async t => {
  const config = defaults(); config.channels = [{id:'custom',name:'独立',model:'m',endpoint:'https://example.test/v1',timeoutMs:1000,retries:0,temperature:.2,maxTokens:50,stream:true,omitParameters:['temperature']}]; config.routing.extraction = 'custom'; const f = await fixture({config}); t.after(() => f.runtime.stop()); let body;
  f.runtime.gateway.fetchImpl = async (url,request) => {body = JSON.parse(request.body); const encoder = new TextEncoder(); return new Response(new ReadableStream({start(controller) {controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"分段"}}]}\n\ndata: {"choices":[{"delta":{"content":"响应"}}]}\n\ndata: [DONE]\n')); controller.close();}}));};
  const request = () => f.runtime.gateway.request({task:'extraction',module:'memory',key:Math.random().toString(),messages:[{role:'user',content:'测试'}],lease:f.runtime.capture(),assertCurrent:() => f.runtime.capture(),maxTokens:80});
  assert.equal(await request(),'分段响应'); assert.equal(body.max_tokens,50); assert.equal(body.stream,true); assert.equal(body.temperature,undefined); assert.equal(body.model,'m'); assert.equal(f.calls,0);
  f.runtime.gateway.fetchImpl = async () => new Response('',{status:503}); await assert.rejects(request(),e => e.code === 'UPSTREAM_ERROR'); assert.equal(f.calls,0);
  await f.runtime.settings.update({api:{fallbackToMain:true}}); f.setResponse(() => '主渠道'); assert.equal(await request(),'主渠道'); assert.equal(f.calls,1);
  f.runtime.gateway.fetchImpl = async () => new Response('',{status:401}); await assert.rejects(request(),e => e.code === 'API_REJECTED'); assert.equal(f.calls,1);
  assert.throws(() => validateSettings({...config,channels:[{...config.channels[0],temperature:9}]}),e => e.code === 'INVALID_SETTINGS');
});

test('scene aliases and hierarchical revisits reuse IDs, while source changes invalidate derived state',async t => {
  const f = await fixture({chat:[{mes:'港口仓库',is_user:false},{mes:'重访仓库',is_user:false}]}); t.after(() => f.runtime.stop());
  await f.runtime.p1.saveEntity({kind:'scene',id:'port',name:'港口',aliases:['港湾'],fields:{}}); await f.runtime.p1.saveEntity({kind:'scene',id:'warehouse',name:'仓库',aliases:['库房'],fields:{parentId:'port',fixedFeatures:'两扇窗'}});
  f.setResponse(() => JSON.stringify({summary:{text:'重访仓库',visibility:'public'},changes:[{kind:'scene',id:'new-port',name:'港湾',fields:{}},{kind:'scene',id:'new-warehouse',name:'库房',fields:{parentId:'new-port',focus:'雨夜'}},{kind:'clock',id:'story_clock',name:'当前故事',fields:{locationId:'new-warehouse'}}]}));
  await f.runtime.p1.range({start:2,end:2,review:false}); assert.equal(domainView(f.runtime.getSnapshot()).scenes.length,2); assert.equal(f.runtime.getSnapshot().state.entities.warehouse.fields.focus,'雨夜'); assert.equal(f.runtime.getSnapshot().state.entities.warehouse.fields.fixedFeatures,'两扇窗');
  assert.equal(domainView(f.runtime.getSnapshot()).locationId,'warehouse');
});

test('flashbacks keep the current time, tags auto-parse, and independent thresholds and batch limits apply',async t => {
  const config = defaults(); config.memory.floorThreshold = 3; config.memory.tokenThreshold = 999; const f = await fixture({config,chat:[{mes:'<story_time>2026-10-10 09:00</story_time>事件',is_user:false},{mes:'回忆',is_user:false}]}); t.after(() => f.runtime.stop());
  assert.equal(f.runtime.p1.automaticReady(),false); await f.runtime.settings.update({memory:{...f.runtime.settings.snapshot().memory,tokenThreshold:1}}); assert.equal(f.runtime.p1.automaticReady(),true);
  f.setResponse(() => JSON.stringify({summary:{text:'事件'},changes:[],storyTime:f.calls === 1 ? null : {...parseStoryTime('2020-01-01'),sequence:'flashback'}}));
  await f.runtime.p1.range({review:false,limit:1}); assert.equal(f.runtime.getSnapshot().coverage.summary.summarized,1); assert.equal(domainView(f.runtime.getSnapshot()).time.year,2026);
  await f.runtime.p1.range({review:false}); assert.equal(domainView(f.runtime.getSnapshot()).time.year,2026); assert.equal(f.runtime.getSnapshot().state.entities.story_clock.fields.history.at(-1).time.year,2020);
  assert.equal(parseStoryTime('倒叙：2020-01-01').sequence,'flashback'); assert.equal(parseStoryTime('2026年').precision,'year'); assert.equal(parseStoryTime('9时').precision,'hour');
});
