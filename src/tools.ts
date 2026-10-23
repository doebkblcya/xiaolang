import { Ajv } from 'ajv';
import type { Fields, Message, Tool, ToolCall, Tools, ToolSchema, ToolSource, ToolSourceStatus, ToolSourceView } from './contracts.js';
import { object } from './contracts.js';
import { abortable, check, Failure } from './errors.js';

export class ToolRegistry implements Tools {
  constructor(private adminIds: readonly string[] = []) {}
  private entries = new Map<string, { tool: Tool; validate: ReturnType<Ajv['compile']>; controller: AbortController }>();
  private ajv = new Ajv({ strict: true });
  private providers = new Map<string, ToolSource>();
  registerSource(source: ToolSource): () => void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/.test(source.id) || this.providers.has(source.id)
      || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(source.plugin) || !source.title || source.title.length > 120) throw new Failure('invalid_tool_source');
    this.providers.set(source.id, source);
    return () => { if (this.providers.get(source.id) === source) this.providers.delete(source.id); };
  }
  async sources(): Promise<ToolSourceView[]> {
    const entries = [...this.providers.values()];
    const result = await Promise.all(entries.map(async source => {
      const view: ToolSourceView = { id: source.id, plugin: source.plugin, title: source.title };
      if (!source.status) return view;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await Promise.race([Promise.resolve().then(() => source.status!()), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Failure('tool_source_timeout')), 1000);
        })]);
        if (!status || !['ready', 'disabled', 'connecting', 'error', 'empty'].includes(status.state) || typeof status.label !== 'string'
          || status.label.length > 160 || status.items && (!Array.isArray(status.items) || status.items.length > 100)) throw new Failure('invalid_tool_source_status');
        view.status = { state: status.state, label: status.label, ...(status.items ? { items: status.items.map(item => {
          if (!item || typeof item.name !== 'string' || item.name.length > 200) throw new Failure('invalid_tool_source_status');
          const value: NonNullable<ToolSourceStatus['items']>[number] = { name: item.name };
          for (const key of ['detail', 'state', 'errorCode'] as const) if (item[key] !== undefined) {
            if (typeof item[key] !== 'string' || item[key]!.length > 4096) throw new Failure('invalid_tool_source_status'); value[key] = item[key];
          }
          return value;
        }) } : {}) };
      } catch { view.status = { state: 'error', label: '状态读取失败' }; }
      finally { clearTimeout(timer); }
      return view;
    }));
    return result.filter((_, index) => this.providers.get(entries[index]!.id) === entries[index]);
  }
  register(tool: Tool): () => void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tool.name) || this.entries.has(tool.name)) throw new Failure('invalid_tool_registration');
    if (tool.access && !['everyone', 'admin'].includes(tool.access)) throw new Failure('invalid_tool_registration');
    if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 180000)) throw new Failure('invalid_tool_registration');
    for (const key of ['title', 'summary', 'owner'] as const) if (tool[key] !== undefined && (typeof tool[key] !== 'string' || tool[key]!.length > (key === 'summary' ? 500 : 120))) throw new Failure('invalid_tool_registration');
    const policy = tool.validation;
    if (policy && (!['strict', 'compatible'].includes(policy.mode) || [policy.maxCatalogTools, policy.maxSchemaChars].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1)))) throw new Failure('invalid_tool_registration');
    const parametersSize = JSON.stringify(tool.parameters).length;
    if (policy?.maxCatalogTools !== undefined && this.entries.size >= policy.maxCatalogTools || policy?.maxSchemaChars !== undefined && parametersSize > policy.maxSchemaChars) throw new Failure('tool_catalog_limit');
    const validator = policy?.mode === 'compatible' ? new Ajv({ strict: false, validateFormats: false }) : this.ajv;
    const parameters = { ...tool.parameters }; delete parameters.$schema;
    const entry = { tool, validate: validator.compile(parameters), controller: new AbortController() };
    this.entries.set(tool.name, entry);
    return () => {
      if (this.entries.get(tool.name) !== entry) return;
      this.entries.delete(tool.name);
      entry.controller.abort();
    };
  }
  private access(tool: Tool): 'everyone' | 'admin' { return tool.access ?? ((tool.effect ?? 'write') === 'write' ? 'admin' : 'everyone'); }
  private allowed(tool: Tool, message: Message): boolean { return this.access(tool) === 'everyone' || this.adminIds.includes(message.sender); }
  list() { return [...this.entries.values()].map(({ tool }) => ({ name: tool.name, title: tool.title, summary: tool.summary, owner: tool.owner ?? tool.source, description: tool.description,
    source: tool.source ?? 'external', access: this.access(tool), effect: tool.effect ?? 'write' as const })); }
  timeout(name: string): number | undefined { return this.entries.get(name)?.tool.timeoutMs; }
  schemas(message?: Message): ToolSchema[] {
    return [...this.entries.values()].filter(({ tool }) => !message || this.allowed(tool, message))
      .sort((a, b) => a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0).map(({ tool }) => ({
      type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  async execute(call: ToolCall, message: Message, signal: AbortSignal): Promise<unknown> {
    check(signal);
    const entry = this.entries.get(call.function.name);
    if (!entry) throw new Failure('tool_unavailable');
    // Use the authenticated adapter message, never an ID supplied in model arguments or prompt text.
    if (!this.allowed(entry.tool, message)) throw new Failure('tool_admin_required');
    let args: Fields | undefined;
    try { args = object(JSON.parse(call.function.arguments)); }
    catch { throw new Failure('invalid_tool_arguments'); }
    if (!args || !entry.validate(args)) throw new Failure('invalid_tool_arguments');
    const combined = AbortSignal.any([signal, entry.controller.signal]);
    check(combined);
    let started = false;
    try {
      return await abortable(Promise.resolve().then(() => {
        check(combined);
        started = true;
        return entry.tool.execute(args, { message, signal: combined });
      }), combined);
    } catch (error) {
      const unknown = started && (entry.tool.effect ?? 'write') === 'write';
      throw new Failure(error instanceof Failure ? error.code : 'tool_execution_failed', unknown || (error instanceof Failure && error.unknownOutcome));
    }
  }
}
