import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { ConfigurationStore } from '../src/configuration.js';
import { builtinTitles, officialIds, officialModule } from '../src/plugin-catalog.js';
import { config, FakeAdapter, FakeModel, event } from './fixtures.js';

test('the runtime image graph contains no external feature implementation', async () => {
  const files = await readdir('dist/host/src');
  for (const name of ['memory.js', 'persona.js', 'model.js', 'trigger.js', 'mcp.js', 'skills.js', 'reminders.js', 'memory-cleanup.js']) assert.ok(!files.includes(name), name);
  for (const id of officialIds) {
    const implementation = await readdir(join('dist/plugins', id, 'impl'));
    assert.ok(implementation.length > 0, id);
    assert.ok(!(await readFile(join('dist/plugins', id, 'index.mjs'), 'utf8')).includes('/dist/src/'));
  }
});

test('disabling any host plugin or default feature leaves the process available; dependencies wait', async () => {
  for (const id of [...Object.keys(builtinTitles), ...officialIds.filter(id => id !== 'xiaolang-adapter')]) {
    const value = config();
    value.plugins = { directory: 'plugins', entries: [{ id, module: id in builtinTitles ? 'builtin:host' : officialModule(id), enabled: false }] };
    const app = await createApp(value, { adapter: new FakeAdapter(), model: new FakeModel() });
    try {
      if (id === 'xiaolang-deepseek') {
        assert.equal(app.ctx.get('model'), undefined);
        assert.equal(app.ctx.get('chat'), undefined);
        assert.equal(app.ctx.inspection.status().state, 'ready');
        assert.ok(app.ctx.inspection.status().plugins.find(item => item.id === 'xiaolang-memory')?.missingDependencies?.includes('model'));
      }
      if (id === 'xiaolang-trigger') assert.equal(app.ctx.get('chat'), undefined);
    } finally { await app.stop(); }
  }
});

test('QQ can be disabled and replaced by another adapter without a host change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-adapter-replace-'));
  try {
    await writeFile(join(directory, 'wechat.mjs'), `export const apply = ctx => ctx.provide('adapter', {platform:'wechat',account:'test',capabilities:{groupMessages:'all',maxTextChars:4000},start(){},stop(){},async reply(){return {id:'ok'}}});`);
    const value = config();
    value.plugins = { directory, entries: [{ id: 'xiaolang-adapter', module: officialModule('xiaolang-adapter'), enabled: false }] };
    let app = await createApp(value, { model: new FakeModel() });
    try {
      assert.equal(app.ctx.inspection.status().state, 'ready');
      assert.equal(app.ctx.inspection.status().connection, 'disabled');
      assert.equal(app.ctx.get('chat'), undefined);
    } finally { await app.stop(); }
    value.plugins.entries.push({ id: 'wechat', module: './wechat.mjs' });
    app = await createApp(value, { model: new FakeModel() });
    try { assert.equal(app.ctx.adapter.platform, 'wechat'); assert.ok(app.ctx.get('chat')); }
    finally { await app.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disabled plugins still clean their derived data; all listed plugins expose writable switches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-plugin-cleanup-'));
  try {
    const value = config(); value.database = join(directory, 'chat.sqlite');
    value.plugins = { directory: 'plugins', entries: [{ id: 'xiaolang-memory', module: officialModule('xiaolang-memory'), enabled: false }] };
    const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(value));
    const configuration = await ConfigurationStore.load(path, () => {}, () => true, {});
    const app = await createApp(configuration.config, { adapter: new FakeAdapter(), model: new FakeModel(), configuration });
    try {
      configuration.bindPlugins(() => app.ctx.inspection.status().plugins);
      for (const plugin of app.ctx.inspection.status().plugins) assert.equal((await configuration.plugin(plugin.id)).canToggle, true, plugin.id);
      app.ctx.intake.receive(event('普通聊天', 7));
      await app.ctx.chat.idle();
      const conversation = app.ctx.historyReader.conversations().items[0]!;
      const result = await app.ctx.inspection.deleteData({ kind: 'conversation', id: conversation.id }) as { messages: number };
      assert.ok(result.messages > 0);
      assert.equal(app.ctx.historyReader.conversations().items.length, 0);
      assert.ok(app.ctx.xiaolangHost.cleanups.has('xiaolang-memory'));
    } finally { await app.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
