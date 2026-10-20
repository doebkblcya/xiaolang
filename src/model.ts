import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Model, ModelMessage, ModelOptions, ToolCall, ToolSchema } from './contracts.js';
import { object } from './contracts.js';
import { check, Failure } from './errors.js';
import { meterRequest } from './usage.js';
import type { UsageMeter } from './usage.js';

export class DeepSeekModel implements Model {
  constructor(private config: Config['model'], private apiKey: string, private fetcher: typeof fetch = fetch, private meter?: UsageMeter) {}
  async complete(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, options?: ModelOptions): Promise<ModelMessage> {
    const config = { ...this.config, ...options };
    for (let attempt = 0; ; attempt++) {
      check(signal);
      try { return await this.request(messages, tools, signal, undefined, config, attempt + 1); }
      catch (error) {
        check(signal);
        if (!(error instanceof Failure) || !error.retryable || attempt >= config.retries) throw error;
        await delay(Math.min(500 * 2 ** attempt, 4000), undefined, { signal });
      }
    }
  }
  async stream(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, write: (delta: string) => Promise<void>): Promise<ModelMessage> {
    let emitted = false;
    for (let attempt = 0; ; attempt++) {
      check(signal);
      try { return await this.request(messages, tools, signal, async delta => { emitted = true; await write(delta); }, this.config, attempt + 1); }
      catch (error) {
        check(signal);
        if (emitted || !(error instanceof Failure) || !error.retryable || attempt >= this.config.retries) throw error;
        await delay(Math.min(500 * 2 ** attempt, 4000), undefined, { signal });
      }
    }
  }
  private request(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, write: ((delta: string) => Promise<void>) | undefined, config: Config['model'], attempt: number) {
    return meterRequest({ provider: 'deepseek', model: config.name, kind: 'chat', streaming: !!write,
      thinking: config.thinking ? config.reasoningEffort ?? 'enabled' : 'off', attempt },
    capture => this.once(messages, tools, signal, write, config, capture), this.meter);
  }
  private async once(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, write: ((delta: string) => Promise<void>) | undefined,
    config: Config['model'], capture: (body: unknown) => void): Promise<ModelMessage> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetcher(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.name, messages: messages.map(({ images, ...message }) => {
          // Preserve actual tool-continuation thoughts; older non-thinking chat has no reasoning state.
          if (config.thinking && tools.length && message.role === 'assistant' && message.reasoning_content === undefined) message.reasoning_content = '';
          return images?.length ? { ...message, content: [
          { type: 'text', text: message.content ?? '' }, ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })),
        ] } : message; }), stream: !!write, ...(write ? { stream_options: { include_usage: true } } : {}), max_tokens: config.maxOutputTokens,
          thinking: { type: config.thinking ? 'enabled' : 'disabled' },
          ...(config.thinking ? {
            ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
            ...(config.topP !== undefined ? { top_p: config.topP } : {}),
          } : config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.stop?.length ? { stop: config.stop } : {}), ...(tools.length ? { tools } : {}) }),
      });
    } catch {
      check(signal);
      throw new Failure(combined.aborted ? 'model_timeout' : 'model_network', false, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Failure(`model_http_${response.status}`, false, response.status === 429 || response.status >= 500);
    }
    let raw: unknown;
    if (write) raw = await this.readStream(response, combined, signal, write, capture);
    else try { raw = await response.json(); capture(raw); }
    catch {
      check(signal);
      throw new Failure(combined.aborted ? 'model_timeout' : 'model_invalid_json', false, combined.aborted);
    }
    check(signal);
    const body = object(raw);
    const choices = body?.choices;
    const choice = Array.isArray(choices) ? object(choices[0]) : undefined;
    if (choice?.finish_reason === 'length') throw new Failure('model_output_truncated');
    if (!choice || !['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw new Failure('model_invalid_response');
    const message = object(choice.message);
    if (message?.role !== 'assistant') throw new Failure('model_invalid_response');
    const result: ModelMessage = { role: 'assistant', content: typeof message.content === 'string' ? message.content : null };
    if (typeof message.reasoning_content === 'string') result.reasoning_content = message.reasoning_content;
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8) throw new Failure('model_invalid_tool_calls');
      const ids = new Set<string>();
      result.tool_calls = message.tool_calls.map((rawCall: unknown): ToolCall => {
        const call = object(rawCall);
        const fn = object(call?.function);
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 128 || ids.has(call.id)
          || typeof fn?.name !== 'string' || typeof fn.arguments !== 'string' || fn.arguments.length > 20000) throw new Failure('model_invalid_tool_calls');
        ids.add(call.id);
        return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
      });
    }
    if (!result.tool_calls?.length && !result.content?.trim()) throw new Failure('model_empty_response');
    return result;
  }
  private async readStream(response: Response, combined: AbortSignal, signal: AbortSignal, write: (delta: string) => Promise<void>, capture: (body: unknown) => void): Promise<unknown> {
    if (!response.body) throw new Failure('model_invalid_response');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', content = '', reasoning = '', finish: unknown, done = false;
    const calls = new Map<number, ToolCall>();
    const consume = async (frame: string) => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || done) return;
      if (data === '[DONE]') { done = true; return; }
      let raw: unknown;
      try { raw = JSON.parse(data); } catch { throw new Failure('model_invalid_json'); }
      capture(raw);
      const choices = object(raw)?.choices;
      if (!Array.isArray(choices)) throw new Failure('model_invalid_response');
      if (!choices.length) return; // Optional usage-only event.
      const choice = object(choices[0]), delta = object(choice?.delta);
      if (!choice || !delta || (delta.role !== undefined && delta.role !== 'assistant')) throw new Failure('model_invalid_response');
      if (choice.finish_reason != null) finish = choice.finish_reason;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) throw new Failure('model_invalid_tool_calls');
        for (const rawCall of delta.tool_calls) {
          const item = object(rawCall), index = item?.index;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 8) throw new Failure('model_invalid_tool_calls');
          const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
          const fn = object(item?.function);
          if (item?.type !== undefined && item.type !== 'function') throw new Failure('model_invalid_tool_calls');
          if (typeof item?.id === 'string') call.id += item.id;
          if (typeof fn?.name === 'string') call.function.name += fn.name;
          if (typeof fn?.arguments === 'string') call.function.arguments += fn.arguments;
          if (call.id.length > 128 || call.function.name.length > 128 || call.function.arguments.length > 20000) throw new Failure('model_invalid_tool_calls');
          calls.set(index, call);
        }
      }
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; await write(delta.content); }
      if (content.length + reasoning.length > 2_000_000) throw new Failure('model_output_too_long');
    };
    try {
      while (!done) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { check(signal); throw new Failure(combined.aborted ? 'model_timeout' : 'model_stream_interrupted', false, combined.aborted); }
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        // Normalize CRLF only once complete lines are present, including split CR/LF chunks.
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index).replace(/\r\n/g, '\n');
          buffer = buffer.slice(match.index + match[0].length);
          await consume(frame);
        }
        if (buffer.length > 1_000_000) throw new Failure('model_invalid_response');
        if (chunk.done) { if (buffer.trim()) await consume(buffer.replace(/\r\n/g, '\n')); break; }
      }
      check(signal);
      if (combined.aborted) throw new Failure('model_timeout');
      if (!done || finish == null) throw new Failure('model_stream_interrupted');
      return { choices: [{ finish_reason: finish, message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) } }] };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

}
