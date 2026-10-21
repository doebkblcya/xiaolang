import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';
import type { Log } from '../src/contracts.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';

async function workspace(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-plugins-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const mocks = () => ({ adapter: new FakeAdapter(), model: new FakeModel() });

test('an external plugin loads through the official Loader, uses config and unregisters its tool', async t => {
  const directory = await workspace(t);
  await mkdir(join(directory, 'hello'));
  await writeFile(join(directory, 'hello/index.mjs'), await readFile('examples/plugins/hello/index.mjs'));
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'hello', module: './hello/index.mjs', config: { greeting: '欢迎' } }] };
  const adapter = new FakeAdapter();
  const model = new FakeModel(async messages => messages.at(-1)?.role === 'tool'
    ? { role: 'assistant', content: messages.at(-1)!.content }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'external-greet', type: 'function', function: { name: 'greet', arguments: '{"name":"朋友"}' } }] });
  const app = await createApp(settings, { model, adapter });
  t.after(() => app.stop());
  assert.equal(app.ctx.loader.constructor.name, 'Loader');
  assert.deepEqual(app.plugins, [{ id: 'hello', state: 'active' }]);
  let message: import('../src/contracts.js').Message | undefined;
  app.ctx.on('xiaolang/observed', value => { message = value; });
  app.ctx.intake.receive(event('normal'));
  assert.ok(message);
  assert.equal(await app.ctx.tools.execute({ id: '1', type: 'function', function: { name: 'greet', arguments: '{"name":"朋友"}' } }, message, new AbortController().signal), '欢迎，朋友。');
  app.ctx.intake.receive(event('小狼向朋友问好', 2));
  await app.ctx.chat.idle();
  assert.equal(adapter.sent.length, 1);
  assert.ok(JSON.stringify(adapter.sent).includes('欢迎，朋友。'));
  await app.ctx.loader.store.hello!.fiber!.dispose();
  assert.ok(!app.ctx.tools.schemas().some(tool => tool.function.name === 'greet'));
});

test('disabled plugins are not imported, even when their directory does not exist', async t => {
  const settings = config();
  settings.plugins = { directory: '/missing-plugin-directory', entries: [{ id: 'unused', module: './missing.mjs', enabled: false }] };
  const app = await createApp(settings, mocks());
  t.after(() => app.stop());
  assert.deepEqual(app.plugins, [{ id: 'unused', state: 'disabled' }]);
});

test('dependencies resolve regardless of entry order, including dependencies on built-in chat', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'consumer.mjs'), `export const inject=['greeting', 'chat']; export function apply(ctx) { ctx.provide('observedGreeting', ctx.greeting); }`);
  await writeFile(join(directory, 'provider.mjs'), `export function apply(ctx) { ctx.provide('greeting', 'hello'); }`);
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'consumer', module: './consumer.mjs' }, { id: 'provider', module: './provider.mjs' }] };
  const app = await createApp(settings, mocks());
  t.after(() => app.stop());
  assert.equal(app.ctx.get('observedGreeting'), 'hello');
  assert.ok(app.plugins.every(plugin => plugin.state === 'active'));
});

test('a missing dependency waits without stopping the host and exposes missing service names', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'missing.mjs'), `export const inject=['doesNotExist', 'tools']; export function apply() { throw new Error('must not activate'); }`);
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'missing', module: './missing.mjs' }] };
  const logs: Log[] = [];
  const app = await createApp(settings, { ...mocks(), report: entry => logs.push(entry) });
  t.after(() => app.stop());
  assert.equal(app.ctx.inspection.status().state, 'ready');
  assert.equal(app.plugins.find(plugin => plugin.id === 'missing')?.state, 'pending');
  assert.ok(logs.some(entry => entry.plugin === 'missing' && entry.dependencies?.join(',') === 'doesNotExist'));
});

test('failed activation cleans partial registrations instead of running a half-loaded app', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'broken.mjs'), `
    export function apply(ctx) {
      ctx.effect(() => () => ctx.emit('xiaolang/log', {code:'broken_cleaned'}));
      ctx.on('xiaolang/observed', () => {});
      throw new Error('broken plugin');
    }
  `);
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'broken', module: './broken.mjs' }] };
  const logs: Log[] = [];
  await assert.rejects(createApp(settings, { ...mocks(), report: entry => logs.push(entry) }), { code: 'plugin_activation_failed' });
  assert.ok(logs.some(entry => entry.code === 'broken_cleaned'));
});

test('invalid exports, incompatible API, missing imports and path escapes are reported', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'invalid.mjs'), 'export default 42;');
  await writeFile(join(directory, 'version.mjs'), 'export const xiaolangApiVersion=99; export function apply() {}');
  await writeFile(join(directory, 'import.mjs'), `import 'not-installed'; export function apply() {}`);
  for (const [module, expected] of [
    ['./invalid.mjs', 'plugin_invalid_export'], ['./version.mjs', 'plugin_api_incompatible'],
    ['./import.mjs', 'plugin_import_failed'], ['./../elsewhere.mjs', 'plugin_file_missing'], ['file:///tmp/plugin.mjs', 'plugin_invalid_module'],
  ]) {
    const settings = config();
    settings.plugins = { directory, entries: [{ id: 'test', module: module! }] };
    await assert.rejects(createApp(settings, mocks()), { code: expected });
  }
});

test('a package installed in the mounted workspace resolves there and remains available after restart', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}');
  const packageDirectory = join(directory, 'node_modules/external-plugin');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), '{"name":"external-plugin","type":"module","exports":{"import":"./index.mjs"}}');
  await writeFile(join(packageDirectory, 'index.mjs'), `export function apply(ctx, config) { ctx.provide('packageValue', config.value); }`);
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'package', module: 'external-plugin', config: { value: 'persistent' } }] };
  for (let restart = 0; restart < 2; restart++) {
    const app = await createApp(settings, mocks());
    assert.equal(app.ctx.get('packageValue'), 'persistent');
    await app.stop();
  }
});

test('selecting an external chat plugin replaces the default and respects the master switch', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'chat.mjs'), `
    export const inject=['tools'];
    export function apply(ctx) {
      const remove=ctx.on('xiaolang/message', () => ctx.emit('xiaolang/log', {code:'custom_reply'}));
      const stop=async () => { remove(); };
      ctx.provide('chat', { idle: async()=>{}, stop });
      ctx.effect(()=>stop);
    }
  `);
  const logs: Log[] = [];
  const settings = config();
  settings.plugins = { directory, chat: 'custom', entries: [{ id: 'custom', module: './chat.mjs' }] };
  const model = new FakeModel();
  const app = await createApp(settings, { model, adapter: new FakeAdapter(), report: entry => logs.push(entry) });
  app.ctx.intake.receive(event('小狼', 1));
  assert.equal(logs.filter(entry => entry.code === 'custom_reply').length, 1);
  assert.equal(model.requests.length, 0);
  await app.stopChat();
  app.ctx.intake.receive(event('小狼', 2));
  assert.equal(logs.filter(entry => entry.code === 'custom_reply').length, 1);
  await app.stop();
  settings.chatEnabled = false;
  const disabled = await createApp(settings, { ...mocks(), report: entry => logs.push(entry) });
  t.after(() => disabled.stop());
  disabled.ctx.intake.receive(event('小狼', 3));
  assert.equal(logs.filter(entry => entry.code === 'custom_reply').length, 1);
  assert.deepEqual(disabled.plugins, [{ id: 'custom', state: 'disabled' }]);
});

test('malformed replacement chat fails cleanly; duplicate plugin IDs are rejected', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'bad-chat.mjs'), `export function apply(ctx) { ctx.provide('chat', {}); }`);
  const settings = config();
  settings.plugins = { directory, chat: 'bad', entries: [{ id: 'bad', module: './bad-chat.mjs' }] };
  await assert.rejects(createApp(settings, mocks()), { code: 'invalid_chat_service' });
  settings.plugins.entries.push({ id: 'bad', module: './bad-chat.mjs' });
  assert.throws(() => validateConfig(settings), { code: 'duplicate_plugin_id' });
});

test('a new process loads changed plugin files without changing the application build', async t => {
  const directory = await workspace(t);
  const settings = config();
  settings.plugins = { directory, entries: [{ id: 'revision', module: './revision.mjs' }] };
  const script = `
    import {createApp} from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)};
    import {FakeModel, FakeAdapter} from ${JSON.stringify(new URL('./fixtures.js', import.meta.url).href)};
    const app = await createApp(${JSON.stringify(settings)}, {model:new FakeModel(), adapter:new FakeAdapter()});
    console.info(JSON.stringify(app.ctx.get('revision')));
    await app.stop();
  `;
  for (const revision of ['before', 'after']) {
    await writeFile(join(directory, 'revision.mjs'), `export function apply(ctx) { ctx.provide('revision', ${JSON.stringify(revision)}); }`);
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
    assert.equal(JSON.parse(stdout.trim()), revision);
  }
});

test('an external chat stop error still disposes its resources and core services', async t => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'stop-error.mjs'), `
    export function apply(ctx) {
      ctx.effect(() => () => ctx.emit('xiaolang/log', {code:'resources_disposed'}));
      ctx.provide('chat', { idle:async()=>{}, stop:async()=>{ throw new Error('stop failed'); } });
    }
  `);
  const settings = config();
  settings.plugins = { directory, chat: 'custom', entries: [{ id: 'custom', module: './stop-error.mjs' }] };
  const logs: Log[] = [];
  const app = await createApp(settings, { ...mocks(), report: entry => logs.push(entry) });
  await assert.rejects(app.stop(), /stop failed/);
  assert.ok(logs.some(entry => entry.code === 'resources_disposed'));
  assert.equal(app.ctx.get('store'), undefined);
});
