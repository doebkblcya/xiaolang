import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProactiveTrigger } from '../src/proactive.js';
import { proactiveDefaults } from '../src/trigger-config.js';
import type { Log, ModelMessage } from '../src/contracts.js';
import { normalize } from '../src/messages.js';
import { createApp } from '../src/app.js';
import { DeepSeekModel } from '../src/model.js';
import { validateConfig } from '../src/config.js';
import { triggerSettings } from '../src/trigger.js';
import { config, deferred, event, FakeAdapter, FakeModel } from './fixtures.js';

function message(seq: number, group = 100, text = `消息${seq}`) {
  const value = normalize(event(text, seq, group), new FakeAdapter(), [])!;
  return { ...value, seq };
}
function controller(model = new FakeModel(async () => ({ role: 'assistant', content: '{"reply":false,"addressed":false,"reason":"群友在互相聊天"}' })), overrides = {}) {
  const sent: number[] = [], logs: Log[] = [];
  const value = new ProactiveTrigger({ ...proactiveDefaults, enabled: true, idleSeconds: 0.04, idleMessages: 3, ...overrides }, {
    model, persona: '小狼', history: message => [{ seq: message.seq, session: message.session, direction: 'in', message, text: message.text }],
    imageContext: () => '', report: entry => logs.push(entry),
  });
  return { value, model, sent, logs, observe: (seq: number, group = 100) => value.observe(message(seq, group), message => sent.push(message.seq)) };
}

test('judging has independent thinking settings and preserves the legacy fast path', async () => {
  for (const thinking of ['off', 'low', 'high', 'max'] as const) {
    const instance = controller(undefined, { thinking, idleMessages: 1 });
    try {
      instance.observe(1); await instance.value.idle();
      const options = instance.model.options[0]!;
      assert.equal(options.thinking, thinking !== 'off');
      assert.equal(options.reasoningEffort, thinking === 'off' ? undefined : thinking);
      assert.equal(options.maxOutputTokens, thinking === 'off' ? 256 : 8192);
      assert.equal(options.timeoutMs, thinking === 'off' ? 8000 : 30000);
      assert.deepEqual(options.stop, []);
    } finally { await instance.value.clear(); }
  }
  assert.equal(triggerSettings(config()).proactive.thinking, 'off');
});

test('one quiet-group message is judged at the deadline; the count threshold triggers a single batch early', async () => {
  const first = controller(); first.observe(1); await first.value.idle();
  assert.equal(first.model.requests.length, 1); assert.equal(first.sent.length, 0);
  const second = controller(undefined, { idleSeconds: 10 });
  second.observe(1); second.observe(2); second.observe(3); await second.value.idle();
  assert.equal(second.model.requests.length, 1);
  assert.deepEqual(JSON.parse(second.model.requests[0]![1]!.content!).pending, [1, 2, 3]);
  await first.value.clear(); await second.value.clear();
});

test('proactive groups use exclusions; legacy allowed groups are cleared rather than inverted', async () => {
  const instance = controller(undefined, { idleMessages: 1, excludedGroupIds: ['101'] });
  instance.observe(1, 101); instance.observe(2, 102); await instance.value.idle();
  assert.equal(instance.model.requests.length, 1);
  assert.equal(JSON.parse(instance.model.requests[0]![1]!.content!).group, '102');
  await instance.value.clear();
  const base = config();
  const { excludedGroupIds: _groups, ...old } = proactiveDefaults;
  const previous = { ...base, trigger: { privateReply: true, groupMention: true, groupKeywords: true, words: ['小狼'],
    proactive: { ...old, enabled: true, groupIds: ['100'] } } };
  const migrated = validateConfig(previous);
  assert.deepEqual(migrated.trigger?.proactive?.excludedGroupIds, []);
  assert.equal(Object.hasOwn(migrated.trigger!.proactive!, 'groupIds'), false);
  assert.deepEqual(triggerSettings(previous as unknown as typeof base).proactive.excludedGroupIds, []);
  assert.equal(proactiveDefaults.idleSeconds, 60); assert.equal(proactiveDefaults.idleMessages, 20);
});

test('activation is group-local, expires without participation, and a new summons invalidates an in-flight judgement', async () => {
  const started = deferred(), late = deferred<ModelMessage>();
  const instance = controller(new FakeModel(async () => { started.resolve(); return late.promise; }), { idleMessages: 1 });
  instance.observe(1); await started.promise;
  instance.value.queued(message(2), 'mention');
  late.resolve({ role: 'assistant', content: '{"reply":true,"addressed":true,"reason":"接话"}' });
  await instance.value.idle();
  assert.equal(instance.sent.length, 0);
  instance.value.settled(message(2), true);
  await instance.value.clear();

  const groups = controller(undefined, { activeSeconds: 0.03, idleSeconds: 0.01 });
  groups.value.queued(message(1), 'mention'); groups.value.settled(message(1), true);
  groups.observe(2, 101); await groups.value.idle();
  assert.equal(JSON.parse(groups.model.requests[0]![1]!.content!).mode, 'idle');
  await delay(35); groups.observe(3); await groups.value.idle();
  assert.equal(JSON.parse(groups.model.requests[1]![1]!.content!).mode, 'idle');
  await groups.value.clear();
});

test('ordinary new messages cannot starve pending participation; failures stay silent and clearing cancels deferred work', async () => {
  const started = deferred(), late = deferred<ModelMessage>(); let count = 0;
  const instance = controller(new FakeModel(async () => {
    if (!count++) { started.resolve(); return late.promise; }
    return { role: 'assistant', content: '{"reply":false,"addressed":false,"reason":"话题已经转移"}' };
  }), { idleMessages: 1 });
  instance.observe(1); await started.promise; instance.observe(2);
  late.resolve({ role: 'assistant', content: '{"reply":true,"addressed":true,"reason":"旧话题"}' });
  await instance.value.idle();
  assert.deepEqual(instance.sent, [1]); assert.equal(instance.model.requests.length, 2);
  assert.equal(instance.value.current(message(1)), true);
  instance.value.queued(message(3), 'mention');
  assert.equal(instance.value.current(message(1)), false);
  instance.value.settled(message(3), true);
  await instance.value.clear();
  const broken = controller(new FakeModel(async () => { throw new Error('private-provider-details'); }));
  broken.observe(1); await broken.value.idle();
  assert.equal(broken.sent.length, 0); assert.ok(broken.logs.some(log => log.code === 'proactive_judge_failed'));
  assert.ok(!JSON.stringify(broken.logs).includes('private-provider-details'));
  broken.observe(2); await broken.value.clear(); await broken.value.idle();
  assert.equal(broken.model.requests.length, 1);
});

test('an unmentioned follow-up is judged promptly, reuses normal delivery, and cannot expose write tools', async t => {
  const settings = config();
  settings.trigger = { privateReply: true, groupMention: true, groupKeywords: true, words: ['小狼'],
    proactive: { ...proactiveDefaults, enabled: true, excludedGroupIds: ['101'], idleSeconds: 60 } };
  let judgments = 0;
  const model = new FakeModel(async (messages, tools) => {
    if (messages[0]?.content?.includes('你负责判断QQ群聊天')) {
      judgments++; assert.equal(tools.length, 0);
      assert.ok(messages[1]?.content?.includes('修好了吗'));
      return { role: 'assistant', content: '{"reply":true,"addressed":true,"reason":"正在回应小狼的问题"}' };
    }
    if (messages.at(-1)?.content?.includes('你正在自主参与群聊')) {
      assert.ok(!tools.some(tool => tool.function.name === 'sensitive_write'));
      return { role: 'assistant', content: '那就好！' };
    }
    return { role: 'assistant', content: '后来修好了吗？' };
  });
  const adapter = new FakeAdapter(), app = await createApp(settings, { model, adapter });
  t.after(() => app.stop());
  app.ctx.tools.register({ name: 'sensitive_write', description: 'test', effect: 'write', parameters: { type: 'object', properties: {} }, execute: async () => 'done' });
  app.ctx.intake.receive(event('小狼，问问我的硬盘', 1)); await app.ctx.chat.idle();
  app.ctx.intake.receive(event('修好了，换了根线', 2)); await app.ctx.chat.idle();
  assert.equal(judgments, 1); assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.sent[1]?.message.id, '2');
  assert.equal(app.ctx.historyReader.recent(1).items[0]?.reason, 'proactive');
  app.ctx.intake.receive(event('别的群聊天', 3, 101)); await app.ctx.chat.idle();
  assert.equal(judgments, 1);
  app.ctx.intake.receive(event('小狼你好', 4, 101)); await app.ctx.chat.idle();
  assert.equal(adapter.sent.length, 3); assert.equal(judgments, 1);
});

test('short judging overrides neither mutate reply model settings nor inherit stop markers or thinking', async () => {
  const settings = config().model; settings.thinking = true; settings.stop = ['结束'];
  const bodies: any[] = [];
  const model = new DeepSeekModel(settings, 'test-key', (async (_url, request) => {
    bodies.push(JSON.parse(String(request?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
  }) as typeof fetch);
  await model.complete([], [], new AbortController().signal, { thinking: false, maxOutputTokens: 256, stop: [], retries: 0 });
  await model.complete([], [], new AbortController().signal);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' }); assert.equal(bodies[0].max_tokens, 256); assert.equal(bodies[0].stop, undefined);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled' }); assert.deepEqual(bodies[1].stop, ['结束']);
});

test('only genuine direct continuations renew activity; incidental interjections cannot keep a group active', async t => {
  for (const addressed of [false, true]) {
    const start = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const instance = controller(new FakeModel(async () => ({ role: 'assistant', content: JSON.stringify({ reply: true, addressed, reason: '判断结果' }) })), { activeSeconds: 60, idleMessages: 1 });
    instance.value.queued(message(1), 'mention'); instance.value.settled(message(1), true);
    t.mock.timers.setTime(start + 59000);
    instance.value.observe(message(2), value => { instance.value.queued(value, 'proactive'); instance.value.settled(value, true); });
    await instance.value.idle();
    t.mock.timers.setTime(start + 61000);
    instance.observe(3); await instance.value.idle();
    assert.equal(JSON.parse(instance.model.requests.at(-1)![1]!.content!).mode, addressed ? 'active' : 'idle');
    assert.ok(instance.logs.some(entry => entry.reason?.includes(addressed ? '刷新活跃时间' : '不延长活跃时间')));
    await instance.value.clear(); t.mock.timers.reset();
  }
});

test('the queue deadline starts after the idle judgement, not before the configured observation window', async () => {
  const instance = controller(new FakeModel(async () => ({ role: 'assistant', content: '{"reply":true,"addressed":false,"reason":"有值得补充的内容"}' })));
  const pending = { ...message(1), time: Date.now() - 60000 };
  instance.value.observe(pending, value => instance.sent.push(value.seq));
  await instance.value.idle(); assert.deepEqual(instance.sent, [1]); assert.equal(instance.value.current(pending), true);
  instance.value.queued(message(2), 'mention'); assert.equal(instance.value.current(pending), false);
  instance.value.settled(message(2), false); await instance.value.clear();
});
