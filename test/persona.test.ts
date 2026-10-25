import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup as personaCleanup } from '../src/persona-cleanup.js';
import { PersonaLearning } from '../src/persona.js';
import { personaDefaults, personaSchema } from '../src/persona-config.js';
import { ConfigurationStore } from '../src/configuration.js';
import { SqliteStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import type { Message, ThinkingLevel } from '../src/contracts.js';
import { config, event, FakeAdapter, FakeModel, deferred } from './fixtures.js';
import { writeFile, rm } from 'node:fs/promises';

function setup(model = new FakeModel(), path = ':memory:', level: ThinkingLevel = 'low', excludedUserIds: string[] = []) {
  const cfg = config(); cfg.database = path; cfg.character = { ...personaDefaults, learningThinking: level, excludedUserIds };
  const ctx = new Context(), store = new SqliteStore(path, new Map([['persona', personaCleanup]])); ctx.provide('store', store);
  let now = 1800000000000;
  const learning = new PersonaLearning(ctx, cfg, model, () => now);
  const add = (text: string, user = 'A') => store.admit({ ...event(text, store.records({ limit: 500 }).length + 1, 'G', user), key: `k${store.records({ limit: 500 }).length + 1}`, platform: 'mock', session: 'G', text, seq: 0 } as Message)!;
  const addPairs = () => { add('你好可爱'); add('哼，也就一点点吧', 'B'); add('你真厉害'); add('那当然啦', 'B'); };
  return { ctx, cfg, store, learning, add, addPairs, advance: () => { now += 31 * 60_000; }, close: async () => { await learning.stop(); learning.close(); store.close(); await ctx.fiber.dispose(); } };
}
const answer = (text = '语气放松，措辞随聊天自然变化。不为了接话刻意补上一句反问。', sources = [2, 4]) => ({ role: 'assistant' as const, content: JSON.stringify({ text, sources }) });
const unchanged = () => ({ role: 'assistant' as const, content: '{"unchanged":true}' });

test('learning revises one supplement and injects its full text for every topic without another model call', async () => {
  const text = '真实表达示例与措辞参考。'.repeat(200), model = new FakeModel(async () => answer(text)), s = setup(model);
  try {
    s.addPairs(); await s.learning.learn();
    const data = s.learning.list(); assert.equal(data.document.text, text); assert.equal(data.document.version, 2);
    for (const message of [s.add('租房'), s.add('下雨了'), s.add('你真厉害')]) {
      const parts = s.learning.promptParts(message);
      assert.equal(parts.reference, `学习补充（表达参考资料）：\n${text}`);
      assert.ok(!parts.instructions.includes(text));
    }
    assert.equal(model.requests.length, 1); assert.equal(s.cfg.character!.anchor, personaDefaults.anchor);
    assert.throws(() => s.learning.mutate({ action: 'update', version: 2, text: '文字', enabled: true, anchor: '变成人' }), { code: 'invalid_persona_request' });
  } finally { await s.close(); }
});

test('a later batch receives the existing supplement, can replace it or leave it unchanged, and advances its cursor once', async () => {
  let call = 0;
  const model = new FakeModel(async () => ++call === 1 ? answer() : unchanged()), s = setup(model);
  try {
    s.addPairs(); await s.learning.learn(); const before = s.learning.list().document;
    s.addPairs(); s.advance(); await s.learning.learn();
    assert.equal(JSON.parse(model.requests[1]![1]!.content!).existing, before.text);
    assert.deepEqual(s.learning.list().document, before); assert.equal(s.learning.status().cursor, 8);
    assert.equal(s.learning.status().dailyCalls, 2);
    await assert.rejects(s.learning.learn(), { code: 'persona_rate_limited' });
  } finally { await s.close(); }
});

test('manual saves and rollback are versioned; a draft edit wins over in-flight learning', async () => {
  const gate = deferred<void>(); let call = 0;
  const model = new FakeModel(async () => { if (++call === 2) { await gate.promise; return answer('自动覆盖', [6,8]); } return answer(); });
  const s = setup(model);
  try {
    s.addPairs(); await s.learning.learn(); s.addPairs(); s.advance(); const pending = s.learning.learn();
    s.learning.mutate({ action: 'update', version: 2, text: '手动保留的措辞', enabled: false });
    gate.resolve(); await assert.rejects(pending, { code: 'persona_conflict' });
    assert.equal(s.learning.list().document.text, '手动保留的措辞'); assert.equal(s.learning.promptParts(s.store.record(1)!.message).reference, '');
    assert.throws(() => s.learning.mutate({ action: 'rollback', version: 2, targetVersion: 2 }), { code: 'persona_conflict' });
    s.learning.mutate({ action: 'rollback', version: 3, targetVersion: 2 });
    assert.equal(s.learning.list().document.version, 4); assert.match(s.learning.prompt(s.store.record(1)!.message), /语气放松/);
  } finally { gate.resolve(); await s.close(); }
});

test('invalid source, schema or oversized output leaves both supplement and processing cursor intact', async () => {
  for (const result of [answer('虚构来源',[99]),answer('机器人自身措辞',[5]),answer('a'.repeat(6001)),
    { role:'assistant' as const, content:'{"text":"bad","sources":[2],"anchor":"覆盖主人格"}' }]) {
    const s = setup(new FakeModel(async () => result));
    try {
      s.addPairs(); const turn=s.store.createTurn(s.store.record(3)!.message,'keyword'); s.store.delivered(turn,'自己的回答',[],['r']);
      await assert.rejects(s.learning.learn(), { code:'invalid_persona_result' });
      assert.equal(s.learning.status().cursor,0); assert.equal(s.learning.status().dailyCalls,1); assert.equal(s.learning.list().document.version,1);
    } finally { await s.close(); }
  }
});

test('legacy cards remain archived with their quota and cursor; no old answering rules are injected', async () => {
  const root=mkdtempSync(join(tmpdir(),'xiaolang-persona-v2-')),path=join(root,'chat.sqlite'); let s=setup(undefined,path);
  try {
    s.addPairs(); const raw=new DatabaseSync(path);
    raw.prepare('INSERT INTO persona_styles VALUES (?,?)').run('old',JSON.stringify({rule:'遇到设备问题先追问型号'}));
    raw.prepare('UPDATE persona_state SET payload=? WHERE key=?').run(JSON.stringify({cursor:4,lastAttempt:0,day:'',calls:0,revision:7}),'learning');raw.close();
    await s.close();s=setup(undefined,path);
    assert.equal(s.learning.status().legacyCount,1);assert.equal(s.learning.status().cursor,4);
    assert.equal(s.learning.promptParts(s.store.record(1)!.message).reference,'');
    s.learning.mutate({action:'update',version:1,text:'新的表达补充',enabled:true});await s.close();s=setup(undefined,path);
    assert.equal(s.learning.list().document.text,'新的表达补充');
  } finally { await s.close();rmSync(root,{recursive:true,force:true}); }
});

test('source exclusions affect new material and prevent injection of previously learned bot-derived text', async () => {
  const root=mkdtempSync(join(tmpdir(),'xiaolang-persona-source-')),path=join(root,'chat.sqlite');let s=setup(new FakeModel(async()=>answer()),path);
  try {
    s.addPairs();await s.learning.learn();await s.close();
    const model=new FakeModel(async()=>unchanged());s=setup(model,path,'low',['B']);
    assert.equal(s.learning.promptParts(s.store.record(1)!.message).reference,'');s.addPairs();s.advance();await s.learning.learn();
    const input=JSON.parse(model.requests[0]![1]!.content!);
    assert.equal(input.existing,'');assert.ok(input.conversation.every((row:{user:string})=>row.user!=='B'));
  } finally { await s.close();rmSync(root,{recursive:true,force:true}); }
});

test('erasing source chats also erases derived supplement versions, including when the plugin is stopped', async () => {
  const root=mkdtempSync(join(tmpdir(),'xiaolang-persona-delete-')),path=join(root,'chat.sqlite'),s=setup(new FakeModel(async()=>answer()),path);
  try {
    s.addPairs();await s.learning.learn();const message=s.store.record(2)!;
    const conversation=s.store.conversations().items[0]!;await s.learning.stop();
    s.store.deleteData({kind:'message',id:conversation.id,seq:message.seq});
    assert.equal(s.learning.list().document.text,'');
    assert.ok(s.learning.detail('supplement').versions.every((v:{text:string})=>!v.text.includes('语气放松')));
    assert.ok(s.store.record(1));
  } finally { await s.close();rmSync(root,{recursive:true,force:true}); }
});

test('ordinary replies include the full supplement locally and never invoke the learning model', async () => {
  const cfg=config();cfg.character=structuredClone(personaDefaults);
  const adapter=new FakeAdapter(),model=new FakeModel(),learner=new FakeModel(),app=await createApp(cfg,{adapter,model,personaModel:learner});
  try {
    app.ctx.persona.mutate({action:'update',version:1,text:'措辞参考完整带入',enabled:true});
    adapter.receive!(event('小狼你好'));await app.ctx.chat.idle();
    assert.equal(adapter.sent.length,1);assert.equal(learner.requests.length,0);
    assert.ok(JSON.stringify(model.requests[0]).includes('措辞参考完整带入'));
  } finally { await app.stop(); }
});

test('all learning thinking levels retain bounded requests and a persisted daily quota', async () => {
  for (const level of ['off','low','high','max'] as const) {
    const model=new FakeModel(async()=>unchanged()),s=setup(model,':memory:',level);
    try { s.addPairs();await s.learning.learn();assert.equal(model.options[0]?.thinking,level!=='off');assert.equal(model.options[0]?.maxOutputTokens,level==='off'?4096:8192);assert.equal(model.options[0]?.timeoutMs,60000); }
    finally { await s.close(); }
  }
});

test('persona plugin settings persist through the existing apply workflow and preserve a legacy custom anchor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaolang-persona-settings-')), path = join(root, 'config.json');
  try {
    const cfg = config(); cfg.database = join(root, 'chat.sqlite'); cfg.persona = '原本自己设定的人设';
    await writeFile(path, JSON.stringify(cfg));
    const settings = await ConfigurationStore.load(path, () => {}, () => true, {});
    settings.bindPlugins(() => [{ id: 'xiaolang-persona', title: '人设与学习', kind: 'builtin', module: 'src/persona.ts', state: 'active', dependencies: [], provides: ['persona'] }]);
    settings.registerPlugin('xiaolang-persona', personaSchema);
    const before = await settings.plugin('xiaolang-persona'); assert.equal((before.config as Record<string, unknown>).anchor, cfg.persona);
    await settings.savePlugin('xiaolang-persona', { revision: before.revision, config: personaDefaults });
    const next = await ConfigurationStore.load(path, () => {}, () => true, {});
    assert.equal(next.config.character?.anchor, personaDefaults.anchor); assert.equal(next.config.character?.learningEnabled, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
