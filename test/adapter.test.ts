import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage, QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import { createApp } from '../src/app.js';
import { normalize } from '../src/messages.js';
import { QQOfficialAdapter, normalizeQQ, validateQQConfig } from '../src/adapters/qq-official.js';
import type { QQClient } from '../src/adapters/qq-official.js';
import type { IncomingMessage, Log, Message } from '../src/contracts.js';
import { config, deferred, event, FakeAdapter, FakeModel } from './fixtures.js';

const qqConfig = () => validateQQConfig(config().adapter.config);
const incoming = (extra: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage => ({
  rawEventType: 'C2C_MESSAGE_CREATE', kind: 'c2c', senderId: 'user-openid', content: '你好',
  messageId: 'incoming-id', timestamp: new Date().toISOString(),
  raw: { author: { user_openid: 'user-openid' }, content: '你好', id: 'incoming-id', timestamp: new Date().toISOString() },
  replyTarget: { scope: 'c2c', targetId: 'user-openid', msgId: 'incoming-id' }, ...extra,
});
// SDK boundary only: these tests never construct a real client or open a connection.
class MockQQ extends EventEmitter {
  run = deferred();
  stopped = 0;
  sent: { scope: string; target: string; body: Record<string, unknown> }[] = [];
  failure?: Error;
  sendGate?: Promise<void>;
  start(): Promise<void> { queueMicrotask(() => this.emit('ready')); return this.run.promise; }
  stop(): void { this.stopped++; this.run.resolve(); }
  getCredentials() { return { appId: '123456789', clientSecret: 'fake' }; }
  messageApi = { sendC2CStreamMessage: async (_credentials: unknown, target: string, body: Record<string, unknown>) => {
    this.sent.push({ scope: 'stream', target, body });
    if (this.failure) throw this.failure;
    return { id: 'bubble', timestamp: Date.now() };
  }, sendRaw: async (scope: string, target: string, _credentials: unknown, body: Record<string, unknown>) => {
    this.sent.push({ scope, target, body });
    if (this.sendGate) await this.sendGate;
    if (this.failure) throw this.failure;
    return { id: 'receipt', timestamp: Date.now() };
  } };
}
function adapter(client: MockQQ, logs: string[] = [], options?: (options: QQBotOptions) => void) {
  return new QQOfficialAdapter(qqConfig(), 'fake', code => logs.push(code), opts => { options?.(opts); return client as unknown as QQClient; });
}
function message(client: QQOfficialAdapter, extra: Partial<QQBotInboundMessage> = {}): Message {
  return normalize(normalizeQQ(incoming(extra), client.account), client, [])!;
}

test('an external adapter runs the complete chat pipeline with opaque IDs and no QQ credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'adapter.mjs'), `
    export function apply(ctx, config) {
      ctx.provide('adapter', {
        platform: 'other-platform', account: config.account,
        capabilities: {groupMessages:'all', maxTextChars:2},
        start(receive) { receive({account:config.account, sender:'opaque-user', id:'opaque-message', name:'用户', time:Date.now(), segments:[{type:'text',text:'hello'}]}); },
        stop() { ctx.emit('xiaolang/log', {code:'adapter_stopped'}); },
        async reply(message, text, part) {
          if (message.sender !== 'opaque-user') throw new Error('wrong target');
          ctx.emit('xiaolang/log', {code:'sent_'+part+'_'+text});
          return {id:'receipt-'+part};
        },
      });
    }
  `);
  const settings = config();
  settings.adapter = { module: './adapter.mjs', config: { account: 'opaque-app' } };
  settings.plugins = { directory, entries: [] };
  const logs: Log[] = [];
  const app = await createApp(settings, { model: new FakeModel(async () => ({ role: 'assistant', content: '甲🐺乙' })), report: entry => logs.push(entry) });
  await app.ctx.chat.idle();
  assert.deepEqual(logs.filter(entry => entry.code.startsWith('sent_')).map(entry => entry.code), ['sent_0_甲🐺', 'sent_1_乙']);
  await app.stop();
  assert.ok(logs.some(entry => entry.code === 'adapter_stopped'));
});

test('message identity is isolated by platform and account; malformed messages fail closed', () => {
  const first = new FakeAdapter();
  const second = new FakeAdapter(); second.platform = 'another-platform';
  assert.notEqual(normalize(event('same'), first, [])!.key, normalize(event('same'), second, [])!.key);
  assert.notEqual(normalize(event('same'), first, [])!.session, normalize(event('same'), second, [])!.session);
  assert.equal(normalize({ ...event('same'), group: '' }, first, []), undefined);
  assert.equal(normalize({ ...event('same'), time: NaN }, first, []), undefined);
  assert.equal(normalize({ ...event('same'), account: 'another-app' }, first, []), undefined);
});

test('startup validates every plugin before starting an adapter and cleans a failed start', async () => {
  const transport = new FakeAdapter();
  let starts = 0;
  transport.start = () => { starts++; };
  const settings = config();
  settings.plugins = { directory: '/missing', entries: [{ id: 'missing', module: './missing.mjs' }] };
  await assert.rejects(createApp(settings, { model: new FakeModel(), adapter: transport }), { code: 'plugin_directory_missing' });
  assert.equal(starts, 0);
  let stopped = false;
  transport.start = () => { throw new Error('start failed'); };
  transport.stop = () => { stopped = true; };
  await assert.rejects(createApp(config(), { model: new FakeModel(), adapter: transport }), /start failed/);
  assert.equal(stopped, true);
  const invalid = new FakeAdapter(); invalid.capabilities.maxTextChars = 0;
  await assert.rejects(createApp(config(), { model: new FakeModel(), adapter: invalid }), { code: 'invalid_adapter_service' });
});

test('QQ configuration and credentials stay inside the selected plugin', async () => {
  assert.throws(() => validateQQConfig({ ...qqConfig(), appSecret: 'must-not-be-in-config' }), { code: 'invalid_qq_config' });
  const settings = config(); settings.adapter.config = { ...qqConfig(), secretEnv: 'XIAOLANG_TEST_MISSING_SECRET' };
  delete process.env.XIAOLANG_TEST_MISSING_SECRET;
  await assert.rejects(createApp(settings, { model: new FakeModel() }), { code: 'plugin_activation_failed' });
});

test('events emitted during a failed adapter start never reach the model or sender', async () => {
  const transport = new FakeAdapter(); const model = new FakeModel();
  transport.start = receive => { receive(event('private', 1, null)); throw new Error('not ready'); };
  await assert.rejects(createApp(config(), { model, adapter: transport }), /not ready/);
  assert.equal(model.requests.length, 0);
  assert.equal(transport.sent.length, 0);
});

test('cancelling adapter startup stops it and disposes core services', async () => {
  const transport = new FakeAdapter();
  const started = deferred(); const blocked = deferred();
  let stopped = false;
  transport.start = () => { started.resolve(); return blocked.promise; };
  transport.stop = () => { stopped = true; blocked.resolve(); };
  const cancel = new AbortController();
  const pending = createApp(config(), { model: new FakeModel(), adapter: transport, signal: cancel.signal });
  await started.promise;
  cancel.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(stopped, true);
});

test('QQ maps private, @ and non-@ group messages without exposing protocol fields to the core', async t => {
  const client = new MockQQ();
  const logs: string[] = [];
  const transport = adapter(client, logs, options => { assert.equal(options.intents, 1 << 25); assert.equal(options.markdownSupport, false); });
  t.after(() => transport.stop());
  const received: IncomingMessage[] = [];
  await transport.start(message => received.push(message));
  client.emit('message', {}, incoming());
  client.emit('message', {}, incoming({ kind: 'group', groupOpenid: 'group-openid', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '你好' }));
  client.emit('message', {}, incoming({ kind: 'group', groupOpenid: 'group-openid', rawEventType: 'GROUP_MESSAGE_CREATE', content: '今天小狼怎么没说话' }));
  client.emit('message', {}, incoming({ kind: 'group', groupOpenid: 'group-openid', senderIsBot: true }));
  client.emit('message', {}, incoming({ kind: 'guild' }));
  assert.equal(received.length, 3);
  assert.equal(received[0]?.sender, 'user-openid');
  assert.ok(received[1]?.segments.some(part => part.type === 'mention' && part.userId === transport.account));
  assert.equal(received[2]?.segments.some(part => part.type === 'mention'), false);
  assert.ok(logs.includes('qq_connected'));
});

test('QQ passive replies use OpenIDs, incoming message IDs and stable per-part sequences', async t => {
  const client = new MockQQ(); const transport = adapter(client);
  t.after(() => transport.stop());
  await transport.start(() => {});
  await transport.reply(message(transport), 'private text', 0, new AbortController().signal);
  await transport.reply(message(transport, { kind: 'group', groupOpenid: 'group-openid' }), 'group text', 1, new AbortController().signal);
  assert.deepEqual(client.sent.map(item => [item.scope, item.target, item.body.msg_seq]), [['c2c', 'user-openid', 1], ['group', 'group-openid', 2]]);
  assert.equal(client.sent[0]?.body.msg_id, 'incoming-id');
  assert.equal(client.sent[0]?.body.msg_type, 0);
  const expired = message(transport, { timestamp: new Date(Date.now() - 301_000).toISOString() });
  await assert.rejects(transport.reply(expired, 'late', 0, new AbortController().signal), { code: 'qq_reply_expired', unknownOutcome: false });
  assert.equal(client.sent.length, 2);
});

test('QQ rejection, lost delivery and cancellation remain distinct and are never retried', async t => {
  const client = new MockQQ(); const transport = adapter(client);
  t.after(() => transport.stop());
  await transport.start(() => {});
  for (const [status, unknown] of [[400, false], [503, true], [0, true]] as const) {
    client.failure = new ApiError('failure', status, '/test');
    await assert.rejects(transport.reply(message(transport), 'reply', 0, new AbortController().signal), { unknownOutcome: unknown });
  }
  client.failure = undefined;
  const gate = deferred(); client.sendGate = gate.promise;
  const cancel = new AbortController();
  const task = transport.reply(message(transport), 'reply', 0, cancel.signal);
  cancel.abort();
  await assert.rejects(task, { code: 'qq_send_cancelled', unknownOutcome: true });
  gate.resolve();
  assert.equal(client.sent.length, 4);
});

test('QQ disconnect blocks sends until resume; stopping detaches listeners and startup timeout cleans up', async () => {
  const client = new MockQQ(); const transport = adapter(client);
  await transport.start(() => {});
  client.emit('disconnected', {});
  await assert.rejects(transport.reply(message(transport), 'reply', 0, new AbortController().signal), { code: 'qq_not_ready' });
  client.emit('resumed', {});
  await transport.reply(message(transport), 'reply', 0, new AbortController().signal);
  await transport.stop();
  assert.equal(client.listenerCount('message'), 0);
  const silent = new MockQQ(); silent.start = () => silent.run.promise;
  const pending = new QQOfficialAdapter({ ...qqConfig(), connectTimeoutMs: 5 }, 'fake', undefined, () => silent as unknown as QQClient);
  await assert.rejects(pending.start(() => {}), { code: 'qq_connect_timeout' });
  assert.equal(silent.stopped, 1);
});


test('QQ private native stream uses one sequence and reuses the first bubble ID', async t => {
  const client = new MockQQ(), qq = adapter(client); await qq.start(() => {}); t.after(() => qq.stop());
  const input = message(qq);
  await qq.streamReply(input, 'hello', 0, false, undefined, new AbortController().signal);
  await qq.streamReply(input, 'hello world', 1, true, 'bubble', new AbortController().signal);
  assert.deepEqual(client.sent.map(item => item.body), [
    { input_mode: 'replace', input_state: 1, content_type: 'markdown', content_raw: 'hello', event_id: input.id, msg_id: input.id, msg_seq: 1, index: 0 },
    { input_mode: 'replace', input_state: 10, content_type: 'markdown', content_raw: 'hello world', event_id: input.id, msg_id: input.id, msg_seq: 1, index: 1, stream_msg_id: 'bubble' },
  ]);
  await assert.rejects(qq.streamReply({ ...input, group: 'group' }, 'text', 0, false, undefined, new AbortController().signal), { code: 'qq_stream_private_only' });
});

test('scheduled QQ push uses the active message body, validates its real target and distinguishes rejection from uncertainty', async t => {
  const client = new MockQQ(), transport = adapter(client), signal = new AbortController().signal;
  t.after(() => transport.stop()); await transport.start(() => {});
  const target = { platform: transport.platform, account: transport.account, scope: 'private' as const, recipient: 'user-openid' };
  await transport.push(target, '⏰ 提醒你：喝水', 42, signal);
  await transport.push({ ...target, scope: 'group', recipient: 'group-openid' }, '提醒', 43, signal);
  assert.deepEqual(client.sent.map(item => [item.scope, item.target]), [['c2c', 'user-openid'], ['group', 'group-openid']]);
  assert.deepEqual(client.sent[0]?.body, { content: '⏰ 提醒你：喝水', msg_type: 0, msg_seq: 42 });
  await assert.rejects(transport.push({ ...target, account: 'another-app' }, '提醒', 44, signal), { code: 'adapter_target_mismatch' });
  assert.equal(client.sent.length, 2);
  client.failure = new ApiError('denied', 403, '/test', 40034105);
  await assert.rejects(transport.push(target, '提醒', 44, signal), { code: 'qq_push_permission_denied', unknownOutcome: false });
  client.failure = new ApiError('server error', 503, '/test');
  await assert.rejects(transport.push(target, '提醒', 45, signal), { code: 'qq_send_unknown', unknownOutcome: true });
});
