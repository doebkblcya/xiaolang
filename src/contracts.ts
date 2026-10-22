import type { Context } from 'cordis';
import type { UsageMeter, UsageQuery } from './usage.js';

export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';
export type Fields = Record<string, unknown>;
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string }
  | { type: 'reply'; messageId: string }
  | { type: 'image'; url: string; mime?: string }
  | { type: 'unsupported'; kind: string };
export interface IncomingMessage {
  account: string;
  id: string;
  sender: string;
  name: string;
  group?: string;
  time: number;
  segments: Segment[];
}
export interface Message extends IncomingMessage {
  key: string;
  platform: string;
  session: string;
  text: string;
  seq: number;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  images?: { url: string }[];
}
export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Fields };
}
/** Original image bytes are transient input, never part of the persisted tool result. */
export class VisualToolResult {
  constructor(public result: Fields, public readonly images: { url: string }[]) {}
  toJSON(): Fields { return this.result; }
}
export interface Model {
  stream?(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, write: (delta: string) => Promise<void>): Promise<ModelMessage>;
  complete(messages: ModelMessage[], tools: ToolSchema[], signal: AbortSignal, options?: ModelOptions): Promise<ModelMessage>;
}
export interface ModelOptions { thinking?: boolean; reasoningEffort?: 'low' | 'high' | 'max'; maxOutputTokens?: number; timeoutMs?: number; retries?: number; temperature?: number; stop?: string[] }
export interface Adapter {
  platform: string;
  account: string;
  capabilities: { groupMessages: 'all' | 'mentions'; maxTextChars: number; maxReplyParts?: number; nativeStreaming?: boolean };
  start(receive: (message: IncomingMessage) => void): Promise<void> | void;
  stop(): Promise<void> | void;
  groupName?(group: string): Promise<string | undefined>;
  streamReply?(message: Message, text: string, index: number, done: boolean, streamId: string | undefined, signal: AbortSignal): Promise<{ id: string }>;
  reply(message: Message, text: string, part: number, signal: AbortSignal): Promise<{ id: string }>;
  push?(target: PushTarget, text: string, sequence: number, signal: AbortSignal): Promise<{ id: string }>;
}
export interface PushTarget { platform: string; account: string; scope: 'private' | 'group'; recipient: string }
export type TurnState = 'queued' | 'running' | 'sending' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'expired';
export interface Turn { id: string; message: Message; reason: string }
export interface SendRecord { part: number; text: string; state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'; platformId?: string }
export interface Store {
  pushDelivered?(source: number, execution: string, text: string, receipt: string, time: number): void;
  records(query: { after?: number; before?: number; fence?: number; session?: string; limit: number; incoming?: boolean }): ChatRecord[];
  record(seq: number): ChatRecord | undefined;
  admit(message: Message): Message | undefined;
  history(message: Message, limit: number): ModelMessage[];
  createTurn(message: Message, reason: string): Turn;
  state(id: string, state: TurnState, code?: string): void;
  draft(id: string, text: string, protocol: ModelMessage[]): void;
  prepareSend(id: string, parts: string[]): void;
  streamIntent(id: string, part: number, text: string): void;
  sendState(id: string, part: number, state: SendRecord['state'], platformId?: string): void;
  delivered(turn: Turn, text: string, protocol: ModelMessage[], platformIds: string[]): void;
  confirmSend(turn: Turn, part: number, platformId: string, text: string, protocol: ModelMessage[], platformIds: string[]): void;
  toolStart(turn: string, call: ToolCall): void;
  toolEnd(turn: string, call: string, state: string, result: string): void;
  prepareFeedback(turn: string, text: string): boolean;
}
export interface ChatRecord { seq: number; session: string; direction: 'in' | 'out'; message: Message; text: string }
export interface Reminders {
  start(): void;
  stop(): Promise<void>;
  idle(): Promise<void>;
  list(message?: Message, includeFinished?: boolean): Record<string, unknown>;
  create(input: unknown, message: Message): Record<string, unknown>;
  cancel(id: unknown, message?: Message): Record<string, unknown>;
}
export interface Persona {
  prompt(message: Message): string;
  promptParts?(message: Message): { instructions: string; reference: string };
  status(): Record<string, unknown>;
  list(): unknown;
  detail(id: string): unknown;
  mutate(input: unknown): unknown;
  learn(): Promise<unknown>;
  stop(): Promise<void>;
}
export interface Memory {
  sourceAllowed?(seq: number): boolean;
  imageContext?(message: Message): string;
  prepare(turn: Turn, signal: AbortSignal): Promise<{ history: ModelMessage[]; context: string; images: { url: string }[];
    parts?: { instructions: string; summary: string; recall: string; current: string } } | undefined>;
  status(): Record<string, unknown>;
  list(query: string, kind?: string, before?: number): Record<string, unknown>;
  detail(id: string, beforeVersion?: number): unknown;
  mutate(input: unknown): Promise<unknown>;
  recalled(turn: string): unknown;
  maintain(action: string): Promise<unknown>;
}
export interface Scheduler {
  enqueue(key: string, run: (signal: AbortSignal) => Promise<void>): Promise<void>;
}
export interface Trigger {
  match(message: Message): string | undefined;
  observe?(message: Message, dispatch: (message: Message, reason: string) => void): void;
  queued?(message: Message, reason: string): void;
  settled?(message: Message, replied: boolean): void;
  current?(message: Message): boolean;
  idle?(): Promise<void>;
  clear?(): Promise<void>;
}
export interface Intake { receive(event: unknown): void }
export interface ToolContext { message: Message; signal: AbortSignal }
export interface Tool {
  name: string;
  description: string;
  parameters: Fields;
  effect?: 'read' | 'write';
  access?: 'everyone' | 'admin';
  source?: string;
  timeoutMs?: number;
  execute(args: Fields, context: ToolContext): Promise<unknown>;
}
export interface Tools {
  register(tool: Tool): () => void;
  schemas(message?: Message): ToolSchema[];
  list(): { name: string; description: string; source: string; access: 'everyone' | 'admin'; effect: 'read' | 'write' }[];
  timeout(name: string): number | undefined;
  execute(call: ToolCall, message: Message, signal: AbortSignal): Promise<unknown>;
}
export interface ReplyStream {
  write(delta: string): Promise<void>;
  finish(protocol: ModelMessage[]): Promise<void>;
}
export interface Output {
  openStream?(turn: Turn, signal: AbortSignal): ReplyStream;
  send(turn: Turn, text: string, protocol: ModelMessage[], signal: AbortSignal): Promise<void>;
  feedback?(turn: Turn, text: string, signal: AbortSignal): Promise<boolean>;
}
export interface FaultFeedback { notify(turn: Turn, failure: string, signal: AbortSignal): Promise<void> }
export interface Chat { idle(): Promise<void>; stop(): Promise<void> }
export interface Log {
  code: string; time?: string; level?: 'info' | 'warn' | 'error';
  turn?: string; stage?: string; plugin?: string; dependencies?: string[];
  messageId?: string; taskId?: string; scope?: 'private' | 'group'; sender?: string; group?: string;
  preview?: string; reason?: string; model?: string; step?: number; tool?: string;
  part?: number; parts?: number; toolCalls?: number; durationMs?: number; waitMs?: number;
  state?: string; errorCode?: string; receipt?: string;
  usageId?: number; purpose?: string; provider?: string; attempt?: number;
  imageCount?: number;
  inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedTokens?: number; reasoningTokens?: number;
}
export interface TurnView {
  id: string; seq: number; state: string; reason: string; errorCode: string | null;
  received: number; updated: number; scope: 'private' | 'group'; sender: string; group?: string;
  input: string; reply: string; inputTruncated: boolean; replyTruncated: boolean;
}
export interface TurnDetail extends TurnView {
  sends: { part: number; kind?: 'reply' | 'feedback'; text: string; state: string; receipt: string | null }[];
  tools: { name: string; state: string }[];
}
export interface ConversationView {
  id: string; scope: 'group' | 'private'; recipient: string; name: string; alias: string; version: number;
  platform: string; account: string; lastSeq: number; preview: string; messages: number;
}
export interface TimelineItem {
  seq: number; direction: 'in' | 'out'; time: number; sender: string; name: string;
  text: string; segments: Segment[]; kind: 'message' | 'reply' | 'reminder'; parts?: string[];
  turn?: { id: string; state: string; reason: string }; feedback?: { text: string; state: string };
}
export interface HistoryReader {
  deleteData(input: unknown): unknown;
  cacheConversationName(id: string, name: string): void;
  conversations(query?: string, scope?: string, before?: number): { items: ConversationView[]; next: number | null };
  timeline(id: string, before?: number): { conversation: ConversationView; items: TimelineItem[]; next: number | null };
  renameConversation(id: string, alias: string, version: number): ConversationView;

  counts(): Record<string, number>;
  recent(limit: number, before?: number, failures?: boolean): { items: TurnView[]; next: number | null };
  detail(id: string): TurnDetail | undefined;
}
export interface LogItem { seq: number; entry: Log }
export interface PluginInfo { id: string; title: string; module: string; kind: 'builtin' | 'external'; state: string; dependencies: string[]; provides: string[]; missingDependencies?: string[]; impact?: string; panel?: import('./panel.js').PluginPanel }
export interface Inspection {
  usage?(query: UsageQuery): ReturnType<UsageMeter['view']>;
  deleteData(input: unknown): Promise<unknown>;
  status(): {
    started: number; uptimeMs: number; state: string; connection: string; lastMessage?: string;
    model: string; platform?: string; chatEnabled: boolean; memoryBytes: number;
    counts: Record<string, number>; plugins: PluginInfo[];
  };
  recent: HistoryReader['recent']; detail: HistoryReader['detail'];
  conversations(query?: string, scope?: string, before?: number): Promise<ReturnType<HistoryReader['conversations']>>;
  timeline(id: string, before?: number): Promise<ReturnType<HistoryReader['timeline']>>;
  renameConversation: HistoryReader['renameConversation'];
  logs(after?: number): { items: LogItem[]; cursor: number; reset: boolean };
}

export interface Configuration {
  view(): Promise<Record<string, unknown>>;
  save(section: 'model' | 'qq' | 'trigger', input: unknown): Promise<Record<string, unknown>>;
  apply(revision: string): Promise<void>;
  registerPlugin(id: string, schema: Fields): void;
  plugin(id: string): Promise<Record<string, unknown>>;
  savePlugin(id: string, input: unknown): Promise<Record<string, unknown>>;
}

declare module 'cordis' {
  interface Context {
    xiaolangHost: { config: import('./config.js').Config; options: import('./app.js').AppOptions; cleanups: Map<string, import('./data-cleanup.js').DataCleanup>; panels: Map<string, import('./panel.js').PanelRegistration>; pluginDependencies: Map<string, string[]> };
    store: Store;
    scheduler: Scheduler;
    trigger: Trigger;
    intake: Intake;
    model: Model;
    adapter: Adapter;
    tools: Tools;
    output: Output;
    chat: Chat;
    logOutput: { write(entry: Log): void };
    historyReader: HistoryReader;
    inspection: Inspection;
    configuration: Configuration;
    faultFeedback: FaultFeedback;
    memory: Memory;
    persona: Persona;
    mcp: { status(): unknown[] };
    skills: { status(): unknown[] };
    reminders: Reminders;
    usage: UsageMeter;
  }
  interface Events {
    'xiaolang/start'(): void | Promise<void>;
    'xiaolang/message'(message: Message): void;
    'xiaolang/observed'(message: Message): void | Promise<void>;
    'xiaolang/log'(entry: Log): void;
    'xiaolang/logged'(entry: Log): void;
  }
}

export function emitLog(ctx: Context, entry: Log): void {
  // Observability must never change the outcome of message processing.
  try { ctx.emit('xiaolang/log', { ...entry, time: new Date().toISOString() }); } catch { /* isolated observer */ }
}
export function log(ctx: Context, code: string, turn?: string, stage?: string, details: Partial<Log> = {}): void {
  emitLog(ctx, { ...details, code, turn, stage });
}
export function messageLog(message: Message): Partial<Log> {
  return { messageId: message.key, scope: message.group ? 'group' : 'private', sender: message.name, group: message.group };
}
export function elapsed(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}
export function object(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}
export function id(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}
