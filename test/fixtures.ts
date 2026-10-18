import { readFileSync } from 'node:fs';
import { validateConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { toolingDefaults } from '../src/tooling-config.js';
import type { Adapter, IncomingMessage, Message, Model, ModelMessage, ToolSchema } from '../src/contracts.js';

export function config(): Config {
  const value = validateConfig(JSON.parse(readFileSync('config.example.json', 'utf8')));
  // General pipeline fixtures exercise legacy configuration; persona tests opt in explicitly.
  delete value.character;
  value.database = ':memory:';
  value.limits.turnTimeoutMs = 3000;
  value.model.timeoutMs = 1000;
  value.tooling = structuredClone(toolingDefaults); value.tooling.access.adminIds = ['200'];
  return value;
}
export function event(text: string, messageId = 1, group: number | string | null = 100, user: number | string = 200): IncomingMessage {
  return { account: '123456789', sender: String(user), group: group === null ? undefined : String(group),
    id: String(messageId), time: Date.now(), name: `user-${user}`, segments: [{ type: 'text', text }] };
}
export class FakeAdapter implements Adapter {
  platform = 'mock';
  account = '123456789';
  capabilities = { groupMessages: 'all' as const, maxTextChars: 4000 };
  receive?: (message: IncomingMessage) => void;
  sent: { message: Message; text: string; part: number }[] = [];
  start(receive: (message: IncomingMessage) => void): void { this.receive = receive; }
  stop(): void { this.receive = undefined; }
  async reply(message: Message, text: string, part: number): Promise<{ id: string }> {
    this.sent.push({ message, text, part });
    return { id: String(this.sent.length + 1000) };
  }
}
export class FakeModel implements Model {
  requests: ModelMessage[][] = [];
  constructor(private reply: (messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal) => Promise<ModelMessage> = async () => ({ role: 'assistant', content: '收到。' })) {}
  async complete(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal): Promise<ModelMessage> {
    this.requests.push(structuredClone(messages));
    return this.reply(messages, tools, signal);
  }
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
