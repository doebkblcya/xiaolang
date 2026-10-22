import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app.js';
import { registerPanel } from '../src/panel.js';
import { config, FakeAdapter, FakeModel } from './fixtures.js';

test('sidebar pages belong to their plugins, preserve catalog order, and disabled plugin declarations do not execute code', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaolang-panel-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'custom/panel'), { recursive: true });
  await writeFile(join(directory, 'custom/index.mjs'), 'throw new Error("must not activate");');
  await writeFile(join(directory, 'custom/panel/page.js'), 'export function mount() {}');
  await writeFile(join(directory, 'custom/xiaolang.plugin.json'), JSON.stringify({ dependencies: ['store'], panel: {
    detail: { entry: './panel/page.js' }, pages: [{ id: 'custom-page', title: '自定义页面', entry: './panel/page.js' }],
  } }));
  const settings = config(); settings.plugins = { directory, entries: [{ id: 'custom', module: './custom/index.mjs', enabled: false }] };
  const app = await createApp(settings, { adapter: new FakeAdapter(), model: new FakeModel() });
  t.after(() => app.stop());
  const { createPanelRegistry } = await import(pathToFileURL(resolve('examples/plugins/panel/registry.mjs')).href);
  const registry = createPanelRegistry(app.ctx.runtime, app.ctx.xiaolangHost.panels);
  const data = registry.describe();
  assert.deepEqual(data.pages.slice(0, 3).map((page: { id: string }) => page.id), ['xiaolang-logging:logs', 'xiaolang-store:chats', 'xiaolang-usage:usage']);
  assert.equal(data.pages.at(-1).id, 'custom:custom-page');
  assert.equal(data.pages.at(-1).state, 'disabled');
  assert.deepEqual(app.ctx.runtime.status().plugins.find(plugin => plugin.id === 'custom')?.dependencies, ['store']);
  assert.equal(data.details.custom.entry, '/api/panel/assets/custom/page.js');
  assert.ok(!JSON.stringify(data).includes(directory));
  assert.equal((await registry.asset('custom', 'page.js')).body.toString(), 'export function mount() {}');
  await writeFile(join(directory, 'secret.js'), 'secret');
  await symlink(join(directory, 'secret.js'), join(directory, 'custom/panel/escape.js'));
  assert.equal(await registry.asset('custom', 'escape.js'), undefined);
  assert.equal(await registry.asset('custom', '../secret.js'), undefined);
  assert.equal(await registry.asset('custom', 'page.json'), undefined);
});

test('panel declarations reject ambiguous content, duplicate pages, and executable paths outside panel assets', () => {
  const registry = new Map();
  for (const definition of [
    { pages: [{ id: 'bad', title: 'bad', entry: '../secret.js' }] },
    { detail: { view: 'chats', entry: './panel/page.js' } },
    { pages: [{ id: 'same', title: 'A', view: 'chats' }, { id: 'same', title: 'B', view: 'logs' }] },
    { pages: [{ id: 'bad', title: '', view: 'chats' }] },
  ]) assert.throws(() => registerPanel(registry, 'custom', definition, '/plugins/custom'), { code: 'invalid_plugin_panel' });
  registerPanel(registry, 'custom', { pages: [{ id: 'good', title: '示例', entry: './panel/page.js' }] }, '/plugins/custom');
  assert.equal(registry.get('custom')?.definition.pages?.[0]?.title, '示例');
});

test('panel-only metrics report the current process against physical memory without observing other processes', async () => {
  const { createSystemCollector } = await import(pathToFileURL(resolve('examples/plugins/panel/system.mjs')).href);
  const collect = createSystemCollector();
  const sample = await collect();
  assert.ok(sample.machine.memoryTotal > 0);
  assert.ok(sample.process.memoryBytes > 0);
  assert.equal(sample.process.memoryPercent, sample.process.memoryBytes / sample.machine.memoryTotal * 100);
  assert.ok(sample.process.cpuPercent >= 0 && sample.process.cpuPercent <= 100);
  assert.equal(sample.process.nodeVersion, process.version);
  assert.equal(sample.processes, undefined);
  assert.equal(await collect(), sample);
});
