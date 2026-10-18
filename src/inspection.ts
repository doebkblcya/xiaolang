import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import type { LogItem, PluginInfo } from './contracts.js';

export const inspectionPlugin: Plugin.Object<{ config: Config; plugins: () => PluginInfo[] }> = {
  name: 'xiaolang-inspection', inject: ['historyReader'],
  apply(ctx, options) {
    const { config } = options;
    const started = Date.now();
    let state = 'starting';
    let connection = 'starting';
    let lastMessage: string | undefined;
    let cursor = 0;
    const buffer: LogItem[] = [];
    ctx.on('xiaolang/logged', entry => {
      if (entry.code === 'application_ready') state = 'ready';
      if (entry.code === 'application_stopping') state = 'stopping';
      if (entry.code === 'application_failed') state = 'failed';
      if (entry.code === 'qq_connected') connection = 'connected';
      if (entry.code === 'qq_disconnected') connection = 'disconnected';
      if (entry.code === 'qq_connection_failed' || entry.code === 'qq_connection_error') connection = 'error';
      if (entry.code === 'message_received') lastMessage = entry.time;
      buffer.push({ seq: ++cursor, entry: structuredClone(entry) });
      if (buffer.length > 500) buffer.shift();
    });
    ctx.provide('inspection', {
      status() {
        return { started, uptimeMs: Math.max(0, Date.now() - started), state, connection, lastMessage,
          model: config.model.name, platform: ctx.get('adapter')?.platform, chatEnabled: !!ctx.get('chat'),
          contextBudget: { unit: config.limits.contextTokens === undefined ? 'characters' : 'tokens',
            max: config.limits.contextTokens ?? config.limits.contextChars,
            recentMessages: config.memory?.enabled ? config.memory.recentMessages : config.limits.history },
          memoryBytes: process.memoryUsage().rss, counts: ctx.historyReader.counts(),
          plugins: structuredClone(options.plugins()),
        };
      },
      conversations: (query, scope, before) => ctx.historyReader.conversations(query, scope, before),
      timeline: (id, before) => ctx.historyReader.timeline(id, before),
      renameConversation: (id, alias, version) => ctx.historyReader.renameConversation(id, alias, version),
      recent: (limit, before, failures) => ctx.historyReader.recent(limit, before, failures),
      detail: id => ctx.historyReader.detail(id),
      logs(after = 0) {
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid_log_cursor');
        const reset = after > cursor || (buffer.length > 0 && after > 0 && after < buffer[0]!.seq - 1);
        return { items: structuredClone(buffer.filter(item => reset || item.seq > after)), cursor, reset };
      },
    });
  },
};
