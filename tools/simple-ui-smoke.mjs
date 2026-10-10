import path from 'node:path';

export async function verifySimpleHome({ browser, url, root, check, errors }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.stack));
  try {
    await page.goto(url); await page.waitForFunction(() => window.ready);
    await page.evaluate(async () => {
      const config = f.runtime.settings.snapshot();
      await f.runtime.settings.update({ ui: { ...config.ui, mode: 'light' }, modules: { ...config.modules, memory: false }, prompt: { ...config.prompt, recentWindow: 0 } });
    });
    await page.locator('#st-memory-core-menu-item').click();
    const home = page.locator('.memory-core-quick-start');
    const api = page.locator('#memory-core-view-api');
    const workbench = page.locator('#memory-core-view-workbench');
    await page.getByRole('tab', { name: '查看记忆', exact: true }).waitFor();
    check('简洁模式只保留首页、查看记忆和 API 三个页签', await page.getByRole('tab').count() === 3);
    check('首次使用不自动调用模型且可直接跟随酒馆 API', await page.evaluate(() => f.calls === 0) && await home.getByLabel('记忆使用的 API').inputValue() === 'main');
    await home.getByRole('button', { name: '连接独立 API', exact: true }).click();
    await page.evaluate(() => {
      window.quickApiCalls = 0;
      f.runtime.gateway.fetchImpl = async (url, options) => {
        if (url.endsWith('/status')) return new Response('{"data":[{"id":"simple-model"}]}');
        quickApiCalls++;
        const actor = Object.values(f.runtime.getSnapshot().state.entities).find(entity => entity.kind === 'character');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: { text: '自动整理的港口记忆', visibility: 'public' }, changes: [{ kind: 'character', id: actor?.id ?? 'quick-actor', name: '旅人', fields: { current: { presence: 'present' } } }] }) } }] }));
      };
    });
    await api.getByLabel('API 基础地址（含 /v1 等路径）', { exact: true }).fill('https://simple.example/v1');
    await api.getByLabel('API Key（仅本次会话保存）', { exact: true }).fill('simple-session-key');
    await api.getByRole('button', { name: '获取模型', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('memory-core-channel-model').value === 'simple-model');
    await api.getByRole('button', { name: '添加渠道', exact: true }).click(); await home.waitFor();
    check('独立 API 无需命名和另选路由，添加后自动返回首页', await page.evaluate(() => {
      const config = f.runtime.settings.snapshot(); const channel = config.channels[0];
      return channel.name === 'simple.example' && ['summary', 'extraction', 'compression'].every(task => f.runtime.settings.route(task, f.runtime.getSnapshot().scope) === channel.id);
    }));
    await home.getByRole('button', { name: '开启自动记忆', exact: true }).click();
    await page.waitForFunction(() => f.runtime.getSnapshot().coverage.summary?.summarized === 2 && f.runtime.p1.progress.status === 'completed');
    check('一键开启后自动分析、直接保存且不留下待确认结果', await page.evaluate(() => {
      const config = f.runtime.settings.snapshot(); const snapshot = f.runtime.getSnapshot();
      return config.enabled && config.modules.memory && config.memory.autoSummarize && !config.memory.requireReview && config.memory.autoCompress && config.prompt.enabled && quickApiCalls === 2 && !Object.values(snapshot.state.entities).some(entity => entity.kind === 'draft' && entity.fields.status === 'pending');
    }));
    await page.waitForFunction(() => document.querySelector('.memory-core-quick-totals strong').textContent === '2');
    check('首页显示已记住楼层、人物和最近记忆', await home.locator('.memory-core-quick-totals strong').nth(1).textContent() === '1' && await home.locator('.memory-core-quick-recent details').count() === 2);
    await page.evaluate(async () => {
      await f.events.emit('GENERATION_STARTED', 'normal'); await f.events.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
      f.context.chat.push({ mes: '旅人继续前进。', is_user: false }); await f.events.emit('GENERATION_ENDED');
    });
    await page.waitForFunction(() => f.runtime.getSnapshot().coverage.summary?.summarized === 3 && f.runtime.p1.progress.status === 'completed');
    check('继续聊天自动更新且生成前带上已有记忆', await page.evaluate(() => quickApiCalls === 3 && f.runtime.p1.lastBundle.text.includes('自动整理的港口记忆') && f.runtime.p1.lastBundle.delivery === 'submitted-to-host'));
    await home.getByRole('button', { name: '暂停自动记忆', exact: true }).click();
    await page.evaluate(async () => { f.context.chat.push({ mes: '尚未整理的第四楼。', is_user: false }); await f.events.emit('GENERATION_ENDED'); });
    check('暂停后停止自动调用但保留已保存记忆', await page.evaluate(() => quickApiCalls === 3 && f.runtime.getSnapshot().coverage.summary.summarized === 3 && f.context.prompt.includes('自动整理的港口记忆')));
    await home.getByRole('button', { name: '补齐历史记忆', exact: true }).click();
    await page.waitForFunction(() => f.runtime.getSnapshot().coverage.summary?.summarized === 4 && f.runtime.p1.progress.status === 'completed');
    check('历史记忆无需填写楼层范围即可补齐', await page.evaluate(() => quickApiCalls === 4 && !f.runtime.settings.snapshot().memory.autoSummarize));
    await home.getByRole('button', { name: '查看记忆', exact: true }).click();
    check('查看记忆直接进入人物记录且默认收起技术字段', await workbench.getByLabel('人物 · 旅人', { exact: true }).isVisible() && !(await workbench.getByLabel('记录 ID（新建留空）').isVisible()) && await workbench.getByRole('button', { name: '分析与审阅', exact: true }).count() === 0);
    await page.getByRole('tab', { name: '记忆首页', exact: true }).click();
    await home.getByRole('button', { name: '高级设置', exact: true }).click();
    await workbench.getByRole('button', { name: '保存记忆选项', exact: true }).waitFor();
    check('高级设置仍可访问并保留已保存数据', await page.evaluate(() => f.runtime.settings.snapshot().ui.mode === 'advanced' && f.runtime.getSnapshot().coverage.summary.summarized === 4));
    await workbench.getByLabel('界面模式', { exact: true }).last().selectOption('light'); await workbench.getByRole('button', { name: '保存界面入口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#st-memory-core-panel').dataset.uiMode === 'light');
    await page.getByRole('tab', { name: '记忆首页', exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await page.locator('.memory-core-dialog-content').evaluate(element => { element.scrollTop = 0; });
      const overflow = await page.evaluate(() => { const dialog = document.querySelector('.memory-core-dialog-content'); return { scroll: dialog.scrollWidth, client: dialog.clientWidth }; });
      check(`${width}px 简洁首页无整体横向溢出`, overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
      await page.screenshot({ path: path.join(root, `artifacts/simple-home-${width}.png`), fullPage: true });
    }
    await page.evaluate(async () => {
      f.context.chat.push({ mes: '第五楼待补齐。', is_user: false }); await f.runtime.sync();
      f.runtime.gateway.fetchImpl = async () => new Response('{"error":true}');
    });
    await home.getByRole('button', { name: '补齐历史记忆', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.memory-core-quick-status').dataset.tone === 'error');
    check('整理失败在首页显示原因并保留已有记忆', await page.evaluate(() => f.runtime.getSnapshot().coverage.summary.summarized === 4) && (await home.locator('.memory-core-quick-status').textContent()).includes('整理失败'));
    await page.evaluate(() => { f.runtime.gateway.fetchImpl = async () => new Promise(resolve => { window.finishSimple = resolve; }); });
    await home.getByRole('button', { name: '补齐历史记忆', exact: true }).click({ noWaitAfter: true }); await page.waitForFunction(() => typeof window.finishSimple === 'function');
    await home.getByRole('button', { name: '停止整理', exact: true }).click();
    await page.evaluate(() => finishSimple(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: { text: '停止后的迟到内容', visibility: 'public' }, changes: [] }) } }] }))));
    await page.waitForFunction(() => f.runtime.p1.progress.status === 'stopped');
    check('简洁首页窄屏可停止整理且不保存迟到结果', await page.evaluate(() => f.runtime.getSnapshot().coverage.summary.summarized === 4 && !JSON.stringify(f.runtime.getSnapshot().state.entities).includes('停止后的迟到内容')));
  } finally { await page.close(); }
}
