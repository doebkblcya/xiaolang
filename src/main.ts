import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { code, Failure } from './errors.js';
import { ConfigurationStore } from './configuration.js';

async function main(): Promise<void> {
  const path = process.env.XIAOLANG_CONFIG ?? 'config.local.json';
  if (process.argv.includes('--check-config')) {
    await loadConfig(path);
    console.info('配置格式检查通过。');
    return;
  }
  if (process.platform !== 'linux') throw new Failure('runtime_requires_linux');
  const controller = new AbortController();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    if (app) void app.stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const configuration = await ConfigurationStore.load(path, () => {
    setTimeout(() => {
      stopping = true;
      controller.abort();
      void app?.stop().then(() => process.exit(0), () => process.exit(1));
    }, 300);
  }, () => {
    if (!app) return false;
    const counts = app.ctx.get('historyReader')?.counts() ?? {};
    return !['running', 'queued', 'sending'].some(state => counts[state]);
  });
  const config = configuration.config;
  if (configuration.secrets.deepseek) process.env.DEEPSEEK_API_KEY = configuration.secrets.deepseek;
  if (configuration.secrets.embedding) process.env.BAILIAN_API_KEY = configuration.secrets.embedding;
  if (configuration.secrets.qq && typeof config.adapter.config?.secretEnv === 'string') process.env[config.adapter.config.secretEnv] = configuration.secrets.qq;
  try {
    app = await createApp(config, {
      apiKey: process.env.DEEPSEEK_API_KEY, embeddingKey: process.env.BAILIAN_API_KEY, signal: controller.signal,
      configuration,
      writeLog: line => console.info(line),
      secrets: Object.entries(process.env).filter(([key, value]) => value && /KEY|SECRET|TOKEN|PASSWORD/i.test(key)).map(([, value]) => value!),
    });
    configuration.bindPlugins(() => app!.ctx.xiaolangRuntime.status().plugins);
    await configuration.confirm();
  } catch (error) {
    if (controller.signal.aborted) { process.exitCode = 0; return; }
    if (app) await app.stop().catch(() => {});
    if (await configuration.rollback()) console.error(JSON.stringify({ code: 'settings_apply_rolled_back' }));
    throw error;
  }
}
void main().catch(error => {
  console.error(JSON.stringify({ code: code(error) }));
  process.exitCode = 1;
});
