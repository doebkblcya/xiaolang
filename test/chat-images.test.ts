import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatImages, pictures } from '../src/chat-images.js';
import { MemoryRepository } from '../src/memory-store.js';
import { memoryDefaults } from '../src/memory-config.js';
import { createApp } from '../src/app.js';
import { normalize } from '../src/messages.js';
import { config, event, FakeAdapter, FakeModel, deferred } from './fixtures.js';
import type { Message } from '../src/contracts.js';
import { VisualToolResult } from '../src/contracts.js';
import { imageKey } from '../src/image-identity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store.js';
const settings = { ...memoryDefaults, enabled: true };
const signal = () => new AbortController().signal;
function pictureMessage(): Message {
  const input = event('', 1, 'group-one');
  input.segments = [{ type: 'image', url: 'https://example.qpic.cn/first.png?key=one' }, { type: 'image', url: 'https://example.qpic.cn/second.png?key=two' }];
  return { ...normalize(input, new FakeAdapter(), [])!, seq: 7 };
}
function fetchPictures(count: { value: number }): typeof fetch {
  return async url => { count.value++; return new Response(String(url).includes('second') ? 'second-pixels' : 'first-pixels', { headers: { 'Content-Type': 'image/png' } }); };
}

test('each picture has its own stable reference; descriptions are reused but reinspection fetches originals every time', async () => {
  const repository = new MemoryRepository(':memory:', settings), calls = { value: 0 };
  const model = new FakeModel(async messages => ({ role: 'assistant', content: messages.at(-1)!.content === '请描述这张图片。' ? '两列商品价格表。' : '第二列价格是128元。' }));
  const images = new ChatImages(settings, repository, model, () => {}, fetchPictures(calls));
  try {
    const message = pictureMessage();
    assert.deepEqual(pictures(message).map(image => image.imageId), ['img_7_1', 'img_7_2']);
    await Promise.all([images.describe(message), images.describe(message)]);
    assert.equal(calls.value, 2); assert.equal(model.requests.length, 2);
    assert.ok(images.text(message).includes('img_7_2'));
    assert.ok(!JSON.stringify(images.references(message)).includes('base64'));
    await images.describe(message); assert.equal(calls.value, 2);
    const first = await images.inspect(message, 1, '第二列多少钱？', signal());
    const second = await images.inspect(message, 1, '再确认一下价格', signal());
    assert.ok(first instanceof VisualToolResult && second instanceof VisualToolResult);
    assert.equal(first.result.available, true); assert.equal(second.result.imageId, 'img_7_2'); assert.equal(calls.value, 4);
    assert.equal(model.requests.length, 2, 'reinspection must not make a separate caption/vision request');
    const supplied = second.images[0]!.url;
    assert.equal(Buffer.from(supplied.split(',')[1]!, 'base64').toString(), 'second-pixels');
    assert.ok(!JSON.stringify(second).includes('base64'));
    await assert.rejects(images.inspect(message, 2, '看图', signal()), /image_not_found/);
  } finally { await images.stop(); repository.close(); }
});

test('an unavailable QQ image is reported as unavailable, even when an old text description exists', async () => {
  const repository = new MemoryRepository(':memory:', settings), message = pictureMessage();
  repository.image(pictures(message)[0]!.key, '旧描述：一张表格。');
  const model = new FakeModel();
  const images = new ChatImages(settings, repository, model, () => {}, async () => new Response('', { status: 403 }));
  try {
    const result = await images.inspect(message, 0, '第二行的数字', signal());
    assert.ok(!(result instanceof VisualToolResult));
    assert.equal(result.available, false); assert.equal(result.description, '旧描述：一张表格。');
    assert.ok(result.notice?.includes('没有重新看到原图'));
    assert.equal(model.requests.length, 0);
  } finally { await images.stop(); repository.close(); }
});

test('untriggered images are described immediately; multiple text followups carry references without original pixels and tools inspect the selected image', async () => {
  const options = config(); options.memory = { ...settings, imageDescriptionThinking: 'off' };
  const adapter = new FakeAdapter(), described = deferred<void>(), calls = { value: 0 };
  const background = new FakeModel(async messages => {
    const current = messages.at(-1)!;
    if (current.images?.length) {
      if (current.content === '请描述这张图片。') { described.resolve(); return { role: 'assistant', content: '一张两列的商品价格表，具体数字需重看原图确认。' }; }
      assert.equal(current.content, '第二行的价格？');
      return { role: 'assistant', content: '第二行价格为128元。' };
    }
    return { role: 'assistant', content: '{"memories":[]}' };
  });
  const model = new FakeModel(async messages => {
    assert.ok(JSON.stringify(messages).includes('img_1_1'));
    const last = messages.at(-1)!;
    if (last.role === 'tool') {
      const supplied = messages.filter(message => message.images?.length);
      assert.equal(supplied.length, 1); assert.equal(supplied[0]!.role, 'user');
      assert.equal(Buffer.from(supplied[0]!.images![0]!.url.split(',')[1]!, 'base64').toString(), 'first-pixels');
      return { role: 'assistant', content: '第二行是128元。' };
    }
    assert.ok(!messages.some(message => message.images?.length), 'later turns must not inherit original pixels');
    assert.ok(messages[0]!.content?.includes('本轮开始时实际附带的原图（按顺序）：无'));
    assert.ok(messages.some(message => message.content?.includes('历史图片索引；后台模型生成的描述')));
    if (last.content?.includes('第二行')) return { role: 'assistant', content: null, tool_calls: [{ id: 'see-first-image', type: 'function', function: { name: 'inspect_chat_image', arguments: '{"imageId":"img_1_1","question":"第二行的价格？"}' } }] };
    return { role: 'assistant', content: '记得，是商品价格表。' };
  });
  const app = await createApp(options, { adapter, model, memoryModel: background, imageFetch: fetchPictures(calls) });
  try {
    const image = event('', 1); image.segments = [{ type: 'image', url: 'https://example.qpic.cn/table.png' }];
    app.ctx.intake.receive(image);
    await described.promise; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(background.options[0]?.thinking, false);
    assert.equal(background.options[0]?.reasoningEffort, undefined);
    assert.equal(adapter.sent.length, 0);
    assert.equal(calls.value, 1);
    app.ctx.intake.receive(event('小狼，你记得这张图吗？', 2)); await app.ctx.chat.idle();
    assert.equal(calls.value, 1);
    app.ctx.intake.receive(event('小狼，第二行是多少？', 3)); await app.ctx.chat.idle();
    assert.equal(calls.value, 2);
    assert.equal(adapter.sent.at(-1)!.text, '第二行是128元。');
    assert.ok(app.ctx.historyReader.recent(1).items[0]!.state === 'completed');
    assert.ok(!JSON.stringify(app.ctx.store.records({ limit: 100 })).includes('base64'), 'persisted history must not contain pixels');
    app.ctx.intake.receive(event('小狼，你还记得吗？', 4)); await app.ctx.chat.idle();
    assert.ok(!model.requests.at(-1)!.some(row => row.images?.length));
    // Forgetting the source also prevents the image tool from reopening it.
    const memory = await app.ctx.memory.mutate({ action: 'remember', value: { content: '一张表格', kind: 'event', people: ['200'], sources: [1], importance: 2 } }) as { item: { id: string; version: number } };
    await app.ctx.memory.mutate({ action: 'forget', id: memory.item.id, version: memory.item.version });
    await assert.rejects(app.ctx.tools.execute({ id: 'blocked-image', type: 'function', function: { name: 'inspect_chat_image', arguments: '{"imageId":"img_1_1","question":"价格？"}' } }, app.ctx.store.record(1)!.message, signal()), /image_not_found/);
  } finally { await app.stop(); }
});

test('QQ download fileids cannot share captions; renewing an access key preserves the same resource identity', async () => {
  const first = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=first&rkey=old&spec=0';
  const renewed = 'https://multimedia.nt.qq.com.cn/download?spec=0&rkey=new&fileid=first&appid=1407';
  const second = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=second&rkey=old&spec=0';
  assert.equal(imageKey(first), imageKey(renewed)); assert.notEqual(imageKey(first), imageKey(second));
  const repository = new MemoryRepository(':memory:', settings), model = new FakeModel();
  const images = new ChatImages({ ...settings, imageDescriptionThinking: 'high' }, repository, model, () => {}, fetchPictures({ value: 0 }));
  try {
    const message = pictureMessage(); message.segments = [{ type: 'image', url: first }, { type: 'image', url: second }];
    await images.describe(message); assert.equal(model.requests.length, 2);
    assert.ok(model.options.every(option => option?.thinking && option.reasoningEffort === 'high' && option.maxOutputTokens === 8192));
  } finally { await images.stop(); repository.close(); }
});

test('legacy caption migration discards derived image context but preserves chat and long-term memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-caption-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'chat.sqlite'), store = new SqliteStore(path);
  store.admit(pictureMessage()); store.close();
  const old = new MemoryRepository(path, settings);
  old.image('old-colliding-hash', 'wrong caption'); old.setSummary('a-chat', 1, 'wrong summary');
  const memory = old.write({ content: '用户喜欢蓝莓', kind: 'profile', people: ['200'], sources: [1], importance: 3 });
  assert.ok(memory);
  old.meta('image_cache_version', '1'); old.close();
  const migrated = new MemoryRepository(path, settings);
  assert.equal(migrated.image('old-colliding-hash'), undefined); assert.equal(migrated.summary('a-chat'), undefined);
  assert.equal(migrated.get(memory.id)?.content, '用户喜欢蓝莓'); assert.equal(migrated.meta('image_cache_version'), '2');
  migrated.image('v2:new', 'correct caption'); migrated.close();
  const reopened = new MemoryRepository(path, settings);
  assert.equal(reopened.image('v2:new'), 'correct caption'); reopened.close();
  const chats = new SqliteStore(path); assert.equal(chats.records({ limit: 10 }).length, 1); chats.close();
});
