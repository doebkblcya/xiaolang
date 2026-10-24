import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { ChatMemory } from '../src/memory.js';
import { memoryDefaults } from '../src/memory-config.js';
import { Failure } from '../src/errors.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';

function settings() {
  const cfg = config(); cfg.chatEnabled = false;
  cfg.memory = { ...memoryDefaults, enabled: true, images: false, batchSeconds: 600, extractionThinking: 'high' };
  return cfg;
}
const empty = () => new FakeModel(async () => ({ role: 'assistant', content: '{"memories":[]}' }));

test('sparse arrivals wait from the first pending message, then extract once without duplicating new text in reference', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const model = empty(), app = await createApp(settings(), { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: model });
  t.after(() => app.stop()); const memory = app.ctx.memory as ChatMemory;
  app.ctx.intake.receive(event('第一条新消息', 1)); await memory.process(false);
  assert.equal(model.requests.length, 0);
  t.mock.timers.setTime(now + 300000);
  app.ctx.intake.receive(event('第二条新消息', 2)); await memory.process(false);
  t.mock.timers.setTime(now + 599999); await memory.process(false);
  assert.equal(model.requests.length, 0);
  t.mock.timers.setTime(now + 600000); await memory.process(false);
  assert.equal(model.requests.length, 1);
  const input = JSON.parse(model.requests[0]![1]!.content!);
  assert.deepEqual(input.messages.map((row: { seq: number }) => row.seq), [1, 2]);
  assert.ok(!input.conversation.some((row: { seq: number }) => [1, 2].includes(row.seq)));
  assert.equal(memory.status().processedThrough, 2);
  assert.equal(model.options[0]?.reasoningEffort, 'high');
});

test('a full batch runs immediately and manual maintenance can flush a smaller batch', async t => {
  const model = empty(), app = await createApp(settings(), { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: model });
  t.after(() => app.stop()); const memory = app.ctx.memory as ChatMemory;
  for (let id = 1; id <= 20; id++) app.ctx.intake.receive(event(`消息${id}`, id));
  await memory.process(false);
  assert.equal(model.requests.length, 1); assert.equal(memory.status().processedThrough, 20);
  app.ctx.intake.receive(event('尚不足一批', 21)); await memory.process(false);
  assert.equal(model.requests.length, 1);
  await memory.process(); assert.equal(model.requests.length, 2);
  assert.equal(memory.status().processedThrough, 21);
});

test('restart preserves a partially collected batch and its original deadline', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const dir = await mkdtemp(join(tmpdir(), 'xiaolang-batch-')), cfg = settings(); cfg.database = join(dir, 'chat.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  let app = await createApp(cfg, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: empty() });
  app.ctx.intake.receive(event('重启前的原文', 1)); await (app.ctx.memory as ChatMemory).process(false); await app.stop();
  t.mock.timers.setTime(now + 300000); const model = empty();
  app = await createApp(cfg, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: model }); t.after(() => app.stop());
  await (app.ctx.memory as ChatMemory).process(false); assert.equal(model.requests.length, 0);
  t.mock.timers.setTime(now + 600000); await (app.ctx.memory as ChatMemory).process(false);
  assert.equal(model.requests.length, 1); assert.equal(app.ctx.memory.status().processedThrough, 1);
});

test('an unsuccessful batch retains its cursor and new arrivals cannot bypass the retry cooldown', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now }); const cfg = settings(); cfg.memory!.batchSize = 2;
  let attempts = 0;
  const model = new FakeModel(async () => { if (++attempts === 1) throw new Failure('unavailable'); return { role: 'assistant', content: '{"memories":[]}' }; });
  const app = await createApp(cfg, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: model }); t.after(() => app.stop());
  const memory = app.ctx.memory as ChatMemory;
  app.ctx.intake.receive(event('第一条', 1)); app.ctx.intake.receive(event('第二条', 2)); await memory.process(false);
  assert.equal(memory.status().processedThrough, 0);
  app.ctx.intake.receive(event('第三条', 3)); await memory.process(false); assert.equal(attempts, 1);
  t.mock.timers.setTime(now + 60000); await memory.process(false);
  assert.equal(attempts, 2); assert.equal(memory.status().processedThrough, 2);
});
