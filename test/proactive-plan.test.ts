import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ProactiveTrigger } from '../src/proactive.js';
import { proactiveDefaults } from '../src/trigger-config.js';
import { normalize } from '../src/messages.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';
import type { Log } from '../src/contracts.js';

function settings() {
  const cfg = config(); cfg.chatEnabled = true;
  cfg.trigger = { privateReply: true, groupMention: true, groupKeywords: true, words: ['小狼'],
    proactive: { ...proactiveDefaults, enabled: true, idleMessages: 3, idleSeconds: 60 } };
  return cfg;
}

test('replying to a known bot receipt triggers immediately, without judging; nested quotes and other authors do not', async t => {
  const cfg = settings(), adapter = new FakeAdapter(), model = new FakeModel();
  cfg.trigger!.proactive!.enabled = false;
  const app = await createApp(cfg, { adapter, model }); t.after(() => app.stop());
  app.ctx.intake.receive(event('小狼，你怎么看', 1)); await app.ctx.chat.idle();
  const quote = event('ai 在哪', 2);
  quote.segments.unshift({ type: 'reply', messageId: '1001' });
  app.ctx.intake.receive(quote); await app.ctx.chat.idle();
  assert.equal(model.requests.length, 2); assert.equal(adapter.sent[1]?.message.id, '2');
  assert.equal(app.ctx.historyReader.recent(1).items[0]?.reason, 'quote');
  const other = event('这是谁说的', 3);
  other.segments.unshift({ type: 'reply', messageId: 'unknown', sender: 'someone-else', segments: [{ type: 'reply', messageId: '1001', sender: adapter.account }] });
  app.ctx.intake.receive(other); await app.ctx.chat.idle();
  assert.equal(adapter.sent.length, 2);
});

test('a batch selects non-last and multiple targets, generates once and sends to the original authors with a shared snapshot', async t => {
  const adapter = new FakeAdapter(), cfg = settings();
  let judgments = 0, generations = 0;
  const model = new FakeModel(async messages => {
    if (messages[0]?.content?.startsWith('你负责判断QQ群聊天')) {
      judgments++;
      const input = JSON.parse(messages[1]!.content!);
      assert.deepEqual(input.pending, [1, 2, 3]); assert.equal(input.candidates.length, 3);
      assert.ok(input.candidates[0].text.includes('第一件事'));
      assert.ok(!input.recent.some((row: { seq: number }) => input.pending.includes(row.seq)));
      return { role: 'assistant', content: '{"replies":[{"seq":2,"reason":"可补充"},{"seq":1,"reason":"可以回答"}]}' };
    }
    generations++;
    assert.ok(JSON.stringify(messages).includes('第三条问别人的'));
    assert.ok(JSON.stringify(messages).includes('contextThrough'));
    return { role: 'assistant', content: '{"replies":[{"seq":2,"text":"第二个回答"},{"seq":1,"text":"第一个回答"}]}' };
  });
  const app = await createApp(cfg, { adapter, model }); t.after(() => app.stop());
  app.ctx.intake.receive(event('第一件事', 1, 100, 201));
  app.ctx.intake.receive(event('第二件事', 2, 100, 202));
  app.ctx.intake.receive(event('第三条问别人的', 3, 100, 203));
  await app.ctx.chat.idle();
  assert.equal(judgments, 1); assert.equal(generations, 1);
  assert.deepEqual(adapter.sent.map(row => [row.message.id, row.message.sender, row.text]), [['1', '201', '第一个回答'], ['2', '202', '第二个回答']]);
  const turns = app.ctx.historyReader.recent(5).items;
  assert.deepEqual(turns.map(turn => [turn.seq, turn.state]), [[2, 'completed'], [1, 'completed']]);
  assert.equal(turns[0]?.plan?.id, turns[1]?.id);
  const records = app.ctx.store.records({ limit: 10 });
  assert.ok(!records.filter(row => row.direction === 'out').some(row => row.text.includes('"replies"')));
  const decisions = app.ctx.processLogs.query({ event: 'proactive_decided', limit: 10 }).items;
  assert.deepEqual(decisions.map(item => item.entry.state), ['selected', 'selected', 'unselected']);
});

test('invalid or duplicate selection targets never fall back to the last message; zero selection is valid', async () => {
  for (const replies of [[], [{ seq: 99, reason: '历史消息' }], [{ seq: 1, reason: '重复' }, { seq: 1, reason: '重复' }]]) {
    const logs: Log[] = [], sent: number[] = [];
    const trigger = new ProactiveTrigger({ ...proactiveDefaults, enabled: true, idleMessages: 2 }, {
      model: new FakeModel(async () => ({ role: 'assistant', content: JSON.stringify({ replies }) })), persona: '小狼',
      history: () => [], imageContext: () => '', report: entry => logs.push(entry),
    });
    try {
      for (let i = 1; i <= 2; i++) trigger.observe({ ...normalize(event(`消息${i}`, i), new FakeAdapter(), [])!, seq: i }, message => sent.push(message.seq));
      await trigger.idle(); assert.deepEqual(sent, []);
      assert.equal(logs.some(row => row.code === 'proactive_judge_failed'), replies.length > 0);
    } finally { await trigger.clear(); }
  }
});

test('active arrivals are judged separately and direct replies do not consume autonomous send quota', async () => {
  const model = new FakeModel(async () => ({ role: 'assistant', content: '{"replies":[]}' }));
  const trigger = new ProactiveTrigger({ ...proactiveDefaults, enabled: true, idleSeconds: 60, maxRepliesPerMinute: 1 }, {
    model, persona: '小狼', history: () => [], imageContext: () => '', report() {},
  });
  const message = (seq: number) => ({ ...normalize(event(`消息${seq}`, seq), new FakeAdapter(), [])!, seq });
  try {
    trigger.queued(message(1), 'quote'); trigger.settled(message(1), true);
    trigger.observe(message(2), () => {}); trigger.observe(message(3), () => {}); trigger.observe(message(4), () => {});
    await trigger.idle();
    assert.equal(model.requests.length, 3);
    assert.ok(model.requests.every(request => { const input = JSON.parse(request[1]!.content!); return input.mode === 'active' && input.candidates.length === 1; }));
  } finally { await trigger.clear(); }
});

test('all generated targets are validated before sending any part of a multi-reply', async t => {
  for (const answer of [
    { replies: [{ seq: 1, text: 'one' }, { seq: 1, text: 'duplicate' }] },
    { replies: [{ seq: 1, text: 'one' }, { seq: 99, text: 'unknown' }] },
    { replies: [{ seq: 1, text: 'missing target' }] },
  ]) {
    const cfg = settings(); cfg.trigger!.proactive!.idleMessages = 2;
    const adapter = new FakeAdapter(), model = new FakeModel(async messages => ({ role: 'assistant', content:
      JSON.stringify(messages[0]?.content?.startsWith('你负责判断QQ群聊天')
        ? { replies: [{ seq: 1, reason: '可回答' }, { seq: 2, reason: '可回答' }] } : answer) }));
    const app = await createApp(cfg, { adapter, model }); t.after(() => app.stop());
    app.ctx.intake.receive(event('第一个问题', 1)); app.ctx.intake.receive(event('第二个问题', 2)); await app.ctx.chat.idle();
    assert.equal(adapter.sent.length, 0);
    assert.ok(app.ctx.historyReader.recent(5).items.every(turn => turn.errorCode === 'proactive_reply_invalid'));
  }
});

test('latest message decisions stay scoped to requested messages and work after a journal restart', async t => {
  const { LogJournal } = await import('../src/log-journal.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-decisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'logs.sqlite'), first = 'a'.repeat(64), second = 'b'.repeat(64);
  let journal = new LogJournal(path);
  journal.append({ code: 'proactive_observing', messageId: first });
  journal.append({ code: 'proactive_decided', messageId: first, state: 'unselected', targetSeq: 2 });
  journal.append({ code: 'proactive_decided', messageId: second, state: 'selected', targetSeq: 2 });
  journal.close(); journal = new LogJournal(path); t.after(() => journal.close());
  const rows = journal.latest([first], ['proactive_observing', 'proactive_decided']);
  assert.equal(rows.length, 1); assert.equal(rows[0]?.entry.state, 'unselected');
  assert.equal(rows[0]?.entry.targetSeq, 2); assert.equal(journal.query().degraded, false);
});
