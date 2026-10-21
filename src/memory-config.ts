import type { Fields, ThinkingLevel } from './contracts.js';

export const summaryLimits = { maxOutputTokens: 32768, timeoutMs: 180000 } as const;

export interface MemoryConfig {
  enabled: boolean;
  extractionThinking?: ThinkingLevel;
  summaryThinking?: ThinkingLevel;
  imageDescriptionThinking?: ThinkingLevel;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  recentMessages: number;
  recallLimit: number;
  contextChars: number;
  batchSize: number;
  batchSeconds: number;
  images: boolean;
  maxImages: number;
}
export const memoryDefaults: MemoryConfig = {
  enabled: false, extractionThinking: 'low', summaryThinking: 'off', imageDescriptionThinking: 'off', embeddingBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  embeddingModel: 'text-embedding-v4', embeddingDimensions: 1024,
  recentMessages: 100, recallLimit: 8, contextChars: 5000, batchSize: 20, batchSeconds: 60, images: true, maxImages: 3,
};
export const memoryProperties = {
  enabled: { type: 'boolean', title: '启用聊天与记忆', default: false },
  embeddingBaseUrl: { type: 'string', title: '百炼 API 地址', minLength: 1, maxLength: 1000, description: '填写所在地域或业务空间的 OpenAI 兼容地址，自动追加 /embeddings。' },
  embeddingModel: { type: 'string', title: '向量模型', minLength: 1, maxLength: 100 },
  embeddingDimensions: { type: 'integer', title: '向量维度', enum: [64, 128, 256, 512, 768, 1024, 1536, 2048] },
  recentMessages: { type: 'integer', title: '保留最近原文条数', minimum: 5, maximum: 100 },
  recallLimit: { type: 'integer', title: '每轮最多召回记忆数', minimum: 1, maximum: 20 },
  contextChars: { type: 'integer', title: '记忆与摘要字数预算', minimum: 500, maximum: 12000 },
  batchSize: { type: 'integer', title: '每批整理聊天条数', minimum: 1, maximum: 50 },
  batchSeconds: { type: 'integer', title: '后台整理间隔（秒）', minimum: 15, maximum: 3600 },
  extractionThinking: { type: 'string', title: '记忆提炼思考档位', enum: ['off', 'low', 'high', 'max'], default: 'low', description: '只影响记忆提炼，不影响图片、摘要或聊天回复。思考与结果共享 8192 Token 上限，每次请求限时 60 秒。高档更耗时，可能触及上限。' },
  summaryThinking: { type: 'string', title: '聊天摘要思考档位', enum: ['off', 'low', 'high', 'max'], default: 'off', description: '只影响较早聊天的摘要，思考与摘要共用 32768 Token 上限、180 秒请求时限。失败后按进度冷却，不因下一条聊天立刻重试。' },
  imageDescriptionThinking: { type: 'string', title: '图片描述思考档位', enum: ['off', 'low', 'high', 'max'], default: 'off', description: '只影响给历史和摘要使用的图片短描述。重看图片直接交给回复模型，沿用回复模型的思考设置。' },
  images: { type: 'boolean', title: '理解聊天图片' },
  maxImages: { type: 'integer', title: '单轮最多图片数', minimum: 1, maximum: 5 },
};
export const memorySchema: Fields = { type: 'object', additionalProperties: false, required: Object.keys(memoryProperties), properties: {
  ...memoryProperties, apiKey: { type: 'string', title: '百炼 API Key', writeOnly: true, maxLength: 4096, description: '留空保留已有密钥；缺少密钥时仅使用关键词检索。' },
} };
