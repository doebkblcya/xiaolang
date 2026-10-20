import { memoryDefaults, memorySchema } from '../src/memory-config.js';
import { personaDefaults, personaSchema } from '../src/persona-config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurationStore } from '../src/configuration.js';
import { DeepSeekModel } from '../src/model.js';
import { config } from './fixtures.js';

// Temporary files and in-memory HTTP only; never start a bot or a listener on Mac.
test('configuration saves atomically, hides secrets, checks revisions and keeps the previous working settings on failed apply', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = config(); value.database = join(directory, 'data', 'xiaolang.sqlite');
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(value));
  const env = { DEEPSEEK_API_KEY: 'existing-model-key', QQBOT_APP_SECRET: 'existing-qq-key' };
  let restarted = false, idle = false;
  const store = await ConfigurationStore.load(path, () => { restarted = true; }, () => idle, env);
  const initial = await store.view();
  const saved = await store.save('model', { revision: initial.revision, value: { ...value.model, temperature: 0.8 }, secret: 'new-model-key' });
  assert.equal(saved.pendingRestart, true);
  assert.equal(store.config.model.temperature, undefined);
  assert.ok(!JSON.stringify(saved).includes('new-model-key'));
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await assert.rejects(store.save('model', { revision: initial.revision, value: value.model }), { code: 'settings_conflict' });
  await assert.rejects(store.save('model', { revision: saved.revision, value: { ...value.model, temperature: 9 } }), { code: 'invalid_config' });
  await assert.rejects(store.apply(saved.revision as string), { code: 'chat_busy' });
  idle = true; await store.apply(saved.revision as string); assert.equal(restarted, true);
  const boot = await ConfigurationStore.load(path, () => {}, () => true, env);
  assert.equal(boot.config.model.temperature, 0.8);
  assert.equal(boot.secrets.deepseek, 'new-model-key');
  await boot.confirm();
  assert.equal((await boot.view()).pendingRestart, false);
  const beforeQQ = await boot.view();
  const qq = { ...beforeQQ.qq as Record<string, unknown> }; delete qq.secretConfigured; delete qq.supported; delete qq.transport;
  const bad = await boot.save('qq', { revision: beforeQQ.revision, value: { ...qq, appId: '999999' }, secret: 'wrong-qq-key' });
  assert.ok(!JSON.stringify(bad).includes('wrong-qq-key'));
  const attempted = await ConfigurationStore.load(path, () => {}, () => true, env);
  assert.equal(attempted.config.adapter.config?.appId, '999999');
  assert.equal(await attempted.rollback(), true);
  const restored = await ConfigurationStore.load(path, () => {}, () => true, env);
  assert.equal(restored.config.adapter.config?.appId, value.adapter.config?.appId);
  assert.equal(restored.secrets.deepseek, 'new-model-key');
  assert.equal(restored.secrets.qq, undefined);
  assert.equal((await restored.view()).lastApplyFailed, true);
  assert.ok((await readFile(store.path, 'utf8')).includes('new-model-key'));
});

test('configuration HTTP writes require same-origin token and JSON, and reject stale updates without exposing secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-settings-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = config(); value.database = join(directory, 'data', 'xiaolang.sqlite');
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(value));
  const store = await ConfigurationStore.load(path, () => {}, () => true, {});
  const module = await import(pathToFileURL(resolve('examples/plugins/panel/index.mjs')).href);
  const handle = module.createHandler({}, store);
  async function request(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    let status = 0, output = '';
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
      { url, method, headers: { host: '127.0.0.1:18080', ...headers } });
    await handle(req, { writeHead(code: number) { status = code; }, end(text: string) { output = String(text); } });
    return { status, data: JSON.parse(output) };
  }
  const page = (await request('/api/settings')).data;
  const body = { revision: page.revision, value: value.model, secret: 'replacement-key' };
  assert.equal((await request('/api/settings/model', 'POST', body)).status, 403);
  const headers = { origin: 'http://127.0.0.1:18080', 'x-xiaolang-token': page.writeToken, 'content-type': 'application/json' };
  assert.equal((await request('/api/settings/model', 'POST', body, { ...headers, origin: 'http://evil.example' })).status, 403);
  const saved = await request('/api/settings/model', 'POST', body, headers);
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.data).includes('replacement-key'));
  assert.equal((await request('/api/settings/model', 'POST', body, headers)).status, 409);
  assert.equal((await request('/api/settings/model', 'POST', { ...body, secret: 'x'.repeat(17000) }, headers)).status, 413);
});

test('DeepSeek forwards only the parameters effective in the selected thinking mode', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
  }) as typeof fetch;
  const settings = { ...config().model, temperature: 0.7, topP: 0.96, reasoningEffort: 'low' as const, stop: ['结束'] };
  await new DeepSeekModel({ ...settings, thinking: false }, 'fake', fetcher).complete([], [], new AbortController().signal);
  await new DeepSeekModel({ ...settings, thinking: true }, 'fake', fetcher).complete([], [], new AbortController().signal);
  assert.equal(bodies[0]?.temperature, 0.7); assert.equal(bodies[0]?.top_p, undefined); assert.equal(bodies[0]?.reasoning_effort, undefined);
  assert.equal(bodies[1]?.temperature, undefined); assert.equal(bodies[1]?.top_p, 0.96); assert.equal(bodies[1]?.reasoning_effort, 'low');
  assert.deepEqual(bodies[1]?.stop, ['结束']);
});


test('legacy plugin settings default to low and panel saves memory/persona thinking levels independently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-thinking-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cfg = config(); cfg.database = join(directory, 'chat.sqlite');
  const oldMemory = { ...memoryDefaults }; delete oldMemory.extractionThinking;
  const oldCharacter = { ...personaDefaults }; delete oldCharacter.learningThinking;
  cfg.memory = oldMemory; cfg.character = oldCharacter;
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(cfg));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ version: 1, active: { model: cfg.model, memory: oldMemory, character: oldCharacter, secrets: {} } }));
  const store = await ConfigurationStore.load(path, () => {}, () => true, {});
  store.bindPlugins(() => ['xiaolang-memory', 'xiaolang-persona'].map(id => ({ id, title: id, module: 'builtin', kind: 'builtin', state: 'active', dependencies: [], provides: [] })));
  store.registerPlugin('xiaolang-memory', memorySchema); store.registerPlugin('xiaolang-persona', personaSchema);
  const memory = await store.plugin('xiaolang-memory'), persona = await store.plugin('xiaolang-persona');
  assert.equal((memory.config as Record<string, unknown>).extractionThinking, 'low');
  assert.equal((persona.config as Record<string, unknown>).learningThinking, 'low');
  await store.savePlugin('xiaolang-memory', { revision: memory.revision, config: { ...memory.config as Record<string, unknown>, extractionThinking: 'high', summaryThinking: 'high', imageDescriptionThinking: 'high' } });
  const fresh = await store.plugin('xiaolang-persona');
  await assert.rejects(store.savePlugin('xiaolang-persona', { revision: fresh.revision, config: { ...fresh.config as Record<string, unknown>, learningThinking: 'invalid' } }), { code: 'invalid_plugin_config' });
  await store.savePlugin('xiaolang-persona', { revision: fresh.revision, config: { ...fresh.config as Record<string, unknown>, learningThinking: 'off' } });
  const boot = await ConfigurationStore.load(path, () => {}, () => true, {});
  assert.equal(boot.config.memory?.extractionThinking, 'high'); assert.equal(boot.config.character?.learningThinking, 'off');
  assert.equal(boot.config.memory?.summaryThinking, 'high'); assert.equal(boot.config.memory?.imageDescriptionThinking, 'high');
  assert.equal(boot.config.model.thinking, false); assert.equal(boot.config.character.anchor, oldCharacter.anchor);
  await boot.confirm(); assert.equal((await boot.view()).pendingRestart, false);
});
