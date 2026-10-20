// External Cordis plugin: edit this mounted file and restart; no image rebuild.
export const name = 'xiaolang-console-logger';
export const xiaolangApiVersion = 1;

const labels = {
  api_usage: 'API 用量', usage_record_failed: '用量写入失败',
  application_ready: '小狼已就绪', application_stopping: '小狼正在停止', application_failed: '启动失败',
  qq_connected: 'QQ 已连接', qq_disconnected: 'QQ 已断开', qq_connection_error: 'QQ 连接错误',
  qq_connection_failed: 'QQ 连接失败', qq_event_failed: 'QQ 消息解析失败',
  adapter_group_messages_limited: '当前声明仅接收群 @ 消息，非 @ 推送权限尚待验证',
  message_received: '收到消息', message_ignored: '忽略消息', trigger_matched: '触发回复',
  turn_queued: '等待调度', turn_started: '开始处理', model_started: '调用模型',
  model_completed: '模型返回', model_failed: '模型调用失败', reply_generated: '生成回复',
  tool_started: '调用工具', tool_completed: '工具完成', tool_failed: '工具失败', tool_unknown: '工具结果未知',
  send_started: '发送回复', send_confirmed: 'QQ 已确认发送', send_failed: '发送失败', send_unknown: '发送结果未知',
  turn_completed: '本轮完成', turn_failed: '本轮失败',
  feedback_started: '发送故障提示', feedback_sent: '故障提示已发送', feedback_failed: '故障提示发送失败', feedback_unknown: '故障提示结果未知', feedback_skipped: '未追加故障提示',
  panel_listening: '面板已启动', panel_server_error: '面板服务异常',
  memory_recalled: '读取聊天与记忆', memory_processing_started: '开始整理记忆', memory_processing_completed: '记忆整理完成',
  memory_processing_failed: '记忆整理失败', memory_vector_fallback: '向量不可用，使用关键词检索', memory_summary_failed: '聊天摘要整理失败', memory_image_unavailable: '图片暂时无法读取',
  memory_image_described: '图片描述已生成',
  proactive_state: '插话状态更新', proactive_observing: '收集待判断消息', proactive_judge_started: '判断是否接话',
  proactive_decided: '接话判断完成', proactive_skipped: '本次未接话', proactive_judge_failed: '接话判断失败，保持沉默',
};
Object.assign(labels, { reminder_created: '已创建提醒', reminder_cancelled: '已取消提醒', reminder_queued: '提醒等待发送', reminder_send_started: '开始发送提醒', reminder_sent: '提醒已确认发送', reminder_failed: '提醒发送失败', reminder_unknown: '提醒发送结果未知', reminder_scheduler_failed: '提醒调度异常', reminder_history_failed: '提醒已发出，聊天记录写入失败' });
Object.assign(labels, { persona_learning_started: '开始学习聊天表达', persona_learning_completed: '表达学习完成', persona_learning_failed: '表达学习未完成' });
const reasons = {
  private: '私聊默认回复', mention: '@机器人', keyword: '命中触发词', proactive: '主动插话', no_trigger: '未命中直接触发条件',
  duplicate: '重复消息', own_message: '机器人自身消息', group_not_allowed: '群不在白名单',
  account_mismatch: '账号不匹配', invalid_message: '消息格式无效', chat_disabled: '聊天链路已停用',
};
export function formatText(entry) {
  const text = [`${entry.time} ${entry.level?.toUpperCase()} ${labels[entry.code] ?? entry.code}`, `event=${entry.code}`];
  if (entry.scope) text.push(entry.scope === 'private' ? '私聊' : '群聊');
  if (entry.sender) text.push(`用户=${JSON.stringify(entry.sender)}`);
  if (entry.group) text.push(`群=${JSON.stringify(entry.group)}`);
  if (entry.reason) text.push(`原因=${reasons[entry.reason] ?? entry.reason}`);
  if (entry.preview !== undefined) text.push(`内容=${JSON.stringify(entry.preview)}`);
  if (entry.taskId) text.push(`提醒=${entry.taskId}`);
  if (entry.turn) text.push(`turn=${entry.turn}`);
  if (entry.messageId) text.push(`message=${entry.messageId}`);
  if (entry.model) text.push(`模型=${entry.model}`);
  if (entry.purpose) text.push(`用途=${({ chat: '聊天回复', proactive: '插话判断', memory_extract: '记忆提炼', memory_summary: '聊天摘要', persona_learn: '表达学习', image_description: '图片描述', image_inspect: '重看图片', embedding_recall: '向量检索', embedding_index: '记忆向量入库', embedding_test: '向量测试', web_search: '网页搜索', web_fetch: '网页阅读', other: '其他' })[entry.purpose] ?? entry.purpose}`);
  for (const [key, title] of Object.entries({ inputTokens: '输入Token', outputTokens: '输出Token', totalTokens: '合计Token', cachedTokens: '缓存命中', reasoningTokens: '思考Token' })) if (entry[key] !== undefined) text.push(`${title}=${entry[key]}`);
  if (entry.attempt > 1) text.push(`尝试=${entry.attempt}`);
  if (entry.step !== undefined) text.push(`模型步骤=${entry.step}`);
  if (entry.tool) text.push(`工具=${JSON.stringify(entry.tool)}`);
  if (entry.toolCalls !== undefined) text.push(`工具调用数=${entry.toolCalls}`);
  if (entry.part !== undefined) text.push(`分段=${entry.part}/${entry.parts}`);
  if (entry.waitMs !== undefined) text.push(`排队=${entry.waitMs}ms`);
  if (entry.durationMs !== undefined) text.push(`耗时=${entry.durationMs}ms`);
  if (entry.state) text.push(`状态=${({ active: '活跃', idle: '旁观', speak: '决定接话', silent: '保持沉默' })[entry.state] ?? entry.state}`);
  if (entry.errorCode) text.push(`错误=${entry.errorCode}`);
  if (entry.receipt) text.push(`回执=${JSON.stringify(entry.receipt)}`);
  if (entry.plugin) text.push(`插件=${entry.plugin}`);
  if (entry.dependencies?.length) text.push(`缺少依赖=${entry.dependencies.join(',')}`);
  return text.join(' | ');
}

export function apply(ctx, config = {}) {
  const format = config.format ?? 'text';
  if (!['text', 'json'].includes(format)) throw new Error('invalid_log_format');
  ctx.provide('logOutput', {
    write(entry) { console.info(format === 'json' ? JSON.stringify(entry) : formatText(entry)); },
  });
}
