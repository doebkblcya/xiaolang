import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekModel } from '../src/model.js';
import { Sender, outputSchema } from '../src/output.js';
import { SqliteStore } from '../src/store.js';
import { normalize } from '../src/messages.js';
import { ConfigurationStore } from '../src/configuration.js';
import { createApp } from '../src/app.js';
import type { Adapter, Model } from '../src/contracts.js';
import { Failure } from '../src/errors.js';
import { config, event, FakeAdapter } from './fixtures.js';

const signal = () => new AbortController().signal;
function sse(events: unknown[], done = true): Response {
  const bytes = new TextEncoder().encode(events.map(delta => `data: ${JSON.stringify(delta)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  // Break UTF-8 characters and CRLF separators across network chunks.
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }));
}
const frame = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ delta, finish_reason }] });

test('SSE streams only content and assembles split tool arguments, UTF-8 and finish state', async () => {
  let requested = false;
  const model = new DeepSeekModel(config().model, 'fake', (async (_url, init) => {
    requested = JSON.parse(String(init?.body)).stream;
    return sse([frame({ role: 'assistant', reasoning_content: 'private thoughts' }), frame({ content: '你好🐺。' }),
      frame({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'current_time', arguments: '{' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, 'tool_calls')]);
  }) as typeof fetch);
  const visible: string[] = [];
  const reply = await model.stream([], [], signal(), async delta => { visible.push(delta); });
  assert.equal(requested, true); assert.deepEqual(visible, ['你好🐺。']);
  assert.equal(reply.reasoning_content, 'private thoughts'); assert.equal(reply.tool_calls?.[0]?.function.arguments, '{}');
});

test('stream interruption and downstream send failure do not retry an emitted response', async () => {
  for (const downstream of [false, true]) {
    let calls = 0;
    const model = new DeepSeekModel({ ...config().model, retries: 3 }, 'fake', (async () => {
      calls++; return sse([frame({ content: '开始。' })], false);
    }) as typeof fetch);
    await assert.rejects(model.stream([], [], signal(), async () => { if (downstream) throw new Failure('send_error', true, true); }),
      { code: downstream ? 'send_error' : 'model_stream_interrupted' });
    assert.equal(calls, 1);
  }
});

test('group streaming delivers sentences before completion and reserves fifth reply for the remainder', async t => {
  const store = new SqliteStore(':memory:'); t.after(() => store.close());
  const adapter = new FakeAdapter(); adapter.capabilities = { ...adapter.capabilities, maxTextChars: 100 };
  const message = store.admit(normalize(event('小狼'), adapter, [])!)!;
  const turn = store.createTurn(message, 'keyword');
  const stream = new Sender(store, adapter, 100).openStream(turn, signal());
  await stream.write('一。二。三。四。五。六。七。');
  assert.deepEqual(adapter.sent.map(item => item.text), ['一。', '二。', '三。', '四。']);
  await stream.finish([{ role: 'assistant', content: '一。二。三。四。五。六。七。' }]);
  assert.deepEqual(adapter.sent.map(item => item.text), ['一。', '二。', '三。', '四。', '五。六。七。']);
  assert.equal(store.detail(turn.id)?.reply, '一。二。三。四。五。六。七。');
});

test('native streaming updates one bubble and keeps only confirmed text on lost receipt', async t => {
  const store = new SqliteStore(':memory:'); t.after(() => store.close());
  const adapter: Adapter = new FakeAdapter(); adapter.capabilities.nativeStreaming = true;
  const frames: { text: string; index: number; done: boolean; streamId?: string }[] = [];
  let fail = false;
  adapter.streamReply = async (_message, text, index, done, streamId) => { frames.push({ text, index, done, streamId }); if (fail) throw new Failure('lost_receipt', true); return { id: 'bubble' }; };
  const message = store.admit(normalize(event('hello', 1, null), adapter, [])!)!, turn = store.createTurn(message, 'private');
  const stream = new Sender(store, adapter, 100).openStream(turn, signal());
  await stream.write('你好'); await stream.write('，小狼。'); await stream.finish([{ role: 'assistant', content: '你好，小狼。' }]);
  assert.deepEqual(frames, [{ text: '你好', index: 0, done: false, streamId: undefined }, { text: '你好，小狼。', index: 1, done: true, streamId: 'bubble' }]);
  assert.equal(store.inspectSends(turn.id).length, 1);
  const next = store.admit(normalize(event('next', 2, null), adapter, [])!)!, nextTurn = store.createTurn(next, 'private');
  const interrupted = new Sender(store, adapter, 100).openStream(nextTurn, signal());
  await interrupted.write('确认部分'); fail = true; await interrupted.write('未确认部分');
  await assert.rejects(interrupted.finish([]), { code: 'lost_receipt' });
  assert.equal(store.inspectSends(nextTurn.id)[0]?.state, 'unknown');
  assert.equal(store.detail(nextTurn.id)?.reply, '确认部分');
});

test('overlong fifth group reply is explicit and never sends a sixth message', async t => {
  const store = new SqliteStore(':memory:'); t.after(() => store.close()); const adapter = new FakeAdapter();
  const message = store.admit(normalize(event('小狼'), adapter, [])!)!, turn = store.createTurn(message, 'keyword');
  const stream = new Sender(store, adapter, 50).openStream(turn, signal());
  await stream.write('一。二。三。四。' + '余'.repeat(80));
  await assert.rejects(stream.finish([{ role: 'assistant', content: 'unused' }]), { code: 'qq_reply_part_limit' });
  assert.equal(adapter.sent.length, 5); assert.match(adapter.sent[4]!.text, /剩余内容未发送/);
  assert.ok(Array.from(adapter.sent[4]!.text).length <= 50);
});

test('streamed tool execution continues to final reply through the ordinary main chain', async t => {
  let step = 0;
  const model: Model = { complete: async () => { throw new Error('must stream'); }, stream: async (_messages, _tools, _signal, write) => {
    if (step++ === 0) return { role: 'assistant', content: null, tool_calls: [{ id: 'time', type: 'function', function: { name: 'current_time', arguments: '{}' } }] };
    await write('现在'); await write('收到。'); return { role: 'assistant', content: '现在收到。' };
  } };
  const settings = config(); settings.output = { mode: 'streaming' }; const adapter = new FakeAdapter();
  const app = await createApp(settings, { model, adapter }); t.after(() => app.stop());
  adapter.receive!(event('小狼')); await app.ctx.chat.idle();
  assert.deepEqual(adapter.sent.map(item => item.text), ['现在收到。']);
  assert.equal(app.ctx.historyReader.recent(1).items[0]?.state, 'completed');
});

test('builtin output settings survive reload and its disable control is available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-stream-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const value = config(); value.database = join(directory, 'data', 'db.sqlite'); const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(value));
  const store = await ConfigurationStore.load(path, () => {}, () => true, {});
  store.bindPlugins(() => [{ id: 'xiaolang-output', title: '统一发送', module: 'builtin', kind: 'builtin', state: 'active', dependencies: [], provides: ['output'] }]);
  store.registerPlugin('xiaolang-output', outputSchema);
  const detail = await store.plugin('xiaolang-output'); assert.equal(detail.canToggle, true);
  await store.savePlugin('xiaolang-output', { revision: detail.revision, config: { mode: 'streaming' } });
  const boot = await ConfigurationStore.load(path, () => {}, () => true, {}); assert.equal(boot.config.output?.mode, 'streaming');
});
