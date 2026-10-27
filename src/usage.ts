import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { Plugin } from 'cordis';
import type { Log } from './contracts.js';
import { object, emitLog } from './contracts.js';
import { code, Failure } from './errors.js';
import { estimateCost, pricing, pricePeriod } from './usage-pricing.js';

export const usagePurposes = ['chat', 'proactive', 'memory_extract', 'memory_summary', 'persona_learn', 'image_description', 'image_inspect',
  'embedding_recall', 'embedding_index', 'embedding_test', 'web_search', 'web_fetch', 'other'] as const;
export type UsagePurpose = typeof usagePurposes[number];
export interface UsageContext { turn?: string; step?: number; scope?: 'private' | 'group'; compaction?: string }
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

export interface UsageQuery { range?: string; dateFrom?: string; dateTo?: string; purpose?: string; provider?: string; turn?: string; compaction?: string; issue?: string; before?: number }
const aggregate = `COUNT(*) calls, COALESCE(SUM(CASE WHEN state IN ('failed','interrupted') THEN 1 ELSE 0 END),0) failures,
  COALESCE(SUM(CASE WHEN kind!='web' AND total_tokens IS NULL THEN 1 ELSE 0 END),0) unknown,
  COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END),0) metered,
  COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(total_tokens),0) total,
  COALESCE(SUM(cached_tokens),0) cached, COALESCE(SUM(reasoning_tokens),0) reasoning,
  COALESCE(AVG(duration_ms),0) averageMs,
  CASE WHEN COUNT(*)=0 THEN 0 ELSE SUM(estimated_cost) END estimatedCost,
  COALESCE(SUM(CASE WHEN estimated_cost IS NOT NULL THEN 1 ELSE 0 END),0) priced,
  COALESCE(SUM(CASE WHEN estimated_cost IS NULL THEN 1 ELSE 0 END),0) unpriced,
  COALESCE(SUM(CASE WHEN kind='chat' AND input_tokens>0 AND cached_tokens BETWEEN 0 AND input_tokens THEN cached_tokens ELSE 0 END),0) cacheHit,
  COALESCE(SUM(CASE WHEN kind='chat' AND input_tokens>0 AND cached_tokens BETWEEN 0 AND input_tokens THEN input_tokens ELSE 0 END),0) cacheInput,
  COALESCE(SUM(CASE WHEN kind='chat' AND input_tokens>0 AND (cached_tokens IS NULL OR cached_tokens<0 OR cached_tokens>input_tokens) THEN 1 ELSE 0 END),0) cacheUnknown`;

/** Inclusive calendar-day windows in Asia/Shanghai, independent of the host timezone. */
export function usageWindow(query: UsageQuery, now = Date.now()) {
  const range = query.range ?? 'today', dayMs = 86400000;
  const midnight = Math.floor((now + 8 * 3600000) / dayMs) * dayMs - 8 * 3600000;
  if (!['today', 'yesterday', '7d', '30d', 'all', 'custom'].includes(range)) throw new Failure('invalid_usage_query');
  if (range !== 'custom') {
    if (query.dateFrom || query.dateTo) throw new Failure('invalid_usage_query');
    return { from: range === 'all' ? 0 : midnight - (range === 'yesterday' ? 1 : range === '7d' ? 6 : range === '30d' ? 29 : 0) * dayMs,
      to: range === 'yesterday' ? midnight - 1 : now };
  }
  const parse = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Failure('invalid_usage_query');
    const stamp = Date.parse(value + 'T00:00:00+08:00');
    if (!Number.isFinite(stamp) || stamp < 0 || new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) !== value) throw new Failure('invalid_usage_query');
    return stamp;
  };
  const from = parse(query.dateFrom), last = parse(query.dateTo);
  if (from > last || last > midnight || last - from >= 366 * dayMs) throw new Failure('invalid_usage_query');
  return { from, to: Math.min(now, last + dayMs - 1) };
}

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
    const columns = this.db.prepare('PRAGMA table_info(usage_calls)').all();
    if (!columns.some(column => column.name === 'estimated_cost')) this.db.exec('ALTER TABLE usage_calls ADD COLUMN estimated_cost REAL');
    if (!columns.some(column => column.name === 'pricing_version')) this.db.exec('ALTER TABLE usage_calls ADD COLUMN pricing_version TEXT');
    if (!columns.some(column => column.name === 'compaction_id')) this.db.exec('ALTER TABLE usage_calls ADD COLUMN compaction_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS usage_compaction ON usage_calls(compaction_id)');
    this.db.function('usage_estimate', { deterministic: true }, estimateCost);
    // Existing requests use this public rate snapshot as an approximation; actual token fields remain untouched.
    this.db.prepare(`UPDATE usage_calls SET estimated_cost=usage_estimate(provider,model,kind,input_tokens,output_tokens,cached_tokens,started),pricing_version=?
      WHERE pricing_version IS NULL AND state!='running'`).run(pricing.version);
  }
  close(): void { this.db.close(); }
  begin(meta: RequestMeta, scope: Partial<Scope>, started: number): number | undefined {
    try {
      return Number(this.db.prepare(`INSERT INTO usage_calls(started,purpose,provider,model,kind,streaming,thinking,attempt,turn_id,step,scope,compaction_id,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'running')`).run(started, scope.purpose ?? 'other', meta.provider, meta.model.slice(0, 120), meta.kind,
        meta.streaming ? 1 : 0, meta.thinking ?? 'off', meta.attempt ?? 1, scope.turn ?? null, scope.step ?? null, scope.scope ?? null, scope.compaction ?? null).lastInsertRowid);
    } catch { this.failed(); return undefined; }
  }
  private failed(): void { try { this.report({ code: 'usage_record_failed', stage: 'usage', level: 'error', errorCode: 'usage_storage_failed' }); } catch { /* isolated observer */ } }
  finish(id: number | undefined, meta: RequestMeta, scope: Scope | undefined, started: number, raw: unknown, requestId?: string, error?: string): void {
    const u = tokens(raw, meta.kind), now = Date.now(), durationMs = Math.max(0, now - started);
    try {
      if (id !== undefined) this.db.prepare(`UPDATE usage_calls SET finished=?,duration_ms=?,state=?,error_code=?,request_id=?,
        input_tokens=?,output_tokens=?,total_tokens=?,cached_tokens=?,reasoning_tokens=?,estimated_cost=?,pricing_version=? WHERE id=?`)
        .run(now, durationMs, error ? 'failed' : 'success', error ?? null, requestId ?? null, u.input, u.output, u.total, u.cached, u.reasoning,
          estimateCost(meta.provider, meta.model, meta.kind, u.input, u.output, u.cached, started), pricing.version, id);
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
    const range = query.range ?? 'today', purpose = query.purpose ?? '', provider = query.provider ?? '', turn = query.turn ?? '', issue = query.issue ?? '', compaction = query.compaction ?? '';
    if (!['today', 'yesterday', '7d', '30d', 'all', 'custom'].includes(range) || (purpose && !usagePurposes.includes(purpose as UsagePurpose))
      || (provider && !['deepseek', 'bailian'].includes(provider)) || (turn && !/^[a-f0-9-]{36}$/.test(turn))
      || !['', 'failed', 'unknown'].includes(issue)
      || (compaction && !/^[a-f0-9-]{36}$/.test(compaction))
      || (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1))) throw new Failure('invalid_usage_query');
    const { from, to } = usageWindow(query);
    const where = 'started>=? AND started<=? AND (?=\'\' OR purpose=?) AND (?=\'\' OR provider=?) AND (?=\'\' OR turn_id=?) AND (?=\'\' OR compaction_id=?)';
    const args = [from, to, purpose, purpose, provider, provider, turn, turn, compaction, compaction];
    const summary = this.db.prepare(`SELECT ${aggregate} FROM usage_calls WHERE ${where}`).get(...args)!;
    const byPurpose = this.db.prepare(`SELECT purpose,${aggregate} FROM usage_calls WHERE ${where} GROUP BY purpose ORDER BY total DESC,calls DESC`).all(...args);
    const byModel = this.db.prepare(`SELECT provider,model,${aggregate} FROM usage_calls WHERE ${where} GROUP BY provider,model ORDER BY total DESC`).all(...args);
    const daily = this.db.prepare(`SELECT date(started/1000,'unixepoch','+8 hours') day,${aggregate} FROM usage_calls WHERE ${where} GROUP BY day ORDER BY day DESC`).all(...args);
    // Issues narrow the request list only; the overview remains scoped to time / purpose / provider.
    const itemWhere = where + (issue === 'failed' ? " AND state IN ('failed','interrupted')" : issue === 'unknown' ? " AND kind!='web' AND total_tokens IS NULL" : '');
    const matched = Number(this.db.prepare(`SELECT COUNT(*) count FROM usage_calls WHERE ${itemWhere}`).get(...args)!.count);
    const items = this.db.prepare(`SELECT id,started,finished,duration_ms durationMs,purpose,provider,model,kind,streaming,thinking,attempt,
      turn_id turn,step,scope,state,error_code errorCode,request_id requestId,input_tokens input,output_tokens output,total_tokens total,
      cached_tokens cached,reasoning_tokens reasoning,estimated_cost estimatedCost,pricing_version pricingVersion,compaction_id compaction FROM usage_calls WHERE ${itemWhere} AND id<? ORDER BY id DESC LIMIT 51`).all(...args, query.before ?? Number.MAX_SAFE_INTEGER);
    const next = items.length > 50 ? Number(items[49]!.id) : null;
    return { range, from, to, timezone: 'Asia/Shanghai', firstRecorded: this.db.prepare('SELECT MIN(started) time FROM usage_calls').get()!.time ?? null,
      pricing, summary, byPurpose, byModel, daily, issue, matched, items: items.slice(0, 50).map(row => {
        row.pricePeriod = row.estimatedCost !== null ? pricePeriod(Number(row.started)) : null; return row;
      }), next };
  }
}

export const usagePlugin: Plugin.Object<{ database: string }> = {
  name: 'xiaolang-usage', apply(ctx, config) {
    const meter = new UsageMeter(config.database, entry => emitLog(ctx, entry));
    ctx.effect(() => () => meter.close());
    ctx.provide('usage', meter);
  },
};

Object.assign(usagePlugin, { panel: { pages: [{ id: "usage", title: "模型用量", view: "usage" }] } });
