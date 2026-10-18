import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekModel } from '../src/model.js';
import { config } from './fixtures.js';
import { validateConfig } from '../src/config.js';

test('model request carries tool-continuation state; thoughts stay separate from final content', async () => {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'final', reasoning_content: 'private-provider-state' } }] });
  }) as typeof fetch;
  const model = new DeepSeekModel(config().model, 'fake-not-a-secret', fetcher);
  const messages = [{ role: 'assistant' as const, content: null, reasoning_content: 'continue', tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'test', arguments: '{}' } }] },
    { role: 'tool' as const, content: 'result', tool_call_id: '1' }];
  const response = await model.complete(messages, [], new AbortController().signal);
  assert.deepEqual(body.messages, messages);
  assert.equal(response.content, 'final');
  assert.equal(response.reasoning_content, 'private-provider-state');
});

test('invalid model output and truncated output are not silently delivered or retried', async () => {
  for (const [finish_reason, expected] of [['length', 'model_output_truncated'], ['stop', 'model_empty_response']]) {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({ choices: [{ finish_reason, message: { role: 'assistant', content: '' } }] }); }) as typeof fetch;
    const model = new DeepSeekModel(config().model, 'fake', fetcher);
    await assert.rejects(model.complete([], [], new AbortController().signal), { code: expected });
    assert.equal(calls, 1);
  }
});

test('configuration rejects empty trigger words and embedded credentials', () => {
  const value = config();
  value.triggerWords = [''];
  assert.throws(() => validateConfig(value), { code: 'invalid_config' });
  value.triggerWords = ['小狼'];
  value.model.baseUrl = 'https://user:password@example.com';
  assert.throws(() => validateConfig(value), { code: 'invalid_url' });
});


test('per-request low-effort thinking expands the extraction budget without changing other requests', async () => {
  const bodies: Record<string, unknown>[] = [];
  const settings = config().model; settings.thinking = false; settings.reasoningEffort = 'high';
  const model = new DeepSeekModel(settings, 'fake', (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  await model.complete([], [], signal, { thinking: true, reasoningEffort: 'low', maxOutputTokens: 8192 });
  await model.complete([], [], signal);
  assert.deepEqual(bodies[0]?.thinking, { type: 'enabled' });
  assert.equal(bodies[0]?.reasoning_effort, 'low'); assert.equal(bodies[0]?.max_tokens, 8192);
  assert.deepEqual(bodies[1]?.thinking, { type: 'disabled' });
  assert.equal(bodies[1]?.reasoning_effort, undefined); assert.equal(bodies[1]?.max_tokens, settings.maxOutputTokens);
  assert.equal(settings.thinking, false); assert.equal(settings.reasoningEffort, 'high');
});
