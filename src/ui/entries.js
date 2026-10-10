export function mountExtraEntries(runtime,openButton) {
  let disposed = false; const owned = new Set(); let timer;
  const placements = { top:'#top-bar, #top_settings', bottom:'#form_sheld', input:'#send_form' };
  function create(key,parent,floor = null) {
    const identity = `st-memory-core-entry-${key}${floor === null ? '' : `-${floor}`}`; if (document.getElementById(identity)) return;
    const button = document.createElement('button'); button.type = 'button'; button.id = identity; button.className = `menu_button memory-core-extra-entry memory-core-extra-${key}`; button.textContent = floor === null ? '记忆' : '记忆档案'; button.setAttribute('aria-label',floor === null ? '打开记忆中枢' : `查看第 ${floor + 1} 楼记忆`);
    button.addEventListener('click',event => { event.preventDefault(); event.stopPropagation(); openButton.click(); document.getElementById('memory-core-tab-workbench')?.click(); if (floor !== null) document.getElementById('memory-core-view-workbench')?.dispatchEvent(new CustomEvent('memory-core:floor',{detail:{floor:floor + 1}})); }); parent.append(button); owned.add(button);
  }
  function render() {
    if (disposed) return; const config = runtime.settings.snapshot()?.ui?.entries; if (!config) return;
    const menu = document.getElementById('st-memory-core-menu-container'); if (menu) menu.hidden = !config.menu;
    for (const button of owned) { const key = button.className.match(/memory-core-extra-(\w+)/)?.[1]; if (!config[key] || !button.isConnected) { button.remove(); owned.delete(button); } }
    for (const [key,selector] of Object.entries(placements)) if (config[key]) { const target = document.querySelector(selector); if (target) create(key,target); }
    if (config.floating) create('floating',document.body);
    if (config.floor) for (const message of document.querySelectorAll('.mes[mesid]')) { const floor = Number(message.getAttribute('mesid')); if (Number.isInteger(floor)) create('floor',message.querySelector('.mes_buttons') ?? message,floor); }
  }
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(render,100); }); observer.observe(document.body,{childList:true,subtree:true}); const unsubscribe = runtime.subscribe(event => { if (['settings.changed','chat.ready'].includes(event.type)) render(); }); render();
  return () => { disposed = true; clearTimeout(timer); observer.disconnect(); unsubscribe(); for (const node of owned) node.remove(); };
}
