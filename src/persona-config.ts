import type { Config } from './config.js';
import type { Fields, ThinkingLevel } from './contracts.js';

export interface PersonaConfig {
  anchor: string;
  replyStyle: string;
  learningEnabled: boolean;
  learningThinking?: ThinkingLevel;
  batchSize: number;
  intervalMinutes: number;
  maxDailyCalls: number;
}
export const personaDefaults: PersonaConfig = {
  anchor: '你叫小狼，是一只四个多月的母猫，中华田园猫、彩狸。拟人后带幼童的直率和情绪，微傲娇、偏高冷，也会粘人、生气时会拍人。保持自己的性格，不刻意卖萌，不每句话都喵，不扮演客服。幼童感体现在表达和情绪，不限制理解、知识和工具能力。',
  replyStyle: '这是 QQ 聊天。自然接住眼前这句话，亲疏由实际聊天关系决定，通常只回一两句简短的话，不主动发散、长篇解释、列清单或做总结。需要时可以只回很短的一句。对方明确要求详细说明、执行任务时再按需要展开。情绪和亲疏随语境自然表达，不机械重复口头禅，不添加舞台动作或旁白，不强行抬杠。不要编造现实经历或工具结果。',
  learningEnabled: true, learningThinking: 'low', batchSize: 100, intervalMinutes: 30, maxDailyCalls: 12,
};
export function personaSettings(config: Config): PersonaConfig {
  // Old custom prompts remain authoritative until the owner explicitly configures this plugin.
  return config.character ? { learningThinking: 'low', ...config.character } : { ...personaDefaults, anchor: config.persona, learningEnabled: false };
}
export const personaProperties = {
  anchor: { type: 'string', title: '基础人设（仅手动修改）', minLength: 1, maxLength: 8000, description: '自动学习无法修改这部分。' },
  replyStyle: { type: 'string', title: '固定回复风格', minLength: 1, maxLength: 6000 },
  learningEnabled: { type: 'boolean', title: '后台学习聊天表达' },
  learningThinking: { type: 'string', title: '表达学习思考档位', enum: ['off', 'low', 'high', 'max'], default: 'low', description: '只影响后台表达学习，不改变聊天回复。思考与结果共享 8192 Token 上限，每次请求限时 60 秒。高档更耗时，可能触及上限。' },
  batchSize: { type: 'integer', title: '每批最多用户消息数', minimum: 20, maximum: 100 },
  intervalMinutes: { type: 'integer', title: '学习间隔（分钟）', minimum: 5, maximum: 1440 },
  maxDailyCalls: { type: 'integer', title: '每天学习调用上限（北京时间）', minimum: 1, maximum: 48 },
};
export const personaSchema: Fields = { type: 'object', additionalProperties: false, required: Object.keys(personaProperties), properties: personaProperties };
