import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import type { ConversationView, PluginInfo } from './contracts.js';

export const inspectionPlugin: Plugin.Object<{ config: Config; plugins: () => PluginInfo[] }> = {
  name: 'xiaolang-inspection', inject: ['historyReader', 'usage'],
  apply(ctx, options) {
    const { config } = options;
    const started = Date.now();
    let state = 'starting';
    let lastMessage: string | undefined;
    ctx.on('xiaolang/logged', entry => {
      if (entry.code === 'application_ready') state = 'ready';
      if (entry.code === 'application_stopping') state = 'stopping';
      if (entry.code === 'application_failed') state = 'failed';
      if (entry.code === 'message_received') lastMessage = entry.time;
    });
    const nameConversation = async (item: ConversationView) => {
      const adapter = ctx.get('adapter');
      if (item.scope !== 'group' || adapter?.platform !== item.platform || adapter.account !== item.account || !adapter.groupName) return item;
      try {
        const name = await adapter.groupName(item.recipient);
        if (name) { ctx.historyReader.cacheConversationName(item.id, name); return { ...item, name }; }
      } catch { /* Missing optional metadata must not hide the conversation. */ }
      return item;
    };
    ctx.provide('inspection', {
      usage: query => ctx.usage.view(query),
      deleteData: async input => {
        await ctx.get('trigger')?.clear?.();
        const result = ctx.historyReader.deleteData(input);
        ctx.get('processLogs')?.invalidate();
        return result;
      },
      status() {
        return { started, uptimeMs: Math.max(0, Date.now() - started), state, connection: ctx.get('adapter') ? ctx.get('adapter')?.connectionStatus?.() ?? 'unknown' : 'disabled', lastMessage,
          model: config.model.name, platform: ctx.get('adapter')?.platform, chatEnabled: !!ctx.get('chat'),
          contextBudget: { unit: config.limits.contextTokens === undefined ? 'characters' : 'tokens',
            max: config.limits.contextTokens ?? config.limits.contextChars,
            recentMessages: config.memory?.enabled ? config.memory.recentMessages : config.limits.history },
          memoryBytes: process.memoryUsage().rss, counts: ctx.historyReader.counts(),
          plugins: structuredClone(options.plugins()),
        };
      },
      conversations: async (query, scope, before) => {
        const page = ctx.historyReader.conversations(query, scope, before);
        return { ...page, items: await Promise.all(page.items.map(nameConversation)) };
      },
      timeline: async (id, before) => {
        const page = ctx.historyReader.timeline(id, before);
        return { ...page, conversation: await nameConversation(page.conversation) };
      },
      renameConversation: (id, alias, version) => ctx.historyReader.renameConversation(id, alias, version),
      recent: (limit, before, failures) => ctx.historyReader.recent(limit, before, failures),
      detail: id => ctx.historyReader.detail(id),
      // Compatibility for callers migrating to the owning log service.
      logs(after = 0) {
        const journal = ctx.get('processLogs');
        if (!journal) throw new Error('logging_unavailable');
        return journal.query({ after, limit: 500 });
      },
    });
  },
};
