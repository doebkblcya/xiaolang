import { createSystemCollector } from './system.mjs';
import { createPanelRegistry } from './registry.mjs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createAccess, readAuth, readTls, isPrivateAddress } from './security.mjs';

export const name = 'xiaolang-panel';
export const xiaolangApiVersion = 1;
export const inject = ['xiaolangRuntime'];
const assets = { '/assets/xiaolang-halfbody-v1.webp': ['assets/xiaolang-halfbody-v1.webp', 'image/webp'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
function integer(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error('invalid_query');
  return Number(value);
}
async function readJson(request, maximum = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maximum) { request.resume?.(); throw new Error('body_too_large'); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid_json'); }
}
export function createHandler(runtime, configuration, options = {}) {
  const system = options.system ?? createSystemCollector();
  const registry = createPanelRegistry(runtime, options.panels);
  const required = (name, feature) => { const service = options[name]; if (!service) throw new Error(`${feature}_unavailable`); return service; };
  const allowedHosts = options.allowedHosts ?? [];
  if (!Array.isArray(allowedHosts) || allowedHosts.some(host => typeof host !== 'string' || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(host))) throw new Error('invalid_panel_config');
  const writeToken = randomBytes(24).toString('hex');
  const access = createAccess(options.auth, Date.now, { privateHttp: options.privateHttp === true });
  const handler = async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8', extra = {}) => {
      response.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    if (options.privateHttp && !isPrivateAddress(request.socket?.remoteAddress)) return send(403, { error: 'lan_access_only' });
    const host = request.headers.host ?? '';
    const origin = `${request.socket?.encrypted ? 'https' : 'http'}://${host}`;
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/.test(host) && !allowedHosts.includes(host)) return send(403, { error: 'local_access_only' });
    if ((request.headers.origin && request.headers.origin !== origin)
      || (request.url?.startsWith('/api/') && request.headers['sec-fetch-site'] === 'cross-site')) return send(403, { error: 'same_origin_required' });
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) return send(400, { error: 'invalid_request' });
    let url;
    try { url = new URL(request.url, origin); } catch { return send(400, { error: 'invalid_request' }); }
    try {
      const handled = await access?.handle(request, url, send, readJson);
      if (handled === 'login') return send(200, await readFile(new URL('login.html', import.meta.url)), 'text/html; charset=utf-8');
      if (handled) return;
      if (!access && url.pathname === '/api/auth/session' && request.method === 'GET') return send(200, { enabled: false, authenticated: true });
      const writeRoute = /^\/api\/settings\/(model|qq|trigger|apply)$/.exec(url.pathname);
      const memoryRoute = /^\/api\/memory(?:\/(status|action|mutate|[a-f0-9-]{36}))?$/.exec(url.pathname);
      const recallRoute = /^\/api\/memory-recalls\/([a-f0-9-]{36})$/.exec(url.pathname);
      const pluginRoute = /^\/api\/plugins\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
      const personaRoute = /^\/api\/persona(?:\/(learn|mutate|[a-f0-9-]{36}))?$/.exec(url.pathname);
      const conversationRoute = /^\/api\/conversations(?:\/([a-f0-9]{64})(?:\/(name))?)?$/.exec(url.pathname);
      const summaryRoute = /^\/api\/conversations\/([a-f0-9]{64})\/summary$/.exec(url.pathname);
      const messageRoute = /^\/api\/conversations\/([a-f0-9]{64})\/messages\/([1-9][0-9]*)$/.exec(url.pathname);
      const deleteData = url.pathname === '/api/data/delete';
      const cancelReminder = url.pathname === '/api/reminders/cancel';
      if (request.method === 'POST' && (writeRoute || pluginRoute || memoryRoute || personaRoute || conversationRoute || cancelReminder || deleteData)) {
        if (!configuration) return send(503, { error: 'configuration_unavailable' });
        const token = request.headers['x-xiaolang-token'];
        if (request.headers.origin !== origin || typeof token !== 'string'
          || !/^[a-f0-9]{48}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(writeToken))) {
          request.resume?.(); return send(403, { error: 'write_authorization_required' });
        }
        if (request.headers['content-type'] !== 'application/json') { request.resume?.(); return send(415, { error: 'json_required' }); }
        const input = await readJson(request, pluginRoute?.[1] === 'xiaolang-mcp' ? 131072 : pluginRoute?.[1] === 'xiaolang-persona' ? 65536 : 16384);
        if (deleteData) return send(200, await required('history', 'store').deleteData(input));
        if (conversationRoute) {
          if (!conversationRoute[1] || conversationRoute[2] !== 'name') return send(405, { error: 'method_not_allowed' });
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['alias', 'version'].includes(key))) throw new Error('invalid_conversation_request');
          return send(200, required('history', 'store').renameConversation(conversationRoute[1], input.alias, input.version));
        }
        if (personaRoute) {
          if (!options.persona) return send(503, { error: 'persona_unavailable' });
          if (personaRoute[1] === 'mutate') return send(200, options.persona.mutate(input));
          if (personaRoute[1] === 'learn') { void options.persona.learn().catch(() => {}); return send(202, { started: true }); }
          return send(405, { error: 'method_not_allowed' });
        }
        if (cancelReminder) {
          if (!options.reminders) return send(503, { error: 'reminders_unavailable' });
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw new Error('invalid_reminder_request');
          return send(200, options.reminders.cancel(input.id));
        }
        if (memoryRoute) {
          if (!options.memory) return send(503, { error: 'memory_unavailable' });
          if (memoryRoute[1] === 'mutate') return send(200, await options.memory.mutate(input));
          if (memoryRoute[1] === 'action') return send(200, await options.memory.maintain(input?.action));
          return send(405, { error: 'method_not_allowed' });
        }
        if (pluginRoute) return send(200, { ...await configuration.savePlugin(pluginRoute[1], input), writeToken });
        if (writeRoute[1] === 'apply') {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.revision !== 'string') throw new Error('invalid_settings_request');
          await configuration.apply(input.revision); return send(202, { restarting: true });
        }
        return send(200, { ...await configuration.save(writeRoute[1], input), writeToken });
      }
      if (request.method !== 'GET') { request.resume?.(); return send(405, { error: 'method_not_allowed' }); }
      if (messageRoute) {
        const detail = required('history', 'store').message(messageRoute[1], integer(messageRoute[2], undefined));
        let logs = null, images = null, platform = null;
        try { logs = options.logs?.query({ messageId: detail.message.key, limit: 200 }) ?? null; } catch { /* Optional log service. */ }
        if (detail.turn && logs) {
          try {
            const turnLogs = options.logs.query({ q: detail.turn.id, limit: 200 });
            const entries = new Map([...logs.items, ...turnLogs.items].map(item => [item.seq, item]));
            logs = { ...logs, items: [...entries.values()].sort((a, b) => a.seq - b.seq).slice(-200),
              persistent: logs.persistent && turnLogs.persistent, degraded: logs.degraded || turnLogs.degraded };
          } catch { /* Message-level records remain available independently. */ }
        }
        try { images = options.memory?.imageDetails?.(detail.message) ?? null; } catch { /* Optional memory service. */ }
        try { platform = await options.adapter?.conversationStatus?.({ platform: detail.message.platform, account: detail.message.account,
          scope: detail.message.group ? 'group' : 'private', recipient: detail.message.group ?? detail.message.sender }) ?? null; } catch { /* Optional platform state. */ }
        return send(200, { ...detail, logs, images, platform });
      }
      if (summaryRoute) {
        const { conversation } = await required('history', 'store').timeline(summaryRoute[1]);
        if (!options.memory?.summary) return send(200, { available: false });
        const session = JSON.stringify([conversation.platform, conversation.account, conversation.scope, conversation.recipient]);
        return send(200, { available: true, ...options.memory.summary(session) });
      }
      if (conversationRoute) {
        if (conversationRoute[2]) return send(405, { error: 'method_not_allowed' });
        if (conversationRoute[1]) return send(200, await required('history', 'store').timeline(conversationRoute[1], integer(url.searchParams.get('before'), undefined)));
        return send(200, await required('history', 'store').conversations(url.searchParams.get('q') ?? '', url.searchParams.get('scope') ?? '', integer(url.searchParams.get('before'), undefined)));
      }
      if (personaRoute) {
        if (!options.persona) return send(503, { error: 'persona_unavailable' });
        if (['learn', 'mutate'].includes(personaRoute[1])) return send(405, { error: 'method_not_allowed' });
        return send(200, personaRoute[1] ? options.persona.detail(personaRoute[1]) : options.persona.list());
      }
      if (url.pathname === '/api/reminders') return options.reminders ? send(200, options.reminders.list()) : send(503, { error: 'reminders_unavailable' });
      if (recallRoute) return options.memory ? send(200, options.memory.recalled(recallRoute[1])) : send(503, { error: 'memory_unavailable' });
      if (memoryRoute) {
        if (!options.memory) return send(503, { error: 'memory_unavailable' });
        const id = memoryRoute[1];
        if (id === 'status') return send(200, options.memory.status());
        if (id && !['action', 'mutate'].includes(id)) return send(200, options.memory.detail(id, integer(url.searchParams.get('beforeVersion'), undefined)));
        if (!id) return send(200, options.memory.list(url.searchParams.get('q') ?? '', url.searchParams.get('kind') ?? '', integer(url.searchParams.get('before'), undefined)));
        return send(405, { error: 'method_not_allowed' });
      }
      if (pluginRoute) return configuration ? send(200, await configuration.plugin(pluginRoute[1])) : send(503, { error: 'configuration_unavailable' });
      if (url.pathname === '/api/settings') {
        return configuration ? send(200, { ...await configuration.view(), writeToken }) : send(503, { error: 'configuration_unavailable' });
      }
      if (Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname];
        return send(200, await readFile(new URL(file, import.meta.url)), type);
      }
      if (url.pathname === '/api/panel') return send(200, registry.describe());
      if (url.pathname === '/api/panel/home') return send(200, await registry.home());
      if (url.pathname === '/api/panel/system') return send(200, await system());
      const panelAsset = /^\/api\/panel\/assets\/([a-zA-Z0-9_-]{1,64})\/(.+)$/.exec(url.pathname);
      if (panelAsset) { const asset = await registry.asset(panelAsset[1], panelAsset[2]); return asset ? send(200, asset.body, asset.type) : send(404, { error: 'not_found' }); }
      if (url.pathname === '/api/status') {
        let counts = null, lastMessage;
        try { counts = options.history?.counts() ?? null; } catch { /* isolated feature */ }
        try { lastMessage = options.intake?.status?.().lastMessage; } catch { /* isolated feature */ }
        return send(200, { ...runtime.status(), counts, lastMessage,
          intakeEnabled: !!options.intake, memoryBytes: process.memoryUsage().rss });
      }
      if (url.pathname === '/api/usage/balance') return send(200, await options.model?.balance?.() ?? { state: 'unsupported' });
      if (url.pathname === '/api/usage') return options.usage ? send(200, options.usage.view({ range: url.searchParams.get('range') ?? 'today',
        purpose: url.searchParams.get('purpose') ?? '', provider: url.searchParams.get('provider') ?? '', turn: url.searchParams.get('turn') ?? '',
        issue: url.searchParams.get('issue') ?? '',
        before: integer(url.searchParams.get('before'), undefined) })) : send(503, { error: 'usage_unavailable' });
      if (url.pathname === '/api/tools') return send(200, { items: options.tools?.list() ?? [], mcp: options.mcp?.status() ?? [], skills: options.skills?.status() ?? [] });
      if (url.pathname === '/api/logs/events') return options.logs ? send(200, options.logs.events()) : send(503, { error: 'logging_unavailable' });
      if (url.pathname === '/api/logs') {
        const after = integer(url.searchParams.get('after'), undefined), before = integer(url.searchParams.get('before'), undefined);
        const limit = integer(url.searchParams.get('limit'), 200), q = url.searchParams.get('q') ?? '';
        const event = url.searchParams.get('event') ?? '', level = url.searchParams.get('level') ?? '', messageId = url.searchParams.get('messageId') ?? '';
        if (after !== undefined && after < 0 || before !== undefined && before < 1 || after !== undefined && before !== undefined || limit < 1 || limit > 500 || q.length > 200 || event.length > 100 || !['', 'info', 'warn', 'error'].includes(level) || messageId && !/^[a-f0-9]{64}$/.test(messageId)) throw new Error('invalid_log_query');
        return options.logs ? send(200, options.logs.query({ after, before, limit, q, event, level, messageId })) : send(503, { error: 'logging_unavailable' });
      }
      if (url.pathname === '/api/turns') {
        const limit = integer(url.searchParams.get('limit'), 25, 100);
        const before = integer(url.searchParams.get('before'), undefined);
        const failures = url.searchParams.get('failures');
        if (limit < 1 || before === 0 || (failures !== null && !['0', '1'].includes(failures))) throw new Error('invalid_query');
        return send(200, required('history', 'store').recent(limit, before, failures === '1'));
      }
      const match = /^\/api\/turns\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (match) {
        const detail = required('history', 'store').detail(match[1]);
        return detail ? send(200, detail) : send(404, { error: 'turn_not_found' });
      }
      return send(404, { error: 'not_found' });
    } catch (error) {
      const failure = error.code ?? error.message;
      if (['store_unavailable', 'usage_unavailable'].includes(failure)) return send(503, { error: failure });
      if (['invalid_persona_request', 'invalid_persona_result'].includes(failure)) return send(400, { error: failure });
      if (failure === 'persona_not_found') return send(404, { error: failure });
      if (['persona_conflict', 'persona_disabled', 'persona_busy', 'persona_rate_limited', 'persona_not_enough_messages', 'persona_catalog_full'].includes(failure)) return send(409, { error: failure });
      if (failure === 'invalid_delete_request') return send(400, { error: failure });
      if (failure === 'data_busy') return send(409, { error: failure });
      if (failure === 'message_not_found') return send(404, { error: failure });
      if (failure === 'invalid_conversation_request') return send(400, { error: failure });
      if (failure === 'conversation_not_found') return send(404, { error: failure });
      if (failure === 'conversation_conflict') return send(409, { error: failure });
      if (failure === 'invalid_reminder_request') return send(400, { error: failure });
      if (failure === 'reminder_not_found') return send(404, { error: failure });
      if (['invalid_memory_request', 'invalid_memory_source'].includes(failure)) return send(400, { error: failure });
      if (['memory_conflict', 'memory_disabled'].includes(failure)) return send(409, { error: failure });
      if (failure === 'memory_not_found') return send(404, { error: failure });
      if (typeof failure === 'string' && failure.startsWith('embedding_')) return send(502, { error: failure });
      const invalid = ['invalid_mcp_config', 'invalid_settings_request', 'invalid_saved_settings', 'invalid_config', 'invalid_qq_config', 'invalid_url', 'invalid_secret', 'invalid_json', 'persona_exceeds_context', 'trigger_configuration_unavailable'];
      if (invalid.includes(failure)) return send(400, { error: failure });
      if (['settings_conflict', 'settings_busy', 'chat_busy', 'no_pending_settings'].includes(failure)) return send(409, { error: failure });
      if (failure === 'plugin_not_found') return send(404, { error: failure });
      if (['plugin_required', 'plugin_not_configurable'].includes(failure)) return send(409, { error: failure });
      if (failure === 'invalid_plugin_config') return send(400, { error: failure });
      if (failure === 'body_too_large') return send(413, { error: failure });
      return send(error.message === 'invalid_query' || error.message === 'invalid_log_query' || error.message === 'invalid_log_cursor' || error.code === 'invalid_history_query' || error.code === 'invalid_usage_query' ? 400 : 500,
        { error: error.message === 'invalid_query' || error.message === 'invalid_log_query' || error.message === 'invalid_log_cursor' || error.code === 'invalid_history_query' || error.code === 'invalid_usage_query' ? 'invalid_query' : 'panel_query_failed' });
    }
  };
  handler.close = () => access?.close();
  return handler;
}
export async function apply(ctx, config = {}) {
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 18080;
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_panel_config');
  if (config.auth && !config.tls) throw new Error('panel_auth_requires_https');
  const auth = await readAuth(config.auth);
  let tls = config.tls ? await readTls(config.tls) : undefined;
  const handler = createHandler(ctx.xiaolangRuntime, ctx.get('configuration'), { allowedHosts: config.allowedHosts, auth, panels: ctx.xiaolangHost?.panels, logs: ctx.get('processLogs'), history: ctx.get('historyReader'), adapter: ctx.get('adapter'), model: ctx.get('model'), usage: ctx.get('usage'), intake: ctx.get('intake'),
    persona: ctx.get('persona'), memory: ctx.get('memory'), tools: ctx.get('tools'), mcp: ctx.get('mcp'), skills: ctx.get('skills'), reminders: ctx.get('reminders') });
  const server = tls ? createHttpsServer({ maxHeaderSize: 8192, ...tls.options }, handler) : createServer({ maxHeaderSize: 8192 }, handler);
  const listeners = [{ server, handler, port, host }];
  if (config.lanHttp !== undefined) {
    const lan = config.lanHttp;
    if (!auth || !tls || !lan || !['127.0.0.1', '0.0.0.0'].includes(lan.host ?? '0.0.0.0')
      || !Number.isInteger(lan.port) || lan.port < 1 || lan.port > 65535 || lan.port === port
      || !Array.isArray(lan.allowedHosts) || !lan.allowedHosts.length) throw new Error('invalid_panel_lan_config');
    const lanHandler = createHandler(ctx.xiaolangRuntime, ctx.get('configuration'), { allowedHosts: lan.allowedHosts, auth, privateHttp: true, panels: ctx.xiaolangHost?.panels, logs: ctx.get('processLogs'), history: ctx.get('historyReader'), adapter: ctx.get('adapter'), model: ctx.get('model'), usage: ctx.get('usage'), intake: ctx.get('intake'),
      persona: ctx.get('persona'), memory: ctx.get('memory'), tools: ctx.get('tools'), mcp: ctx.get('mcp'), skills: ctx.get('skills'), reminders: ctx.get('reminders') });
    listeners.push({ server: createServer({ maxHeaderSize: 8192 }, lanHandler), handler: lanHandler, port: lan.port, host: lan.host ?? '0.0.0.0' });
  }
  for (const entry of listeners) {
    entry.server.requestTimeout = 10000; entry.server.headersTimeout = 10000; entry.server.keepAliveTimeout = 5000; entry.server.maxConnections = 32;
  }
  let timer, reloading = false, reloadFailed = false;
  ctx.effect(() => () => { clearInterval(timer); return Promise.all(listeners.map(entry => new Promise(resolve => {
    entry.handler.close(); entry.server.close(() => resolve()); entry.server.closeAllConnections();
  }))); });
  for (const entry of listeners) await new Promise((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(entry.port, entry.host, () => { entry.server.off('error', reject); resolve(); });
  });
  if (tls) {
    timer = setInterval(async () => {
      if (reloading) return;
      reloading = true;
      try {
        const next = await readTls(config.tls);
        if (next.digest !== tls.digest) { server.setSecureContext(next.options); tls = next; ctx.emit('xiaolang/log', { code: 'panel_tls_reloaded', plugin: 'panel' }); }
        reloadFailed = false;
      } catch {
        if (!reloadFailed) ctx.emit('xiaolang/log', { code: 'panel_tls_reload_failed', plugin: 'panel' });
        reloadFailed = true;
      } finally { reloading = false; }
    }, 60000);
    timer.unref();
  }
  for (const entry of listeners) entry.server.on('error', () => ctx.emit('xiaolang/log', { code: 'panel_server_error', plugin: 'panel' }));
  ctx.emit('xiaolang/log', { code: 'panel_listening', plugin: 'panel' });
}
