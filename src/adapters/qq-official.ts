import type { Context } from 'cordis';
import { ApiError, QQBot } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage, QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import type { Adapter, IncomingMessage, Message, PushTarget, Log, SendReceipt } from '../contracts.js';
import { id, log, object } from '../contracts.js';
import { abortable, check, Failure } from '../errors.js';

export const name = 'xiaolang-qq-official';
export const xiaolangApiVersion = 1;
export { validateQQConfig } from '../qq-config.js';
import { validateQQConfig } from '../qq-config.js';
import type { QQConfig } from '../qq-config.js';

export { normalizeQQ } from './qq-message.js';
import { normalizeQQ } from './qq-message.js';
import { QQRelationships } from './qq-state.js';

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || undefined;
}

export type QQClient = Pick<QQBot, 'on' | 'off' | 'start' | 'stop' | 'getCredentials' | 'messageApi' | 'api'>;
export class QQOfficialAdapter implements Adapter {
  readonly platform: string;
  readonly account: string;
  readonly capabilities: Adapter['capabilities'];
  private client: QQClient;
  private relationships: QQRelationships;
  private statusRequests = new Map<string, Promise<Record<string, unknown>>>();
  private statusRead = new Map<string, number>();
  private statusUnavailable = 0;
  private statusLastRead = 0;
  private streamRemaining = new Map<string, { remaining: number; length: number }>();
  dispose() { this.relationships.close(); }
  replyLimits(message: Message) { return { parts: message.group ? 5 : 4, ageMs: 300000 }; }
  async conversationStatus(target: PushTarget): Promise<Record<string, unknown>> {
    const current = () => ({ ...this.relationships.get(target.scope, target.recipient), connection: this.connection });
    if (target.platform !== this.platform || target.account !== this.account) return { unavailable: true };
    if (target.scope !== 'group' || this.statusUnavailable > Date.now() || Date.now() - (this.statusRead.get(target.recipient) ?? 0) < 600000) return current();
    const pending = this.statusRequests.get(target.recipient); if (pending) return pending;
    if (Date.now() - this.statusLastRead < 2100) return current();
    this.statusLastRead = Date.now();
    const request = (async () => {
      const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([this.client.api.get<Record<string, unknown>>(`/v2/groups/${encodeURIComponent(target.recipient)}/bot_state`),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('status_timeout')), 3000); })]);
        this.relationships.set('group', target.recipient, { ...(typeof value.allow_proactive_msg === 'boolean' ? { push: value.allow_proactive_msg } : {}),
          receive: typeof value.recv_msg_setting === 'string' ? value.recv_msg_setting.slice(0, 100) : undefined,
          role: typeof value.member_role === 'string' ? value.member_role.slice(0, 30) : undefined, selfId: id(value.member_openid) }, started);
      } catch (error) { if (error instanceof ApiError && error.bizCode === 11253) this.statusUnavailable = Date.now() + 1800000; }
      finally { if (timer) clearTimeout(timer); this.statusRead.set(target.recipient, Date.now()); if (this.statusRead.size > 1000) this.statusRead.delete(this.statusRead.keys().next().value!); this.statusRequests.delete(target.recipient); }
      return current();
    })();
    this.statusRequests.set(target.recipient, request); return request;
  }
  private diagnostic(error: unknown, message?: Message) {
    const p = object(error), business = typeof p?.bizCode === 'number' ? p.bizCode : undefined;
    const http = typeof p?.httpStatus === 'number' ? p.httpStatus : undefined;
    const explanations: Record<number, string> = { 40034005: '被动回复已过期', 304103: '被动回复已过期', 40034128: '被动回复时效或次数超限',
      40034100: '主动消息频控限制', 40034101: '机器人已不在群内', 40034105: '没有主动推送权限', 40054002: '机器人被禁言',
      40034006: '消息内容被平台拒绝', 11253: '机器人未获得该接口权限', 40054013: '用户拒绝接收主动消息' };
    this.report('qq_api_error', { label: 'QQ 接口错误', level: 'error', reason: business === undefined ? '请求未获得明确业务结果' : explanations[business] ?? '平台明确拒绝请求', ...(message ? { messageId: message.key } : {}),
      errorCode: business === undefined ? 'qq_transport_error' : `qq_api_${business}`, fields: [
        ...(http === undefined ? [] : [{ label: 'HTTP', value: http }]),
        ...(business === undefined ? [] : [{ label: '平台错误码', value: business }]),
        ...(typeof p?.traceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(p.traceId) ? [{ label: 'TraceID', value: p.traceId }] : []),
      ] });
    return { business, http };
  }
  private receipt(value: unknown): SendReceipt {
    const p = object(value); if (!id(p?.id)) throw new Failure('send_invalid_receipt', true);
    return { id: id(p!.id)!, reference: id(object(p!.ext_info)?.ref_idx), timestamp: typeof p!.timestamp === 'string' ? p!.timestamp : undefined,
      remaining: typeof p!.remain_msg_len === 'number' && Number.isSafeInteger(p!.remain_msg_len) && p!.remain_msg_len >= 0 ? p!.remain_msg_len : undefined };
  }
  private ready = false;
  private connection = 'starting';
  connectionStatus() { return this.connection; }
  private running?: Promise<void>;
  private cancelStart?: () => void;
  private receive?: (message: IncomingMessage) => void;
  private names = new Map<string, { name?: string; until: number }>();
  private nameRequests = new Map<string, Promise<string | undefined>>();
  private lastNameLookup = 0;
  private namesUnavailableUntil = 0;
  constructor(private config: QQConfig, secret: string, private report: (code: string, details?: Partial<Log>) => void = () => {},
    factory: (options: QQBotOptions) => QQClient = options => new QQBot(options), database?: string) {
    this.account = config.appId;
    this.relationships = new QQRelationships(this.account, database);
    this.platform = config.environment === 'sandbox' ? 'qq-official-sandbox' : 'qq-official';
    this.capabilities = { groupMessages: config.groupMessages, maxTextChars: 1500, maxReplyParts: 5, nativeStreaming: true };
    this.client = factory({
      appId: config.appId, appSecret: secret, transport: config.transport, markdownSupport: false,
      baseUrl: config.environment === 'sandbox' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com',
      tokenBaseUrl: 'https://api.bot.qq.com',
      intents: 1 << 25,
      // SDK logs may contain message bodies or provider response text. Emit our own codes instead.
    });
  }
  async groupName(group: string): Promise<string | undefined> {
    if (!id(group)) return;
    const cached = this.names.get(group);
    if (cached && cached.until > Date.now()) return cached.name;
    const pending = this.nameRequests.get(group);
    if (pending) return pending;
    // Official endpoint permits 30 QPM. Panel polling must not turn into API polling.
    if (this.namesUnavailableUntil > Date.now() || Date.now() - this.lastNameLookup < 2100) return cached?.name;
    this.lastNameLookup = Date.now();
    const request = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          this.client.api.get<{ group_name?: unknown }>(`/v2/groups/${encodeURIComponent(group)}/info`),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('name_timeout')), 3000); }),
        ]);
        const name = displayName(response.group_name);
        this.names.set(group, { name, until: Date.now() + (name ? 3600_000 : 600_000) });
        return name;
      } catch (error) {
        if (error instanceof ApiError && error.bizCode === 11253) this.namesUnavailableUntil = Date.now() + 1800_000;
        this.names.set(group, { name: cached?.name, until: Date.now() + 600_000 });
        return cached?.name;
      } finally {
        if (timer) clearTimeout(timer);
        this.nameRequests.delete(group);
        if (this.names.size > 256) this.names.delete(this.names.keys().next().value!);
      }
    })();
    this.nameRequests.set(group, request);
    return request;
  }
  async start(receive: (message: IncomingMessage) => void): Promise<void> {
    if (this.running) throw new Failure('qq_already_started');
    this.receive = receive;
    let resolve!: () => void;
    let reject!: (reason: Failure) => void;
    const connected = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const onReady = () => { this.ready = true; this.connection = 'connected'; this.report('qq_connected'); resolve(); };
    const onDisconnect = () => { this.ready = false; this.connection = 'disconnected'; this.report('qq_disconnected'); };
    const onError = (error: Error) => { this.connection = 'error'; this.diagnostic(error); this.report('qq_connection_error'); };
    const onMessage = (_ctx: unknown, event: QQBotInboundMessage) => {
      try {
        const message = normalizeQQ(event, this.account);
        if (message && this.ready) {
          this.relationships.set(message.group ? 'group' : 'private', message.group ?? message.sender, { present: true }, Math.floor(message.time / 1000) * 1000);
          for (const part of message.segments) if (part.type === 'mention' && !part.all && this.relationships.get('group', message.group ?? '')?.selfId === part.userId) part.self = true;
          this.receive?.(message);
        }
      } catch { this.report('qq_event_failed'); }
    };
    const onRaw = (context: { eventType: string; data: unknown }) => {
      const event = context.eventType, data = object(context.data); if (!data) return;
      if (!['FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE', 'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_REJECT', 'GROUP_MSG_RECEIVE'].includes(event)) return;
      const group = id(data.group_openid), recipient = group ?? id(data.openid); if (!recipient) return;
      const patch = event === 'FRIEND_DEL' || event === 'GROUP_DEL_ROBOT' ? { present: false }
        : event === 'FRIEND_ADD' || event === 'GROUP_ADD_ROBOT' ? { present: true } : { push: event.endsWith('_RECEIVE') };
      const stamp = typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp * 1000 : Date.now();
      this.relationships.set(group ? 'group' : 'private', recipient, patch, stamp);
      this.report('qq_relationship_changed', { group, state: event, label: 'QQ 会话状态变化' });
    };
    this.client.on('ready', onReady).on('resumed', onReady).on('disconnected', onDisconnect).on('error', onError).on('message', onMessage).on('rawEvent', onRaw);
    const timer = setTimeout(() => reject(new Failure('qq_connect_timeout')), this.config.connectTimeoutMs);
    this.cancelStart = () => reject(new Failure('qq_stopped'));
    this.running = this.client.start().then(() => {
      this.ready = false;
      reject(new Failure('qq_stopped'));
    }, error => {
      this.ready = false;
      this.diagnostic(error);
      this.connection = 'error'; this.report('qq_connection_failed');
      reject(new Failure('qq_connection_failed'));
    }).finally(() => {
      this.client.off('ready', onReady).off('resumed', onReady).off('disconnected', onDisconnect).off('error', onError).off('message', onMessage).off('rawEvent', onRaw);
    });
    try { await connected; }
    catch (error) { await this.stop(); throw error; }
    finally { clearTimeout(timer); this.cancelStart = undefined; }
  }
  async stop(): Promise<void> {
    this.ready = false;
    this.connection = 'disconnected';
    this.receive = undefined;
    this.cancelStart?.();
    this.client.stop();
    await this.running;
    this.running = undefined;
  }
  async streamReply(message: Message, text: string, index: number, done: boolean, streamId: string | undefined, signal: AbortSignal): Promise<SendReceipt> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    if (message.platform !== this.platform || message.account !== this.account) throw new Failure('adapter_target_mismatch');
    if (message.group) throw new Failure('qq_stream_private_only');
    const previous = streamId ? this.streamRemaining.get(streamId) : undefined;
    if (previous && Array.from(text).length - previous.length > previous.remaining) throw new Failure('qq_stream_length_limit');
    if (Date.now() - message.time > 300_000 || message.time > Date.now() + 60_000) throw new Failure('qq_reply_expired');
    try {
      const response = await abortable(this.client.messageApi.sendC2CStreamMessage(this.client.getCredentials(), message.sender, {
        input_mode: 'replace', input_state: done ? 10 : 1, content_type: 'markdown', content_raw: text,
        msg_id: message.id, msg_seq: 1, index, ...(streamId ? { stream_msg_id: streamId } : {}),
      }), signal);
      const receipt = this.receipt(response);
      if (receipt.remaining !== undefined) this.streamRemaining.set(receipt.id, { remaining: receipt.remaining, length: Array.from(text).length });
      if (done) this.streamRemaining.delete(receipt.id);
      if (this.streamRemaining.size > 500) this.streamRemaining.delete(this.streamRemaining.keys().next().value!);
      return receipt;
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      const diagnostic = this.diagnostic(error, message);
      if (error instanceof ApiError && (diagnostic.business !== undefined || error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus))) throw new Failure(diagnostic.business === undefined ? 'qq_stream_api_rejected' : `qq_api_${diagnostic.business}`);
      throw new Failure(signal.aborted ? 'qq_send_cancelled' : 'qq_send_unknown', true);
    }
  }

  async reply(message: Message, text: string, part: number, signal: AbortSignal): Promise<SendReceipt> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    if (message.platform !== this.platform || message.account !== this.account) throw new Failure('adapter_target_mismatch');
    if (Date.now() - message.time > 300_000 || message.time > Date.now() + 60_000) throw new Failure('qq_reply_expired');
    // Conservative first-release bound; never turn an expired reply into an unsolicited push.
    if (!Number.isInteger(part) || part < 0 || part >= this.replyLimits(message).parts) throw new Failure('qq_reply_part_limit');
    const target = message.group ?? message.sender;
    try {
      const response = await abortable(this.client.messageApi.sendRaw(message.group ? 'group' : 'c2c', target, this.client.getCredentials(), {
        content: text, msg_type: 0, msg_id: message.id, msg_seq: part + 1,
      }), signal);
      return this.receipt(response);
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      const diagnostic = this.diagnostic(error, message);
      if (error instanceof ApiError && (diagnostic.business !== undefined || error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus))) {
        throw new Failure(diagnostic.business === undefined ? 'qq_api_rejected' : `qq_api_${diagnostic.business}`);
      }
      // HTTP transport failure/cancellation can happen after QQ accepted the message.
      throw new Failure(signal.aborted ? 'qq_send_cancelled' : 'qq_send_unknown', true);
    }
  }
  async push(target: PushTarget, text: string, sequence: number, signal: AbortSignal): Promise<SendReceipt> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    const relationship = this.relationships.get(target.scope, target.recipient);
    if (relationship?.present === false || relationship?.push === false) throw new Failure('qq_push_refused');
    if (target.platform !== this.platform || target.account !== this.account || !id(target.recipient)
      || !['private', 'group'].includes(target.scope)) throw new Failure('adapter_target_mismatch');
    if (!text.trim() || Array.from(text).length > this.capabilities.maxTextChars || !Number.isSafeInteger(sequence) || sequence < 1) throw new Failure('invalid_push_message');
    try {
      const response = await abortable(this.client.messageApi.sendRaw(target.scope === 'group' ? 'group' : 'c2c', target.recipient, this.client.getCredentials(), {
        content: text, msg_type: 0, msg_seq: sequence,
      }), signal);
      return this.receipt(response);
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      const diagnostic = this.diagnostic(error);
      if (error instanceof ApiError && (diagnostic.business !== undefined || error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus))) {
        const failure = error.bizCode === 40034105 ? 'qq_push_permission_denied' : error.bizCode === 40034100 ? 'qq_push_rate_limited'
          : error.bizCode === 40054013 ? 'qq_push_refused' : 'qq_push_rejected';
        throw new Failure(failure);
      }
      throw new Failure(signal.aborted ? 'qq_send_cancelled' : 'qq_send_unknown', true);
    }
  }
}

export function apply(ctx: Context, raw: unknown): void {
  const config = validateQQConfig(raw);
  const secret = process.env[config.secretEnv];
  if (!secret) throw new Failure('missing_qq_secret');
  const adapter = new QQOfficialAdapter(config, secret, (code, details) => log(ctx, code, undefined, 'adapter', details), undefined, ctx.xiaolangHost.config.database);
  ctx.effect(() => async () => { await adapter.stop(); adapter.dispose(); });
  ctx.provide('adapter', adapter);
}

/** Optional management-panel surfaces owned by this plugin. */
export const xiaolangPanel = { home: [{ id: 'connection', title: 'QQ 连接', action: 'detail' }], detail: { view: 'qq-settings' }, pages: [{ id: 'qq-settings', title: 'QQ 接入', view: 'qq-settings' }] };

export const xiaolangPanelHome: import('../panel.js').PanelHomeReader = ctx => {
  const adapter = ctx.get('adapter');
  if (!adapter) throw new Error('adapter_unavailable');
  const state = adapter.connectionStatus?.() ?? 'unknown';
  const values: Record<string, string> = { connected: '已连接', disconnected: '已断开', starting: '连接中', error: '连接异常', unknown: '暂不可用' };
  return { value: values[state] ?? '暂不可用', detail: adapter.platform === 'qq-official-sandbox' ? '沙箱环境' : '正式环境',
    tone: state === 'connected' ? 'good' : state === 'error' ? 'bad' : 'neutral' };
};
