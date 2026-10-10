export function scanEntries(books, config, text, render = value => value) {
  const materials = []; const entries = [];
  for (const book of books) for (const entry of Object.values(book.data?.entries ?? {})) {
    const id = `${book.name}:${entry.uid}`; let reason = '关键词未命中';
    const match = key => { if (typeof key !== 'string' || !key.trim()) return false; const pattern = key.match(/^\/(.*)\/([imsu]*)$/); if (pattern) { try { return new RegExp(pattern[1],pattern[2]).test(text); } catch { return false; } } if (entry.matchWholeWords) { const escaped = key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,entry.caseSensitive ? 'u' : 'iu').test(text); } return entry.caseSensitive ? text.includes(key) : text.toLocaleLowerCase().includes(key.toLocaleLowerCase()); };
    const primary = (entry.key ?? []).some(match); const secondary = (entry.keysecondary ?? []).map(match);
    const secondaryPass = !entry.selective || !secondary.length || (entry.selectiveLogic === 1 ? !secondary.every(Boolean) : entry.selectiveLogic === 2 ? !secondary.some(Boolean) : entry.selectiveLogic === 3 ? secondary.every(Boolean) : secondary.some(Boolean));
    let active = (entry.constant || primary) && secondaryPass;
    if (config.selectedEntries.length && !config.selectedEntries.includes(id)) { active = false; reason = '未选入'; }
    else if (config.excludedEntries.includes(id)) { active = false; reason = '已排除'; }
    else if (entry.disable) { active = false; reason = '条目已停用'; }
    else if (entry.useProbability && Number(entry.probability) < 100 || entry.vectorized || entry.delayUntilRecursion) { active = false; reason = '需要宿主高级扫描；基础读取跳过此条目'; }
    else if (active) reason = entry.constant ? '常驻' : '关键词命中';
    const textValue = active ? render(String(entry.content ?? '')) : String(entry.content ?? '');
    entries.push({ id, book: book.name, name: entry.comment || String(entry.uid), active, reason, text: textValue });
    if (active && textValue.trim()) materials.push({ id, origin: 'worldbook-setting', text: textValue });
  }
  return { entries, materials, scanMode: 'selected-basic-keywords', warnings: entries.filter(e => e.reason.includes('高级扫描')).map(e => `${e.id}：${e.reason}`) };
}
