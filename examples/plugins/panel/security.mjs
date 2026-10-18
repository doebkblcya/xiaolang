import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, createPrivateKey, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

const cookieName = '__Host-xiaolang-session';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function readAuth(config) {
  if (config === undefined) return undefined;
  try {
    if (!isAbsolute(config.keyHashFile)) throw new Error();
    const { keyHash } = JSON.parse(await readFile(config.keyHashFile, 'utf8'));
    const sessionHours = config.sessionHours ?? 168;
    if (!/^[a-f0-9]{64}$/.test(keyHash) || !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 720) throw new Error();
    return { keyHash, sessionHours };
  } catch { throw new Error('invalid_panel_auth'); }
}

export async function readTls(config) {
  try {
    if (config.directory !== undefined) {
      if (!isAbsolute(config.directory) || typeof config.domain !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(config.domain)) throw new Error();
      // fnOS renews into a new timestamp directory. Mount the domain directory,
      // not individual files, so atomic replacement and renewal remain visible.
      const directories = (await readdir(config.directory, { withFileTypes: true }))
        .filter(item => item.isDirectory() && /^[0-9]{1,16}$/.test(item.name)).sort((a, b) => Number(b.name) - Number(a.name)).slice(0, 32);
      for (const item of directories) {
        const directory = join(config.directory, item.name);
        try {
          const certFile = join(directory, `${config.domain}.crt`), keyFile = join(directory, `${config.domain}.key`);
          const result = await readTls({ certFile, keyFile, chainFile: join(directory, 'fullchain.crt') });
          if (!new X509Certificate(result.options.cert).checkHost(config.domain)) continue;
          return result;
        } catch { /* A half-written renewal must not replace the valid certificate. */ }
      }
      throw new Error();
    }
    if (!isAbsolute(config.certFile) || !isAbsolute(config.keyFile)) throw new Error();
    let [cert, key] = await Promise.all([readFile(config.certFile), readFile(config.keyFile)]);
    const leaf = new X509Certificate(cert);
    if (!leaf.checkPrivateKey(createPrivateKey(key)) || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw new Error();
    if (config.chainFile) {
      if (!isAbsolute(config.chainFile)) throw new Error();
      const chain = await readFile(config.chainFile);
      cert = new X509Certificate(chain).fingerprint256 === leaf.fingerprint256 ? chain : Buffer.concat([cert, Buffer.from('\n'), chain]);
    }
    const options = { cert, key, minVersion: 'TLSv1.2' };
    createSecureContext(options);
    return { options, digest: sha256(Buffer.concat([cert, key])) };
  } catch { throw new Error('invalid_panel_tls'); }
}

export function createAccess(auth, now = Date.now) {
  if (!auth) return undefined;
  if (!/^[a-f0-9]{64}$/.test(auth.keyHash)) throw new Error('invalid_panel_auth');
  const hours = auth.sessionHours ?? 168;
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('invalid_panel_auth');
  const lifetime = hours * 3600000, sessions = new Map(), failures = new Map();
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
  return {
    async handle(request, url, send, readJson) {
      if (!request.socket?.encrypted) { request.resume?.(); send(426, { error: 'https_required' }); return true; }
      const time = now();
      for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id);
      for (const [ip, failure] of failures) if (failure.until <= time) failures.delete(ip);
      const token = String(request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const session = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? sessions.get(sha256(token)) : undefined;
      const authenticated = !!session && session.host === request.headers.host;
      if (url.pathname === '/api/auth/session') {
        if (request.method === 'GET') { send(200, { enabled: true, authenticated }); return true; }
        if (request.method !== 'POST') { request.resume?.(); send(405, { error: 'method_not_allowed' }); return true; }
        if (request.headers.origin !== `https://${request.headers.host}`) { request.resume?.(); send(403, { error: 'same_origin_required' }); return true; }
        if (request.headers['content-type'] !== 'application/json') { request.resume?.(); send(415, { error: 'json_required' }); return true; }
        const ip = request.socket.remoteAddress ?? 'unknown';
        const failure = failures.get(ip);
        if (failure?.count >= 10) { request.resume?.(); send(429, { error: 'auth_rate_limited' }, undefined, { 'Retry-After': String(Math.ceil((failure.until - time) / 1000)) }); return true; }
        const input = await readJson(request, 1024);
        const key = input?.key;
        if (typeof key !== 'string' || key.length < 32 || key.length > 512 || !timingSafeEqual(Buffer.from(sha256(key)), Buffer.from(auth.keyHash))) {
          if (!failure && failures.size >= 256) failures.delete(failures.keys().next().value);
          failures.set(ip, { count: (failure?.count ?? 0) + 1, until: failure?.until ?? time + 900000 });
          send(401, { error: 'invalid_access_key' }); return true;
        }
        failures.delete(ip);
        // Replace this browser's previous session and bound memory use.
        if (token) sessions.delete(sha256(token));
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        const value = randomBytes(32).toString('hex');
        sessions.set(sha256(value), { expires: time + lifetime, host: request.headers.host });
        send(200, { authenticated: true }, undefined, { 'Set-Cookie': cookie(value, lifetime / 1000) }); return true;
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        request.resume?.();
        if (request.headers.origin !== `https://${request.headers.host}`) { send(403, { error: 'same_origin_required' }); return true; }
        if (token) sessions.delete(sha256(token));
        send(200, { authenticated: false }, undefined, { 'Set-Cookie': cookie('', 0) }); return true;
      }
      if (request.method === 'GET' && ['/login.js', '/style.css'].includes(url.pathname)) return false;
      if (authenticated) return false;
      request.resume?.();
      if (url.pathname === '/' && request.method === 'GET') return 'login';
      send(401, { error: 'authentication_required' }); return true;
    },
    close() { sessions.clear(); failures.clear(); },
  };
}
