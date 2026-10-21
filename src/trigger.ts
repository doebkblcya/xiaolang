import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import { ProactiveTrigger } from './proactive.js';
import { emitLog } from './contracts.js';

export { triggerSettings } from './trigger-config.js';
import { triggerSettings } from './trigger-config.js';

/** The only default trigger provider. Custom providers replace it, never run beside it. */
export const triggerPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-trigger', inject: ['store', 'model'], apply(ctx, config) {
    const settings = triggerSettings(config);
    const proactive = new ProactiveTrigger(settings.proactive, { model: ctx.model, persona: config.persona, usage: ctx.get('usage'),
      history: (message, limit) => ctx.store.records({ session: message.session, limit }),
      imageContext: message => ctx.get('memory')?.imageContext?.(message) ?? '', report: entry => emitLog(ctx, entry) });
    ctx.effect(() => () => proactive.clear());
    ctx.provide('trigger', { match(message) {
      if (!message.group) return settings.privateReply ? 'private' : undefined;
      if (settings.groupMention && message.segments.some(part => part.type === 'mention' && part.userId === message.account)) return 'mention';
      if (settings.groupKeywords && settings.words.some(word => message.text.includes(word))) return 'keyword';
      return undefined;
    }, observe: (message, dispatch) => proactive.observe(message, dispatch),
    queued: (message, reason) => proactive.queued(message, reason), settled: (message, replied) => proactive.settled(message, replied),
    current: message => proactive.current(message), idle: () => proactive.idle(), clear: () => proactive.clear() });
  },
};
