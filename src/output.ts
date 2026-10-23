import type { Adapter, Log, ModelMessage, Output, ReplyStream, Store, Turn } from './contracts.js';
import { elapsed, id, messageLog } from './contracts.js';
import { check, code, Failure } from './errors.js';

export function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += limit) parts.push(characters.slice(start, start + limit).join(''));
  return parts;
}
export const outputSchema = {
  type: 'object', description: '普通输出等待完整回复；流式输出边生成边发送：私聊更新同一条消息，群聊按句发送，最后一条合并余文。',
  required: ['mode'], properties: { mode: { type: 'string', title: '回复方式', enum: ['normal', 'streaming'], default: 'normal',
    description: '私聊使用 QQ 原生流式；群聊最多发送 5 条，第五条合并剩余内容。保存并应用后生效。' } },
};
export class Sender implements Output {
  constructor(private store: Store, private adapter: Adapter, private limit: number, private report: (entry: Log) => void = () => {}) {}
  private emit(entry: Log): void { try { this.report(entry); } catch { /* isolated observer */ } }
  async feedback(turn: Turn, text: string, signal: AbortSignal): Promise<boolean> {
    check(signal);
    if (turn.message.platform !== this.adapter.platform || turn.message.account !== this.adapter.account) throw new Failure('adapter_target_mismatch');
    if (!text.trim() || Array.from(text).length > Math.min(this.limit, this.adapter.capabilities.maxTextChars)) throw new Failure('feedback_too_long');
    if (!this.store.prepareFeedback(turn.id, text)) return false;
    const details = { ...messageLog(turn.message), turn: turn.id, stage: 'feedback' };
    this.emit({ ...details, code: 'feedback_started', preview: text });
    let receipt: string;
    try {
      check(signal);
      const response = await this.adapter.reply(turn.message, text, 0, signal);
      const value = id(response.id);
      if (!value) throw new Failure('send_invalid_receipt', true);
      receipt = value;
    } catch (error) {
      const unknown = !(error instanceof Failure) || error.unknownOutcome;
      this.store.sendState(turn.id, -1, unknown ? 'unknown' : 'failed');
      this.emit({ ...details, code: unknown ? 'feedback_unknown' : 'feedback_failed', errorCode: code(error) });
      return false;
    }
    this.store.sendState(turn.id, -1, 'sent', receipt);
    this.emit({ ...details, code: 'feedback_sent', receipt });
    return true;
  }
  openStream(turn: Turn, signal: AbortSignal): ReplyStream {
    if (turn.message.platform !== this.adapter.platform || turn.message.account !== this.adapter.account) throw new Failure('adapter_target_mismatch');
    const native = !turn.message.group && this.adapter.capabilities.nativeStreaming && this.adapter.streamReply;
    const limit = Math.min(this.limit, this.adapter.capabilities.maxTextChars), maxParts = this.adapter.replyLimits?.(turn.message).parts ?? this.adapter.capabilities.maxReplyParts ?? 5;
    let text = '', pending = '', visible = '', part = 0, index = 0, streamId: string | undefined, lastSent = 0;
    const platformIds: string[] = [];
    const transmit = async (content: string, done = false) => {
      check(signal);
      const sendPart = native ? 0 : part;
      this.store.streamIntent(turn.id, sendPart, content);
      const started = performance.now();
      const details = { ...messageLog(turn.message), turn: turn.id, stage: 'send', part: sendPart + 1 };
      this.emit({ ...details, code: 'send_started', preview: content });
      let receipt: string, metadata: Awaited<ReturnType<Adapter['reply']>>;
      try {
        const response = native ? await native.call(this.adapter, turn.message, content, index, done, streamId, signal)
          : await this.adapter.reply(turn.message, content, part, signal);
        const value = id(response.id);
        if (!value) throw new Failure('send_invalid_receipt', true);
        receipt = value;
        metadata = response;
      } catch (error) {
        const unknown = !(error instanceof Failure) || error.unknownOutcome;
        this.store.sendState(turn.id, sendPart, unknown ? 'unknown' : 'failed');
        this.emit({ ...details, code: unknown ? 'send_unknown' : 'send_failed', durationMs: elapsed(started), errorCode: code(error) });
        throw new Failure(error instanceof Failure ? error.code : 'send_error', unknown);
      }
      if (native) { streamId ??= receipt; platformIds[0] = streamId; visible = content; index++; lastSent = performance.now(); }
      else { platformIds.push(receipt); visible += content; part++; }
      try { this.store.saveReceipt?.(turn.id, sendPart, metadata); this.store.confirmSend(turn, sendPart, receipt, visible, [{ role: 'assistant', content: visible }], platformIds); }
      catch { throw new Failure('send_persistence_failed', true); }
      this.emit({ ...details, code: 'send_confirmed', durationMs: elapsed(started), receipt });
    };
    return {
      write: async delta => {
        check(signal);
        text += delta; pending += delta;
        this.store.draft(turn.id, text, [{ role: 'assistant', content: text }]);
        if (text.length > 100_000) throw new Failure('model_output_too_long');
        if (native) {
          if (!streamId || performance.now() - lastSent >= 500) await transmit(text);
          return;
        }
        while (part < maxParts - 1) {
          // Periods in numbers and URLs are kept; Chinese sentence endings and newlines flush immediately.
          const boundary = /[。！？!?\n](?:[”’」』）]*)|\.(?=\s)/.exec(pending);
          const count = boundary ? Array.from(pending.slice(0, boundary.index + boundary[0].length)).length : Infinity;
          const chars = Array.from(pending);
          if (count === Infinity && chars.length < limit) break;
          const length = Math.min(count, limit), chunk = chars.slice(0, length).join('');
          pending = chars.slice(length).join('');
          if (chunk.trim()) await transmit(chunk);
          else visible += chunk;
        }
      },
      finish: async protocol => {
        check(signal);
        if (!text.trim()) throw new Failure('empty_reply');
        this.store.draft(turn.id, text, protocol);
        if (native) await transmit(text, true);
        else if (pending.trim()) {
          const remaining = splitText(pending, limit);
          if (remaining.length > maxParts - part) {
            // Tell the user explicitly instead of silently losing text or issuing a sixth reply.
            const note = '（回复过长，受 QQ 回复次数限制，剩余内容未发送。）';
            const available = Math.max(0, limit - Array.from(note).length);
            await transmit(Array.from(pending).slice(0, available).join('') + Array.from(note).slice(0, limit).join(''));
            throw new Failure('qq_reply_part_limit');
          }
          for (const chunk of remaining) if (chunk.trim()) await transmit(chunk);
        }
        try { this.store.delivered(turn, visible, protocol, platformIds); }
        catch { throw new Failure('send_persistence_failed', true); }
      },
    };
  }

  async send(turn: Turn, text: string, protocol: ModelMessage[], signal: AbortSignal): Promise<void> {
    check(signal);
    if (!text.trim()) throw new Failure('empty_reply');
    if (turn.message.platform !== this.adapter.platform || turn.message.account !== this.adapter.account) throw new Failure('adapter_target_mismatch');
    const parts = splitText(text, Math.min(this.limit, this.adapter.capabilities.maxTextChars));
    if (parts.length > (this.adapter.replyLimits?.(turn.message).parts ?? this.adapter.capabilities.maxReplyParts ?? Infinity)) throw new Failure('qq_reply_part_limit');
    this.store.draft(turn.id, text, protocol);
    this.store.prepareSend(turn.id, parts);
    const platformIds: string[] = [];
    for (const [part, content] of parts.entries()) {
      check(signal);
      this.store.sendState(turn.id, part, 'sending');
      const started = performance.now();
      const details = { ...messageLog(turn.message), turn: turn.id, stage: 'send', part: part + 1, parts: parts.length };
      this.emit({ ...details, code: 'send_started', preview: content });
      let platformId: string, metadata: Awaited<ReturnType<Adapter['reply']>>;
      try {
        const response = await this.adapter.reply(turn.message, content, part, signal);
        const receivedId = id(response.id);
        if (!receivedId) throw new Failure('send_invalid_receipt', true);
        platformId = receivedId;
        metadata = response;
      } catch (error) {
        const unknown = !(error instanceof Failure) || error.unknownOutcome;
        this.store.sendState(turn.id, part, unknown ? 'unknown' : 'failed');
        this.emit({ ...details, code: unknown ? 'send_unknown' : 'send_failed', durationMs: elapsed(started), errorCode: code(error) });
        throw new Failure(error instanceof Failure ? error.code : 'send_error', unknown);
      }
      platformIds.push(platformId);
      this.emit({ ...details, code: 'send_confirmed', durationMs: elapsed(started), receipt: platformId });
      // Only confirmed text enters future chat context; a failed draft never does.
      const visible = parts.slice(0, part + 1).join('');
      const visibleProtocol = structuredClone(protocol);
      visibleProtocol[visibleProtocol.length - 1] = { ...visibleProtocol[visibleProtocol.length - 1]!, content: visible };
      try {
        this.store.saveReceipt?.(turn.id, part, metadata);
        this.store.confirmSend(turn, part, platformId, visible, visibleProtocol, platformIds);
      } catch { throw new Failure('send_persistence_failed', true); }
    }
  }
}
