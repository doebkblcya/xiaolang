import { object } from './contracts.js';
import { Failure } from './errors.js';

export interface PanelContent { view?: string; entry?: string }
export interface PanelPage extends PanelContent { id: string; title: string }
export interface PluginPanel { detail?: PanelContent; pages?: PanelPage[] }
export interface PanelRegistration { definition: PluginPanel; directory?: string }

/** A plugin declares its own UI; registration never activates a disabled plugin. */
export function registerPanel(registry: Map<string, PanelRegistration>, id: string, raw: unknown, directory?: string): void {
  const value = object(raw);
  const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
  const content = (raw: unknown): PanelContent => {
    const item = object(raw);
    if (!item || (typeof item.view === 'string') === (typeof item.entry === 'string')) throw new Failure('invalid_plugin_panel');
    if (item.view !== undefined && !identifier(item.view)) throw new Failure('invalid_plugin_panel');
    if (item.entry !== undefined && (!directory || typeof item.entry !== 'string' || !/^\.\/panel\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(item.entry))) throw new Failure('invalid_plugin_panel');
    if (Object.keys(item).some(key => !['id', 'title', 'view', 'entry'].includes(key))) throw new Failure('invalid_plugin_panel');
    return item.view ? { view: item.view as string } : { entry: item.entry as string };
  };
  if (!value || Object.keys(value).some(key => !['detail', 'pages'].includes(key))
    || (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.length > 12))) throw new Failure('invalid_plugin_panel');
  const pages = (value.pages as unknown[] | undefined)?.map(raw => {
    const page = object(raw);
    if (!page || !identifier(page.id) || typeof page.title !== 'string' || !page.title.trim() || page.title.length > 40) throw new Failure('invalid_plugin_panel');
    return { id: page.id, title: page.title.trim(), ...content(raw) };
  });
  if (pages && new Set(pages.map(page => page.id)).size !== pages.length) throw new Failure('invalid_plugin_panel');
  const definition: PluginPanel = { ...(value.detail ? { detail: content(value.detail) } : {}), ...(pages ? { pages } : {}) };
  registry.set(id, { definition: structuredClone(definition), directory });
}

