import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { IncomingMessage, Segment } from '../contracts.js';
import { id, object } from '../contracts.js';
import { readSegments } from '../messages.js';

const short = (v: unknown, max = 512) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : undefined;
const link = (v: unknown) => { const s = short(v, 4096); return s?.startsWith('//') ? `https:${s}` : s?.startsWith('https://') ? s : undefined; };
const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
function ext(raw: unknown, name: string): string | undefined {
  if (!Array.isArray(raw)) return;
  const item = raw.slice(0, 100).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  return typeof item === 'string' ? id(item.slice(name.length + 1)) : undefined;
}
function attachments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).map(value => {
    const p = object(value) ?? {}, mime = short(p.content_type, 100) ?? 'unknown', url = link(p.url);
    const meta = { filename: short(p.filename, 200), size: number(p.size) };
    if (mime.startsWith('image/') && url) return { type: 'image', url, mime, ...meta, width: number(p.width), height: number(p.height) };
    const kind = mime === 'voice' || mime.startsWith('audio/') ? 'voice' : mime.startsWith('video/') ? 'video' : 'file';
    return { type: 'attachment', kind, url: kind === 'voice' ? link(p.voice_wav_url) ?? url : url, mime, ...meta, transcript: kind === 'voice' ? short(p.asr_refer_text, 10000)?.trim() : undefined };
  });
}
function body(p: Record<string, unknown>, depth: number, nodes: { n: number }, mentions: Record<string, unknown>[] = []): Segment[] {
  if (depth > 4 || ++nodes.n > 300) return [{ type: 'unsupported', kind: '消息结构超出展开上限' }];
  const parts: Segment[] = [], content = short(p.content, 50000) ?? '';
  let offset = 0;
  for (const match of content.matchAll(/<@!?([^<>\s]+)>/g)) {
    const token = match[1]!, m = mentions.find(m => [m.member_openid, m.user_openid, m.id].includes(token));
    if (match.index! > offset) parts.push({ type: 'text', text: content.slice(offset, match.index) });
    parts.push({ type: 'mention', userId: token, name: short(m?.username ?? m?.nickname, 100), all: token === 'all', self: m?.is_you === true });
    offset = match.index! + match[0].length;
  }
  if (offset < content.length) parts.push({ type: 'text', text: content.slice(offset) });
  for (const m of mentions) {
    const member = id(m.member_openid ?? m.user_openid ?? m.id);
    if (member && !parts.some(p => p.type === 'mention' && p.userId === member)) parts.push({ type: 'mention', userId: member, name: short(m.username ?? m.nickname, 100), all: m.scope === 'all', self: m.is_you === true });
  }
  const card = object(p.ark_data);
  if (card) {
    const f = object(card.fields) ?? {};
    parts.push({ type: 'card', kind: short(card.ark_type, 100) ?? 'unknown', title: short(f.title ?? card.ark_name, 500),
      description: short(f.desc ?? f.address ?? f.nickname ?? card.prompt, 2000), source: short(f.source, 100), url: link(f.jump_url) });
  }
  parts.push(...attachments(p.attachments));
  // Do not duplicate a transcription which QQ already included as ordinary content.
  for (const part of parts) if (part.type === 'attachment' && part.transcript && content.trim() === part.transcript.trim()) {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i]?.type === 'text') parts.splice(i, 1);
    break;
  }
  const elements = Array.isArray(p.msg_elements) ? p.msg_elements.slice(0, 100) : [];
  const nested = elements.map(v => object(v)).filter((v): v is Record<string, unknown> => !!v);
  if (nested.length) {
    const items = nested.map(item => { const author = object(item.author); return { sender: id(author?.member_openid ?? author?.user_openid ?? author?.id), name: short(author?.username, 100), segments: body(item, depth + 1, nodes) }; });
    if (p.message_type === 103 || p.refKey) parts.unshift({ type: 'reply', messageId: id(p.refKey) ?? id(nested[0]?.msg_idx) ?? 'unavailable',
      ...(items.length === 1 ? items[0] : { segments: [{ type: 'bundle', kind: 'forward', items }] }) });
    else parts.push({ type: 'bundle', kind: p.message_type === 101 ? 'parallel' : 'forward', items });
  } else if (p.refKey) parts.unshift({ type: 'reply', messageId: String(p.refKey) });
  if (!parts.length) parts.push({ type: 'unsupported', kind: `消息类型 ${number(p.message_type) ?? 'unknown'}` });
  return parts;
}
/** QQ-only wire interpretation; no raw authentication data crosses the adapter boundary. */
export function normalizeQQ(event: QQBotInboundMessage, appId: string): IncomingMessage | undefined {
  if (!['c2c', 'group'].includes(event.kind) || event.senderIsBot || !id(event.senderId) || !id(event.messageId) || event.kind === 'group' && !id(event.groupOpenid)) return;
  const time = Date.parse(event.timestamp); if (!Number.isFinite(time)) return;
  const raw = object(event.raw) ?? {}, author = object(raw.author), scene = object(raw.message_scene ?? event.messageScene);
  const candidates = body({ ...raw, content: event.content, attachments: event.attachments ?? raw.attachments,
    message_type: event.msgType ?? raw.message_type, msg_elements: event.msgElements ?? raw.msg_elements,
    refKey: event.refMsgIdx ?? ext(scene?.ext, 'ref_msg_idx') }, 0, { n: 0 }, (event.mentions ?? []).slice(0, 100));
  const segments = readSegments(candidates) ?? [{ type: 'unsupported' as const, kind: '消息内容超出解析上限' }];
  if (event.rawEventType === 'GROUP_AT_MESSAGE_CREATE' && !segments.some(p => p.type === 'mention' && p.self)) segments.unshift({ type: 'mention', userId: appId, self: true });
  return { account: appId, id: event.messageId, sender: event.senderId, name: short(event.senderName, 100)?.trim() || short(author?.username, 100)?.trim() || event.senderId,
    group: event.kind === 'group' ? event.groupOpenid : undefined, time, segments,
    metadata: { index: event.msgIdx ?? ext(scene?.ext, 'msg_idx'), sequence: number(raw.msg_seq), eventType: short(event.rawEventType, 100),
      type: number(event.msgType ?? raw.message_type), source: short(scene?.source, 100), author: { role: short(author?.member_role, 30), unifiedId: id(author?.union_openid), bot: author?.bot === true } } };
}
