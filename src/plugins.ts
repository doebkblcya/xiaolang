import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FiberState } from 'cordis';
import type { Context } from 'cordis';
import type { EntryOptions } from '@cordisjs/plugin-loader';
import type { PluginConfig, PluginEntry } from './config.js';
import { emitLog, object } from './contracts.js';
import { registerPanel } from './panel.js';
import { Failure } from './errors.js';
import { officialIds, officialModule } from './plugin-catalog.js';
import { fileURLToPath } from 'node:url';

export interface PluginStatus { id: string; state: 'active' | 'disabled' | 'pending' }

function fail(ctx: Context, code: string, plugin: string, dependencies?: string[]): never {
  emitLog(ctx, { code, plugin, dependencies });
  throw new Failure(code);
}
function disabled(entry: PluginEntry, settings: PluginConfig, chatEnabled: boolean): boolean {
  return entry.enabled === false || (entry.id === settings.chat && !chatEnabled);
}
function contains(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path);
}
async function moduleName(ctx: Context, directory: string, entry: PluginEntry): Promise<string> {
  const name = entry.module;
  if (name.startsWith('builtin:')) {
    if (name !== 'builtin:qq-official') return fail(ctx, 'plugin_unknown_builtin', entry.id);
    return moduleName(ctx, directory, { ...entry, module: officialModule('xiaolang-adapter') });
  }
  if (name.startsWith('./')) {
    try {
      const file = await realpath(resolve(directory, name));
      if (!contains(directory, file) || !['.js', '.mjs', '.cjs'].includes(extname(file))) return fail(ctx, 'plugin_invalid_path', entry.id);
      if (!(await stat(file)).isFile()) return fail(ctx, 'plugin_invalid_path', entry.id);
      return pathToFileURL(file).href;
    } catch (error) {
      if (error instanceof Failure) throw error;
      if (officialIds.includes(entry.id) && name === officialModule(entry.id)) {
        const bundled = new URL('../plugins/' + entry.id + '/index.mjs', import.meta.url);
        try { await stat(bundled); return bundled.href; } catch { /* development output is absent in production */ }
      }
      return fail(ctx, 'plugin_file_missing', entry.id);
    }
  }
  // Package names resolve in the mounted workspace, never through remote URLs.
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/.test(name)
    || name.split('/').some(part => part === '..' || part === '.')) return fail(ctx, 'plugin_invalid_module', entry.id);
  try {
    if (!(await stat(join(directory, 'package.json'))).isFile()) return fail(ctx, 'plugin_workspace_missing', entry.id);
  } catch { return fail(ctx, 'plugin_workspace_missing', entry.id); }
  return name;
}

/** Import and activation belong to the upstream Loader; this only validates app configuration. */
export async function configurePlugins(ctx: Context, settings: PluginConfig, chatEnabled: boolean): Promise<void> {
  let directory = resolve(settings.directory);
  const enabled = settings.entries.filter(entry => !disabled(entry, settings, chatEnabled));
  const workspaceEntries = enabled.filter(entry => !entry.module.startsWith('builtin:'));
  if (workspaceEntries.length) {
    try { directory = await realpath(directory); }
    catch { if (workspaceEntries.some(entry => !officialIds.includes(entry.id))) return fail(ctx, 'plugin_directory_missing', workspaceEntries[0]!.id); }
  }
  const rows: EntryOptions[] = [];
  // One shared host API keeps error types and usage attribution consistent across packages.
  try { await writeFile(join(directory, '_runtime.mjs'), `export * from ${JSON.stringify(new URL('./plugin-api.js', import.meta.url).href)};\n`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of settings.entries) {
    // Cleanup modules are data lifecycle hooks, not plugin activation. Load even when disabled.
    let resolved: string | undefined;
    try { resolved = await moduleName(ctx, directory, entry); }
    catch (error) { if (!disabled(entry, settings, chatEnabled)) throw error; }
    if (resolved?.startsWith('file:')) {
      const folder = dirname(fileURLToPath(resolved));
      try {
        const manifest = await realpath(join(folder, 'xiaolang.plugin.json'));
        if (!contains(folder, manifest)) return fail(ctx, 'plugin_invalid_path', entry.id);
        const raw = object(JSON.parse(await readFile(manifest, 'utf8')));
        if (raw?.apiVersion !== undefined && raw.apiVersion !== 1) return fail(ctx, 'plugin_api_incompatible', entry.id);
        if (ctx.get('configuration') && object(raw?.configSchema)) ctx.configuration.registerPlugin(entry.id, raw!.configSchema as Record<string, unknown>);
        if (Array.isArray(raw?.dependencies) && raw.dependencies.length <= 100 && raw.dependencies.every(name => typeof name === 'string' && /^[a-zA-Z0-9_./:-]{1,100}$/.test(name))) ctx.xiaolangHost.pluginDependencies.set(entry.id, raw.dependencies as string[]);
        if (raw?.panel !== undefined) registerPanel(ctx.xiaolangHost.panels, entry.id, raw.panel, folder);
        if (typeof raw?.cleanup === 'string') {
          const cleanup = await realpath(resolve(folder, raw.cleanup));
          if (!contains(folder, cleanup)) return fail(ctx, 'plugin_invalid_path', entry.id);
          const hook = await import(pathToFileURL(cleanup).href);
          if (typeof hook.cleanup?.erase !== 'function' || (hook.cleanup.prepare !== undefined && typeof hook.cleanup.prepare !== 'function')) return fail(ctx, 'invalid_plugin_config_schema', entry.id);
          ctx.xiaolangHost.cleanups.set(entry.id, hook.cleanup);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { if (error instanceof Failure) throw error; return fail(ctx, 'invalid_plugin_config_schema', entry.id); }
      }
    }
    if (disabled(entry, settings, chatEnabled)) {
      rows.push({ id: entry.id, name: entry.module, disabled: true, config: entry.config ?? {} });
      continue;
    }
    const name = resolved ?? await moduleName(ctx, directory, entry);
    let exports: unknown;
    try { exports = await ctx.loader.import(name); }
    catch { return fail(ctx, 'plugin_import_failed', entry.id); }
    const module = object(exports);
    if (ctx.get('configuration') && object(module?.xiaolangConfig)) ctx.configuration.registerPlugin(entry.id, module!.xiaolangConfig as Record<string, unknown>);
    if (module?.xiaolangPanel !== undefined) registerPanel(ctx.xiaolangHost.panels, entry.id, module.xiaolangPanel, resolved?.startsWith('file:') ? dirname(fileURLToPath(resolved)) : undefined);
    if (module?.xiaolangApiVersion !== undefined && module.xiaolangApiVersion !== 1) return fail(ctx, 'plugin_api_incompatible', entry.id);
    const plugin: unknown = ctx.loader.unwrapExports(exports);
    const dependencies = object(plugin)?.inject ?? module?.inject;
    if (Array.isArray(dependencies)) ctx.xiaolangHost.pluginDependencies.set(entry.id, dependencies.filter((value): value is string => typeof value === 'string'));
    else if (object(dependencies)) ctx.xiaolangHost.pluginDependencies.set(entry.id, Object.keys(dependencies as object));
    if (typeof plugin !== 'function' && typeof object(plugin)?.apply !== 'function') return fail(ctx, 'plugin_invalid_export', entry.id);
    rows.push({ id: entry.id, name, disabled: false, config: entry.config ?? {} });
  }
  try {
    await ctx.loader.root.update(rows);
    await ctx.loader.await();
  } catch { fail(ctx, 'plugin_activation_failed', 'loader'); }
}

export async function checkPlugins(ctx: Context, settings: PluginConfig, chatEnabled: boolean): Promise<PluginStatus[]> {
  await ctx.loader.await();
  return settings.entries.map(entry => {
    if (disabled(entry, settings, chatEnabled)) return { id: entry.id, state: 'disabled' };
    const fiber = ctx.loader.store[entry.id]?.fiber;
    if (fiber?.state === FiberState.PENDING) {
      const missing = Object.keys(fiber.inject).filter(name => fiber.parent.get(name) === undefined);
      emitLog(ctx, { code: 'plugin_dependency_missing', plugin: entry.id, dependencies: missing });
      return { id: entry.id, state: 'pending' as const };
    }
    if (fiber?.state !== FiberState.ACTIVE) return fail(ctx, 'plugin_activation_failed', entry.id);
    return { id: entry.id, state: 'active' };
  });
}
