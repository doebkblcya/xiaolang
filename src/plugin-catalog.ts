import type { Config, PluginEntry } from './config.js';

/** Delivery metadata only. Feature implementations live in the mounted packages. */
export const builtinTitles: Record<string, string> = {
  'xiaolang-logging': '日志处理', 'xiaolang-store': '会话存储', 'xiaolang-usage': '模型用量统计',
  'xiaolang-inspection': '运行观察', 'xiaolang-configuration': '配置管理', 'xiaolang-scheduler': '任务调度',
  'xiaolang-tools': '工具注册与执行', 'xiaolang-intake': '消息接纳', 'xiaolang-output': '统一发送',
  'xiaolang-chat': '默认聊天编排', 'xiaolang-fault-feedback': '故障反馈', loader: 'Cordis 插件加载器',
};
export const externalTitles: Record<string, string> = {
  'xiaolang-adapter': 'QQ 官方接入', 'xiaolang-deepseek': 'DeepSeek 模型', 'xiaolang-trigger': '消息触发',
  'xiaolang-memory': '聊天与记忆', 'xiaolang-persona': '人设与学习', 'xiaolang-web': '网页搜索与阅读',
  'xiaolang-mcp': 'MCP 接入', 'xiaolang-skills': 'Skills 接入', 'xiaolang-reminders': '定时提醒',
  'xiaolang-clock': '查询时间工具', 'xiaolang-basic-tools': '基础计算工具', panel: '管理面板', 'console-logger': '终端日志展示',
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
    ...configured.filter(entry => !defaults.some(item => item.id === entry.id) && !builtinTitles[entry.id])];
}
export function builtinEnabled(config: Config, id: string): boolean {
  return config.plugins?.entries.find(entry => entry.id === id)?.enabled !== false;
}
export function toggleImpact(id: string): string {
  if (id === 'panel') return '停用后网页入口会关闭，需在配置文件中重新启用。';
  if (id === 'xiaolang-configuration') return '停用后无法在面板修改配置，需编辑配置文件恢复。';
  if (id === 'loader') return '停用后所有外挂都不会加载，需编辑配置文件恢复。';
  if (id === 'xiaolang-adapter') return '停用后不再收发 QQ 消息；发送、聊天、提醒等待接入服务。';
  if (id === 'xiaolang-deepseek') return '停用后聊天、触发判断、记忆和学习等待模型服务。';
  if (id === 'xiaolang-trigger') return '停用后默认聊天等待触发服务，不再自动回复。';
  return '停用后停止该能力；依赖它的插件等待服务。配置与数据保留。';
}
