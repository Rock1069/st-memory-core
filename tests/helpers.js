import { MemoryRuntime } from '../src/runtime.js';
import { SillyTavernHost } from '../src/host/sillytavern.js';
import { defaults } from '../src/core/settings.js';

class Events {
  constructor() { this.listeners = new Map(); }
  on(name,callback) { const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name,list); }
  removeListener(name,callback) { this.listeners.set(name,(this.listeners.get(name) ?? []).filter(item => item !== callback)); }
  async emit(name,...args) { for (const callback of this.listeners.get(name) ?? []) await callback(...args); }
}
export async function fixture({ chat = [{mes:'旅人在港口拿到地图。',is_user:false}],config = null, response = null } = {}) {
  const settings = config ?? defaults(); settings.modules.memory = true;
  const events = new Events(); let calls = 0; let saves = 0; let handler = response ?? (() => JSON.stringify({summary:{text:'旅人在港口拿到地图。',visibility:'public',audienceIds:[]},changes:[],storyTime:null}));
  const context = { chat, chatMetadata:{}, extensionSettings:{st_memory_core:settings}, eventSource:events, eventTypes:Object.fromEntries(['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED','GENERATION_AFTER_COMMANDS','GENERATION_ENDED','GENERATION_STOPPED','WORLDINFO_UPDATED'].map(name => [name,name])), characters:[{avatar:'traveler.png',name:'旅人',description:'角色设定'}],characterId:0,name2:'旅人',name1:'用户',powerUserSettings:{persona_description:'用户设定'}, getCurrentChatId:() => 'test', saveChat:async () => { saves++; },saveMetadata:async () => {}, saveSettingsDebounced:() => {}, generateRaw:async request => {calls++;return handler(request);},getRequestHeaders:() => ({}),setExtensionPrompt:(key,text) => {context.prompt = text;},loadWorldInfo:async () => ({entries:{}}),getWorldInfoNames:() => ['港口'],substituteParams:text => text.replaceAll('{{char}}','旅人'),updateMessageBlock:() => {},isToolCallingSupported:() => false };
  const host = new SillyTavernHost(() => context); const runtime = new MemoryRuntime(host); await runtime.start();
  return {runtime,host,context,events,setResponse:fn => {handler = fn;},get calls() {return calls;},get saves() {return saves;} };
}
export async function waitFor(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve,5)); } throw new Error('等待任务超时'); }
