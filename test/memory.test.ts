import test from 'node:test';
import { Failure } from '../src/errors.js';
import { contextSize } from '../src/context-budget.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository } from '../src/memory-store.js';
import { memoryDefaults } from '../src/memory-config.js';
import { BailianEmbeddings } from '../src/embedding.js';
import { ChatMemory } from '../src/memory.js';
import { createApp } from '../src/app.js';
import { DeepSeekModel } from '../src/model.js';
import { ConfigurationStore } from '../src/configuration.js';
import type { MemoryItem } from '../src/memory-store.js';
import { config, event, FakeAdapter, FakeModel, deferred } from './fixtures.js';
const signal = () => new AbortController().signal;
const vector = (axis = 0) => Array.from({ length: 64 }, (_, i) => i === axis ? 1 : 0);

test('Chinese lexical and native vector retrieval combine globally; edits and deletion remove stale indexes and suppressed sources', () => {
  const db = new MemoryRepository(':memory:', { ...memoryDefaults, embeddingDimensions: 64 });
  try {
    assert.equal(db.vectorError, undefined);
    const first = db.write({ content: '张三喜欢骑自行车，周末常去骑行。', kind: 'profile', people: ['user-a'], sources: [1], importance: 4 })!;
    const second = db.write({ content: '李四下周要参加音乐节。', kind: 'event', people: ['user-b'], sources: [2], importance: 3 })!;
    db.index(first, vector()); db.index(second, vector(1));
    assert.ok(db.lexical('张三骑车').some(item => item.id === first.id));
    assert.equal(db.semantic(vector())[0]!.id, first.id);
    assert.ok(db.candidates('自行车', ['user-other'], vector()).some(item => item.id === first.id));
    db.transaction(() => db.remove(first.id, first.version));
    assert.equal(db.get(first.id), undefined);
    assert.equal(db.lexical('骑行').length, 0);
    assert.equal(db.semantic(vector()).length, 0);
    assert.equal(db.write({ ...first, id: undefined }), undefined);
    assert.equal(db.suppressed(1), true);
    const updated = db.write({ ...second, content: '李四取消了音乐节计划。', sources: [3] })!;
    // An index job that started before a correction must not put the old vector back.
    db.index(second, vector(1));
    assert.equal(db.counts().indexed, 0);
    assert.equal(updated.version, 2);
    assert.throws(() => db.remove(updated.id, 1), /memory_conflict/);
  } finally { db.close(); }
});

test('all observed group messages feed memory; global recall includes original sources, current identity and time without forcing replies', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true, embeddingDimensions: 64 };
  const background = new FakeModel(async messages => {
    const body = JSON.parse(messages.at(-1)!.content!) as { messages: { seq: number; user: string }[] };
    return { role: 'assistant', content: JSON.stringify({ memories: body.messages.map(row => ({ content: '用户喜欢骑自行车。', kind: 'profile', people: [row.user], sources: [row.seq], importance: 4 })) }) };
  });
  const adapter = new FakeAdapter();
  const app = await createApp(options, { adapter, model: new FakeModel(), memoryModel: background, embeddings: { embed: async texts => texts.map(() => vector()) } });
  try {
    app.ctx.intake.receive(event('我喜欢骑自行车', 1, 'group-a', 'user-a'));
    await (app.ctx.memory as ChatMemory).process();
    assert.equal(adapter.sent.length, 0);
    const items = (app.ctx.memory.list('', '') as { items: MemoryItem[] }).items;
    assert.equal(items.length, 1);
    const detail = app.ctx.memory.detail(items[0]!.id) as { sources: { group: string; user: string }[] };
    assert.equal(detail.sources[0]!.group, 'group-a');
    app.ctx.intake.receive(event('小狼，谁喜欢自行车？', 2, 'group-b', 'user-b'));
    const message = app.ctx.store.records({ limit: 1 })[0]!.message;
    const prepared = await app.ctx.memory.prepare({ id: randomUUID(), message, reason: 'keyword' }, signal());
    assert.ok(prepared!.context.includes('用户喜欢骑自行车'));
    assert.ok(prepared!.context.includes('Asia/Shanghai'));
    assert.ok(prepared!.context.includes('group-b'));
    assert.ok(prepared!.context.includes('user-b'));
    assert.equal(prepared!.history.length, 0);
    await app.ctx.memory.mutate({ action: 'forget', id: items[0]!.id, version: items[0]!.version });
    assert.equal((app.ctx.memory.list('') as { items: unknown[] }).items.length, 0);
  } finally { await app.stop(); }
});

test('a human forget during an extraction call invalidates its stale writes and summaries', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true };
  const gate = deferred<void>(), entered = deferred<void>();
  const background = new FakeModel(async () => {
    entered.resolve(); await gate.promise;
    return { role: 'assistant', content: JSON.stringify({ memories: [{ content: '我喜欢咖啡', kind: 'profile', people: ['200'], sources: [1], importance: 3 }] }) };
  });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  try {
    app.ctx.intake.receive(event('我喜欢咖啡'));
    const created = await app.ctx.memory.mutate({ action: 'remember', value: { content: '我喜欢咖啡', kind: 'profile', people: ['200'], sources: [1], importance: 3 } }) as { item: MemoryItem };
    const process = (app.ctx.memory as ChatMemory).process(); await entered.promise;
    await app.ctx.memory.mutate({ action: 'forget', id: created.item.id, version: created.item.version });
    gate.resolve(); await process;
    assert.equal((app.ctx.memory.list('') as { items: unknown[] }).items.length, 0);
    await (app.ctx.memory as ChatMemory).process();
    assert.equal(app.ctx.memory.status().processedThrough, 1);
    assert.equal(background.requests.length, 1);
  } finally { gate.resolve(); await app.stop(); }
});

test('the extraction cursor processes the oldest backlog first and survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-memory-'));
  const options = config(); options.database = join(directory, 'chat.sqlite'); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true, batchSize: 2 };
  const batches: number[][] = [];
  const background = new FakeModel(async messages => {
    batches.push((JSON.parse(messages.at(-1)!.content!) as { messages: { seq: number }[] }).messages.map(row => row.seq));
    return { role: 'assistant', content: '{"memories":[]}' };
  });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  try {
    for (let id = 1; id <= 5; id++) app.ctx.intake.receive(event(`消息${id}`, id));
    await (app.ctx.memory as ChatMemory).process(); await (app.ctx.memory as ChatMemory).process(); await (app.ctx.memory as ChatMemory).process();
    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
  } finally { await app.stop(); }
  const reopened = new MemoryRepository(options.database, options.memory!);
  try { assert.equal(reopened.meta('cursor'), '5'); } finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
});

test('embedding batches are ordered, validated and sent to the configured compatible endpoint', async () => {
  const settings = { ...memoryDefaults, embeddingBaseUrl: 'https://space.example/compatible-mode/v1', embeddingDimensions: 64 };
  const requests: unknown[] = [];
  const embedding = new BailianEmbeddings(settings, 'test-secret', async (url, options) => {
    assert.equal(url, 'https://space.example/compatible-mode/v1/embeddings');
    const body = JSON.parse(String(options?.body)) as { input: string[] }; requests.push(body);
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: vector(index % 2) })).reverse() });
  });
  const result = await embedding.embed(Array.from({ length: 12 }, (_, i) => String(i)), signal());
  assert.equal(requests.length, 2); assert.equal(result.length, 12); assert.deepEqual(result[0], vector()); assert.deepEqual(result[1], vector(1));
  const malformed = new BailianEmbeddings(settings, 'test-secret', async () => Response.json({ data: [{ index: 0, embedding: [1] }] }));
  await assert.rejects(malformed.embed(['test'], signal()), /embedding_invalid_response/);
});

test('vision content reaches DeepSeek as real multimodal input without leaking internal fields', async () => {
  const model = new DeepSeekModel(config().model, 'test-secret', async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as { messages: Record<string, unknown>[] };
    assert.deepEqual(body.messages[0]!.content, [{ type: 'text', text: '图片问题' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }]);
    assert.equal('images' in body.messages[0]!, false);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '看到了。' }, finish_reason: 'stop' }] });
  });
  await model.complete([{ role: 'user', content: '图片问题', images: [{ url: 'data:image/png;base64,test' }] }], [], signal());
});

test('memory plugin configuration preserves blank credentials, masks them and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-memory-config-'));
  try {
    const base = config(); base.database = join(directory, 'chat.sqlite'); const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(base));
    const settings = await ConfigurationStore.load(path, () => {}, () => true, {});
    const app = await createApp(settings.config, { adapter: new FakeAdapter(), model: new FakeModel(), configuration: settings });
    try {
      settings.bindPlugins(() => app.ctx.xiaolangRuntime.status().plugins);
      const plugin = await settings.plugin('xiaolang-memory');
      assert.equal(plugin.canToggle, true);
      await settings.savePlugin('xiaolang-memory', { revision: plugin.revision, config: { ...memoryDefaults, embeddingBaseUrl: 'https://space.example/v1', apiKey: 'private-embedding-key' } });
      const masked = await settings.plugin('xiaolang-memory');
      assert.equal(JSON.stringify(masked).includes('private-embedding-key'), false);
      assert.equal((masked.secretConfigured as Record<string, boolean>).apiKey, true);
      await settings.savePlugin('xiaolang-memory', { revision: masked.revision, config: { ...memoryDefaults, apiKey: '' } });
    } finally { await app.stop(); }
    const reloaded = await ConfigurationStore.load(path, () => {}, () => true, {});
    assert.equal(reloaded.secrets.embedding, 'private-embedding-key');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vector service failure falls back to keywords; queued context includes earlier confirmed replies and excludes later user messages', async () => {
  const settings = config(); settings.chatEnabled = false; settings.memory = { ...memoryDefaults, enabled: true };
  const app = await createApp(settings, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: new FakeModel(async () => ({ role: 'assistant', content: '{"memories":[]}' })), embeddings: { embed: async () => { throw new Error('offline'); } } });
  try {
    app.ctx.intake.receive(event('我喜欢蓝莓', 1));
    const first = app.ctx.store.records({ limit: 1 })[0]!.message;
    const turn = app.ctx.store.createTurn(first, 'test');
    app.ctx.intake.receive(event('你记得蓝莓吗', 2));
    const second = app.ctx.store.records({ limit: 1 })[0]!.message;
    app.ctx.intake.receive(event('这是后来的消息', 3));
    app.ctx.store.delivered(turn, '我记住了。', [{ role: 'assistant', content: '我记住了。' }], ['receipt']);
    await app.ctx.memory.mutate({ action: 'remember', value: { content: '用户喜欢蓝莓', kind: 'profile', people: ['200'], sources: [first.seq], importance: 3 } });
    const prepared = await app.ctx.memory.prepare({ id: randomUUID(), message: second, reason: 'test' }, signal());
    assert.ok(prepared!.context.includes('用户喜欢蓝莓'));
    assert.ok(prepared!.history.some(item => item.content === '我记住了。'));
    assert.ok(!JSON.stringify(prepared!.history).includes('这是后来的消息'));
    assert.equal(app.ctx.memory.status().vectorState, 'error');
  } finally { await app.stop(); }
});

test('a fabricated extraction source never enters memory and does not advance the durable cursor', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true };
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: new FakeModel(async () => ({ role: 'assistant', content: JSON.stringify({ memories: [{ content: '虚构信息', kind: 'event', people: ['200'], sources: [999], importance: 3 }] }) })) });
  try {
    app.ctx.intake.receive(event('真实原文'));
    await (app.ctx.memory as ChatMemory).process();
    assert.equal(app.ctx.memory.status().extractionError, 'memory_invalid_source');
    assert.equal(app.ctx.memory.status().processedThrough, 0);
    assert.equal((app.ctx.memory.list('') as { items: unknown[] }).items.length, 0);
  } finally { await app.stop(); }
});

test('optional null fields from the extraction model do not block a valid new memory', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true };
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: new FakeModel(async () => ({ role: 'assistant', content: JSON.stringify({ memories: [{ id: null, version: null, content: '用户喜欢喝无糖咖啡。', kind: 'profile', people: ['200'], sources: [1], importance: 3, validUntil: '' }] }) })) });
  try {
    app.ctx.intake.receive(event('我喜欢喝无糖咖啡'));
    await (app.ctx.memory as ChatMemory).process();
    assert.equal(app.ctx.memory.status().extractionError, null);
    assert.equal((app.ctx.memory.list('') as { items: unknown[] }).items.length, 1);
  } finally { await app.stop(); }
});

test('compaction waits for 200 records, keeps pending text, then preserves the recent tail; correction invalidates it', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true, recentMessages: 5, summaryThinking: 'high' };
  const finishSummary = deferred<{ role: 'assistant'; content: string }>();
  const background = new FakeModel(async messages => messages[0]!.content!.startsWith('将旧摘要') ? finishSummary.promise : { role: 'assistant', content: '{"memories":[]}' });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  try {
    for (let i = 1; i <= 200; i++) app.ctx.intake.receive(event('聊天'+i, i, null));
    const boundary = app.ctx.store.records({ limit: 1 })[0]!.message;
    const firstTurn = { id: randomUUID(), message: boundary, reason: 'test' };
    const first = (await app.ctx.memory.prepare(firstTurn, signal()))!;
    await app.ctx.memory.compact!(firstTurn, first, { used: contextSize(first.history, options.limits) + 1000, budget: 80000, overhead: 1000 }, signal());
    assert.equal(first.history.length, 199);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(app.ctx.memory.status().summaries, 0);
    app.ctx.intake.receive(event('聊天201', 201, null));
    const message = app.ctx.store.records({ limit: 1 })[0]!.message;
    const turn = { id: randomUUID(), message, reason: 'test' };
    const prepared = (await app.ctx.memory.prepare(turn, signal()))!;
    const pending = await app.ctx.memory.compact!(turn, prepared, { used: contextSize(prepared.history, options.limits) + 1000, budget: 80000, overhead: 1000 }, signal());
    assert.equal(pending.history.length, 200, 'raw history stays available until the summary succeeds');
    assert.equal(app.ctx.memory.status().summaries, 0);
    finishSummary.resolve({ role: 'assistant', content: '用户200之前讨论过骑行计划，尚未确认完成。' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const result = await app.ctx.memory.prepare(turn, signal());
    assert.ok(result!.context.includes('骑行计划'));
    const summaryIndex = background.requests.findIndex(messages => messages[0]!.content!.startsWith('将旧摘要'));
    assert.equal(background.options[summaryIndex]?.thinking, true); assert.equal(background.options[summaryIndex]?.reasoningEffort, 'high');
    assert.equal(background.options[summaryIndex]?.maxOutputTokens, 8192);
    assert.equal(background.options[summaryIndex]?.timeoutMs, 60000); assert.equal(background.options[summaryIndex]?.retries, 0);
    assert.equal(result!.history.length, 5);
    const record = app.ctx.memory.summary!(message.session).compactions![0]!;
    assert.equal(record.count, 195); assert.equal(record.afterCount, 5); assert.equal(record.state, 'completed');
    const item = await app.ctx.memory.mutate({ action: 'remember', value: { content: '用户喜欢骑行', kind: 'profile', people: ['200'], sources: [1], importance: 3 } }) as { item: MemoryItem };
    await app.ctx.memory.mutate({ action: 'forget', id: item.item.id, version: item.item.version });
    assert.equal(app.ctx.memory.status().summaries, 0);
  } finally { await app.stop(); }
});

test('summary failures preserve progress and persistent backoff despite new messages; successful recovery clears it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-summary-backoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = config(); options.database = join(directory, 'chat.sqlite'); options.chatEnabled = false;
  options.memory = { ...memoryDefaults, enabled: true, recentMessages: 5, summaryThinking: 'high' };
  let now = Date.now(), recover = false;
  t.mock.method(Date, 'now', () => now);
  const background = new FakeModel(async messages => {
    if (messages[0]!.content!.startsWith('将旧摘要')) {
      if (!recover) throw new Failure('model_output_truncated');
      return { role: 'assistant', content: '先前聊过蓝莓。' };
    }
    return { role: 'assistant', content: '{"memories":[]}' };
  });
  const count = () => background.requests.filter(messages => messages[0]!.content!.startsWith('将旧摘要')).length;
  const open = () => createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  let app = await open();
  const prepare = async () => {
    const message = app.ctx.store.records({ limit: 1 })[0]!.message;
    const turn = { id: randomUUID(), message, reason: 'test' };
    const prepared = (await app.ctx.memory.prepare(turn, signal()))!;
    await app.ctx.memory.compact!(turn, prepared, { used: contextSize(prepared.history, options.limits) + 1000, budget: 80000, overhead: 1000 }, signal());
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    for (let i = 1; i <= 201; i++) app.ctx.intake.receive(event('聊天'+i, i, null));
    await prepare(); assert.equal(count(), 1); assert.equal(app.ctx.memory.status().summaries, 0);
    app.ctx.intake.receive(event('新的消息不会取消冷却', 202, null));
    await prepare(); assert.equal(count(), 1);
    now += 5 * 60000; await prepare(); assert.equal(count(), 2);
    now += 15 * 60000; await prepare(); assert.equal(count(), 3);
    await app.stop(); app = await open();
    now += 59 * 60000; await prepare(); assert.equal(count(), 3, 'restart must preserve the one-hour pause');
    now += 60000; recover = true; await prepare(); assert.equal(count(), 4);
    assert.equal(app.ctx.memory.status().summaries, 1); assert.equal(app.ctx.memory.status().summaryError, null);
    await prepare(); assert.equal(count(), 4);
  } finally { await app.stop(); }
});

test('token pressure compacts fewer than 200 records and a full context waits for a committed summary', async () => {
  const options = config(); options.chatEnabled = false; options.memory = { ...memoryDefaults, enabled: true };
  const finish = deferred<{ role: 'assistant'; content: string }>();
  const background = new FakeModel(async messages => messages[0]!.content!.startsWith('将旧摘要') ? finish.promise : { role: 'assistant', content: '{"memories":[]}' });
  const app = await createApp(options, { adapter: new FakeAdapter(), model: new FakeModel(), memoryModel: background });
  try {
    for (let i = 1; i <= 21; i++) app.ctx.intake.receive(event('长消息。'.repeat(200), i, null));
    const message = app.ctx.store.records({ limit: 1 })[0]!.message, turn = { id: randomUUID(), message, reason: 'test' };
    const prepared = (await app.ctx.memory.prepare(turn, signal()))!;
    const used = contextSize(prepared.history, options.limits) + 1000, budget = used - 100;
    let settled = false;
    const compacted = app.ctx.memory.compact!(turn, prepared, { used, budget, overhead: 1000 }, signal()).then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(prepared.history.length, 20); assert.equal(app.ctx.memory.status().summaries, 0);
    const running = app.ctx.memory.summary!(message.session).compactions![0]!;
    assert.equal(running.reason, 'tokens'); assert.equal(running.afterCount, 20);
    finish.resolve({ role: 'assistant', content: '之前有一段重复的长消息。' });
    const result = await compacted;
    assert.ok(result.history.length < 20); assert.ok(result.parts!.summary.includes('重复的长消息'));
    const completed = app.ctx.memory.summary!(message.session).compactions![0]!;
    assert.equal(completed.count + result.history.length, 20); assert.equal(completed.afterCount, result.history.length);
    assert.ok(completed.contextAfter! < completed.contextBefore);
    assert.equal(app.ctx.store.records({ limit: 500 }).length, 21, 'compaction never deletes original messages');
  } finally { finish.resolve({ role: 'assistant', content: '结束。' }); await app.stop(); }
});
