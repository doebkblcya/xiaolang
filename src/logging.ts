import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import type { Log } from './contracts.js';

const strings = ['code', 'time', 'turn', 'stage', 'plugin', 'messageId', 'taskId', 'scope', 'sender', 'group',
  'reason', 'model', 'tool', 'state', 'errorCode', 'receipt', 'purpose', 'provider'] as const;
const numbers = ['step', 'part', 'parts', 'toolCalls', 'durationMs', 'waitMs', 'usageId', 'attempt', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'imageCount'] as const;

export interface LoggingOptions {
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
    // A broken output or observer cannot interrupt the bot or the other output.
    try { options.report?.(structuredClone(entry)); } catch { /* isolated observer */ }
  };
}
export const loggingPlugin: Plugin.Object<LoggingOptions> = {
  name: 'xiaolang-logging',
  apply(ctx, options) {
    ctx.on('xiaolang/log', createReporter({ ...options, report(entry) {
      try { options.report?.(structuredClone(entry)); } catch { /* isolated observer */ }
      try { ctx.emit('xiaolang/logged', structuredClone(entry)); } catch { /* isolated observer */ }
      try {
        const output = ctx.get('logOutput');
        if (output) output.write(structuredClone(entry));
        else options.write?.(JSON.stringify(entry));
      } catch { /* isolated output */ }
    } }));
  },
};
