import { realpath, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

export function createPanelRegistry(inspection, registrations = new Map()) {
  const content = (plugin, value) => value?.view ? { view: value.view } : value?.entry ? {
    entry: `/api/panel/assets/${encodeURIComponent(plugin.id)}/${value.entry.replace(/^\.\/panel\//, '')}`,
  } : undefined;
  return {
    describe() {
      const pages = [], details = {};
      for (const plugin of inspection.status().plugins) {
        const declaration = registrations.get(plugin.id)?.definition ?? plugin.panel;
        if (!declaration) continue;
        if (declaration.detail) details[plugin.id] = content(plugin, declaration.detail);
        for (const page of declaration.pages ?? []) pages.push({ id: `${plugin.id}:${page.id}`, plugin: plugin.id, title: page.title, state: plugin.state, ...content(plugin, page) });
      }
      return { pages, details };
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
