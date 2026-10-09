import { SillyTavernHost } from './src/host/sillytavern.js';
import { MemoryRuntime } from './src/runtime.js';
import { mountPanel } from './src/ui/panel.js';

const INSTANCE = Symbol.for('st-memory-core.instance');

export async function onEnable() {
  const previous = globalThis[INSTANCE];
  if (previous) return previous.ready;
  const runtime = new MemoryRuntime(new SillyTavernHost());
  const instance = { runtime, disposePanel: null, ready: null };
  globalThis[INSTANCE] = instance;
  instance.ready = (async () => {
    try {
      await runtime.start();
      if (globalThis[INSTANCE] !== instance) { runtime.stop(); return; }
      const api = runtime.publicApi(); globalThis.STMemoryCore = api;
      instance.disposePanel = mountPanel(runtime);
      window.dispatchEvent(new CustomEvent('st-memory-core:ready', { detail: { apiVersion: 1 } }));
    } catch (error) {
      instance.disposePanel?.(); runtime.stop();
      if (globalThis[INSTANCE] === instance) { delete globalThis[INSTANCE]; delete globalThis.STMemoryCore; }
      console.error('[记忆中枢]', runtime.logger.redact(error.message ?? String(error)));
    }
  })();
  return instance.ready;
}

export function onDisable() {
  const instance = globalThis[INSTANCE];
  if (!instance) return;
  instance.disposePanel?.(); instance.runtime.stop();
  delete globalThis[INSTANCE]; delete globalThis.STMemoryCore;
}

export const onDelete = onDisable;
// ESM import is the compatibility entry for hosts without extension lifecycle hooks.
void onEnable();
