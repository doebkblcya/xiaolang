import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import { ProactiveTrigger } from './proactive.js';
import { emitLog, messageLog } from './contracts.js';

export { triggerSettings } from './trigger-config.js';
import { triggerSettings } from './trigger-config.js';

/** The only default trigger provider. Custom providers replace it, never run beside it. */
export const triggerPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-trigger', inject: ['store', 'model'], apply(ctx, config) {
    const settings = triggerSettings(config);
    const proactive = new ProactiveTrigger(settings.proactive, { model: ctx.model, persona: config.persona, usage: ctx.get('usage'),
      history: (message, limit) => ctx.store.records({ session: message.session, before: message.seq + 1, limit }),
      imageContext: message => ctx.get('memory')?.imageContext?.(message) ?? '', report: entry => emitLog(ctx, entry) });
    ctx.effect(() => () => proactive.clear());
    ctx.on('xiaolang/before-delete', () => proactive.clear());
    ctx.provide('trigger', { match(message) {
      if (!message.group && settings.privateReply) return 'private';
      if (message.group && settings.groupMention && message.segments.some(part => part.type === 'mention' && !part.all && (part.self || part.userId === message.account))) return 'mention';
      if (message.group && settings.groupReply && message.segments.some(part => part.type === 'reply' && (part.sender === message.account
        || part.seq !== undefined && ctx.store.record(part.seq)?.direction === 'out' && ctx.store.record(part.seq)?.session === message.session))) return 'quote';
      if (message.group && settings.groupKeywords && settings.words.some(word => message.text.includes(word))) return 'keyword';
      emitLog(ctx, { ...messageLog(message), code: 'trigger_unmatched', label: '未命中直接回复规则', stage: 'trigger',
        reason: !message.group ? '私聊自动回复已关闭' : [settings.groupMention ? '未命中 @小狼' : '@回复已关闭', settings.groupReply ? '未引用回复小狼' : '引用回复已关闭', settings.groupKeywords ? '未命中触发词' : '触发词回复已关闭'].join('；') });
      return undefined;
    }, observe: (message, dispatch) => proactive.observe(message, dispatch),
    queued: (message, reason) => proactive.queued(message, reason), settled: (message, replied) => proactive.settled(message, replied),
    current: message => proactive.current(message), begin: message => proactive.begin(message), beforeReply: (message, signal) => proactive.beforeReply(message, signal), idle: () => proactive.idle(), clear: () => proactive.clear() });
  },
};

/** Optional management-panel surfaces owned by this plugin. */
export const xiaolangPanel = { detail: { view: 'trigger-settings' }, pages: [{ id: 'trigger-settings', title: '触发规则', view: 'trigger-settings' }] };
