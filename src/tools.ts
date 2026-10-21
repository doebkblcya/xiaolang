import { Ajv } from 'ajv';
import type { Fields, Message, Tool, ToolCall, Tools, ToolSchema } from './contracts.js';
import { object } from './contracts.js';
import { abortable, check, Failure } from './errors.js';

export class ToolRegistry implements Tools {
  constructor(private adminIds: readonly string[] = []) {}
  private entries = new Map<string, { tool: Tool; validate: ReturnType<Ajv['compile']>; controller: AbortController }>();
  private ajv = new Ajv({ strict: true });
  register(tool: Tool): () => void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tool.name) || this.entries.has(tool.name)) throw new Failure('invalid_tool_registration');
    if (tool.access && !['everyone', 'admin'].includes(tool.access)) throw new Failure('invalid_tool_registration');
    if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 180000)) throw new Failure('invalid_tool_registration');
    const parametersSize = JSON.stringify(tool.parameters).length;
    if (tool.source?.startsWith('mcp:') && (this.entries.size >= 100 || parametersSize > 12000)) throw new Failure('tool_catalog_limit');
    const validator = tool.source?.startsWith('mcp:') ? new Ajv({ strict: false, validateFormats: false }) : this.ajv;
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
  list() { return [...this.entries.values()].map(({ tool }) => ({ name: tool.name, description: tool.description,
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
