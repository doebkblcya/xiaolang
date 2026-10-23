// Read-only projections of registered tools and the shared log journal.
export async function toolCatalog(runtime, configuration, options) {
  const plugins = runtime.status().plugins.map(({ id, title, state, provides }) => ({ id, title, state, provides }));
  let sources = [], sourceError = false;
  try { sources = await options.tools?.sources?.() ?? []; } catch { sourceError = true; }
  return { items: options.tools?.list() ?? [], plugins, sources, sourceError, available: !!options.tools, configurable: !!configuration };
}

export function toolActivity(journal, { before, state = '', limit = 30 } = {}) {
  const events = { success: 'tool_completed', failed: 'tool_failed', unknown: 'tool_unknown' };
  if (!Object.hasOwn(events, state) && state !== '' || before !== undefined && (!Number.isSafeInteger(before) || before < 1)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_query');
  if (!journal) return { available: false, items: [], next: null };
  const pages = (state ? [events[state]] : Object.values(events)).map(event => journal.query({ event, before, limit }));
  const records = pages.flatMap(page => page.items).sort((a, b) => b.seq - a.seq), items = records.slice(0, limit);
  return { available: true, items, next: records.length > limit || pages.some(page => page.before) ? items.at(-1)?.seq ?? null : null,
    persistent: pages.every(page => page.persistent), degraded: pages.some(page => page.degraded), generation: pages[0]?.generation };
}
