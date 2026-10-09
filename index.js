import { SillyTavernHost } from './src/host/sillytavern.js';
import { MemoryRuntime } from './src/runtime.js';
import { mountPanel, mountStartupPanel } from './src/ui/panel.js';

const INSTANCE = Symbol.for('st-memory-core.instance');

export async function onEnable() {
  const previous = globalThis[INSTANCE];
  if (previous) return previous.ready;
  const runtime = new MemoryRuntime(new SillyTavernHost());
  const instance = { runtime, disposePanel: null, ready: null };
  globalThis[INSTANCE] = instance;
  const startupPanel = mountStartupPanel(() => {
    // Retire the failed instance without first closing an open diagnostic dialog.
    if (globalThis[INSTANCE] !== instance) return;
    runtime.stop(); delete globalThis[INSTANCE];
    return onEnable();
  });
  instance.disposePanel = startupPanel.dispose;
  instance.ready = (async () => {
    try {
      await runtime.start();
      if (globalThis[INSTANCE] !== instance) { runtime.stop(); return; }
      const api = runtime.publicApi(); globalThis.STMemoryCore = api;
      instance.disposePanel = mountPanel(runtime);
      window.dispatchEvent(new CustomEvent('st-memory-core:ready', { detail: { apiVersion: 1 } }));
    } catch (error) {
      runtime.stop();
      if (globalThis[INSTANCE] !== instance) return;
      delete globalThis.STMemoryCore;
      const message = runtime.logger.redact(error.message ?? String(error));
      startupPanel.fail(error.code ?? 'UNEXPECTED', message);
      console.error('[记忆中枢]', message);
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
