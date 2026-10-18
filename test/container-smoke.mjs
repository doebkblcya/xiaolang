import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createApp } from '/app/dist/src/app.js';

// CI only: an actual Linux container with externally mounted code and zero network access.
const config = JSON.parse(await readFile('/app/config.example.json', 'utf8'));
config.database = ':memory:';
config.plugins = {
  directory: '/app/plugins',
  entries: [
    { id: 'hello', module: './hello/index.mjs', config: { greeting: '容器测试通过' } },
    { id: 'console-logger', module: './console-logger/index.mjs', config: { format: 'text' } },
    { id: 'panel', module: './panel/index.mjs', config: { host: '127.0.0.1', port: 18080 } },
  ],
};
let delivered = '';
let requests = 0;
const events = [];
const app = await createApp(config, {
  report: entry => events.push(entry),
  model: {
    complete: async (messages, tools) => {
      requests++;
      assert.ok(tools.some(tool => tool.function.name === 'greet'));
      if (messages.at(-1)?.role === 'tool') return { role: 'assistant', content: messages.at(-1).content };
      return { role: 'assistant', content: null, tool_calls: [
        { id: 'container-test', type: 'function', function: { name: 'greet', arguments: '{"name":"小狼"}' } },
      ] };
    },
  },
  adapter: {
    platform: 'mock', account: 'test-app', capabilities: { groupMessages: 'all', maxTextChars: 4000 },
    start() {}, stop() {}, reply: async (_message, text) => { delivered = text; return { id: '1' }; },
  },
});
try {
  app.ctx.intake.receive({
    account: 'test-app', sender: 'user-openid', id: '1', name: '测试用户', time: Date.now(),
    segments: [{ type: 'text', text: '向小狼问好' }],
  });
  await app.ctx.chat.idle();
  assert.equal(requests, 2);
  assert.ok(delivered.includes('容器测试通过，小狼。'));
  assert.equal(typeof app.ctx.logOutput.write, 'function');
  assert.ok(events.some(entry => entry.code === 'message_received' && entry.preview === '向小狼问好'));
  assert.ok(events.some(entry => entry.code === 'send_confirmed' && entry.receipt === '1'));
  const status = await fetch('http://127.0.0.1:18080/api/status').then(response => response.json());
  assert.equal(status.state, 'ready');
  const conversations = await fetch('http://127.0.0.1:18080/api/conversations').then(response => response.json());
  assert.equal(conversations.items.length, 1);
  const timeline = await fetch(`http://127.0.0.1:18080/api/conversations/${conversations.items[0].id}`).then(response => response.json());
  assert.equal(timeline.items[0].text, '向小狼问好');
  assert.equal(timeline.items.at(-1).text, delivered);
  assert.equal(timeline.conversation.scope, 'private');
  assert.ok(status.plugins.some(plugin => plugin.id === 'panel' && plugin.state === 'active'));
  const turns = await fetch('http://127.0.0.1:18080/api/turns').then(response => response.json());
  assert.equal(turns.items[0].reply, delivered);
  const detail = await fetch(`http://127.0.0.1:18080/api/turns/${turns.items[0].id}`).then(response => response.json());
  assert.equal(detail.sends[0].state, 'sent');
  assert.ok(!('protocol' in detail));
  const logs = await fetch('http://127.0.0.1:18080/api/logs').then(response => response.json());
  assert.ok(logs.items.some(item => item.entry.code === 'turn_completed'));
  // fetch may normalize Host to the URL authority; send an actual hostile Host over HTTP.
  const rejectedHost = await new Promise((resolve, reject) => {
    const request = httpRequest('http://127.0.0.1:18080/api/status', { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch('http://127.0.0.1:18080/api/status', { method: 'POST' })).status, 405);
  assert.ok((await fetch('http://127.0.0.1:18080/').then(response => response.text())).includes('小狼'));
  console.info('Mounted external plugin: OK');
} finally { await app.stop(); }
