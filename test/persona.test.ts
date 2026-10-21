import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaLearning } from '../src/persona.js';
import { personaDefaults, personaSchema } from '../src/persona-config.js';
import { ConfigurationStore } from '../src/configuration.js';
import { SqliteStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import type { Message, ThinkingLevel } from '../src/contracts.js';
import { config, event, FakeAdapter, FakeModel, deferred } from './fixtures.js';
import { writeFile, rm } from 'node:fs/promises';

function setup(model = new FakeModel(), path = ':memory:', level: ThinkingLevel = 'low') {
  const cfg = config(); cfg.database = path; cfg.character = { ...personaDefaults, learningThinking: level };
  const ctx = new Context(), store = new SqliteStore(path); ctx.provide('store', store);
  let now = 1800000000000;
  const learning = new PersonaLearning(ctx, cfg, model, () => now);
  const add = (text: string, user = 'A') => store.admit({ ...event(text, store.records({ limit: 500 }).length + 1, 'G', user), key: `k${store.records({ limit: 500 }).length + 1}`, platform: 'mock', session: 'G', text, seq: 0 } as Message)!;
  const addPairs = () => { add('你好可爱'); add('哼，也就一点点吧', 'B'); add('你真厉害'); add('那当然啦', 'B'); };
  return { ctx, cfg, store, learning, add, addPairs, advance: () => { now += 31 * 60_000; }, close: async () => { await learning.stop(); learning.close(); store.close(); await ctx.fiber.dispose(); } };
}
const style = (a = 1, b = 2, c = 3, d = 4) => ({ scene: '被夸奖时', rule: '用短句接住夸奖，偶尔轻微嘴硬', keywords: ['可爱', '厉害'], examples: [{ prompt: a, reply: b }, { prompt: c, reply: d }] });
const answer = (styles: unknown[]) => ({ role: 'assistant' as const, content: JSON.stringify({ styles }) });

test('learning is a separate batch request; anchor stays fixed and grounded references affect subsequent replies without extra calls', async () => {
  const model = new FakeModel(async () => answer([style()])), s = setup(model);
  try {
    s.addPairs(); await s.learning.learn();
    assert.equal(model.requests.length, 1);
    assert.deepEqual(model.options[0], { thinking: true, reasoningEffort: 'low', maxOutputTokens: 8192, retries: 0, stop: [] });
    const data = s.learning.list() as { items: { id: string; version: number }[] };
    assert.equal(data.items.length, 1);
    const prompt = s.learning.prompt(s.store.record(1)!.message);
    const parts = s.learning.promptParts(s.store.record(1)!.message);
    assert.ok(!parts.instructions.includes('humanReply'));
    assert.ok(parts.reference.includes('humanReply'));
    assert.match(prompt, /四个多月的母猫/); assert.match(prompt, /QQ 聊天/); assert.match(prompt, /短句接住夸奖/);
    assert.equal(model.requests.length, 1);
    assert.throws(() => s.learning.mutate({ action: 'update', id: data.items[0]!.id, version: 1, anchor: '变成人' }), { code: 'invalid_persona_request' });
  } finally { await s.close(); }
});

test('bot replies cannot be learned as human examples; invalid candidates are discarded and consume only their own quota', async () => {
  const model = new FakeModel(async () => answer([style(1, 2, 3, 5)])), s = setup(model);
  try {
    s.addPairs(); const turn = s.store.createTurn(s.store.record(3)!.message, 'keyword');
    s.store.delivered(turn, '机器人自己的措辞', [], ['r']);
    await s.learning.learn();
    assert.equal(s.learning.status().cursor, 5); assert.equal(s.learning.status().dailyCalls, 1);
    assert.equal((s.learning.list() as { items: unknown[] }).items.length, 0);
    await assert.rejects(s.learning.learn(), { code: 'persona_rate_limited' });
    assert.equal(model.requests.length, 1);
  } finally { await s.close(); }
});

test('manual edits, disable and rollback are versioned and reject stale writes and stale in-flight learning', async () => {
  const gate = deferred<void>(); let call = 0;
  const model = new FakeModel(async () => { call++; if (call === 2) { await gate.promise; return answer([{ ...style(5, 6, 7, 8), id, version: 1 }]); } return answer([style()]); });
  const s = setup(model); let id = '';
  try {
    s.addPairs(); await s.learning.learn(); id = (s.learning.list() as { items: { id: string }[] }).items[0]!.id;
    s.addPairs(); s.advance(); const pending = s.learning.learn();
    s.learning.mutate({ action: 'update', id, version: 1, scene: '夸奖', rule: '简短接话', keywords: ['夸奖'], enabled: false });
    gate.resolve(); await assert.rejects(pending, { code: 'persona_conflict' });
    assert.doesNotMatch(s.learning.prompt(s.store.record(1)!.message), /简短接话/);
    assert.throws(() => s.learning.mutate({ action: 'rollback', id, version: 1, targetVersion: 1 }), { code: 'persona_conflict' });
    s.learning.mutate({ action: 'rollback', id, version: 2, targetVersion: 1 });
    const detail = s.learning.detail(id) as { version: number; versions: unknown[]; sources: unknown[] };
    assert.equal(detail.version, 3); assert.equal(detail.versions.length, 3); assert.equal(detail.sources.length, 4);
  } finally { gate.resolve(); await s.close(); }
});

test('quota, cursor and disabled styles survive reopening; suppressed evidence is excluded from prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaolang-persona-')), path = join(root, 'chat.sqlite');
  let s = setup(new FakeModel(async () => answer([style()])), path);
  try {
    s.addPairs(); await s.learning.learn();
    const item = (s.learning.list() as { items: { id: string }[] }).items[0]!;
    s.learning.mutate({ action: 'update', id: item.id, version: 1, scene: '被夸奖时', rule: style().rule, keywords: ['可爱'], enabled: false });
    await s.close();
    const model = new FakeModel(async () => answer([{ ...style(5, 6, 7, 8), id: item.id, version: 2 }]));
    s = setup(model, path); assert.equal(s.learning.status().dailyCalls, 1); assert.equal(s.learning.status().cursor, 4);
    s.addPairs(); s.advance(); await s.learning.learn();
    assert.equal((s.learning.detail(item.id) as { enabled: boolean }).enabled, false);
    s.learning.mutate({ action: 'rollback', id: item.id, version: 2, targetVersion: 1 });
    s.ctx.provide('memory', { sourceAllowed: () => false } as never);
    assert.doesNotMatch(s.learning.prompt(s.store.record(1)!.message), /短句接住夸奖/);
  } finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a normal chat uses persona locally, never waits for or invokes the learning model', async () => {
  const cfg = config(); cfg.character = structuredClone(personaDefaults);
  const adapter = new FakeAdapter(), model = new FakeModel(), learner = new FakeModel();
  const app = await createApp(cfg, { adapter, model, personaModel: learner });
  try {
    adapter.receive!(event('小狼你好')); await app.ctx.chat.idle();
    assert.equal(adapter.sent.length, 1); assert.equal(model.requests.length, 1); assert.equal(learner.requests.length, 0);
    assert.match(model.requests[0]![0]!.content!, /四个多月的母猫/);
  } finally { await app.stop(); }
});

test('persona plugin settings persist through the existing apply workflow and preserve a legacy custom anchor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaolang-persona-settings-')), path = join(root, 'config.json');
  try {
    const cfg = config(); cfg.database = join(root, 'chat.sqlite'); cfg.persona = '原本自己设定的人设';
    await writeFile(path, JSON.stringify(cfg));
    const settings = await ConfigurationStore.load(path, () => {}, () => true, {});
    settings.bindPlugins(() => [{ id: 'xiaolang-persona', title: '人设与学习', kind: 'builtin', module: 'src/persona.ts', state: 'active', dependencies: [], provides: ['persona'] }]);
    settings.registerPlugin('xiaolang-persona', personaSchema);
    const before = await settings.plugin('xiaolang-persona'); assert.equal((before.config as Record<string, unknown>).anchor, cfg.persona);
    await settings.savePlugin('xiaolang-persona', { revision: before.revision, config: personaDefaults });
    const next = await ConfigurationStore.load(path, () => {}, () => true, {});
    assert.equal(next.config.character?.anchor, personaDefaults.anchor); assert.equal(next.config.character?.learningEnabled, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one weak candidate does not discard grounded candidates or cause another batch call', async () => {
  const model = new FakeModel(async () => answer([style(), { ...style(), rule: '证据不足', examples: [{ prompt: 1, reply: 2 }] }]));
  const s = setup(model);
  try { s.addPairs(); await s.learning.learn(); assert.equal((s.learning.list() as { items: unknown[] }).items.length, 1); assert.equal(s.learning.status().cursor, 4); assert.equal(model.requests.length, 1); }
  finally { await s.close(); }
});


test('expression learning honors its own off/high/max setting while keeping the shared output budget', async () => {
  for (const level of ['off', 'high', 'max'] as const) {
    const model = new FakeModel(async () => answer([])), s = setup(model, ':memory:', level);
    try {
      s.addPairs(); await s.learning.learn();
      assert.equal(model.options[0]?.thinking, level !== 'off');
      assert.equal(model.options[0]?.reasoningEffort, level === 'off' ? undefined : level);
      assert.equal(model.options[0]?.maxOutputTokens, 8192);
    } finally { await s.close(); }
  }
});
