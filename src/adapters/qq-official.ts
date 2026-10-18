import { Ajv } from 'ajv';
import type { Context } from 'cordis';
import { ApiError, QQBot } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage, QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import type { Adapter, IncomingMessage, Message, PushTarget, Segment } from '../contracts.js';
import { id, log } from '../contracts.js';
import { abortable, check, Failure } from '../errors.js';

export const name = 'xiaolang-qq-official';
export const xiaolangApiVersion = 1;
export interface QQConfig {
  appId: string;
  secretEnv: string;
  transport: 'websocket';
  environment: 'sandbox' | 'production';
  groupMessages: 'all' | 'mentions';
  connectTimeoutMs: number;
}
const validate = new Ajv().compile<QQConfig>({
  type: 'object', additionalProperties: false,
  required: ['appId', 'secretEnv', 'transport', 'environment', 'groupMessages', 'connectTimeoutMs'],
  properties: {
    appId: { type: 'string', pattern: '^[0-9]{1,32}$' },
    secretEnv: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    transport: { const: 'websocket' }, groupMessages: { enum: ['all', 'mentions'] },
    environment: { enum: ['sandbox', 'production'] },
    connectTimeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
  },
});
export function validateQQConfig(raw: unknown): QQConfig {
  if (!validate(raw)) throw new Failure('invalid_qq_config');
  return raw;
}

/** Only this plugin understands QQ event names, OpenIDs and passive reply rules. */
export function normalizeQQ(event: QQBotInboundMessage, appId: string): IncomingMessage | undefined {
  if (!['c2c', 'group'].includes(event.kind) || event.senderIsBot || !id(event.senderId) || !id(event.messageId)) return;
  if (event.kind === 'group' && !id(event.groupOpenid)) return;
  const time = Date.parse(event.timestamp);
  if (!Number.isFinite(time)) return;
  const segments: Segment[] = [];
  if (event.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || event.mentions?.some(mention => mention.is_you === true && mention.scope !== 'all')) {
    segments.push({ type: 'mention', userId: appId });
  }
  if (typeof event.content === 'string') segments.push({ type: 'text', text: event.content });
  for (const attachment of event.attachments ?? []) {
    const url = attachment.url?.startsWith('//') ? `https:${attachment.url}` : attachment.url;
    if (attachment.content_type?.startsWith('image/') && url?.startsWith('https://')) segments.push({ type: 'image', url, mime: attachment.content_type });
    else segments.push({ type: 'unsupported', kind: attachment.content_type ?? 'attachment' });
  }
  if (!segments.length) return;
  return {
    account: appId, id: event.messageId, sender: event.senderId, name: event.senderName ?? event.senderId,
    group: event.kind === 'group' ? event.groupOpenid : undefined, time, segments,
  };
}

export type QQClient = Pick<QQBot, 'on' | 'off' | 'start' | 'stop' | 'getCredentials' | 'messageApi'>;
export class QQOfficialAdapter implements Adapter {
  readonly platform: string;
  readonly account: string;
  readonly capabilities: Adapter['capabilities'];
  private client: QQClient;
  private ready = false;
  private running?: Promise<void>;
  private cancelStart?: () => void;
  private receive?: (message: IncomingMessage) => void;
  constructor(private config: QQConfig, secret: string, private report: (code: string) => void = () => {},
    factory: (options: QQBotOptions) => QQClient = options => new QQBot(options)) {
    this.account = config.appId;
    this.platform = config.environment === 'sandbox' ? 'qq-official-sandbox' : 'qq-official';
    this.capabilities = { groupMessages: config.groupMessages, maxTextChars: 1500, maxReplyParts: 5, nativeStreaming: true };
    this.client = factory({
      appId: config.appId, appSecret: secret, transport: config.transport, markdownSupport: false,
      baseUrl: config.environment === 'sandbox' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com',
      intents: 1 << 25,
      // SDK logs may contain message bodies or provider response text. Emit our own codes instead.
    });
  }
  async start(receive: (message: IncomingMessage) => void): Promise<void> {
    if (this.running) throw new Failure('qq_already_started');
    this.receive = receive;
    let resolve!: () => void;
    let reject!: (reason: Failure) => void;
    const connected = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const onReady = () => { this.ready = true; this.report('qq_connected'); resolve(); };
    const onDisconnect = () => { this.ready = false; this.report('qq_disconnected'); };
    const onError = () => { this.report('qq_connection_error'); };
    const onMessage = (_ctx: unknown, event: QQBotInboundMessage) => {
      try {
        const message = normalizeQQ(event, this.account);
        if (message && this.ready) this.receive?.(message);
      } catch { this.report('qq_event_failed'); }
    };
    this.client.on('ready', onReady).on('resumed', onReady).on('disconnected', onDisconnect).on('error', onError).on('message', onMessage);
    const timer = setTimeout(() => reject(new Failure('qq_connect_timeout')), this.config.connectTimeoutMs);
    this.cancelStart = () => reject(new Failure('qq_stopped'));
    this.running = this.client.start().then(() => {
      this.ready = false;
      reject(new Failure('qq_stopped'));
    }, () => {
      this.ready = false;
      this.report('qq_connection_failed');
      reject(new Failure('qq_connection_failed'));
    }).finally(() => {
      this.client.off('ready', onReady).off('resumed', onReady).off('disconnected', onDisconnect).off('error', onError).off('message', onMessage);
    });
    try { await connected; }
    catch (error) { await this.stop(); throw error; }
    finally { clearTimeout(timer); this.cancelStart = undefined; }
  }
  async stop(): Promise<void> {
    this.ready = false;
    this.receive = undefined;
    this.cancelStart?.();
    this.client.stop();
    await this.running;
    this.running = undefined;
  }
  async streamReply(message: Message, text: string, index: number, done: boolean, streamId: string | undefined, signal: AbortSignal): Promise<{ id: string }> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    if (message.platform !== this.platform || message.account !== this.account) throw new Failure('adapter_target_mismatch');
    if (message.group) throw new Failure('qq_stream_private_only');
    if (Date.now() - message.time > 300_000 || message.time > Date.now() + 60_000) throw new Failure('qq_reply_expired');
    try {
      const response = await abortable(this.client.messageApi.sendC2CStreamMessage(this.client.getCredentials(), message.sender, {
        input_mode: 'replace', input_state: done ? 10 : 1, content_type: 'markdown', content_raw: text,
        event_id: message.id, msg_id: message.id, msg_seq: 1, index, ...(streamId ? { stream_msg_id: streamId } : {}),
      }), signal);
      if (!id(response.id)) throw new Failure('send_invalid_receipt', true);
      return { id: response.id };
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      if (error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus)) throw new Failure('qq_stream_api_rejected');
      throw new Failure(signal.aborted ? 'qq_send_cancelled' : 'qq_send_unknown', true);
    }
  }

  async reply(message: Message, text: string, part: number, signal: AbortSignal): Promise<{ id: string }> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    if (message.platform !== this.platform || message.account !== this.account) throw new Failure('adapter_target_mismatch');
    if (Date.now() - message.time > 300_000 || message.time > Date.now() + 60_000) throw new Failure('qq_reply_expired');
    // Conservative first-release bound; never turn an expired reply into an unsolicited push.
    if (!Number.isInteger(part) || part < 0 || part >= 5) throw new Failure('qq_reply_part_limit');
    const target = message.group ?? message.sender;
    try {
      const response = await abortable(this.client.messageApi.sendRaw(message.group ? 'group' : 'c2c', target, this.client.getCredentials(), {
        content: text, msg_type: 0, msg_id: message.id, msg_seq: part + 1,
      }), signal);
      if (!id(response.id)) throw new Failure('send_invalid_receipt', true);
      return { id: response.id };
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      if (error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus)) {
        throw new Failure('qq_api_rejected');
      }
      // HTTP transport failure/cancellation can happen after QQ accepted the message.
      throw new Failure(signal.aborted ? 'qq_send_cancelled' : 'qq_send_unknown', true);
    }
  }
  async push(target: PushTarget, text: string, sequence: number, signal: AbortSignal): Promise<{ id: string }> {
    check(signal);
    if (!this.ready) throw new Failure('qq_not_ready');
    if (target.platform !== this.platform || target.account !== this.account || !id(target.recipient)
      || !['private', 'group'].includes(target.scope)) throw new Failure('adapter_target_mismatch');
    if (!text.trim() || Array.from(text).length > this.capabilities.maxTextChars || !Number.isSafeInteger(sequence) || sequence < 1) throw new Failure('invalid_push_message');
    try {
      const response = await abortable(this.client.messageApi.sendRaw(target.scope === 'group' ? 'group' : 'c2c', target.recipient, this.client.getCredentials(), {
        content: text, msg_type: 0, msg_seq: sequence,
      }), signal);
      if (!id(response.id)) throw new Failure('send_invalid_receipt', true);
      return { id: response.id };
    } catch (error) {
      if (error instanceof Failure && error.unknownOutcome) throw error;
      if (error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409].includes(error.httpStatus)) {
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
  const adapter = new QQOfficialAdapter(config, secret, code => log(ctx, code));
  ctx.effect(() => () => adapter.stop());
  ctx.provide('adapter', adapter);
}
