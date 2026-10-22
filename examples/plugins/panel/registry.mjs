import { realpath, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

export function createPanelRegistry(runtime, registrations = new Map()) {
  const content = (plugin, value) => value?.view ? { view: value.view } : value?.entry ? {
    entry: `/api/panel/assets/${encodeURIComponent(plugin.id)}/${value.entry.replace(/^\.\/panel\//, '')}`,
  } : undefined;
  return {
    describe() {
      const pages = [], details = {};
      for (const plugin of runtime.status().plugins) {
        const declaration = registrations.get(plugin.id)?.definition ?? plugin.panel;
        if (!declaration) continue;
        if (declaration.detail) details[plugin.id] = content(plugin, declaration.detail);
        for (const page of declaration.pages ?? []) pages.push({ id: `${plugin.id}:${page.id}`, plugin: plugin.id, title: page.title, state: plugin.state, ...content(plugin, page) });
      }
      return { pages, details };
    },
    async home() {
      const modules = [];
      for (const plugin of runtime.status().plugins) {
        const registration = registrations.get(plugin.id);
        for (const item of (registration?.definition ?? plugin.panel)?.home ?? []) modules.push({ plugin, item, registration });
      }
      return { items: await Promise.all(modules.map(async ({ plugin, item, registration }) => {
        const card = { id: `${plugin.id}:${item.id}`, plugin: plugin.id, title: item.title, state: plugin.state,
          ...(item.action ? { action: item.action === 'detail' ? { plugin: plugin.id } : { page: `${plugin.id}:${item.action}` } } : {}) };
        const inactive = { disabled: '已停用', failed: '启动失败', pending: '等待依赖', stopping: '停止中' };
        if (plugin.state !== 'active') return { ...card, value: inactive[plugin.state] ?? '启动中', tone: plugin.state === 'failed' ? 'bad' : 'neutral' };
        let timer;
        try {
          if (!registration?.readHome) throw new Error('missing_home_reader');
          const value = await Promise.race([Promise.resolve().then(() => registration.readHome(item.id)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('home_timeout')), 1000); })]);
          if (!value || typeof value.value !== 'string' || value.value.length > 120
            || (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 160))) throw new Error('invalid_home_value');
          return { ...card, value: value.value, ...(value.detail ? { detail: value.detail } : {}),
            tone: ['good', 'neutral', 'waiting', 'bad'].includes(value.tone) ? value.tone : 'neutral' };
        } catch { return { ...card, value: '暂不可用', tone: 'neutral' }; }
        finally { clearTimeout(timer); }
      })) };
    },
    async asset(id, path) {
      const registration = registrations.get(id);
      if (!registration?.directory || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) || path.split('/').some(part => part.startsWith('.'))) return undefined;
      const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
      const type = types[extname(path)];
      if (!type) return undefined;
      try {
        const directory = await realpath(registration.directory);
        const root = await realpath(resolve(directory, 'panel'));
        const confined = relative(directory, root); if (!confined || confined.startsWith('..') || isAbsolute(confined)) return undefined;
        const file = await realpath(resolve(root, path)), local = relative(root, file);
        if (!local || local.startsWith('..') || isAbsolute(local)) return undefined;
        return { body: await readFile(file), type };
      } catch { return undefined; }
    },
  };
}
