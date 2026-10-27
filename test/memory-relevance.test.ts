import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../src/memory-store.js';
import { memoryDefaults } from '../src/memory-config.js';
import { ChatMemory } from '../src/memory.js';
import { contextSize } from '../src/context-budget.js';
import { createApp } from '../src/app.js';
import { config, event, FakeAdapter, FakeModel, deferred } from './fixtures.js';
const vector = (x: number) => [x, Math.sqrt(1-x*x), ...Array(62).fill(0)] as number[];

test('memory retrieval rejects weak vectors and conversational glue instead of filling the recall quota', () => {
  const db = new MemoryRepository(':memory:', {...memoryDefaults, embeddingDimensions:64});
  try {
    const item = db.write({content:'用户甲使用一台3D打印机。',kind:'profile',people:['A'],sources:[1],importance:3})!;
    db.index(item, vector(.3));
    assert.deepEqual(db.candidates('隔壁楼房租便宜五百', ['A'], vector(1)), []);
    assert.deepEqual(db.candidates('我觉得这个就是这样', ['A']), []);
    assert.equal(db.candidates('我是谁', ['A'])[0]!.id, item.id);
    assert.equal(db.candidates('3D打印机', ['other'])[0]!.id, item.id);
    db.index(item, vector(.8));
    assert.equal(db.candidates('立体成型设备', ['other'], vector(1))[0]!.id,item.id);
  } finally { db.close(); }
});

test('the full saved summary, including its tail, reaches the next prompt without another model request', async () => {
  const cfg=config(); cfg.chatEnabled=false;cfg.memory={...memoryDefaults,enabled:true};
  const app=await createApp(cfg,{adapter:new FakeAdapter(),model:new FakeModel(),memoryModel:new FakeModel(async()=>({role:'assistant',content:'{"memories":[]}'}))});
  try {
    app.ctx.intake.receive(event('旧消息',1));app.ctx.intake.receive(event('新问题',2));
    const message=app.ctx.store.records({limit:1})[0]!.message;
    const memory=app.ctx.memory as ChatMemory, body='较早资料。'.repeat(380)+'末尾约定：下周一起去书店，尚未确认时间。';
    memory.repository.setSummary(message.session,1,body);
    const prepared=(await memory.prepare({id:randomUUID(),message,reason:'test'},new AbortController().signal))!;
    assert.ok(prepared.parts.summary.endsWith('末尾约定：下周一起去书店，尚未确认时间。'));
    assert.equal(memory.summary(message.session).summary!.prompt,prepared.parts.summary);
  } finally { await app.stop(); }
});

test('oversized summaries never advance the cursor or discard original history', async () => {
  const cfg=config();cfg.chatEnabled=false;cfg.memory={...memoryDefaults,enabled:true};
  const background=new FakeModel(async m=>({role:'assistant',content:(m[0]!.content!.startsWith('将旧摘要')||m[0]!.content!.startsWith('压缩这份'))?'长'.repeat(3201):'{"memories":[]}'}));
  const app=await createApp(cfg,{adapter:new FakeAdapter(),model:new FakeModel(),memoryModel:background});
  try {
    for(let i=1;i<=201;i++)app.ctx.intake.receive(event('聊天'+i,i));
    const message=app.ctx.store.records({limit:1})[0]!.message,turn={id:randomUUID(),message,reason:'test'};
    const memory=app.ctx.memory as ChatMemory,prepared=(await memory.prepare(turn,new AbortController().signal))!;
    await memory.compact(turn,prepared,{used:contextSize(prepared.history,cfg.limits)+1000,budget:80000,overhead:1000},new AbortController().signal);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(memory.summary(message.session).summary,null);assert.equal(memory.status().summaryError,'memory_summary_too_long');
    assert.equal(app.ctx.store.records({limit:500}).length,201);
  } finally { await app.stop(); }
});

test('an overfull turn resumes at the first committed prefix while later compaction batches remain pending', async () => {
  const cfg=config();cfg.chatEnabled=false;delete cfg.limits.contextTokens;cfg.limits.contextChars=9000;
  cfg.memory={...memoryDefaults,enabled:true,recentMessages:5};
  const first=deferred<{role:'assistant';content:string}>(),later=deferred<{role:'assistant';content:string}>();let calls=0;
  const background=new FakeModel(async messages=>messages[0]!.content!.startsWith('将旧摘要')?(++calls===1?first.promise:later.promise):{role:'assistant',content:'{"memories":[]}'});
  const app=await createApp(cfg,{adapter:new FakeAdapter(),model:new FakeModel(),memoryModel:background});
  try {
    for(let i=1;i<=61;i++)app.ctx.intake.receive(event('原始长消息。'.repeat(25),i));
    const message=app.ctx.store.records({limit:1})[0]!.message,turn={id:randomUUID(),message,reason:'test'};
    const memory=app.ctx.memory as ChatMemory,prepared=(await memory.prepare(turn,new AbortController().signal))!;
    const used=contextSize(prepared.history,cfg.limits)+1000,budget=used-100;
    const pending=memory.compact(turn,prepared,{used,budget,overhead:1000},AbortSignal.timeout(2000));
    await new Promise<void>(resolve=>setImmediate(resolve));
    first.resolve({role:'assistant',content:'先前聊过一些长消息，原始消息仍完整保存。'});
    const result=await pending;
    assert.ok(calls>=2);assert.ok(result.history.length>5);assert.ok(result.history.length<60);
    assert.ok(contextSize(result.history,cfg.limits)+contextSize(result.parts!.summary,cfg.limits)+1000<budget);
  } finally { first.resolve({role:'assistant',content:'摘要'});later.resolve({role:'assistant',content:'完整摘要'});await app.stop(); }
});


test('a too-long summary is shortened once using only its draft before saving the compacted prefix', async () => {
  const cfg=config();cfg.chatEnabled=false;cfg.memory={...memoryDefaults,enabled:true};
  let summaries=0,repairs=0;
  const background=new FakeModel(async messages=>{
    if(messages[0]!.content!.startsWith('将旧摘要')) { summaries++;return {role:'assistant',content:'长'.repeat(3201)}; }
    if(messages[0]!.content!.startsWith('压缩这份')) { repairs++;assert.equal(messages[1]!.content,'长'.repeat(3201));return {role:'assistant',content:'保留关键事实与未完成事项。'}; }
    return {role:'assistant',content:'{"memories":[]}'};
  });
  const app=await createApp(cfg,{adapter:new FakeAdapter(),model:new FakeModel(),memoryModel:background});
  try {
    for(let i=1;i<=201;i++)app.ctx.intake.receive(event('聊天'+i,i));
    const message=app.ctx.store.records({limit:1})[0]!.message,turn={id:randomUUID(),message,reason:'test'};
    const memory=app.ctx.memory as ChatMemory,prepared=(await memory.prepare(turn,new AbortController().signal))!;
    await memory.compact(turn,prepared,{used:contextSize(prepared.history,cfg.limits)+1000,budget:80000,overhead:1000},new AbortController().signal);
    for(let i=0;i<20&&!memory.summary(message.session).summary;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(memory.summary(message.session).summary!.body,'保留关键事实与未完成事项。');
    assert.equal(summaries,1);assert.equal(repairs,1);assert.equal(app.ctx.store.records({limit:500}).length,201);
  } finally { await app.stop(); }
});
