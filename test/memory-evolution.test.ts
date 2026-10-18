import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../src/memory-store.js';
import type { MemoryItem } from '../src/memory-store.js';
import { ChatMemory } from '../src/memory.js';
import { memoryDefaults } from '../src/memory-config.js';
import { createApp } from '../src/app.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';
const vector = (axis = 0) => Array.from({ length: 64 }, (_, i) => i === axis ? 1 : 0);
const settings = { ...memoryDefaults, embeddingDimensions: 64 };
const value = { content: '用户A住在北京。', kind: 'profile' as const, people: ['A'], sources: [1], importance: 4 };

test('supplement preserves valid preferences; a superseding state keeps an explicit text history but only the head is indexed', () => {
  const db = new MemoryRepository(':memory:', settings);
  try {
    const first = db.write({ ...value, operation: 'add' })!; db.index(first, vector());
    const second = db.write({ ...first, operation: 'supersede', content: '用户A搬到了上海。', sources: [2] })!;
    assert.deepEqual(second.sources, [2]); assert.equal(second.version, 2);
    assert.equal(db.lexical('北京').length, 0); assert.equal(db.semantic(vector()).length, 0);
    db.index(first, vector()); assert.equal(db.counts().indexed, 0);
    db.index(second, vector(1));
    assert.equal(db.semantic(vector(1))[0]?.content, second.content);
    assert.equal(db.searchHistory('北京')[0]?.item.content, first.content);
    assert.deepEqual(db.versions(first.id).map(v => [v.item.version, v.change]), [[2, 'supersede'], [1, 'add']]);
    const coffee = db.write({ ...value, content: '用户A喜欢咖啡。', sources: [3] })!;
    const both = db.write({ ...coffee, operation: 'update', content: '用户A喜欢咖啡，也喜欢茶。', sources: [4] })!;
    assert.deepEqual(both.sources, [3, 4]); assert.match(both.content, /咖啡.*茶/);
    assert.throws(() => db.write({ ...both, operation: 'supersede', people: ['B'] }), { code: 'memory_subject_mismatch' });
    assert.equal(db.get(both.id)?.version, 2);
  } finally { db.close(); }
});

test('correction invalidates prior versions for tools; forgetting removes every version, old source and historical index', () => {
  const db = new MemoryRepository(':memory:', settings);
  try {
    const first = db.write(value)!;
    const second = db.write({ ...first, operation: 'supersede', content: '用户A搬到了上海。', sources: [2] })!;
    const corrected = db.transaction(() => { db.protect(second); return db.write({ ...second, content: '用户A实际住在苏州。', sources: [2] }, true)!; });
    assert.deepEqual(db.versions(first.id).map(v => v.item.version), [3]);
    assert.equal(db.searchHistory('北京').length, 0); assert.equal(db.searchHistory('上海').length, 0);
    assert.deepEqual(db.versions(first.id, undefined, 10, true).map(v => v.usable), [true, false, false]);
    assert.equal(db.suppressed(1), true); assert.equal(db.suppressed(2), true);
    db.transaction(() => db.remove(corrected.id, corrected.version));
    assert.equal(db.get(corrected.id), undefined); assert.equal(db.versions(corrected.id, undefined, 10, true).length, 0);
    assert.equal(db.write(value), undefined); assert.equal(db.write({ ...value, content: second.content, sources: [2] }), undefined);
    assert.equal(db.searchHistory('苏州').length, 0);
  } finally { db.close(); }
});

test('legacy migration records the surviving version without inventing lost history and remains stable on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaolang-memory-history-')), path = join(root, 'state.sqlite');
  try {
    let db = new MemoryRepository(path, settings);
    const first = db.write(value)!;
    const last = db.write({ ...first, content: '用户A搬到上海。', sources: [2] })!;
    db.index(last, vector()); db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE memory_versions; DROP TABLE memory_version_fts; DELETE FROM memory_meta WHERE key='history_initialized'"); legacy.close();
    db = new MemoryRepository(path, settings);
    assert.deepEqual(db.versions(last.id).map(v => [v.item.version, v.change]), [[2, 'baseline']]);
    assert.equal(db.counts().indexed, 1); assert.equal(db.searchHistory('北京').length, 0); db.close();
    db = new MemoryRepository(path, settings); assert.equal(db.versions(last.id).length, 1); db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one extraction call per batch handles state changes and ignores duplicates; history is loaded only through its tool', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...settings, enabled: true, images: false };
  const embedded: string[][] = [];
  const background = new FakeModel(async messages => {
    const input = JSON.parse(messages.at(-1)!.content!);
    const source = input.messages[0], old = input.existing[0];
    const operation = source.text.includes('刚搬') ? 'supersede' : old ? 'ignore' : 'add';
    return { role: 'assistant', content: JSON.stringify({ memories: [operation === 'ignore' ? { operation, id: old.id, version: old.version }
      : { operation, ...(old ? { id: old.id, version: old.version } : {}), content: operation === 'add' ? '用户200住北京。' : '用户200刚搬到上海。',
        kind: 'profile', people: ['200'], sources: [source.seq], importance: 4 }] }) };
  });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background,
    embeddings: { embed: async texts => { embedded.push(texts); return texts.map(() => vector()); } } });
  try {
    const memory = app.ctx.memory as ChatMemory;
    for (const [i, text] of ['我住北京', '我刚搬到上海', '我住上海'].entries()) {
      app.ctx.intake.receive(event(text, i + 1)); await memory.process();
      assert.equal(memory.status().extractionError, null);
    }
    assert.ok(background.options.every(value => value?.thinking === true && value.reasoningEffort === 'low' && value.maxOutputTokens === 8192));
    assert.equal(background.requests.length, 3); assert.equal(embedded.length, 2);
    const item = (memory.list('').items as MemoryItem[])[0]!;
    assert.equal(item.version, 2); assert.deepEqual(item.sources, [2]);
    const message = app.ctx.store.record(3)!.message;
    const prepared = await memory.prepare({ id: randomUUID(), message, reason: 'test' }, new AbortController().signal);
    assert.ok(prepared!.context.includes('用户200刚搬到上海。')); assert.ok(!prepared!.context.includes('用户200住北京。'));
    const tool = await app.ctx.tools.execute({ id: 'history', type: 'function', function: { name: 'read_memory_history', arguments: JSON.stringify({ query: '北京' }) } }, message, new AbortController().signal) as { items: { content: string; current: { content: string } }[] };
    assert.equal(tool.items[0]?.content, '用户200住北京。'); assert.equal(tool.items[0]?.current.content, item.content);
    await memory.mutate({ action: 'update', value: { ...item, content: '用户200实际住在苏州。' } });
    const corrected = await app.ctx.tools.execute({ id: 'history2', type: 'function', function: { name: 'read_memory_history', arguments: JSON.stringify({ id: item.id }) } }, message, new AbortController().signal) as { items: unknown[] };
    assert.equal(corrected.items.length, 0);
    const detail = memory.detail(item.id) as { history: { items: { usable: boolean }[] } };
    assert.deepEqual(detail.history.items.map(v => v.usable), [true, false, false]);
  } finally { await app.stop(); }
});

test('two operations against one old memory abort the whole batch and leave the extraction cursor unchanged', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...settings, enabled: true, images: false };
  const background = new FakeModel(async messages => {
    const input = JSON.parse(messages.at(-1)!.content!), old = input.existing[0];
    return { role: 'assistant', content: JSON.stringify({ memories: [1, 2].map(() => ({ id: old.id, version: old.version, kind: old.kind, people: old.people, importance: old.importance, operation: 'update', sources: [2], content: '重复修改' })) }) };
  });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  try {
    app.ctx.intake.receive(event('我住北京', 1));
    const memory = app.ctx.memory as ChatMemory;
    const first = await memory.mutate({ action: 'remember', value: { ...value, people: ['200'] } }) as { item: MemoryItem };
    memory.repository.meta('cursor', '1');
    app.ctx.intake.receive(event('我搬到了上海', 2));
    await memory.process();
    assert.equal(memory.status().extractionError, 'memory_duplicate_operation');
    assert.equal(memory.status().processedThrough, 1); assert.equal(memory.repository.get(first.item.id)?.version, 1);
  } finally { await app.stop(); }
});


test('memory extraction honors its own off/high/max setting independently of the chat model', async () => {
  for (const level of ['off', 'high', 'max'] as const) {
    const cfg = config(); cfg.chatEnabled = false;
    cfg.memory = { ...settings, enabled: true, images: false, extractionThinking: level };
    const model = new FakeModel(), background = new FakeModel(async () => ({ role: 'assistant', content: '{"memories":[]}' }));
    const app = await createApp(cfg, { adapter: new FakeAdapter(), model, memoryModel: background });
    try {
      app.ctx.intake.receive(event('今天不错')); await (app.ctx.memory as ChatMemory).process();
      assert.equal(background.requests.length, 1); assert.equal(model.requests.length, 0);
      assert.equal(background.options[0]?.thinking, level !== 'off');
      assert.equal(background.options[0]?.reasoningEffort, level === 'off' ? undefined : level);
      assert.equal(background.options[0]?.maxOutputTokens, 8192);
    } finally { await app.stop(); }
  }
});
