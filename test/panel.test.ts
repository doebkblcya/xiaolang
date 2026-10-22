import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { emitLog } from '../src/contracts.js';
import { Failure } from '../src/errors.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';
import type { Inspection } from '../src/contracts.js';

async function handler(inspection: Inspection, allowedHosts: string[] = []) {
  const module = await import(pathToFileURL(resolve('examples/plugins/panel/index.mjs')).href);
  const handle = module.createHandler(inspection, undefined, { allowedHosts });
  return async (url: string, method = 'GET', headers: Record<string, string> = {}) => {
    let status = 0, output = '', responseHeaders: Record<string, string> = {};
    // No HTTP listener on Mac: exercise the request handler with in-memory messages.
    await handle({ url, method, headers: { host: '127.0.0.1:18080', ...headers }, resume() {} }, {
      writeHead(value: number, values: Record<string, string>) { status = value; responseHeaders = values; },
      end(value: string | Buffer) { output = String(value); },
    });
    return { status, headers: responseHeaders, text: output, json: () => JSON.parse(output) };
  };
}

test('read-only history projections paginate, filter failures, and expose only confirmed reply text', async t => {
  let requests = 0;
  const settings = config(); settings.persona = 'hidden-system-prompt';
  const app = await createApp(settings, { adapter: new FakeAdapter(), model: new FakeModel(async () => {
    if (++requests === 2) throw new Failure('model_timeout');
    return { role: 'assistant', content: '确认回复', reasoning_content: 'hidden-thoughts' };
  }) });
  t.after(() => app.stop());
  app.ctx.intake.receive(event('第一条', 1, null)); await app.ctx.chat.idle();
  app.ctx.intake.receive(event('第二条', 2, null)); await app.ctx.chat.idle();
  const reader = app.ctx.historyReader;
  const first = reader.recent(1);
  assert.equal(first.items[0]?.input, '第二条');
  assert.equal(first.items[0]?.reply, '');
  assert.equal(first.items[0]?.errorCode, 'model_timeout');
  assert.ok(first.next);
  const older = reader.recent(1, first.next!);
  assert.equal(older.items[0]?.input, '第一条');
  assert.equal(older.items[0]?.reply, '确认回复');
  assert.equal(older.next, null);
  assert.equal(reader.recent(25, undefined, true).items.length, 1);
  assert.deepEqual(reader.counts(), { completed: 1, failed: 1 });
  const detail = reader.detail(older.items[0]!.id)!;
  assert.equal(detail.sends[0]?.state, 'sent');
  assert.ok(detail.sends[0]?.receipt);
  const serialized = JSON.stringify({ first, older, detail });
  for (const value of ['hidden-system-prompt', 'hidden-thoughts', 'protocol', 'draft', 'arguments']) assert.ok(!serialized.includes(value));
  assert.throws(() => reader.recent(1000));
  assert.throws(() => reader.recent(1, -1));
  assert.equal(reader.detail('missing'), undefined);
});

test('inspection status and bounded sanitized logs reflect lifecycle, reject stale cursors and resist mutation', async t => {
  let connection = 'connected';
  const adapter = Object.assign(new FakeAdapter(), { connectionStatus: () => connection });
  const app = await createApp(config(), { adapter, model: new FakeModel(), secrets: ['secret-value'] });
  t.after(() => app.stop());
  const inspection = app.ctx.inspection;
  assert.equal(inspection.status().state, 'ready');
  emitLog(app.ctx, { code: 'qq_connected' });
  assert.equal(inspection.status().connection, 'connected');
  connection = 'disconnected';
  assert.equal(inspection.status().connection, 'disconnected');
  for (let i = 0; i < 600; i++) emitLog(app.ctx, { code: 'test', preview: 'secret-value', step: i });
  const page = inspection.logs(1);
  assert.equal(page.items.length, 500);
  assert.equal(page.reset, true);
  assert.ok(!JSON.stringify(page).includes('secret-value'));
  page.items[0]!.entry.preview = 'mutated';
  assert.ok(!JSON.stringify(inspection.logs()).includes('mutated'));
  assert.equal(inspection.logs(page.cursor).items.length, 0);
  assert.equal(inspection.logs(page.cursor + 1).reset, true);
  assert.throws(() => inspection.logs(-1));
});

test('panel handler enforces local Host, same-origin, read-only methods and bounded queries without exposing files', async t => {
  const app = await createApp(config(), { adapter: new FakeAdapter(), model: new FakeModel() });
  t.after(() => app.stop());
  const request = await handler(app.ctx.inspection);
  const status = await request('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.json().model, 'deepseek-flash');
  assert.equal((await request('/api/usage?range=7d&purpose=proactive')).status, 200);
  assert.equal((await request('/api/usage?range=invalid')).status, 400);
  assert.equal((await request('/api/usage?provider=invalid')).status, 400);
  assert.equal((await request('/api/usage?before=0')).status, 400);
  assert.equal(status.headers['Cache-Control'], 'no-store');
  assert.ok(status.headers['Content-Security-Policy']?.includes("frame-ancestors 'none'"));
  assert.equal((await request('/api/status', 'GET', { host: 'attacker.example:18080' })).status, 403);
  assert.equal((await request('/api/status', 'GET', { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/status', 'GET', { 'sec-fetch-site': 'cross-site' })).status, 403);
  const lan = await handler(app.ctx.inspection, ['192.168.31.97:18080']);
  assert.equal((await lan('/api/status', 'GET', { host: '192.168.31.97:18080' })).status, 200);
  assert.equal((await lan('/api/status', 'GET', { host: '192.168.31.98:18080' })).status, 403);
  assert.equal((await lan('/api/status', 'GET', { host: '192.168.31.97:18080', origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/status', 'POST')).status, 405);
  for (const url of ['/api/turns?limit=0', '/api/turns?limit=101', '/api/turns?before=0', '/api/logs?after=-1', '/api/turns?failures=bad']) assert.equal((await request(url)).status, 400);
  for (const url of ['/.env', '/../../config.local.json', '/api/config', '/api/turns/../../.env']) assert.equal((await request(url)).status, 404);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('小狼'));
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/style.css')).status, 200);
});

test('panel Key protects pages and APIs, uses an opaque HTTPS session and revokes it on logout', async () => {
  const module = await import(pathToFileURL(resolve('examples/plugins/panel/index.mjs')).href);
  const key = 'a'.repeat(64), host = 'nas.example.com:48393';
  let writes = 0, cancelled = 0, learned = 0;
  const handle = module.createHandler({ status: () => ({ state: 'ready' }) }, {
    view: () => ({ revision: 'one' }), save: () => { writes++; return { revision: 'two' }; },
  }, { allowedHosts: [host], auth: { keyHash: createHash('sha256').update(key).digest('hex') },
    persona: { list: () => ({ items: [], status: {} }), learn: async () => { learned++; } },
    reminders: { list: () => ({ items: [], total: 0 }), cancel: () => { cancelled++; return { state: 'cancelled' }; } } });
  async function request(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, encrypted = true) {
    let status = 0, text = '', outputHeaders: Record<string, string> = {};
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      url, method, headers: { host, ...headers }, socket: { encrypted, remoteAddress: 'test' },
    });
    await handle(req, { writeHead(code: number, values: Record<string, string>) { status = code; outputHeaders = values; }, end(value: string) { text = String(value); } });
    return { status, text, headers: outputHeaders, json: () => JSON.parse(text) };
  }
  assert.ok((await request('/')).text.includes('访问验证'));
  for (const path of ['/api/status', '/api/settings', '/api/turns', '/api/memory', '/api/reminders', '/api/persona', '/app.js']) assert.equal((await request(path)).status, 401);
  const post = { origin: `https://${host}`, 'content-type': 'application/json' };
  assert.equal((await request('/api/auth/session', 'POST', { key }, { ...post, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/auth/session', 'POST', { key }, post, false)).status, 403);
  assert.equal((await request('/api/status', 'GET', undefined, { 'x-forwarded-proto': 'https' }, false)).status, 426);
  assert.equal((await request('/api/auth/session', 'POST', { key: 'wrong'.repeat(10) }, post)).status, 401);
  const login = await request('/api/auth/session', 'POST', { key }, post);
  assert.equal(login.status, 200);
  assert.match(login.headers['Set-Cookie']!, /HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!login.text.includes(key) && !login.headers['Set-Cookie']!.includes(key));
  const cookie = login.headers['Set-Cookie']!.split(';')[0]!;
  assert.equal((await request('/api/status', 'GET', undefined, { cookie })).status, 200);
  assert.ok((await request('/', 'GET', undefined, { cookie })).text.includes('plugin-navigation'));
  const settings = (await request('/api/settings', 'GET', undefined, { cookie })).json();
  assert.equal((await request('/api/settings/model', 'POST', {}, { ...post, cookie })).status, 403);
  assert.equal((await request('/api/settings/model', 'POST', {}, { ...post, cookie, 'x-xiaolang-token': settings.writeToken })).status, 200);
  assert.equal(writes, 1);
  assert.equal((await request('/api/reminders', 'GET', undefined, { cookie })).status, 200);
  assert.equal((await request('/api/reminders/cancel', 'POST', { id: 'test' }, { ...post, cookie })).status, 403);
  assert.equal(cancelled, 0);
  assert.equal((await request('/api/reminders/cancel', 'POST', { id: 'test' }, { ...post, cookie, 'x-xiaolang-token': settings.writeToken })).status, 200);
  assert.equal(cancelled, 1);
  assert.equal((await request('/api/persona/learn', 'POST', {}, { ...post, cookie })).status, 403);
  assert.equal(learned, 0);
  assert.equal((await request('/api/persona/learn', 'POST', {}, { ...post, cookie, 'x-xiaolang-token': settings.writeToken })).status, 202);
  assert.equal(learned, 1);
  assert.equal((await request('/api/auth/logout', 'POST', {}, { ...post, cookie })).status, 200);
  assert.equal((await request('/api/status', 'GET', undefined, { cookie })).status, 401);
  handle.close();
});

test('panel sessions expire and repeated invalid Keys are rate limited without trusting forwarded addresses', async () => {
  const module = await import(pathToFileURL(resolve('examples/plugins/panel/security.mjs')).href);
  const key = 'b'.repeat(64), hash = createHash('sha256').update(key).digest('hex');
  let clock = 1000;
  const access = module.createAccess({ keyHash: hash, sessionHours: 1 }, () => clock);
  async function request(path: string, body?: unknown, cookie?: string) {
    let status = 0, headers: Record<string, string> = {}, data: unknown;
    await access.handle({ method: body ? 'POST' : 'GET', headers: { host: 'nas:1234', origin: 'https://nas:1234', 'content-type': 'application/json', cookie, 'x-forwarded-for': String(clock) }, socket: { encrypted: true, remoteAddress: 'same-peer' }, resume() {} },
      new URL(path, 'https://nas:1234'), (code: number, value: unknown, _type: unknown, extra: Record<string, string> = {}) => { status = code; data = value; headers = extra; }, async () => body);
    return { status, data, headers };
  }
  const login = await request('/api/auth/session', { key });
  const cookie = login.headers['Set-Cookie']!.split(';')[0];
  assert.equal((await request('/api/status', undefined, cookie)).status, 0);
  clock += 3600001;
  assert.equal((await request('/api/status', undefined, cookie)).status, 401);
  for (let n = 0; n < 10; n++) assert.equal((await request('/api/auth/session', { key: 'bad' })).status, 401);
  const limited = await request('/api/auth/session', { key });
  assert.equal(limited.status, 429); assert.equal(limited.headers['Retry-After'], '900');
  clock += 900001;
  assert.equal((await request('/api/auth/session', { key })).status, 200);
  access.close();
});

test('separate LAN HTTP access keeps Key checks and write tokens, isolates cookies and rejects public peers', async () => {
  const module = await import(pathToFileURL(resolve('examples/plugins/panel/index.mjs')).href);
  const key = 'c'.repeat(64), host = '192.168.31.97:18081', auth = { keyHash: createHash('sha256').update(key).digest('hex') };
  let writes = 0;
  const inspect = { status: () => ({ state: 'ready' }) }, configuration = { view: () => ({ revision: 'one' }), save: () => { writes++; return { revision: 'two' }; } };
  const lan = module.createHandler(inspect, configuration, { allowedHosts: [host], auth, privateHttp: true });
  const publicHandler = module.createHandler(inspect, configuration, { allowedHosts: [host], auth });
  async function request(handle: typeof lan, path: string, method = 'GET', body?: unknown, cookie?: string, peer = '::ffff:192.168.31.20') {
    let status = 0, headers: Record<string,string> = {}, text = '';
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { url: path, method,
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json', cookie, 'x-forwarded-for': '192.168.31.20' }, socket: { encrypted: false, remoteAddress: peer } });
    await handle(req, { writeHead(code: number, values: Record<string,string>) { status = code; headers = values; }, end(value: string) { text = String(value); } });
    return { status, headers, text };
  }
  try {
    assert.equal((await request(lan,'/api/status')).status,401);
    assert.equal((await request(lan,'/api/status','GET',undefined,undefined,'203.0.113.5')).status,403);
    assert.equal((await request(publicHandler,'/api/status')).status,426);
    const login=await request(lan,'/api/auth/session','POST',{key});assert.equal(login.status,200);
    assert.match(login.headers['Set-Cookie']!,/^xiaolang-lan-session=/);assert.ok(!login.headers['Set-Cookie']!.includes('Secure'));
    const cookie=login.headers['Set-Cookie']!.split(';')[0];
    assert.equal((await request(lan,'/api/status','GET',undefined,cookie)).status,200);
    assert.equal((await request(lan,'/api/settings/model','POST',{},cookie)).status,403);assert.equal(writes,0);
    assert.equal((await request(lan,'/api/auth/logout','POST',{},cookie)).status,200);
    assert.equal((await request(lan,'/api/status','GET',undefined,cookie)).status,401);
  } finally { lan.close();publicHandler.close(); }
});
