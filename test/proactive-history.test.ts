import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRecord, Log, Message } from '../src/contracts.js';
import { normalize, render } from '../src/messages.js';
import { textTokens } from '../src/context-budget.js';
import { ProactiveTrigger } from '../src/proactive.js';
import { proactiveDefaults } from '../src/trigger-config.js';
import { proactiveHistoryBudget, selectProactiveHistory } from '../src/proactive-history.js';
import { event, FakeAdapter, FakeModel } from './fixtures.js';

function message(seq: number, text = `消息${seq}`, group = 100): Message {
  return { ...normalize(event(text, seq, group), new FakeAdapter(), [])!, seq };
}
function record(seq: number, text: string, direction: 'in' | 'out' = 'in'): ChatRecord {
  const source = message(seq, text); return { seq, session: source.session, direction, message: source, text };
}

test('quoted originals outside the window, the last bot reply and neighboring dialogue survive a bounded history selection', () => {
  const rows = Array.from({ length: 30 }, (_, i) => record(i + 11, `历史${i + 11}：` + '这是一段普通历史背景。'.repeat(80)));
  rows[14] = record(25, '小狼：你说的是哪台设备？', 'out');
  const quoted = record(2, '原文：我准备换一台旧设备。'), pending = message(41, '这台，帮我参考一下');
  pending.segments.unshift({ type: 'reply', messageId: 'old', seq: 2 });
  const result = selectProactiveHistory(rows, [pending], { limit: 30, record: seq => seq === 2 ? quoted : undefined,
    imageContext: () => '', fits: () => true });
  assert.ok(result.items.some(row => row.seq === 2 && row.text.includes('旧设备')));
  assert.ok(result.items.some(row => row.seq === 25 && row.speaker === 'bot'));
  assert.ok(result.items.some(row => row.seq === 40));
  assert.ok(result.items.length < rows.length);
  assert.ok(result.tokens <= proactiveHistoryBudget);
  assert.deepEqual(result.items.map(row => row.seq), result.items.map(row => row.seq).sort((a, b) => a - b));
});

test('already embedded quotes are not repeated and references cannot import another session, future data or candidates', () => {
  const pending = message(41);
  pending.segments.unshift({ type: 'reply', messageId: 'old', seq: 2, segments: [{ type: 'text', text: '完整引用原文' }] },
    { type: 'reply', messageId: 'foreign', seq: 3 }, { type: 'reply', messageId: 'future', seq: 90 });
  const foreign = record(3, '另一个群的资料'); foreign.session = message(3, 'other', 101).session;
  const before = structuredClone(pending);
  const result = selectProactiveHistory([record(2, '完整引用原文'), foreign, record(90, '尚未出现的资料'), record(41, '本批原文')], [pending], {
    limit: 30, imageContext: () => '', fits: () => true, record: seq => seq === 3 ? foreign : undefined,
  });
  assert.deepEqual(result.items, []); assert.equal(result.inlined, 1);
  assert.deepEqual(pending, before);
});

test('oversized reference anchors are explicitly marked as fragments and yield to the remaining request budget', () => {
  const pending = message(3);
  pending.segments.unshift({ type: 'reply', messageId: 'old', seq: 1 });
  const rows = [record(1, '引用原文。'.repeat(3000)), record(2, '最近的一句话')];
  const result = selectProactiveHistory(rows, [pending], { limit: 30, imageContext: () => '',
    fits: items => textTokens(JSON.stringify(items)) <= 150 });
  assert.ok(result.items.some(row => row.seq === 1 && row.truncated));
  assert.ok(result.tokens <= 150);
  const none = selectProactiveHistory(rows, [pending], { limit: 30, imageContext: () => '', fits: items => items.length === 0 });
  assert.deepEqual(none.items, []);
});

test('the live judging path preserves complete candidates and reports history reduction without another model request', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => record(i + 1, '普通旧话题。'.repeat(100)));
  const pending = message(31, '这条新消息必须逐字保留。'.repeat(220));
  const original = render(pending), logs: Log[] = [];
  const model = new FakeModel(async messages => {
    const input = JSON.parse(messages[1]!.content!);
    assert.deepEqual(input.candidates, [{ seq: 31, text: original }]);
    assert.ok(textTokens(messages[1]!.content!) <= 6000);
    assert.ok(textTokens(JSON.stringify(input.recent)) <= proactiveHistoryBudget);
    assert.ok(input.recent.length < rows.length);
    return { role: 'assistant', content: '{"replies":[]}' };
  });
  const trigger = new ProactiveTrigger({ ...proactiveDefaults, enabled: true, idleMessages: 1 }, {
    model, persona: '小狼', history: () => rows, imageContext: () => '', report: entry => logs.push(entry),
  });
  try {
    trigger.observe(pending, () => assert.fail('silent selection must not dispatch'));
    await trigger.idle(); assert.equal(model.requests.length, 1);
    assert.ok(!logs.some(entry => entry.code === 'proactive_judge_failed'));
    assert.ok(logs.some(entry => entry.fields?.some(field => field.label === '历史参考预算' && field.value === proactiveHistoryBudget)));
  } finally { await trigger.clear(); }
});
