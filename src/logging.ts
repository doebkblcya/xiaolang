import { Ajv } from 'ajv';
import { LogJournal } from './log-journal.js';
import { labelLog, formatText } from './log-format.js';
import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import type { Log } from './contracts.js';

const strings = ['label', 'code', 'time', 'turn', 'stage', 'plugin', 'messageId', 'taskId', 'scope', 'sender', 'group',
  'reason', 'model', 'tool', 'state', 'errorCode', 'receipt', 'purpose', 'provider'] as const;
const numbers = ['step', 'part', 'parts', 'toolCalls', 'durationMs', 'waitMs', 'usageId', 'attempt', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'imageCount'] as const;

export interface LoggingOptions {
  database?: string;
  settings?: Config['logging'];
  secrets?: string[];
  report?: (entry: Log) => void;
  write?: (line: string) => void;
}
export function createReporter(options: LoggingOptions): (raw: Log) => void {
  const secrets = [...new Set(options.secrets?.filter(Boolean) ?? [])].sort((a, b) => b.length - a.length);
  const clean = (value: string, limit = 512): string => {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|app[_-]?secret|password|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\r\n?|\n/g, '\\n').replace(/\t/g, '\\t');
    const chars = Array.from(text);
    return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text;
  };
  return raw => {
    const entry: Log = { code: clean(raw.code, 100), time: raw.time ?? new Date().toISOString() };
    for (const key of strings) if (typeof raw[key] === 'string') Object.assign(entry, { [key]: clean(raw[key]!) });
    for (const key of numbers) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) Object.assign(entry, { [key]: Math.max(0, Math.round(raw[key]!)) });
    entry.level = raw.level === 'error' || raw.level === 'warn' ? raw.level
      : /failed|error|unknown/.test(entry.code) ? 'error' : entry.code === 'message_ignored' || entry.code.includes('limited') ? 'warn' : 'info';
    if (Array.isArray(raw.dependencies)) entry.dependencies = raw.dependencies.slice(0, 32).filter(value => typeof value === 'string').map(value => clean(value, 100));
    if (options.settings?.content !== false && typeof raw.preview === 'string') entry.preview = clean(raw.preview, options.settings?.previewChars ?? 200);
    if (Array.isArray(raw.fields)) entry.fields = raw.fields.slice(0, 16).filter(field => field && typeof field.label === 'string' && (typeof field.value === 'string' || typeof field.value === 'number' && Number.isFinite(field.value))).map(field => ({ label: clean(field.label, 40), value: typeof field.value === 'string' ? clean(field.value, 200) : field.value }));
    // A broken output or observer cannot interrupt the bot or the other output.
    try { options.report?.(structuredClone(entry)); } catch { /* isolated observer */ }
  };
}
export const loggingSchema = { type: 'object', additionalProperties: false, properties: {
  content: { type: 'boolean', title: '正文预览', default: true },
  previewChars: { type: 'integer', title: '预览字数', minimum: 1, maximum: 1000, default: 200 },
  console: { type: 'boolean', title: '控制台输出', default: true },
  format: { type: 'string', title: '输出格式', enum: ['text', 'json'], default: 'text' },
  retentionDays: { type: 'integer', title: '保留天数', minimum: 1, maximum: 365, default: 7 },
  maxRecords: { type: 'integer', title: '最多条数', minimum: 1000, maximum: 1000000, default: 100000 },
} };
const validateSettings = new Ajv().compile(loggingSchema);
export const loggingPlugin: Plugin.Object<LoggingOptions> = {
  name: 'xiaolang-logging',
  apply(ctx, options) {
    const entries = ctx.xiaolangHost.config.plugins?.entries ?? [];
    const legacy = entries.find(entry => entry.id === 'console-logger');
    const settings = { ...(legacy ? { console: legacy.enabled !== false, format: legacy.config?.format ?? 'text' } : {}),
      ...options.settings, ...entries.find(entry => entry.id === 'xiaolang-logging')?.config };
    if (!validateSettings(settings)) throw new Error('invalid_logging_config');
    const schema = structuredClone(loggingSchema);
    for (const [key, value] of Object.entries(settings)) Object.assign(schema.properties[key as keyof typeof schema.properties], { default: value });
    (ctx.get('configuration') ?? ctx.xiaolangHost.options.configuration)?.registerPlugin('xiaolang-logging', schema);
    const journal = new LogJournal(options.database ?? ':memory:', settings.retentionDays as number | undefined, settings.maxRecords as number | undefined,
      () => options.write?.('日志持久化暂不可用'));
    ctx.provide('processLogs', journal);
    ctx.provide('logOutput', { write(entry) { options.write?.(settings.format === 'json' ? JSON.stringify(entry) : formatText(entry)); } });
    ctx.effect(() => () => journal.close());
    ctx.on('xiaolang/log', createReporter({ ...options, settings: settings as Config['logging'], report(raw) {
      const entry = labelLog(raw);
      journal.append(entry);
      try { options.report?.(structuredClone(entry)); } catch { /* isolated observer */ }
      try { ctx.emit('xiaolang/logged', structuredClone(entry)); } catch { /* isolated observer */ }
      try { if (settings.console !== false) ctx.logOutput.write(structuredClone(entry)); } catch { /* isolated output */ }
    } }));
  },
};

Object.assign(loggingPlugin, { panel: { pages: [{ id: 'logs', title: '过程日志', view: 'logs' }] } });

export const loggingCleanup: import('./data-cleanup.js').DataCleanup = {
  erase(db, { seqs, exists }) {
    if (!exists('process_logs')) return;
    for (const seq of seqs) {
      const row = db.prepare('SELECT key FROM messages WHERE seq=?').get(seq);
      if (!row) continue;
      db.prepare("DELETE FROM process_logs WHERE json_extract(body,'$.messageId')=?").run(String(row.key));
      for (const turn of db.prepare("SELECT id FROM turns WHERE message_key=? OR 'reply:'||id=?").all(String(row.key), String(row.key))) {
        db.prepare("DELETE FROM process_logs WHERE json_extract(body,'$.turn')=?").run(String(turn.id));
      }
    }
  },
};
