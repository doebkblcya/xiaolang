import { registerPanel } from './panel.js';
import { usagePlugin } from './usage.js';
import { Context, FiberState } from 'cordis';
import type { Fiber, Plugin } from 'cordis';
import { Loader } from '@cordisjs/plugin-loader';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import type { Adapter, Configuration, ConversationView, IncomingMessage, Log, Model, PluginInfo } from './contracts.js';
import { emitLog, log, messageLog } from './contracts.js';
import { chatPlugin } from './chat.js';
import { faultFeedbackPlugin } from './fault-feedback.js';
import { inspectMessage } from './messages.js';
import { loggingPlugin, loggingSchema, loggingCleanup } from './logging.js';
import { SessionQueue } from './scheduler.js';
import { SqliteStore } from './store.js';
import { ToolRegistry } from './tools.js';
import { toolingDefaults, toolingSchemas } from './tooling-config.js';
import { Sender, outputSchema } from './output.js';
import type { Embeddings } from './embedding.js';
import { abortable, check, code, Failure } from './errors.js';
import { checkPlugins, configurePlugins } from './plugins.js';
import { builtinTitles, externalTitles, pluginEntries, builtinEnabled } from './plugin-catalog.js';
import { triggerSettings } from './trigger-config.js';
import type { PluginStatus } from './plugins.js';

export const storePlugin: Plugin.Object<Config> & { panel: import('./panel.js').PluginPanel } = {
  panel: { pages: [{ id: 'chats', title: '聊天记录', view: 'chats' }] },
  name: 'xiaolang-store', apply(ctx, config) {
    const store = new SqliteStore(config.database, ctx.xiaolangHost.cleanups);
    ctx.effect(() => () => store.close());
    ctx.provide('store', store);
    const nameConversation = async (item: ConversationView) => {
      const adapter = ctx.get('adapter');
      if (item.scope !== 'group' || adapter?.platform !== item.platform || adapter.account !== item.account || !adapter.groupName) return item;
      try {
        const name = await adapter.groupName(item.recipient);
        if (name) { store.cacheConversationName(item.id, name); return { ...item, name }; }
      } catch { /* Optional platform metadata cannot hide stored conversations. */ }
      return item;
    };
    ctx.provide('historyReader', {
      deleteData: async input => {
        await ctx.parallel('xiaolang/before-delete', input);
        const result = store.deleteData(input);
        try { ctx.emit('xiaolang/data-deleted'); } catch { /* committed deletion must remain successful */ }
        return result;
      },
      cacheConversationName: (id, name) => store.cacheConversationName(id, name),
      conversations: async (query, scope, before) => {
        const page = store.conversations(query, scope, before);
        return { ...page, items: await Promise.all(page.items.map(nameConversation)) };
      },
      timeline: async (id, before) => {
        const page = store.timeline(id, before);
        return { ...page, conversation: await nameConversation(page.conversation) };
      },
      renameConversation: (id, alias, version) => store.renameConversation(id, alias, version),
      counts: () => store.counts(), recent: (limit, before, failures) => store.recent(limit, before, failures), detail: id => store.detail(id),
    });
  },
};
export const schedulerPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-scheduler', apply(ctx, config) {
    const queue = new SessionQueue(config.limits.concurrency, config.limits.queue, config.limits.queueAgeMs);
    ctx.effect(() => () => queue.close());
    ctx.provide('scheduler', queue);
  },
};
export const intakePlugin: Plugin.Object<Config> = {
  name: 'xiaolang-intake', inject: ['store', 'adapter'], apply(ctx, config) {
    let lastMessage: string | undefined;
    ctx.provide('intake', { status: () => ({ lastMessage }), receive(event) {
      const result = inspectMessage(event, ctx.adapter, config.groupIds);
      const normalized = result.message;
      if (!normalized) { log(ctx, 'message_ignored', undefined, 'intake', { reason: result.reason }); return; }
      const details = messageLog(normalized);
      const message = ctx.store.admit(normalized);
      if (!message) { log(ctx, 'message_ignored', undefined, 'intake', { ...details, reason: 'duplicate' }); return; }
      lastMessage = new Date().toISOString();
      log(ctx, 'message_received', undefined, 'intake', { ...details, preview: message.text });
      // Observers have no default reply path, and never block message dispatch.
      void ctx.parallel('xiaolang/observed', structuredClone(message)).catch(() => log(ctx, 'observer_failed'));
      if (!ctx.get('chat')) log(ctx, 'message_ignored', undefined, 'trigger', { ...details, reason: 'chat_disabled' });
      ctx.emit('xiaolang/message', message);
    } });
  },
};
export const toolsPlugin: Plugin.Object<Config> & { panel: import('./panel.js').PluginPanel } = {
  panel: { pages: [{ id: 'tooling', title: '工具与行动', view: 'tooling' }] },
  name: 'xiaolang-tools', apply(ctx, config) {
    ctx.get('configuration')?.registerPlugin('xiaolang-tools', toolingSchemas.access);
    ctx.provide('tools', new ToolRegistry((config.tooling ?? toolingDefaults).access.adminIds));
  },
};
export const outputPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-output', inject: ['store', 'adapter'], apply(ctx, config) { ctx.get('configuration')?.registerPlugin('xiaolang-output', outputSchema); ctx.provide('output', new Sender(ctx.store, ctx.adapter, config.limits.replyChars, entry => emitLog(ctx, entry))); },
};
export interface AppOptions {
  apiKey?: string;
  model?: Model;
  adapter?: Adapter;
  signal?: AbortSignal;
  report?: (entry: Log) => void;
  writeLog?: (line: string) => void;
  secrets?: string[];
  configuration?: Configuration;
  embeddingKey?: string;
  memoryModel?: Model;
  personaModel?: Model;
  embeddings?: Embeddings;
  imageFetch?: typeof fetch;
  webFetch?: typeof fetch;
}

export async function createApp(config: Config, options: AppOptions) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  let chat: Fiber | undefined;
  let loader: Fiber | undefined;
  let adapter: Adapter | undefined = options.adapter;
  let state: 'starting' | 'running' | 'stopped' = 'starting';
  const started = Date.now();
  let runtimeState = 'starting';
  const stateName = (fiber?: Fiber) => fiber?.state === FiberState.ACTIVE ? 'active' : fiber?.state === FiberState.FAILED ? 'failed'
    : fiber?.state === FiberState.DISPOSED ? 'disabled' : fiber?.state === FiberState.UNLOADING ? 'stopping' : 'pending';
  const provided = (fiber?: Fiber) => Object.entries(fiber?.store ?? {}).filter(([, implementation]) => fiber?.uid != null && implementation.fiber.uid === fiber.uid).map(([name]) => name);
  function pluginList(): PluginInfo[] {
    const core: PluginInfo[] = Object.entries(builtinTitles).map(([id, title]) => {
      const fiber = fibers.find(item => (item.name === 'loader' || item === loader ? 'loader' : item.name) === id);
      return { id, title, module: id === 'loader' ? '@cordisjs/plugin-loader' : 'host', kind: 'builtin',
        state: !builtinEnabled(config, id) || (id === 'xiaolang-chat' && (!config.chatEnabled || !!config.plugins?.chat)) || (id === 'xiaolang-fault-feedback' && config.failureFeedback?.enabled === false) ? 'disabled' : stateName(fiber),
        dependencies: fiber ? Object.keys(fiber.inject) : ctx.xiaolangHost.pluginDependencies.get(id) ?? [], provides: provided(fiber),
        missingDependencies: fiber ? Object.keys(fiber.inject).filter(name => fiber.parent.get(name) === undefined) : [], panel: ctx.xiaolangHost.panels.get(id)?.definition };
    });
    return [...core, ...entries.map(entry => {
      const fiber = ctx.get('loader')?.store[entry.id]?.fiber;
      return { id: entry.id, title: externalTitles[entry.id] ?? entry.id, module: entry.module, kind: 'external' as const,
        state: entry.enabled === false || (entry.id === config.plugins?.chat && !config.chatEnabled) || !builtinEnabled(config, 'loader') ? 'disabled' : stateName(fiber),
        dependencies: fiber ? Object.keys(fiber.inject) : ctx.xiaolangHost.pluginDependencies.get(entry.id) ?? [], provides: provided(fiber),
        missingDependencies: fiber ? Object.keys(fiber.inject).filter(name => fiber.parent.get(name) === undefined) : [], panel: ctx.xiaolangHost.panels.get(entry.id)?.definition };
    })];
  }
  const entries = pluginEntries(config).filter(entry => !options.adapter || entry.id !== 'xiaolang-adapter');
  ctx.provide('xiaolangHost', { config, options, cleanups: new Map(), panels: new Map(), pluginDependencies: new Map() });
  ctx.provide('xiaolangRuntime', { status: () => ({ started, uptimeMs: Math.max(0, Date.now() - started), state: runtimeState, plugins: structuredClone(pluginList()) }) });
  ctx.xiaolangHost.cleanups.set('xiaolang-logging', loggingCleanup);
  options.configuration?.registerPlugin('xiaolang-logging', loggingSchema);
  const beforeReady: IncomingMessage[] = [];
  async function mount<T>(plugin: Plugin<T>, config: T): Promise<Fiber | undefined> {
    const id = typeof plugin === 'object' && plugin.name;
    if (id && typeof plugin === 'object') ctx.xiaolangHost.pluginDependencies.set(id, Array.isArray(plugin.inject) ? [...plugin.inject] : Object.keys(plugin.inject ?? {}));
    if (id && typeof plugin === 'object' && 'panel' in plugin) registerPanel(ctx.xiaolangHost.panels, id, plugin.panel);
    if (id && typeof plugin === 'object' && 'panelHome' in plugin && typeof plugin.panelHome === 'function') {
      const registration = ctx.xiaolangHost.panels.get(id);
      const read = plugin.panelHome as import('./panel.js').PanelHomeReader;
      if (registration) registration.readHome = key => read(ctx, key);
    }
    if (id && !builtinEnabled(ctx.xiaolangHost.config, id)) return undefined;
    const fiber = await ctx.plugin(plugin, config);
    fibers.push(fiber);
    return fiber;
  }
  async function stop() {
    if (runtimeState !== 'failed') runtimeState = 'stopping';
    log(ctx, 'application_stopping', undefined, 'lifecycle');
    state = 'stopped';
    beforeReady.length = 0;
    const active = ctx.get('chat');
    try { await Promise.all([typeof active?.stop === 'function' ? active.stop() : undefined, ctx.get('reminders')?.stop(), ctx.get('persona')?.stop()]); }
    finally {
      try { if (typeof adapter?.stop === 'function') await adapter.stop(); }
      finally {
        if (chat && chat.state !== FiberState.DISPOSED) await chat.dispose();
        if (loader && loader.state !== FiberState.DISPOSED) await loader.dispose();
        for (const fiber of [...fibers].reverse()) if (fiber.state !== FiberState.DISPOSED) await fiber.dispose();
        await ctx.fiber.dispose();
      }
    }
  }
  try {
    await mount(loggingPlugin, { database: config.database, settings: config.logging, report: options.report, write: options.writeLog,
      secrets: [...(options.secrets ?? []), ...(options.apiKey ? [options.apiKey] : []), ...(options.embeddingKey ? [options.embeddingKey] : [])] });
    await mount(storePlugin, config);
    await mount(usagePlugin, config);
    if (options.configuration) await mount({ name: 'xiaolang-configuration', apply(context) {
      context.provide('configuration', options.configuration!);
    } }, undefined);
    await mount(schedulerPlugin, config);
    await mount(toolsPlugin, config);
    await mount(intakePlugin, config);
    await mount(outputPlugin, config);
    if (config.failureFeedback?.enabled !== false) await mount(faultFeedbackPlugin, config);
    const settings = config.plugins ?? { directory: 'plugins', entries: [] };
    if (options.adapter) {
      await mount({ name: 'xiaolang-injected-adapter', apply(context) { context.provide('adapter', options.adapter!); } }, undefined);
    }
    const loading = { ...settings, entries };
    if (entries.length && builtinEnabled(config, 'loader')) {
      ctx.baseUrl = pathToFileURL(join(resolve(settings.directory), 'plugins.json')).href;
      loader = await ctx.plugin(Loader, {}); fibers.push(loader);
      await configurePlugins(ctx, loading, config.chatEnabled);
    }
    if (config.chatEnabled && !config.plugins?.chat) chat = await mount(chatPlugin, config);
    const plugins: PluginStatus[] = loader ? await checkPlugins(ctx, loading, config.chatEnabled) : [];
    adapter = ctx.get('adapter');
    if (adapter && (typeof adapter.start !== 'function' || typeof adapter.stop !== 'function' || typeof adapter.reply !== 'function'
      || typeof adapter.platform !== 'string' || !adapter.platform || adapter.platform.length > 64
      || typeof adapter.account !== 'string' || !adapter.account || adapter.account.length > 512
      || !['all', 'mentions'].includes(adapter.capabilities?.groupMessages)
      || !Number.isInteger(adapter.capabilities?.maxTextChars) || adapter.capabilities.maxTextChars < 1 || adapter.capabilities.maxTextChars > 100_000)) throw new Failure('invalid_adapter_service');
    if (fibers.some(fiber => fiber.state === FiberState.FAILED)) throw new Failure('plugin_not_ready');
    if (ctx.get('chat')) {
      const active = ctx.get('chat');
      if (!active || typeof active.idle !== 'function' || typeof active.stop !== 'function') throw new Failure('invalid_chat_service');
    }
    if (ctx.get('trigger') && typeof ctx.trigger.match !== 'function') throw new Failure('invalid_trigger_service');
    if (adapter?.capabilities.groupMessages === 'mentions' && triggerSettings(config).groupKeywords && triggerSettings(config).words.length) log(ctx, 'adapter_group_messages_limited');
    if (options.signal) check(options.signal);
    const owned = adapter;
    const starting = Promise.resolve(owned?.start(message => {
      if (state === 'stopped' || ctx.get('adapter') !== owned) return;
      if (state === 'starting') {
        if (beforeReady.length < 100) beforeReady.push(message);
        else log(ctx, 'adapter_startup_event_capacity');
        return;
      }
      ctx.get('intake')?.receive(message);
    }));
    if (options.signal) await abortable(starting, options.signal);
    else await starting;
    state = 'running';
    runtimeState = 'ready';
    log(ctx, 'application_ready', undefined, 'lifecycle');
    await ctx.parallel('xiaolang/start');
    for (const message of beforeReady.splice(0)) ctx.get('intake')?.receive(message);
    return { ctx, plugins: plugins.filter(plugin => (config.plugins?.entries ?? []).some(entry => entry.id === plugin.id)), stop, stopChat: async () => {
      try { await ctx.get('chat')?.stop(); }
      finally {
        if (chat) await chat.dispose();
        if (config.plugins?.chat) await ctx.loader.store[config.plugins.chat]?.fiber?.dispose();
      }
    } };
  } catch (error) {
    runtimeState = 'failed';
    log(ctx, 'application_failed', undefined, 'startup', { errorCode: code(error), level: 'error' });
    await stop(); throw error;
  }
}
