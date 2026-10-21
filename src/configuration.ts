import { personaSettings } from './persona-config.js';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { loadConfig, validateConfig } from './config.js';
import { validateQQConfig } from './qq-config.js';
import type { Configuration } from './contracts.js';
import { Failure } from './errors.js';
import { triggerSettings } from './trigger-config.js';
import { Ajv } from 'ajv';
import type { Fields, PluginInfo } from './contracts.js';
import { memoryDefaults } from './memory-config.js';
import { toolingDefaults, toolingSections } from './tooling-config.js';
import { builtinTitles, pluginEntries, toggleImpact } from './plugin-catalog.js';

interface QQSettings { appId: string; environment: 'production' | 'sandbox'; groupMessages: 'all' | 'mentions'; connectTimeoutMs: number; groupIds: string[] }
interface PluginSettings { chatEnabled?: boolean; entries?: Record<string, { enabled?: boolean; config?: Fields }> }
interface Settings { character?: Config['character']; tooling?: Config['tooling']; memory?: Config['memory']; output?: Config['output']; model: Config['model']; qq?: QQSettings; trigger?: NonNullable<Config['trigger']>; plugins?: PluginSettings; secrets: { deepseek?: string; qq?: string; embedding?: string } }
interface Document { version: 1; active?: Settings; pending?: Settings; lastApplyFailed?: boolean }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function revision(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function snapshot(config: Config): Settings {
  const qq = config.adapter.module === 'builtin:qq-official' ? validateQQConfig(config.adapter.config) : undefined;
  return { character: structuredClone(personaSettings(config)), tooling: structuredClone(config.tooling ?? toolingDefaults), memory: structuredClone({ ...memoryDefaults, ...config.memory }), model: structuredClone(config.model), ...(qq ? { qq: {
    appId: qq.appId, environment: qq.environment, groupMessages: qq.groupMessages,
    connectTimeoutMs: qq.connectTimeoutMs, groupIds: [...config.groupIds],
  } } : {}), trigger: triggerSettings(config), output: config.output ?? { mode: 'normal' }, secrets: {} };
}
function combine(base: Config, settings: Settings): Config {
  const config = structuredClone(base);
  config.character = structuredClone(settings.character ?? personaSettings(base));
  config.memory = structuredClone(settings.memory ?? base.memory ?? memoryDefaults);
  config.tooling = structuredClone(settings.tooling ?? base.tooling ?? toolingDefaults);
  config.output = structuredClone(settings.output ?? base.output ?? { mode: 'normal' });
  config.model = structuredClone(settings.model);
  config.trigger = structuredClone(settings.trigger ?? triggerSettings(base));
  config.triggerWords = [...config.trigger.words];
  if (settings.plugins) {
    if (settings.plugins.chatEnabled !== undefined) config.chatEnabled = settings.plugins.chatEnabled;
  }
  if (settings.qq && config.adapter.module === 'builtin:qq-official') {
    const { groupIds, ...qq } = settings.qq;
    config.adapter.config = { ...validateQQConfig({ ...config.adapter.config, ...qq }) };
    config.groupIds = [...groupIds];
  }
  const entries = [...pluginEntries(config), ...Object.keys(builtinTitles).map(id => ({ id, module: 'builtin:host' }))];
  config.plugins = { ...config.plugins, directory: config.plugins?.directory ?? 'plugins', entries: entries.map(entry => ({ ...entry, ...settings.plugins?.entries?.[entry.id] })) };
  return validateConfig(config);
}
function checkSettings(raw: unknown, base: Config): Settings {
  if (!record(raw) || !keys(raw, ['model', 'qq', 'trigger', 'plugins', 'output', 'memory', 'tooling', 'character', 'secrets']) || !record(raw.secrets)
    || !keys(raw.secrets, ['deepseek', 'qq', 'embedding'])) throw new Failure('invalid_saved_settings');
  for (const secret of Object.values(raw.secrets)) {
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Failure('invalid_secret');
  }
  if (raw.qq !== undefined && (!record(raw.qq) || Object.keys(raw.qq).length !== 5 || !keys(raw.qq, ['appId', 'environment', 'groupMessages', 'connectTimeoutMs', 'groupIds'])
    || !Array.isArray(raw.qq.groupIds))) throw new Failure('invalid_saved_settings');
  if (raw.plugins !== undefined) {
    if (!record(raw.plugins) || !keys(raw.plugins, ['chatEnabled', 'entries'])
      || (raw.plugins.chatEnabled !== undefined && typeof raw.plugins.chatEnabled !== 'boolean')) throw new Failure('invalid_saved_settings');
    if (raw.plugins.entries !== undefined) {
      if (!record(raw.plugins.entries) || Object.keys(raw.plugins.entries).length > 100) throw new Failure('invalid_saved_settings');
      for (const [id, entry] of Object.entries(raw.plugins.entries)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !record(entry) || !keys(entry, ['enabled', 'config'])
          || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') || (entry.config !== undefined && !record(entry.config))) throw new Failure('invalid_saved_settings');
      }
    }
  }
  const settings = raw as unknown as Settings;
  combine(base, settings);
  return settings;
}

/** Only explicitly allowed configuration sections are writable; credentials never leave this service. */
export class ConfigurationStore implements Configuration {
  readonly config: Config;
  readonly secrets: { deepseek?: string; qq?: string; embedding?: string };
  private boot: Settings;
  private initial: Settings;
  private writing = false;
  private restarting = false;
  private bootPending: boolean;
  private catalog: () => PluginInfo[] = () => [];
  private schemas = new Map<string, { schema: Fields; validate: ReturnType<Ajv['compile']> }>();
  bindPlugins(catalog: () => PluginInfo[]): void { this.catalog = catalog; }
  registerPlugin(id: string, schema: Fields): void {
    if (schema.type !== 'object' || !record(schema.properties) || JSON.stringify(schema).length > 16000
      || !keys(schema, ['type', 'title', 'description', 'properties', 'required', 'additionalProperties'])) throw new Failure('invalid_plugin_config_schema');
    for (const [key, field] of Object.entries(schema.properties)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || !record(field) || !['string', 'number', 'integer', 'boolean', 'array'].includes(String(field.type))
        || !keys(field, ['type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'writeOnly', 'items', 'maxItems', 'uniqueItems'])
        || (field.type === 'array' && (!record(field.items) || field.items.type !== 'string' || !keys(field.items, ['type', 'minLength', 'maxLength'])))) throw new Failure('invalid_plugin_config_schema');
    }
    const copy = structuredClone({ ...schema, additionalProperties: false });
    try { this.schemas.set(id, { schema: copy, validate: new Ajv({ strict: true }).compile(copy) }); }
    catch { throw new Failure('invalid_plugin_config_schema'); }
  }
  private constructor(private base: Config, readonly path: string, document: Document,
    private environment: NodeJS.ProcessEnv, private restart: () => void, private canRestart: () => boolean) {
    this.initial = snapshot(base);
    this.bootPending = !!document.pending;
    this.boot = structuredClone(document.pending ?? document.active ?? this.initial);
    this.config = combine(base, this.boot);
    this.secrets = structuredClone(this.boot.secrets);
  }
  static async load(configPath: string, restart: () => void, canRestart: () => boolean,
    environment: NodeJS.ProcessEnv = process.env): Promise<ConfigurationStore> {
    const base = await loadConfig(configPath);
    const path = join(dirname(resolve(base.database)), 'settings.json');
    const document = (await ConfigurationStore.read(path, base)).document;
    return new ConfigurationStore(base, path, document, environment, restart, canRestart);
  }
  private static async read(path: string, base: Config): Promise<{ document: Document; revision: string }> {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { document: { version: 1 }, revision: revision('') };
      throw new Failure('settings_read_failed');
    }
    try {
      const raw: unknown = JSON.parse(text);
      if (!record(raw) || raw.version !== 1 || !keys(raw, ['version', 'active', 'pending', 'lastApplyFailed'])
        || (raw.lastApplyFailed !== undefined && typeof raw.lastApplyFailed !== 'boolean')) throw new Error();
      if (raw.active !== undefined) checkSettings(raw.active, base);
      if (raw.pending !== undefined) checkSettings(raw.pending, base);
      return { document: raw as unknown as Document, revision: revision(text) };
    } catch { throw new Failure('invalid_saved_settings'); }
  }
  private async write(document: Document): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(document, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } catch { throw new Failure('settings_write_failed'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async view(): Promise<Record<string, unknown>> {
    const { document, revision } = await ConfigurationStore.read(this.path, this.base);
    const settings = document.pending ?? document.active ?? this.initial;
    const qq = this.base.adapter.module === 'builtin:qq-official' ? validateQQConfig(this.base.adapter.config) : undefined;
    return { revision, pendingRestart: !!document.pending, lastApplyFailed: !!document.lastApplyFailed, turnTimeoutMs: this.config.limits.turnTimeoutMs,
      model: { ...settings.model, secretConfigured: !!(settings.secrets.deepseek || this.environment.DEEPSEEK_API_KEY) },
      qq: { ...settings.qq, supported: this.base.adapter.module === 'builtin:qq-official',
        secretConfigured: !!(settings.secrets.qq || (qq && this.environment[qq.secretEnv])), transport: 'websocket' },
      trigger: { ...triggerSettings({ ...this.base, trigger: settings.trigger ?? this.base.trigger }), supported: !this.base.plugins?.trigger },
      active: { model: this.config.model.name, appId: this.config.adapter.config?.appId, environment: this.config.adapter.config?.environment },
    };
  }
  async save(section: 'model' | 'qq' | 'trigger', raw: unknown): Promise<Record<string, unknown>> {
    if (this.writing || this.restarting) throw new Failure('settings_busy');
    this.writing = true;
    try {
      if (!record(raw) || !keys(raw, ['revision', 'value', 'secret']) || typeof raw.revision !== 'string' || !record(raw.value)
        || (raw.secret !== undefined && typeof raw.secret !== 'string')) throw new Failure('invalid_settings_request');
      const existing = await ConfigurationStore.read(this.path, this.base);
      if (raw.revision !== existing.revision) throw new Failure('settings_conflict');
      const next = structuredClone(existing.document.pending ?? existing.document.active ?? this.initial);
      if (section === 'qq') {
        if (!next.qq) throw new Failure('qq_configuration_unavailable');
        next.qq = raw.value as unknown as QQSettings;
      } else if (section === 'trigger') {
        if (this.base.plugins?.trigger) throw new Failure('trigger_configuration_unavailable');
        next.trigger = raw.value as unknown as NonNullable<Config['trigger']>;
      } else next.model = raw.value as unknown as Config['model'];
      const secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
      if (secret && section === 'trigger') throw new Failure('invalid_settings_request');
      if (secret) next.secrets[section === 'model' ? 'deepseek' : 'qq'] = secret;
      checkSettings(next, this.base);
      const active = existing.document.active ?? this.boot;
      await this.write({ version: 1, active,
        ...(JSON.stringify(next) === JSON.stringify(active) ? {} : { pending: next }) });
      return await this.view();
    } finally { this.writing = false; }
  }
  private pluginOptions(id: string, settings: Settings) {
    const config = combine(this.base, settings);
    const info = this.catalog().find(plugin => plugin.id === id);
    if (!info) throw new Failure('plugin_not_found');
    const configured = config.plugins?.entries.find(item => item.id === id);
    const special = id === 'xiaolang-memory' ? { id, module: 'builtin', config: { ...memoryDefaults, ...config.memory, apiKey: settings.secrets.embedding ?? this.environment.BAILIAN_API_KEY ?? '' } as Fields }
      : id === 'xiaolang-persona' ? { id, module: 'builtin', config: personaSettings(config) as unknown as Fields }
      : id === 'xiaolang-output' ? { id, module: 'builtin', config: config.output as unknown as Fields }
      : toolingSections[id] ? { id, module: 'builtin', config: (config.tooling ?? toolingDefaults)[toolingSections[id]!] as unknown as Fields }
      : undefined;
    const entry = configured || special ? { ...special, ...configured, config: { ...special?.config, ...configured?.config } } : undefined;
    const chat = id === config.plugins?.chat;
    const toggleable = !!entry;
    const enabled = chat ? config.chatEnabled && entry?.enabled !== false : entry ? entry.enabled !== false : info.state !== 'disabled';
    const consumers = enabled ? this.catalog().filter(other => other.id !== id && other.state === 'active'
      && !(other.id === 'xiaolang-chat' && !config.chatEnabled) && !(other.id === config.plugins?.chat && !config.chatEnabled)
      && config.plugins?.entries.find(item => item.id === other.id)?.enabled !== false
      && other.dependencies.some(service => info.provides.includes(service))) : [];
    return { config, info, entry, chat, enabled, canToggle: toggleable,
      toggleReason: [toggleImpact(id), consumers.length ? `依赖方：${consumers.map(item => item.title).join('、')}。` : ''].filter(Boolean).join(' ') };

  }
  async plugin(id: string): Promise<Record<string, unknown>> {
    const { document, revision } = await ConfigurationStore.read(this.path, this.base);
    const settings = document.pending ?? document.active ?? this.initial;
    const options = this.pluginOptions(id, settings);
    const schema = this.schemas.get(id)?.schema;
    const values: Fields = {}, secretConfigured: Record<string, boolean> = {};
    if (schema && record(schema.properties)) for (const [key, field] of Object.entries(schema.properties)) {
      if (record(field) && field.writeOnly === true) secretConfigured[key] = !!options.entry?.config?.[key];
      else if (options.entry?.config?.[key] !== undefined) values[key] = structuredClone(options.entry.config[key]);
    }
    const settingsPage = id === 'xiaolang-trigger' ? 'trigger-settings' : id === 'xiaolang-deepseek' ? 'model-settings'
      : id === 'xiaolang-adapter' && this.base.adapter.module === 'builtin:qq-official' ? 'qq-settings' : undefined;
    return { revision, ...options.info, enabled: options.enabled, canToggle: options.canToggle, toggleReason: options.toggleReason,
      schema, config: values, secretConfigured, settingsPage };
  }
  async savePlugin(id: string, raw: unknown): Promise<Record<string, unknown>> {
    if (this.writing || this.restarting) throw new Failure('settings_busy');
    this.writing = true;
    try {
      if (!record(raw) || !keys(raw, ['revision', 'enabled', 'config']) || typeof raw.revision !== 'string'
        || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') || (raw.config !== undefined && !record(raw.config))) throw new Failure('invalid_settings_request');
      const existing = await ConfigurationStore.read(this.path, this.base);
      if (raw.revision !== existing.revision) throw new Failure('settings_conflict');
      const next = structuredClone(existing.document.pending ?? existing.document.active ?? this.initial);
      const options = this.pluginOptions(id, next);
      next.plugins ??= {};
      if (raw.enabled !== undefined && raw.enabled !== options.enabled) {
        if (!options.canToggle) throw new Failure('plugin_required');
        if (options.chat) next.plugins.chatEnabled = raw.enabled;
        next.plugins.entries ??= {}; next.plugins.entries[id] = { ...next.plugins.entries[id], enabled: raw.enabled };
      }
      if (raw.config !== undefined) {
        const registered = this.schemas.get(id);
        if (!registered || !options.entry) throw new Failure('plugin_not_configurable');
        const values = structuredClone(raw.config);
        for (const [key, field] of Object.entries(registered.schema.properties as Fields)) {
          if (record(field) && field.writeOnly === true && (values[key] === '' || values[key] === undefined) && options.entry.config?.[key] !== undefined) values[key] = options.entry.config[key];
        }
        if (!registered.validate(values)) throw new Failure('invalid_plugin_config');
        next.plugins.entries ??= {};
        const publicValues = { ...values };
        if (id === 'xiaolang-memory') delete publicValues.apiKey;
        next.plugins.entries[id] = { ...next.plugins.entries[id], config: publicValues };
        const known = (values: Fields, original: object): Fields => Object.fromEntries(Object.entries(values).filter(([key]) => key in original));
        const legacyCompatible = (section: string, value: unknown) => { try { validateConfig({ ...this.config, [section]: value }); return true; } catch { return false; } };
        if (id === 'xiaolang-memory') {
          const { apiKey, ...memory } = values;
          if (typeof apiKey === 'string' && apiKey.trim()) next.secrets.embedding = apiKey.trim();
          const legacy = known(memory, memoryDefaults);
          if (legacyCompatible('memory', legacy)) next.memory = legacy as unknown as Config['memory'];
        } else if (id === 'xiaolang-persona') {
          const legacy = known(values, personaSettings(this.config));
          if (legacyCompatible('character', legacy)) next.character = legacy as unknown as Config['character'];
        }
        else if (id === 'xiaolang-output') next.output = values as unknown as Config['output'];
        else if (toolingSections[id]) {
          const legacy = { ...(next.tooling ?? this.config.tooling ?? toolingDefaults), [toolingSections[id]!]: known(values, toolingDefaults[toolingSections[id]!]) };
          if (legacyCompatible('tooling', legacy)) next.tooling = legacy;
        }
        else { next.plugins.entries ??= {}; next.plugins.entries[id] = { ...next.plugins.entries[id], config: values }; }
      }
      checkSettings(next, this.base);
      const active = existing.document.active ?? this.boot;
      await this.write({ version: 1, active, ...(JSON.stringify(next) === JSON.stringify(active) ? {} : { pending: next }) });
      return { ...await this.view(), plugin: await this.plugin(id) };
    } finally { this.writing = false; }
  }
  async apply(expectedRevision: string): Promise<void> {
    if (this.writing || this.restarting) throw new Failure('settings_busy');
    this.restarting = true;
    try {
      const { document, revision } = await ConfigurationStore.read(this.path, this.base);
      if (revision !== expectedRevision) throw new Failure('settings_conflict');
      if (!document.pending) throw new Failure('no_pending_settings');
      if (!this.canRestart()) throw new Failure('chat_busy');
      this.restart();
    } catch (error) { this.restarting = false; throw error; }
  }
  async confirm(): Promise<void> {
    if (!this.bootPending) return;
    const { document } = await ConfigurationStore.read(this.path, this.base);
    if (JSON.stringify(document.pending) === JSON.stringify(this.boot)) await this.write({ version: 1, active: this.boot });
    this.bootPending = false;
  }
  async rollback(): Promise<boolean> {
    if (!this.bootPending) return false;
    const { document } = await ConfigurationStore.read(this.path, this.base);
    if (JSON.stringify(document.pending) !== JSON.stringify(this.boot)) return false;
    await this.write({ version: 1, active: document.active ?? this.initial, lastApplyFailed: true });
    return true;
  }
}
