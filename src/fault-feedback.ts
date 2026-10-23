import type { Plugin } from 'cordis';
import type { Config } from './config.js';
import { code, check } from './errors.js';
import { log } from './contracts.js';

const reasons: Record<string, string> = {
  model_stream_interrupted: '模型流式连接中断', streaming_unavailable: '当前模型或发送插件不支持流式输出',
  qq_stream_length_limit: 'QQ 原生流式消息的剩余长度不足',
  model_output_too_long: '模型输出超过安全长度限制', qq_reply_part_limit: '回复超过 QQ 被动回复次数限制',
  model_timeout: '模型接口请求超时', model_network: '连接模型接口失败', model_empty_response: '模型没有返回可发送的回复',
  model_output_truncated: '模型输出达到 Token 上限，回复被截断', model_invalid_response: '模型返回格式不正确',
  model_invalid_json: '模型返回的数据无法解析', model_invalid_tool_calls: '模型返回了无效工具调用',
  turn_timeout: '本轮处理超过总时间限制', queue_full: '等待队列已满', queue_expired: '等待回复的时间过长',
  input_too_long: '本条消息与人设超过上下文长度限制', context_budget: '本轮上下文超过长度限制',
  step_budget: '模型与工具调用达到次数上限', too_many_tool_calls: '模型一次请求了过多工具',
  duplicate_tool_call: '模型重复请求了同一工具调用', tool_outcome_unknown: '工具操作结果未知，请先核对，避免重复操作',
  tool_unavailable: '需要的工具或插件不可用', invalid_tool_arguments: '工具参数不符合要求',
  tool_execution_failed: '工具执行失败', tool_admin_required: '此工具仅管理员可执行', internal_error: '小狼内部或插件处理异常',
};
export function failureText(failure: string, turn: string): string {
  const http = /^model_http_([1-5][0-9]{2})$/.exec(failure);
  const qq = /^qq_api_[0-9]{1,10}$/.test(failure);
  const safe = reasons[failure] ? failure : http || qq ? failure : 'internal_error';
  const reason = reasons[safe] ?? (qq ? 'QQ 平台拒绝本次发送，具体业务错误见后台' : ({ '401': '模型 API Key 无效或未授权', '403': '模型接口拒绝访问', '402': '模型账户余额不足',
    '429': '模型接口限流', '400': '模型请求参数被拒绝' }[http![1]!] ?? '模型接口服务异常') + `（HTTP ${http![1]}）`);
  return `⚠️ 小狼回复失败\n原因：${reason}\n错误码：${safe}\n轮次：${turn.slice(0, 8)}\n${safe === 'tool_outcome_unknown' ? '请先查看后台记录，再决定是否重试。' : '可稍后重试，详细记录见后台。'}`;
}
export const faultFeedbackPlugin: Plugin.Object<Config> = {
  name: 'xiaolang-fault-feedback', inject: ['output'], apply(ctx, config) {
    ctx.provide('faultFeedback', { async notify(turn, failure, signal) {
      if (config.failureFeedback?.enabled === false || failure === 'cancelled') return;
      check(signal);
      const output = ctx.output;
      if (!output.feedback) { log(ctx, 'feedback_unavailable', turn.id, 'feedback'); return; }
      try {
        const sent = await output.feedback(turn, failureText(failure, turn.id), AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        if (!sent) log(ctx, 'feedback_skipped', turn.id, 'feedback');
      } catch (error) { log(ctx, 'feedback_failed', turn.id, 'feedback', { errorCode: code(error) }); }
    } });
  },
};
