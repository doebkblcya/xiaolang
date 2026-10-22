import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/store.js';
import { normalize } from '../src/messages.js';
import { createApp } from '../src/app.js';
import { config, event, FakeAdapter, FakeModel } from './fixtures.js';
const adapter = new FakeAdapter();
function admit(db: SqliteStore, text: string, id: number, group: string | null = 'G', user = 'A') {
  return db.admit(normalize(event(text, id, group, user), adapter, [])!)!;
}

test('conversation history includes untriggered messages, separates group/private and exposes only confirmed reply content', () => {
  const db = new SqliteStore(':memory:');
  try {
    admit(db, '旁听消息', 1); const called = admit(db, '小狼你好', 2, 'G', 'B');
    admit(db, '私聊', 3, null); admit(db, '别的群', 4, 'G2');
    const turn = db.createTurn(called, 'keyword'); db.draft(turn.id, 'hidden-draft', [{ role: 'assistant', content: 'secret-thinking' }]);
    db.prepareSend(turn.id, ['你好。', '今天怎么样？']);
    db.confirmSend(turn, 0, 'receipt-1', '你好。', [{ role: 'assistant', content: '你好。', reasoning_content: 'hidden-thoughts' }], ['receipt-1']);
    const groups = db.conversations('', 'group').items, privateChats = db.conversations('', 'private').items;
    assert.equal(groups.length, 2); assert.equal(privateChats.length, 1); assert.equal(db.conversations().items.length, 3);
    const main = groups.find(x => x.recipient === 'G')!; const timeline = db.timeline(main.id);
    assert.deepEqual(timeline.items.map(x => x.text), ['旁听消息', '小狼你好', '你好。']);
    assert.equal(timeline.items[0]?.turn, undefined); assert.equal(timeline.items[1]?.turn?.id, turn.id);
    assert.deepEqual(timeline.items[2]?.parts, ['你好。']);
    const serialized = JSON.stringify(timeline);
    for (const text of ['hidden-draft', 'hidden-thoughts', 'secret-thinking', '今天怎么样？']) assert.ok(!serialized.includes(text));
    assert.throws(() => db.conversations('', 'wrong'), { code: 'invalid_history_query' });
    assert.throws(() => db.timeline(main.id, 0), { code: 'invalid_history_query' });
  } finally { db.close(); }
});

test('timeline pagination walks every stored message without duplicates or display truncation', () => {
  const db = new SqliteStore(':memory:');
  try {
    for (let n = 1; n <= 120; n++) admit(db, n === 60 ? '完整原文'.repeat(3000) : `消息${n}`, n);
    const id = db.conversations().items[0]!.id, seqs: number[] = []; let before: number | undefined;
    do { const page = db.timeline(id, before); seqs.push(...page.items.map(x => x.seq)); if (page.next === null) break; before = page.next; } while (true);
    assert.equal(seqs.length, 120); assert.equal(new Set(seqs).size, 120); assert.equal(db.timeline(id, 71).items.find(x => x.seq === 60)?.text.length, 12000);
  } finally { db.close(); }
});

test('legacy messages acquire stable conversations, alias edits persist and conflicting edits are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaolang-conversation-')), path = join(root, 'chat.sqlite');
  try {
    let db = new SqliteStore(path); admit(db, '老记录', 1); const id = db.conversations().items[0]!.id; db.close();
    const old = new DatabaseSync(path); old.exec('DROP TABLE chat_sessions'); old.close();
    db = new SqliteStore(path); assert.equal(db.conversations().items[0]!.id, id);
    db.renameConversation(id, '我的测试群', 0);
    assert.equal(db.conversations('测试群').items[0]?.alias, '我的测试群');
    assert.throws(() => db.renameConversation(id, '覆盖', 0), { code: 'conversation_conflict' });
    db.close(); db = new SqliteStore(path); assert.equal(db.conversations().items[0]?.version, 1);
    db.renameConversation(id, '', 1); assert.equal(db.conversations().items[0]?.alias, ''); db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conversation endpoints use existing write authorization and aliases take effect without restarting', async () => {
  const cfg = config(); cfg.chatEnabled = false;
  const app = await createApp(cfg, { adapter: new FakeAdapter(), model: new FakeModel() });
  const { createHandler } = await import(pathToFileURL(resolve('examples/plugins/panel/index.mjs')).href);
  const handle = createHandler(app.ctx.runtime, { view: () => ({ revision: 'test' }) }, { history: app.ctx.historyReader });
  async function request(url: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) {
    let status = 0, body = '';
    const req = Object.assign(Readable.from(data === undefined ? [] : [JSON.stringify(data)]), { url, method, headers: { host: 'localhost:18080', ...headers } });
    await handle(req, { writeHead(value: number) { status = value; }, end(value: string) { body = String(value); } });
    return { status, data: JSON.parse(body) };
  }
  try {
    app.ctx.intake.receive(event('未触发也应展示', 1));
    const list = await request('/api/conversations?scope=group'); assert.equal(list.status, 200);
    const id = list.data.items[0].id;
    assert.equal((await request(`/api/conversations/${id}`)).data.items[0].text, '未触发也应展示');
    const input = { alias: '工作群', version: 0 };
    assert.equal((await request(`/api/conversations/${id}/name`, 'POST', input)).status, 403);
    const token = (await request('/api/settings')).data.writeToken;
    const headers = { origin: 'http://localhost:18080', 'content-type': 'application/json', 'x-xiaolang-token': token };
    assert.equal((await request(`/api/conversations/${id}/name`, 'POST', input, headers)).status, 200);
    assert.equal((await request('/api/conversations?q=工作')).data.items[0].alias, '工作群');
    assert.equal((await request(`/api/conversations/${id}/name`, 'POST', input, headers)).status, 409);
    assert.equal((await request(`/api/conversations/${id}?before=0`)).status, 400);
    assert.equal((await request(`/api/conversations/${'f'.repeat(64)}`)).status, 404);
    assert.equal((await request('/api/data/delete', 'POST', { kind: 'conversation', id })).status, 403);
    assert.equal((await request('/api/data/delete', 'POST', { kind: 'conversation', id }, headers)).status, 200);
    assert.equal((await request('/api/conversations')).data.items.length, 0);
  } finally { handle.close(); await app.stop(); }
});

test('official display names remain separate from aliases and retain known private names across nameless events', () => {
  const db = new SqliteStore(':memory:');
  try {
    admit(db, '群消息', 1); const group = db.conversations().items[0]!;
    db.renameConversation(group.id, '我的备注', 0);
    db.cacheConversationName(group.id, '官方群名');
    const found = db.conversations('官方群名').items[0]!;
    assert.equal(found.name, '官方群名'); assert.equal(found.alias, '我的备注'); assert.equal(found.version, 1);
    const named = normalize({ ...event('第一条', 2, null, 'P'), name: '小明' }, adapter, [])!; db.admit(named);
    db.admit(normalize({ ...event('第二条', 3, null, 'P'), name: 'P' }, adapter, [])!);
    const privateChat = db.conversations('', 'private').items[0]!;
    assert.equal(privateChat.name, '小明');
    assert.ok(db.timeline(privateChat.id).items.every(item => item.name === '小明' && item.sender === 'P'));
  } finally { db.close(); }
});
