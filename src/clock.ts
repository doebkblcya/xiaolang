import type { Plugin } from 'cordis';
export const clockPlugin: Plugin.Object<void> = {
  name: 'xiaolang-clock', inject: ['tools'], apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'current_time', source: 'xiaolang-clock', description: '查询当前时间，返回 UTC 与北京时间。', effect: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ utc: new Date().toISOString(), shanghai: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }),
    }));
  },
};
