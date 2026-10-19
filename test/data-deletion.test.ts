import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vec from 'sqlite-vec';
import { SqliteStore } from '../src/store.js';
import { MemoryRepository } from '../src/memory-store.js';
import { memoryDefaults } from '../src/memory-config.js';
import { normalize } from '../src/messages.js';
import { event, FakeAdapter } from './fixtures.js';

test('deleting an incoming message removes its reply, traces and memories including superseded versions, without deleting other chats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaolang-delete-')), path = join(root,'chat.sqlite');
  const store = new SqliteStore(path), memory = new MemoryRepository(path, { ...memoryDefaults, embeddingDimensions: 3 });
  const raw = new DatabaseSync(path, { allowExtension: true }); vec.load(raw);
  try {
    const original = normalize(event('旧偏好',1,'G'),new FakeAdapter(),[])!, message=store.admit(original)!;
    const other=store.admit(normalize(event('其他聊天',2,'H'),new FakeAdapter(),[])!)!;
    const turn=store.createTurn(message,'keyword'); store.draft(turn.id,'旧偏好',[{role:'assistant',content:'旧偏好'}]);
    store.prepareSend(turn.id,['回复']); store.confirmSend(turn,0,'receipt','回复',[{role:'assistant',content:'回复'}],['receipt']); store.state(turn.id,'completed');
    let item=memory.write({content:'旧偏好',kind:'profile',people:['A'],sources:[message.seq],importance:3})!;
    item=memory.write({id:item.id,version:item.version,operation:'supersede',content:'新偏好',kind:'profile',people:['A'],sources:[other.seq],importance:3})!;
    memory.index(item,[1,0,0]); memory.setSummary(message.session,message.seq,'包含旧偏好的摘要'); memory.recall(turn.id,{items:[item]});
    const conversation=store.conversations().items.find(x=>x.recipient==='G')!;
    const result=store.deleteData({kind:'message',id:conversation.id,seq:message.seq});
    assert.equal(result.messages,2); assert.equal(result.memories,1); assert.ok(store.record(other.seq)); assert.equal(store.record(message.seq),undefined);
    assert.equal(store.inspectTurn(turn.id),undefined); assert.equal(store.inspectSends(turn.id).length,0); assert.equal(memory.get(item.id),undefined);
    for(const table of ['memory_items','memory_versions','memory_vec','memory_fts','memory_version_fts','memory_recalls','memory_summaries']) assert.equal(Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),0,table);
    assert.equal(store.admit(original),undefined,'late gateway duplicates cannot resurrect erased chat');
    assert.equal(store.conversations().items.length,1);
  } finally { raw.close(); memory.close(); store.close(); await rm(root,{recursive:true,force:true}); }
});

test('manual memory deletion erases text, vector and all versions while keeping source chats and blocking re-extraction', async () => {
  const root=await mkdtemp(join(tmpdir(),'xiaolang-delete-')),path=join(root,'chat.sqlite');
  const store=new SqliteStore(path),memory=new MemoryRepository(path,{...memoryDefaults,embeddingDimensions:3});
  const raw=new DatabaseSync(path,{allowExtension:true});vec.load(raw);
  try {
    const message=store.admit(normalize(event('不想再记住的事',1),new FakeAdapter(),[])!)!;
    const item=memory.write({content:'要忘记的记忆',kind:'event',people:['A'],sources:[message.seq],importance:3})!;memory.index(item,[1,0,0]);
    assert.throws(()=>store.deleteData({kind:'memory',id:item.id,version:99}),{code:'memory_conflict'});assert.ok(memory.get(item.id));
    store.deleteData({kind:'memory',id:item.id,version:item.version});assert.ok(store.record(message.seq));assert.ok(memory.suppressed(message.seq));
    assert.equal(raw.prepare('SELECT 1 FROM memory_items WHERE id=?').get(item.id),undefined);
    assert.equal(raw.prepare('SELECT 1 FROM memory_forgotten WHERE content=?').get(item.content),undefined);
    assert.equal(memory.write({content:item.content,kind:'event',people:['A'],sources:[message.seq],importance:3}),undefined);
  } finally {raw.close();memory.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('deleting a learned expression erases every version, protects its source examples and invalidates in-flight learning', async () => {
  const root=await mkdtemp(join(tmpdir(),'xiaolang-delete-')),path=join(root,'chat.sqlite');const store=new SqliteStore(path),raw=new DatabaseSync(path);
  try {
    raw.exec('CREATE TABLE persona_styles(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE persona_versions(id TEXT,version INTEGER,payload TEXT,reason TEXT);CREATE TABLE persona_state(key TEXT PRIMARY KEY,payload TEXT)');
    const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',style={id,version:2,rule:'待删除的表达',examples:[{prompt:1,reply:2}]};
    raw.prepare('INSERT INTO persona_styles VALUES (?,?)').run(id,JSON.stringify(style));
    raw.prepare('INSERT INTO persona_versions VALUES (?,?,?,?)').run(id,1,JSON.stringify({...style,version:1}),'learn');raw.prepare('INSERT INTO persona_state VALUES (?,?)').run('learning',JSON.stringify({revision:3}));
    store.deleteData({kind:'persona',id,version:2});
    assert.equal(raw.prepare('SELECT count(*) AS n FROM persona_styles').get()!.n,0);assert.equal(raw.prepare('SELECT count(*) AS n FROM persona_versions').get()!.n,0);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM persona_suppressed').get()!.n,2);assert.equal(JSON.parse(String(raw.prepare('SELECT payload FROM persona_state').get()!.payload)).revision,4);
    const message=store.admit(normalize(event('正在处理',3),new FakeAdapter(),[])!)!;store.createTurn(message,'keyword');
    assert.throws(()=>store.deleteData({kind:'conversation',id:store.conversations().items[0]!.id}),{code:'data_busy'});assert.ok(store.record(message.seq));
  }finally{raw.close();store.close();await rm(root,{recursive:true,force:true});}
});
