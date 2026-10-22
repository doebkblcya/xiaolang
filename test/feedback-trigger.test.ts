import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { failureText } from '../src/fault-feedback.js';
import { Failure } from '../src/errors.js';
import { ConfigurationStore } from '../src/configuration.js';
import { SqliteStore } from '../src/store.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';

test('a model failure sends one useful diagnostic, keeps failure state and never adds the notice to model context', async t => {
  const adapter = new FakeAdapter();
  const app = await createApp(config(), { adapter, model: new FakeModel(async () => { throw new Failure('model_http_429'); }) });
  t.after(() => app.stop());
  app.ctx.intake.receive(event('hello', 1, null)); await app.ctx.chat.idle();
  app.ctx.intake.receive(event('hello', 1, null)); await app.ctx.chat.idle();
  assert.equal(adapter.sent.length, 1);
  assert.match(adapter.sent[0]!.text, /模型接口限流.*HTTP 429/);
  const turn = app.ctx.historyReader.recent(1).items[0]!;
  assert.equal(turn.state, 'failed'); assert.equal(turn.errorCode, 'model_http_429'); assert.equal(turn.reply, '');
  const detail = app.ctx.historyReader.detail(turn.id)!;
  assert.equal(detail.sends[0]?.kind, 'feedback'); assert.equal(detail.sends[0]?.state, 'sent');
  assert.equal((app.ctx.store as SqliteStore).prepareFeedback(turn.id, 'repeat'), false);
  assert.ok(!failureText('sk-secret-from-an-untrusted-plugin', turn.id).includes('sk-secret'));
});

test('normal delivery uncertainty and partial delivery never cause an additional error message', async t => {
  for (const partial of [false, true]) {
    const settings = config(); settings.limits.replyChars = 2;
    const adapter = new FakeAdapter(); let sends = 0;
    adapter.reply = async () => { sends++; if (partial && sends === 1) return { id: 'confirmed' }; throw new Failure('qq_send_unknown', true); };
    const app = await createApp(settings, { adapter, model: new FakeModel(async () => ({ role: 'assistant', content: '甲乙丙丁' })) });
    t.after(() => app.stop());
    app.ctx.intake.receive(event('hello', 1, null)); await app.ctx.chat.idle();
    assert.equal(sends, partial ? 2 : 1);
    const turn = app.ctx.historyReader.recent(1).items[0]!;
    assert.equal(turn.state, 'unknown');
    assert.ok(app.ctx.historyReader.detail(turn.id)!.sends.every(send => send.kind === 'reply'));
  }
});

test('trigger settings survive restart and a custom provider replaces the default; plugin catalog includes actual core fibers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-trigger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config(); settings.database = join(directory, 'data', 'xiaolang.sqlite');
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(settings));
  const store = await ConfigurationStore.load(path, () => {}, () => true, {});
  const view = await store.view();
  await store.save('trigger', { revision: view.revision, value: { privateReply: false, groupMention: false, groupKeywords: true, words: ['嗷呜'] } });
  const applied = await ConfigurationStore.load(path, () => {}, () => true, {}); await applied.confirm();
  const adapter = new FakeAdapter();
  const app = await createApp(applied.config, { adapter, model: new FakeModel() });
  app.ctx.intake.receive(event('hello', 1, null));
  app.ctx.intake.receive(event('小狼你好', 2));
  app.ctx.intake.receive(event('今天嗷呜怎么没说话', 3)); await app.ctx.chat.idle();
  assert.equal(adapter.sent.length, 1);
  const plugins = app.ctx.xiaolangRuntime.status().plugins;
  for (const id of ['xiaolang-trigger', 'xiaolang-scheduler', 'xiaolang-store', 'xiaolang-output', 'xiaolang-chat', 'xiaolang-fault-feedback']) {
    assert.ok(plugins.some(plugin => plugin.id === id && plugin.kind === (id === 'xiaolang-trigger' ? 'external' : 'builtin') && plugin.state === 'active'));
  }
  assert.ok(plugins.find(plugin => plugin.id === 'xiaolang-chat')?.dependencies.includes('trigger'));
  assert.deepEqual(plugins.find(plugin => plugin.id === 'xiaolang-chat')?.provides, ['chat']);
  await app.stopChat();
  assert.equal(app.ctx.xiaolangRuntime.status().plugins.find(plugin => plugin.id === 'xiaolang-chat')?.state, 'disabled');
  await app.stop();
  await writeFile(join(directory, 'trigger.mjs'), `export function apply(ctx){ctx.provide('trigger',{match:message=>message.text==='custom'?'custom':undefined})}`);
  const custom = config(); custom.plugins = { directory, trigger: 'custom-trigger', entries: [{ id: 'custom-trigger', module: './trigger.mjs' }] };
  const target = new FakeAdapter(); const replacement = await createApp(custom, { adapter: target, model: new FakeModel() });
  t.after(() => replacement.stop());
  replacement.ctx.intake.receive(event('小狼', 1)); replacement.ctx.intake.receive(event('custom', 2)); await replacement.ctx.chat.idle();
  assert.equal(target.sent.length, 1);
  assert.ok(!replacement.ctx.xiaolangRuntime.status().plugins.some(plugin => plugin.id === 'xiaolang-trigger'));
  assert.equal(replacement.ctx.xiaolangRuntime.status().plugins.filter(plugin => plugin.id === 'custom-trigger').length, 1);
});

test('plugin settings allow disabling builtins and dependencies, preserve write-only fields and persist external config and disable state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-plugin-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'provider.mjs'), `export function apply(ctx,config){ctx.provide('exampleValue',config.greeting)}`);
  await writeFile(join(directory, 'consumer.mjs'), `export const inject=['exampleValue'];export function apply(){}`);
  await writeFile(join(directory, 'xiaolang.plugin.json'), JSON.stringify({ configSchema: { type: 'object', properties: {
    greeting: { type: 'string', maxLength: 100 }, apiKey: { type: 'string', writeOnly: true },
  }, additionalProperties: false } }));
  const value = config(); value.database = join(directory, 'data', 'xiaolang.sqlite');
  value.plugins = { directory, entries: [
    { id: 'provider', module: './provider.mjs', config: { greeting: 'before', apiKey: 'stored-test-secret' } },
    { id: 'consumer', module: './consumer.mjs' },
  ] };
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(value));
  const store = await ConfigurationStore.load(path, () => {}, () => true, {});
  const app = await createApp(store.config, { adapter: new FakeAdapter(), model: new FakeModel(), configuration: store });
  t.after(() => app.stop());
  store.bindPlugins(() => app.ctx.xiaolangRuntime.status().plugins);
  const builtin = await store.plugin('xiaolang-store');
  assert.equal(builtin.canToggle, true);
  await store.savePlugin('xiaolang-store', { revision: builtin.revision, enabled: false });
  const restored = await store.plugin('xiaolang-store');
  await store.savePlugin('xiaolang-store', { revision: restored.revision, enabled: true });
  const provider = await store.plugin('provider');
  assert.equal(provider.canToggle, true); assert.ok(!JSON.stringify(provider).includes('stored-test-secret'));
  assert.ok((provider.provides as string[]).includes('exampleValue'));
  assert.equal(provider.toggleReason, undefined);
  await store.savePlugin('provider', { revision: provider.revision, enabled: false });
  const consumer = await store.plugin('consumer');
  await store.savePlugin('consumer', { revision: consumer.revision, enabled: false });
  const editable = await store.plugin('provider');
  assert.equal(editable.canToggle, true);
  const saved = await store.savePlugin('provider', { revision: editable.revision, config: { greeting: 'after', apiKey: '' } });
  assert.ok(!JSON.stringify(saved).includes('stored-test-secret'));
  const next = await ConfigurationStore.load(path, () => {}, () => true, {});
  assert.equal(next.config.plugins?.entries.find(entry => entry.id === 'provider')?.config?.greeting, 'after');
  assert.equal(next.config.plugins?.entries.find(entry => entry.id === 'provider')?.config?.apiKey, 'stored-test-secret');
  assert.equal(next.config.plugins?.entries.find(entry => entry.id === 'consumer')?.enabled, false);
});
