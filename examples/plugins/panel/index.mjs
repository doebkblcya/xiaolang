import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createAccess, readAuth, readTls, isPrivateAddress } from './security.mjs';

export const name = 'xiaolang-panel';
export const xiaolangApiVersion = 1;
export const inject = ['inspection'];
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
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
export function createHandler(inspection, configuration, options = {}) {
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
        if (deleteData) return send(200, await inspection.deleteData(input));
        if (conversationRoute) {
          if (!conversationRoute[1] || conversationRoute[2] !== 'name') return send(405, { error: 'method_not_allowed' });
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['alias', 'version'].includes(key))) throw new Error('invalid_conversation_request');
          return send(200, inspection.renameConversation(conversationRoute[1], input.alias, input.version));
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
      if (conversationRoute) {
        if (conversationRoute[2]) return send(405, { error: 'method_not_allowed' });
        if (conversationRoute[1]) return send(200, await inspection.timeline(conversationRoute[1], integer(url.searchParams.get('before'), undefined)));
        return send(200, await inspection.conversations(url.searchParams.get('q') ?? '', url.searchParams.get('scope') ?? '', integer(url.searchParams.get('before'), undefined)));
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
      if (url.pathname === '/api/status') return send(200, inspection.status());
      if (url.pathname === '/api/usage') return inspection.usage ? send(200, inspection.usage({ range: url.searchParams.get('range') ?? 'today',
        purpose: url.searchParams.get('purpose') ?? '', provider: url.searchParams.get('provider') ?? '', turn: url.searchParams.get('turn') ?? '',
        before: integer(url.searchParams.get('before'), undefined) })) : send(503, { error: 'usage_unavailable' });
      if (url.pathname === '/api/tools') return send(200, { items: options.tools?.list() ?? [], mcp: options.mcp?.status() ?? [], skills: options.skills?.status() ?? [] });
      if (url.pathname === '/api/logs') return send(200, inspection.logs(integer(url.searchParams.get('after'), 0)));
      if (url.pathname === '/api/turns') {
        const limit = integer(url.searchParams.get('limit'), 25, 100);
        const before = integer(url.searchParams.get('before'), undefined);
        const failures = url.searchParams.get('failures');
        if (limit < 1 || before === 0 || (failures !== null && !['0', '1'].includes(failures))) throw new Error('invalid_query');
        return send(200, inspection.recent(limit, before, failures === '1'));
      }
      const match = /^\/api\/turns\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (match) {
        const detail = inspection.detail(match[1]);
        return detail ? send(200, detail) : send(404, { error: 'turn_not_found' });
      }
      return send(404, { error: 'not_found' });
    } catch (error) {
      const failure = error.code ?? error.message;
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
      return send(error.message === 'invalid_query' || error.message === 'invalid_log_cursor' || error.code === 'invalid_history_query' || error.code === 'invalid_usage_query' ? 400 : 500,
        { error: error.message === 'invalid_query' || error.message === 'invalid_log_cursor' || error.code === 'invalid_history_query' || error.code === 'invalid_usage_query' ? 'invalid_query' : 'panel_query_failed' });
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
  const handler = createHandler(ctx.inspection, ctx.get('configuration'), { allowedHosts: config.allowedHosts, auth,
    persona: ctx.get('persona'), memory: ctx.get('memory'), tools: ctx.get('tools'), mcp: ctx.get('mcp'), skills: ctx.get('skills'), reminders: ctx.get('reminders') });
  const server = tls ? createHttpsServer({ maxHeaderSize: 8192, ...tls.options }, handler) : createServer({ maxHeaderSize: 8192 }, handler);
  const listeners = [{ server, handler, port, host }];
  if (config.lanHttp !== undefined) {
    const lan = config.lanHttp;
    if (!auth || !tls || !lan || !['127.0.0.1', '0.0.0.0'].includes(lan.host ?? '0.0.0.0')
      || !Number.isInteger(lan.port) || lan.port < 1 || lan.port > 65535 || lan.port === port
      || !Array.isArray(lan.allowedHosts) || !lan.allowedHosts.length) throw new Error('invalid_panel_lan_config');
    const lanHandler = createHandler(ctx.inspection, ctx.get('configuration'), { allowedHosts: lan.allowedHosts, auth, privateHttp: true,
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
