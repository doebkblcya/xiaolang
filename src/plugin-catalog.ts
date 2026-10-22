import type { Config, PluginEntry } from './config.js';

/** Delivery metadata only. Feature implementations live in the mounted packages. */
export const builtinTitles: Record<string, string> = {
  'xiaolang-logging': '日志', 'xiaolang-store': '会话存储', 'xiaolang-usage': '模型用量统计',
  'xiaolang-inspection': '运行观察', 'xiaolang-configuration': '配置管理', 'xiaolang-scheduler': '任务调度',
  'xiaolang-tools': '工具注册与执行', 'xiaolang-intake': '消息接纳', 'xiaolang-output': '统一发送',
  'xiaolang-chat': '默认聊天编排', 'xiaolang-fault-feedback': '故障反馈', loader: 'Cordis 插件加载器',
};
export const externalTitles: Record<string, string> = {
  'xiaolang-adapter': 'QQ 官方接入', 'xiaolang-deepseek': 'DeepSeek 模型', 'xiaolang-trigger': '消息触发',
  'xiaolang-memory': '聊天与记忆', 'xiaolang-persona': '人设与学习', 'xiaolang-web': '网页搜索与阅读',
  'xiaolang-mcp': 'MCP 接入', 'xiaolang-skills': 'Skills 接入', 'xiaolang-reminders': '定时提醒',
  'xiaolang-clock': '查询时间工具', 'xiaolang-basic-tools': '基础计算工具', panel: '管理面板',
};
export const officialIds = Object.keys(externalTitles).filter(id => !['panel', 'console-logger'].includes(id));
export const officialModule = (id: string) => `./${id}/index.mjs`;
export function pluginEntries(config: Config): PluginEntry[] {
  const configured = config.plugins?.entries ?? [];
  const defaults: PluginEntry[] = officialIds.filter(id => id !== 'xiaolang-trigger' || !config.plugins?.trigger).map(id => ({
    id, module: id === 'xiaolang-adapter' && config.adapter.module !== 'builtin:qq-official' ? config.adapter.module : officialModule(id),
    ...(id === 'xiaolang-adapter' ? { config: config.adapter.config } : {}),
  }));
  return [...defaults.map(entry => ({ ...entry, ...configured.find(item => item.id === entry.id) })),
    ...configured.filter(entry => entry.id !== 'console-logger' && !defaults.some(item => item.id === entry.id) && !builtinTitles[entry.id])];
}
export function builtinEnabled(config: Config, id: string): boolean {
  return config.plugins?.entries.find(entry => entry.id === id)?.enabled !== false;
}
