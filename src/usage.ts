import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { Plugin } from 'cordis';
import type { Log } from './contracts.js';
import { object, emitLog } from './contracts.js';
import { code, Failure } from './errors.js';

export const usagePurposes = ['chat', 'proactive', 'memory_extract', 'memory_summary', 'persona_learn', 'image_description', 'image_inspect',
  'embedding_recall', 'embedding_index', 'embedding_test', 'web_search', 'web_fetch', 'other'] as const;
export type UsagePurpose = typeof usagePurposes[number];
export interface UsageContext { turn?: string; step?: number; scope?: 'private' | 'group' }
interface Scope extends UsageContext { purpose: UsagePurpose; meter: UsageMeter }
const scopes = new AsyncLocalStorage<Scope>();
export interface RequestMeta { provider: 'deepseek' | 'bailian'; model: string; kind: 'chat' | 'embedding' | 'web'; streaming?: boolean; thinking?: string; attempt?: number }
interface Tokens { input: number | null; output: number | null; total: number | null; cached: number | null; reasoning: number | null }
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function tokens(raw: unknown, kind: RequestMeta['kind']): Tokens {
  const u = object(raw);
  return {
    input: count(u?.prompt_tokens) ?? count(u?.input_tokens) ?? (kind === 'embedding' ? count(u?.total_tokens) : null),
    output: count(u?.completion_tokens) ?? count(u?.output_tokens) ?? (kind === 'embedding' && u ? 0 : null),
    total: count(u?.total_tokens),
    cached: count(u?.prompt_cache_hit_tokens) ?? count(object(u?.prompt_tokens_details)?.cached_tokens) ?? count(object(u?.input_tokens_details)?.cached_tokens),
    reasoning: count(object(u?.completion_tokens_details)?.reasoning_tokens) ?? count(object(u?.output_tokens_details)?.reasoning_tokens),
  };
}

/** Scopes belong to the asynchronous call, so simultaneous foreground/background work cannot mix attribution. */
export function withUsage<T>(meter: UsageMeter | undefined, purpose: UsagePurpose, context: UsageContext, work: () => T): T {
  const parent = scopes.getStore();
  return meter ? scopes.run({ ...(parent?.meter === meter ? parent : {}), purpose, ...context, meter }, work) : work();
}

/** One record per actual HTTP attempt, including retries and responses rejected after parsing. */
export async function meterRequest<T>(meta: RequestMeta, work: (capture: (body: unknown) => void) => Promise<T>, fallback?: UsageMeter): Promise<T> {
  const scope = scopes.getStore(), meter = scope?.meter ?? fallback;
  if (!meter) return work(() => {});
  const started = Date.now();
  const id = meter.begin(meta, scope ?? { purpose: 'other' }, started);
  let usage: unknown, requestId: string | undefined;
  const capture = (raw: unknown) => {
    const body = object(raw);
    if (object(body?.usage)) usage = body!.usage;
    const value = body?.id ?? body?.request_id;
    if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)) requestId = value;
  };
  try {
    const result = await work(capture);
    meter.finish(id, meta, scope, started, usage, requestId);
    return result;
  } catch (error) {
    meter.finish(id, meta, scope, started, usage, requestId, code(error));
    throw error;
  }
}

export interface UsageQuery { range?: string; purpose?: string; provider?: string; turn?: string; before?: number }
const aggregate = `COUNT(*) calls, COALESCE(SUM(CASE WHEN state IN ('failed','interrupted') THEN 1 ELSE 0 END),0) failures,
  COALESCE(SUM(CASE WHEN kind!='web' AND total_tokens IS NULL THEN 1 ELSE 0 END),0) unknown,
  COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END),0) metered,
  COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(total_tokens),0) total,
  COALESCE(SUM(cached_tokens),0) cached, COALESCE(SUM(reasoning_tokens),0) reasoning,
  COALESCE(AVG(duration_ms),0) averageMs`;

export class UsageMeter {
  private db: DatabaseSync;
  constructor(path: string, private report: (entry: Log) => void = () => {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS usage_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, finished INTEGER, duration_ms INTEGER,
        purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
        streaming INTEGER NOT NULL, thinking TEXT NOT NULL, attempt INTEGER NOT NULL, turn_id TEXT, step INTEGER, scope TEXT,
        state TEXT NOT NULL, error_code TEXT, request_id TEXT,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS usage_started ON usage_calls(started);
      CREATE INDEX IF NOT EXISTS usage_turn ON usage_calls(turn_id);
      UPDATE usage_calls SET state='interrupted',error_code='process_interrupted' WHERE state='running';`);
  }
  close(): void { this.db.close(); }
  begin(meta: RequestMeta, scope: Partial<Scope>, started: number): number | undefined {
    try {
      return Number(this.db.prepare(`INSERT INTO usage_calls(started,purpose,provider,model,kind,streaming,thinking,attempt,turn_id,step,scope,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'running')`).run(started, scope.purpose ?? 'other', meta.provider, meta.model.slice(0, 120), meta.kind,
        meta.streaming ? 1 : 0, meta.thinking ?? 'off', meta.attempt ?? 1, scope.turn ?? null, scope.step ?? null, scope.scope ?? null).lastInsertRowid);
    } catch { this.failed(); return undefined; }
  }
  private failed(): void { try { this.report({ code: 'usage_record_failed', stage: 'usage', level: 'error', errorCode: 'usage_storage_failed' }); } catch { /* isolated observer */ } }
  finish(id: number | undefined, meta: RequestMeta, scope: Scope | undefined, started: number, raw: unknown, requestId?: string, error?: string): void {
    const u = tokens(raw, meta.kind), now = Date.now(), durationMs = Math.max(0, now - started);
    try {
      if (id !== undefined) this.db.prepare(`UPDATE usage_calls SET finished=?,duration_ms=?,state=?,error_code=?,request_id=?,
        input_tokens=?,output_tokens=?,total_tokens=?,cached_tokens=?,reasoning_tokens=? WHERE id=?`)
        .run(now, durationMs, error ? 'failed' : 'success', error ?? null, requestId ?? null, u.input, u.output, u.total, u.cached, u.reasoning, id);
    } catch { this.failed(); }
    try {
      this.report({ code: 'api_usage', stage: 'usage', usageId: id, purpose: scope?.purpose ?? 'other', provider: meta.provider, model: meta.model,
        turn: scope?.turn, step: scope?.step, scope: scope?.scope, attempt: meta.attempt ?? 1, durationMs, state: error ? 'failed' : 'success',
        ...(error ? { errorCode: error } : {}), ...(u.input !== null ? { inputTokens: u.input } : {}), ...(u.output !== null ? { outputTokens: u.output } : {}),
        ...(u.total !== null ? { totalTokens: u.total } : {}), ...(u.cached !== null ? { cachedTokens: u.cached } : {}),
        ...(u.reasoning !== null ? { reasoningTokens: u.reasoning } : {}), reason: u.total === null ? meta.kind === 'web' ? '按次调用，未返回 Token 用量' : '接口未返回完整用量，不能视为零消耗' : undefined });
    } catch { /* isolated observer */ }
  }
  view(query: UsageQuery = {}) {
    const range = query.range ?? 'today', purpose = query.purpose ?? '', provider = query.provider ?? '', turn = query.turn ?? '';
    if (!['today', '7d', '30d', 'all'].includes(range) || (purpose && !usagePurposes.includes(purpose as UsagePurpose))
      || (provider && !['deepseek', 'bailian'].includes(provider)) || (turn && !/^[a-f0-9-]{36}$/.test(turn))
      || (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))) throw new Failure('invalid_usage_query');
    const now = Date.now(), midnight = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
    const from = range === 'all' ? 0 : midnight - (range === '7d' ? 6 : range === '30d' ? 29 : 0) * 86400000;
    const where = 'started>=? AND started<=? AND (?=\'\' OR purpose=?) AND (?=\'\' OR provider=?) AND (?=\'\' OR turn_id=?)';
    const args = [from, now, purpose, purpose, provider, provider, turn, turn];
    const summary = this.db.prepare(`SELECT ${aggregate} FROM usage_calls WHERE ${where}`).get(...args)!;
    const byPurpose = this.db.prepare(`SELECT purpose,${aggregate} FROM usage_calls WHERE ${where} GROUP BY purpose ORDER BY total DESC,calls DESC`).all(...args);
    const byModel = this.db.prepare(`SELECT provider,model,${aggregate} FROM usage_calls WHERE ${where} GROUP BY provider,model ORDER BY total DESC`).all(...args);
    const daily = this.db.prepare(`SELECT date(started/1000,'unixepoch','+8 hours') day,${aggregate} FROM usage_calls WHERE ${where} GROUP BY day ORDER BY day DESC LIMIT 31`).all(...args);
    const items = this.db.prepare(`SELECT id,started,finished,duration_ms durationMs,purpose,provider,model,kind,streaming,thinking,attempt,
      turn_id turn,step,scope,state,error_code errorCode,request_id requestId,input_tokens input,output_tokens output,total_tokens total,
      cached_tokens cached,reasoning_tokens reasoning FROM usage_calls WHERE ${where} AND id<? ORDER BY id DESC LIMIT 51`).all(...args, query.before ?? Number.MAX_SAFE_INTEGER);
    const next = items.length > 50 ? Number(items[49]!.id) : null;
    return { range, from, to: now, timezone: 'Asia/Shanghai', firstRecorded: this.db.prepare('SELECT MIN(started) time FROM usage_calls').get()!.time ?? null,
      summary, byPurpose, byModel, daily, items: items.slice(0, 50), next };
  }
}

export const usagePlugin: Plugin.Object<{ database: string }> = {
  name: 'xiaolang-usage', apply(ctx, config) {
    const meter = new UsageMeter(config.database, entry => emitLog(ctx, entry));
    ctx.effect(() => () => meter.close());
    ctx.provide('usage', meter);
  },
};
