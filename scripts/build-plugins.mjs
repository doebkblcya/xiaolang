import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const source = resolve('dist/src'), target = resolve('dist/plugins');
const shared = new Set(['contracts.js', 'errors.js', 'usage.js', 'context-budget.js']);
const packages = [
  ['xiaolang-adapter', 'adapters/qq-official.js', null],
  ['xiaolang-deepseek', 'model.js', null],
  ['xiaolang-trigger', 'trigger.js', 'triggerPlugin'], ['xiaolang-memory', 'memory.js', 'memoryPlugin'],
  ['xiaolang-persona', 'persona.js', 'personaPlugin'], ['xiaolang-web', 'web-tools.js', 'webToolsPlugin'],
  ['xiaolang-mcp', 'mcp.js', 'mcpPlugin'], ['xiaolang-skills', 'skills.js', 'skillsPlugin'],
  ['xiaolang-reminders', 'reminders.js', 'remindersPlugin'], ['xiaolang-clock', 'clock.js', 'clockPlugin'],
  ['xiaolang-basic-tools', 'basic-tools.js', 'basicToolsPlugin'],
];
async function graph(entry, out, bridge = false, visited = new Set()) {
  if (visited.has(entry)) return;
  visited.add(entry);
  const destination = join(out, entry);
  await mkdir(dirname(destination), { recursive: true });
  if (bridge && shared.has(entry)) {
    const path = relative(dirname(destination), join(target, '_runtime.mjs')).replaceAll('\\', '/');
    await writeFile(destination, `export * from ${JSON.stringify(path.startsWith('.') ? path : './' + path)};\n`);
    return;
  }
  let text = await readFile(join(source, entry), 'utf8');
  // No source maps with image-private source paths in standalone distributions.
  text = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  await writeFile(destination, text);
  for (const dependency of ts.preProcessFile(text, true, true).importedFiles) if (dependency.fileName.startsWith('.')) {
    await graph(relative(source, resolve(source, dirname(entry), dependency.fileName)), out, bridge, visited);
  }
}
await mkdir(target, { recursive: true });
await writeFile(join(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
await writeFile(join(target, '_runtime.mjs'), "export * from '../src/plugin-api.js';\n");
const memory = await import('../dist/src/memory-config.js');
const persona = await import('../dist/src/persona-config.js');
const tooling = await import('../dist/src/tooling-config.js');
for (const [id, entry, exported] of packages) {
  const directory = join(target, id);
  await graph(entry, join(directory, 'impl'), true);
  let code;
  if (id === 'xiaolang-deepseek') code = `import { DeepSeekModel } from './impl/model.js';
import { Failure } from '../_runtime.mjs';
export const inject = ['xiaolangHost'];
export const apply = (ctx, settings) => {
 const { config, options } = ctx.xiaolangHost;
 if (!options.model && !options.apiKey) throw new Failure('missing_model_key');
 ctx.provide('model', options.model ?? new DeepSeekModel({...config.model,...settings}, options.apiKey, undefined, ctx.get('usage')));
}`;
  else if (id === 'xiaolang-adapter') code = `export { apply, name } from './impl/adapters/qq-official.js';`;
  else {
    const section = tooling.toolingSections[id];
    let options = 'config';
    let setup = '';
    if (id === 'xiaolang-memory') { setup = 'config.memory = {...config.memory,...settings}; delete config.memory.apiKey;'; options = '{config, apiKey: options.apiKey, embeddingKey: settings.apiKey || options.embeddingKey, model: options.memoryModel, embeddings: options.embeddings, imageFetch: options.imageFetch}'; }
    if (id === 'xiaolang-persona') { setup = 'config.character = {...config.character,...settings};'; options = '{config, apiKey: options.apiKey, model: options.personaModel}'; }
    if (id === 'xiaolang-web') options = '{config, apiKey: options.apiKey, fetcher: options.webFetch}';
    if (section) setup = `config.tooling = {...config.tooling, ${section}: {...config.tooling?.${section},...settings}};`;
    code = `import { ${exported} as plugin } from './impl/${entry}';
export const name = plugin.name;
export const inject = [...(plugin.inject ?? []), 'xiaolangHost'];
export const apply = (ctx, settings) => {
 const { options } = ctx.xiaolangHost;
 const config = structuredClone(ctx.xiaolangHost.config);
 ${setup}
 return plugin.apply(ctx, ${options});
}`;
  }
  const schema = id === 'xiaolang-memory' ? memory.memorySchema : id === 'xiaolang-persona' ? persona.personaSchema : tooling.toolingSections[id] ? tooling.toolingSchemas[tooling.toolingSections[id]] : undefined;
  const cleanup = ['xiaolang-memory','xiaolang-persona','xiaolang-reminders'].includes(id) ? './impl/' + id.replace('xiaolang-','') + '-cleanup.js' : undefined;
  if (cleanup) await graph(id.replace('xiaolang-','') + '-cleanup.js', join(directory, 'impl'), true);
  const owner = await import(new URL('../dist/src/' + entry, import.meta.url));
  const panel = owner.xiaolangPanel;
  if (typeof owner.xiaolangPanelHome === 'function') code += `\nexport { xiaolangPanelHome } from './impl/${entry}';\n`;
  const dependencies = id === 'xiaolang-adapter' ? [] : id === 'xiaolang-deepseek' ? ['xiaolangHost'] : [...(owner[exported]?.inject ?? []), 'xiaolangHost'];
  await writeFile(join(directory, 'index.mjs'), code + '\nexport const xiaolangApiVersion = 1;\n' + (panel ? `export const xiaolangPanel = ${JSON.stringify(panel)};\n` : '') + (schema ? `export const xiaolangConfig = ${JSON.stringify(schema)};\n` : ''));
  await writeFile(join(directory, 'xiaolang.plugin.json'), JSON.stringify({ id, apiVersion: 1, dependencies, ...(panel ? { panel } : {}), ...(schema ? { configSchema: schema } : {}), ...(cleanup ? { cleanup } : {}) }, null, 2) + '\n');
}
for (const id of ['panel', 'hello']) await cp(`examples/plugins/${id}`, join(target, id), { recursive: true });
// The image contains only the transitive host graph; feature code is delivered separately.
await graph('main.js', resolve('dist/host/src'));
await graph('plugin-api.js', resolve('dist/host/src'));
console.info('Built host and standalone plugin packages.');
