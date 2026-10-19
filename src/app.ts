import { personaPlugin } from './persona.js';
import { Context, FiberState } from 'cordis';
import type { Fiber, Plugin } from 'cordis';
import { Loader } from '@cordisjs/plugin-loader';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import type { Adapter, Configuration, IncomingMessage, Log, Model, PluginInfo } from './contracts.js';
import { emitLog, log, messageLog } from './contracts.js';
import { chatPlugin } from './chat.js';
import { triggerPlugin, triggerSettings } from './trigger.js';
import { faultFeedbackPlugin } from './fault-feedback.js';
import { inspectMessage } from './messages.js';
import { loggingPlugin } from './logging.js';
import { inspectionPlugin } from './inspection.js';
import { SessionQueue } from './scheduler.js';
import { SqliteStore } from './store.js';
import { DeepSeekModel } from './model.js';
import { ToolRegistry } from './tools.js';
import { toolingDefaults, toolingSchemas } from './tooling-config.js';
import { webToolsPlugin } from './web-tools.js';
import { mcpPlugin } from './mcp.js';
import { skillsPlugin } from './skills.js';
import { basicToolsPlugin } from './basic-tools.js';
import { remindersPlugin } from './reminders.js';
import { Sender, outputSchema } from './output.js';
import { memoryPlugin } from './memory.js';
import type { Embeddings } from './embedding.js';
import { abortable, check, code, Failure } from './errors.js';
import { checkPlugins, configurePlugins } from './plugins.js';
import type { PluginStatus } from './plugins.js';

export const storePlugin: Plugin.Object<Config> = {
  name: 'xiaolang-store', apply(ctx, config) {
    const store = new SqliteStore(config.database);
    ctx.effect(() => () => store.close());
    ctx.provide('store', store);
    ctx.provide('historyReader', { deleteData: input => store.deleteData(input), cacheConversationName: (id, name) => store.cacheConversationName(id, name), conversations: (query, scope, before) => store.conversations(query, scope, before), timeline: (id, before) => store.timeline(id, before), renameConversation: (id, alias, version) => store.renameConversation(id, alias, version), counts: () => store.counts(), recent: (limit, before, failures) => store.recent(limit, before, failures), detail: id => store.detail(id) });
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
    ctx.provide('intake', { receive(event) {
      const result = inspectMessage(event, ctx.adapter, config.groupIds);
      const normalized = result.message;
      if (!normalized) { log(ctx, 'message_ignored', undefined, 'intake', { reason: result.reason }); return; }
      const details = messageLog(normalized);
      const message = ctx.store.admit(normalized);
      if (!message) { log(ctx, 'message_ignored', undefined, 'intake', { ...details, reason: 'duplicate' }); return; }
      log(ctx, 'message_received', undefined, 'intake', { ...details, preview: message.text });
      // Observers have no default reply path, and never block message dispatch.
      void ctx.parallel('xiaolang/observed', structuredClone(message)).catch(() => log(ctx, 'observer_failed'));
      if (!ctx.get('chat')) log(ctx, 'message_ignored', undefined, 'trigger', { ...details, reason: 'chat_disabled' });
      ctx.emit('xiaolang/message', message);
    } });
  },
};
export const toolsPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-tools', apply(ctx, config) {
    ctx.get('configuration')?.registerPlugin('xiaolang-tools', toolingSchemas.access);
    ctx.provide('tools', new ToolRegistry((config.tooling ?? toolingDefaults).access.adminIds));
  },
};
export const clockPlugin: Plugin.Object<void> = {
  name: 'xiaolang-clock', inject: ['tools'], apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'current_time', source: 'xiaolang-clock', description: '查询当前时间，返回 UTC 与北京时间。', effect: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ utc: new Date().toISOString(), shanghai: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }),
    }));
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
  const metadata: Record<string, [string, string]> = {
    'xiaolang-logging': ['日志处理', 'src/logging.ts'], 'xiaolang-store': ['会话存储', 'src/store.ts'],
    'xiaolang-inspection': ['运行观察', 'src/inspection.ts'], 'xiaolang-configuration': ['配置管理', 'src/configuration.ts'],
    'xiaolang-scheduler': ['任务调度', 'src/scheduler.ts'], 'xiaolang-trigger': ['消息触发', 'src/trigger.ts'],
    'xiaolang-tools': ['工具注册与执行', 'src/tools.ts'], 'xiaolang-clock': ['查询时间工具', 'src/app.ts'],
    'xiaolang-intake': ['消息接纳', 'src/messages.ts'], 'xiaolang-deepseek': ['DeepSeek 模型', 'src/model.ts'],
    'xiaolang-output': ['统一发送', 'src/output.ts'], 'xiaolang-chat': ['默认聊天编排', 'src/chat.ts'],
    'xiaolang-fault-feedback': ['故障反馈', 'src/fault-feedback.ts'],
    'xiaolang-memory': ['聊天与记忆', 'src/memory.ts'],
    'xiaolang-persona': ['人设与学习', 'src/persona.ts'],
    'xiaolang-web': ['网页搜索与阅读', 'src/web-tools.ts'], 'xiaolang-mcp': ['MCP 接入', 'src/mcp.ts'],
    'xiaolang-skills': ['Skills 接入', 'src/skills.ts'], 'xiaolang-basic-tools': ['基础计算工具', 'src/basic-tools.ts'],
    'xiaolang-reminders': ['定时提醒', 'src/reminders.ts'],
    'xiaolang-injected-adapter': ['接入服务（测试注入）', 'injected'],
  };
  const stateName = (fiber?: Fiber) => fiber?.state === FiberState.ACTIVE ? 'active' : fiber?.state === FiberState.FAILED ? 'failed'
    : fiber?.state === FiberState.DISPOSED ? 'disabled' : fiber?.state === FiberState.UNLOADING ? 'stopping' : 'pending';
  const provided = (fiber?: Fiber) => Object.entries(fiber?.store ?? {}).filter(([, implementation]) => fiber?.uid != null && implementation.fiber.uid === fiber.uid).map(([name]) => name);
  function pluginList(): PluginInfo[] {
    const core: PluginInfo[] = fibers.map(fiber => ({ id: fiber.name || 'loader', title: metadata[fiber.name]?.[0] ?? 'Cordis 插件加载器',
      module: metadata[fiber.name]?.[1] ?? '@cordisjs/plugin-loader', kind: 'builtin', state: stateName(fiber), dependencies: Object.keys(fiber.inject), provides: provided(fiber) }));
    if (!config.chatEnabled && !config.plugins?.chat) core.push({ id: 'xiaolang-chat', title: '默认聊天编排', module: 'src/chat.ts', kind: 'builtin', state: 'disabled', dependencies: ['store', 'scheduler', 'trigger', 'model', 'tools', 'output'], provides: ['chat'] });
    if (config.failureFeedback?.enabled === false) core.push({ id: 'xiaolang-fault-feedback', title: '故障反馈', module: 'src/fault-feedback.ts', kind: 'builtin', state: 'disabled', dependencies: ['output'], provides: ['faultFeedback'] });
    const entries = [...(config.plugins?.entries ?? [])];
    if (!options.adapter) entries.unshift({ id: 'xiaolang-adapter', ...config.adapter });
    return [...core, ...entries.map(entry => {
      const fiber = ctx.get('loader')?.store[entry.id]?.fiber;
      return { id: entry.id, title: entry.id === 'xiaolang-adapter' ? 'QQ 官方接入' : entry.id === config.plugins?.trigger ? '消息触发（替换插件）'
        : entry.id === config.plugins?.chat ? '聊天编排（替换插件）' : entry.id === 'panel' ? '管理面板' : entry.id === 'console-logger' ? '终端日志展示' : entry.id,
        module: entry.module, kind: entry.module.startsWith('builtin:') ? 'builtin' as const : 'external' as const,
        state: entry.enabled === false || (entry.id === config.plugins?.chat && !config.chatEnabled) ? 'disabled' : stateName(fiber),
        dependencies: fiber ? Object.keys(fiber.inject) : [], provides: provided(fiber) };
    })];
  }
  const beforeReady: IncomingMessage[] = [];
  async function mount<T>(plugin: Plugin<T>, config: T): Promise<Fiber> {
    const fiber = await ctx.plugin(plugin, config);
    fibers.push(fiber);
    return fiber;
  }
  const modelPlugin: Plugin.Object<void> = { name: 'xiaolang-deepseek', apply(context) {
    if (!options.model && !options.apiKey) throw new Failure('missing_model_key');
    context.provide('model', options.model ?? new DeepSeekModel(config.model, options.apiKey!));
  } };
  async function stop() {
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
    await mount(loggingPlugin, { settings: config.logging, report: options.report, write: options.writeLog,
      secrets: [...(options.secrets ?? []), ...(options.apiKey ? [options.apiKey] : []), ...(options.embeddingKey ? [options.embeddingKey] : [])] });
    await mount(storePlugin, config);
    await mount(inspectionPlugin, { config, plugins: pluginList });
    if (options.configuration) await mount({ name: 'xiaolang-configuration', apply(context) {
      context.provide('configuration', options.configuration!);
    } }, undefined);
    await mount(schedulerPlugin, config);
    await mount(modelPlugin, undefined);
    if (!config.plugins?.trigger) await mount(triggerPlugin, config);
    await mount(toolsPlugin, config);
    await mount(clockPlugin, undefined);
    await mount(basicToolsPlugin, undefined);
    await mount(webToolsPlugin, { config, apiKey: options.apiKey, fetcher: options.webFetch });
    await mount(mcpPlugin, config);
    await mount(skillsPlugin, config);
    await mount(remindersPlugin, config);
    await mount(intakePlugin, config);
    await mount(memoryPlugin, { config, apiKey: options.apiKey, embeddingKey: options.embeddingKey, model: options.memoryModel, embeddings: options.embeddings, imageFetch: options.imageFetch });
    await mount(personaPlugin, { config, apiKey: options.apiKey, model: options.personaModel });
    await mount(outputPlugin, config);
    if (config.failureFeedback?.enabled !== false) await mount(faultFeedbackPlugin, config);
    const settings = config.plugins ?? { directory: 'plugins', entries: [] };
    const entries = [...settings.entries];
    if (options.adapter) {
      await mount({ name: 'xiaolang-injected-adapter', apply(context) { context.provide('adapter', options.adapter!); } }, undefined);
    } else {
      entries.unshift({ id: 'xiaolang-adapter', ...config.adapter });
    }
    const loading = { ...settings, entries };
    if (entries.length) {
      ctx.baseUrl = pathToFileURL(join(resolve(settings.directory), 'plugins.json')).href;
      loader = await mount(Loader, {});
      await configurePlugins(ctx, loading, config.chatEnabled);
    }
    if (config.chatEnabled && !config.plugins?.chat) chat = await mount(chatPlugin, config);
    const plugins: PluginStatus[] = loader ? await checkPlugins(ctx, loading, config.chatEnabled) : [];
    adapter = ctx.get('adapter');
    if (!adapter || typeof adapter.start !== 'function' || typeof adapter.stop !== 'function' || typeof adapter.reply !== 'function'
      || typeof adapter.platform !== 'string' || !adapter.platform || adapter.platform.length > 64
      || typeof adapter.account !== 'string' || !adapter.account || adapter.account.length > 512
      || !['all', 'mentions'].includes(adapter.capabilities?.groupMessages)
      || !Number.isInteger(adapter.capabilities?.maxTextChars) || adapter.capabilities.maxTextChars < 1 || adapter.capabilities.maxTextChars > 100_000) throw new Failure('invalid_adapter_service');
    if (fibers.some(fiber => fiber.state !== FiberState.ACTIVE)) throw new Failure('plugin_not_ready');
    if (config.chatEnabled) {
      const active = ctx.get('chat');
      if (!active || typeof active.idle !== 'function' || typeof active.stop !== 'function') throw new Failure('invalid_chat_service');
    }
    if (!ctx.get('trigger') || typeof ctx.trigger.match !== 'function') throw new Failure('invalid_trigger_service');
    if (adapter.capabilities.groupMessages === 'mentions' && triggerSettings(config).groupKeywords && triggerSettings(config).words.length) log(ctx, 'adapter_group_messages_limited');
    if (options.signal) check(options.signal);
    const owned = adapter;
    const starting = Promise.resolve(owned.start(message => {
      if (state === 'stopped' || ctx.get('adapter') !== owned) return;
      if (state === 'starting') {
        if (beforeReady.length < 100) beforeReady.push(message);
        else log(ctx, 'adapter_startup_event_capacity');
        return;
      }
      ctx.intake.receive(message);
    }));
    if (options.signal) await abortable(starting, options.signal);
    else await starting;
    state = 'running';
    log(ctx, 'application_ready', undefined, 'lifecycle');
    ctx.reminders.start();
    for (const message of beforeReady.splice(0)) ctx.intake.receive(message);
    return { ctx, plugins: plugins.filter(plugin => plugin.id !== 'xiaolang-adapter'), stop, stopChat: async () => {
      try { await ctx.get('chat')?.stop(); }
      finally {
        if (chat) await chat.dispose();
        if (config.plugins?.chat) await ctx.loader.store[config.plugins.chat]?.fiber?.dispose();
      }
    } };
  } catch (error) {
    log(ctx, 'application_failed', undefined, 'startup', { errorCode: code(error), level: 'error' });
    await stop(); throw error;
  }
}
