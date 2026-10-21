import test from 'node:test';
import assert from 'node:assert/strict';
import { textTokens, contextSize, inputBudget } from '../src/context-budget.js';
import { assemble } from '../src/chat.js';
import { config, event } from './fixtures.js';
import { normalize } from '../src/messages.js';
import { createApp } from '../src/app.js';
import { memoryDefaults } from '../src/memory-config.js';
import { personaDefaults } from '../src/persona-config.js';
import { FakeAdapter, FakeModel } from './fixtures.js';

test('token budget counts multilingual text and reserves image, response and tool capacity', () => {
  const options = config();
  assert.equal(textTokens('你好，小狼！ Hello world.'), 8);
  assert.ok(textTokens('hello '.repeat(100)) < 600);
  const plain = { role: 'user', content: '你好' };
  assert.equal(contextSize({ ...plain, images: [{ url: 'data:image/png;base64,AAAA' }] }, options.limits), contextSize(plain, options.limits) + 1024);
  assert.equal(inputBudget(options), 100000 - options.model.maxOutputTokens - options.limits.toolResultChars - 512);
});

test('history is trimmed by tokens while preserving the latest complete user/assistant group', () => {
  const options = config();
  const measure = (value: unknown) => contextSize(value, options.limits);
  const current = normalize(event('现在的问题'), { platform: 'mock', account: '123456789' }, []);
  assert.ok(current);
  const recent = [{ role: 'user' as const, content: '最近的问题' }, { role: 'assistant' as const, content: '最近的回答' }];
  const history = [{ role: 'user' as const, content: '很早的消息'.repeat(5000) }, ...recent];
  const result = assemble('人设', history, current, 500, 0, measure);
  assert.deepEqual(result.slice(1, -1), recent);
});

test('stable rules and history precede changing recall and runtime data without losing prompt budget accounting', async () => {
  const options = config(); options.memory = { ...memoryDefaults, enabled: true }; options.character = personaDefaults;
  const model = new FakeModel(), app = await createApp(options, { model, adapter: new FakeAdapter(), memoryModel: new FakeModel(async () => ({ role: 'assistant', content: '{"memories":[]}' })) });
  try {
    app.ctx.intake.receive(event('小狼，我喜欢蓝莓', 1)); await app.ctx.chat.idle();
    const message = app.ctx.store.record(1)!.message;
    await app.ctx.memory.mutate({ action: 'remember', value: { content: '用户喜欢蓝莓。', kind: 'profile', people: [message.sender], sources: [1], importance: 3 } });
    app.ctx.intake.receive(event('小狼，蓝莓怎么样', 2)); await app.ctx.chat.idle();
    const first = model.requests[0]!, second = model.requests[1]!;
    assert.equal(first[0]!.content, second[0]!.content, 'changing seq, time and recalled memory must not change the system prefix');
    assert.ok(!second[0]!.content!.includes('当前时间：'));
    assert.ok(!second[0]!.content!.includes('表达参考（JSON 资料）：'));
    assert.match(second.at(-1)!.content!, /用户喜欢蓝莓/);
    assert.match(second.at(-1)!.content!, /当前时间：/);
    assert.match(second.at(-1)!.content!, /表达参考（JSON 资料）：/);
    assert.match(second[1]!.content!, /小狼，我喜欢蓝莓/);
    assert.equal(first.at(-1)!.images, undefined);
  } finally { await app.stop(); }
  const current = normalize(event('当前问题'), { platform: 'mock', account: '123456789' }, [])!;
  const result = assemble('固定规则', [{ role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史回答' }], current, 3000, 0, undefined, undefined,
    { summary: '前情摘要', references: '本轮记忆', current: '本轮状态' });
  assert.match(result[1]!.content!, /前情摘要/); assert.equal(result[2]!.content, '历史问题');
  assert.ok(result.at(-1)!.content!.indexOf('本轮记忆') < result.at(-1)!.content!.indexOf('当前问题'));
  assert.throws(() => assemble('规则', [], current, 100, 0, undefined, undefined, { summary: '长'.repeat(500) }), /input_too_long/);
});
