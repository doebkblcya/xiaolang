import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageMeter, withUsage } from '../src/usage.js';
import { DeepSeekModel } from '../src/model.js';
import { BailianEmbeddings } from '../src/embedding.js';
import { memoryDefaults } from '../src/memory-config.js';
import { config } from './fixtures.js';

const signal = () => new AbortController().signal;
const answer = (usage?: object) => ({ id: 'chat-request-1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'a private response', reasoning_content: 'private thoughts' } }], usage });

test('concurrent callers attribute actual usage independently; retries are individual requests and never pretend unknown is zero', async t => {
  const meter = new UsageMeter(':memory:'); t.after(() => meter.close());
  let attempt = 0;
  const retried = new DeepSeekModel(config().model, 'secret-key', (async () => ++attempt === 1 ? new Response('', { status: 503 })
    : Response.json(answer({ prompt_tokens: 90, completion_tokens: 10, total_tokens: 100, prompt_cache_hit_tokens: 70, completion_tokens_details: { reasoning_tokens: 4 } }))) as typeof fetch, meter);
  const background = new DeepSeekModel(config().model, 'secret-key', (async () => Response.json(answer({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }))) as typeof fetch, meter);
  await Promise.all([
    withUsage(meter, 'chat', { turn: 'turn-one' }, () => retried.complete([], [], signal())),
    withUsage(meter, 'memory_extract', {}, () => background.complete([], [], signal())),
  ]);
  const view = meter.view({ range: 'all' });
  assert.equal(view.summary.calls, 3); assert.equal(view.summary.total, 125); assert.equal(view.summary.input, 110);
  assert.equal(view.summary.cached, 70); assert.equal(view.summary.reasoning, 4); assert.equal(view.summary.unknown, 1);
  const chat = meter.view({ purpose: 'chat', range: 'all' });
  assert.equal(chat.summary.calls, 2); assert.equal(chat.summary.total, 100);
  assert.equal(chat.items[0]!.attempt, 2); assert.equal(chat.items[1]!.total, null);
  assert.ok(view.items.filter(row => row.purpose === 'memory_extract').every(row => row.turn === null));
  assert.ok(!JSON.stringify(view).includes('private')); assert.ok(!JSON.stringify(view).includes('secret-key'));
});

test('streaming captures final usage-only frames once; truncated output and interrupted streams retain any returned usage', async t => {
  const meter = new UsageMeter(':memory:'); t.after(() => meter.close());
  let requestedUsage = false;
  for (const finish of ['stop', 'length', 'interrupted']) {
    const events = [{ id: 'stream-1', choices: [{ delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: finish === 'length' ? 'length' : 'stop' }] },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }];
    const model = new DeepSeekModel(config().model, 'fake', (async (_url, init) => {
      requestedUsage = JSON.parse(String(init?.body)).stream_options.include_usage;
      return new Response(events.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + (finish === 'interrupted' ? '' : 'data: [DONE]\n\n'));
    }) as typeof fetch, meter);
    const result = withUsage(meter, 'chat', {}, () => model.stream([], [], signal(), async () => {}));
    if (finish === 'stop') assert.equal((await result).content, '你好');
    else await assert.rejects(result, { code: finish === 'length' ? 'model_output_truncated' : 'model_stream_interrupted' });
  }
  assert.equal(requestedUsage, true);
  const view = meter.view(); assert.equal(view.summary.calls, 3); assert.equal(view.summary.total, 300); assert.equal(view.summary.failures, 2);
  assert.equal(view.summary.unknown, 0);
});

test('embedding batches count provider tokens, including total-only usage, and inherit the enclosing turn', async t => {
  const meter = new UsageMeter(':memory:'); t.after(() => meter.close());
  const settings = { ...memoryDefaults, embeddingDimensions: 2 };
  const embeddings = new BailianEmbeddings(settings, 'fake', (async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input as string[];
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 2] })), usage: { total_tokens: input.length * 8 } });
  }) as typeof fetch, meter);
  await withUsage(meter, 'chat', { turn: 'turn-two' }, () => withUsage(meter, 'embedding_index', {}, () => embeddings.embed(Array(11).fill('word'), signal())));
  const view = meter.view({ provider: 'bailian' });
  assert.equal(view.summary.calls, 2); assert.equal(view.summary.input, 88); assert.equal(view.summary.output, 0); assert.equal(view.summary.total, 88);
  assert.ok(view.items.every(row => row.purpose === 'embedding_index' && row.turn === 'turn-two'));
});

test('usage persists across restart, marks unfinished attempts unknown, and rejects unbounded filters', t => {
  const dir = mkdtempSync(join(tmpdir(), 'xiaolang-usage-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'usage.sqlite'); const first = new UsageMeter(path);
  first.begin({ provider: 'deepseek', model: 'test', kind: 'chat' }, { purpose: 'chat' }, Date.now()); first.close();
  const second = new UsageMeter(path); t.after(() => second.close());
  const view = second.view(); assert.equal(view.summary.calls, 1); assert.equal(view.items[0]!.state, 'interrupted'); assert.equal(view.summary.unknown, 1);
  for (const query of [{ purpose: 'bad' }, { range: 'year' }, { provider: 'unknown' }, { before: -1 }]) assert.throws(() => second.view(query), { code: 'invalid_usage_query' });
});
