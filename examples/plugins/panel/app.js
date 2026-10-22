'use strict';
const $ = id => document.getElementById(id);
const usageNames = { chat: '聊天回复', proactive: '插话判断', memory_extract: '记忆提炼', memory_summary: '聊天摘要', persona_learn: '表达学习',
  image_description: '图片描述', image_inspect: '重看图片', embedding_recall: '向量检索', embedding_index: '记忆向量入库', embedding_test: '向量连接测试',
  web_search: '网页搜索', web_fetch: '网页阅读', other: '其他调用' };
const words = { connected: '已连接', disconnected: '已断开', starting: '启动中', ready: '已就绪', stopping: '停止中', failed: '失败', error: '连接异常',
  completed: '已完成', queued: '等待处理', running: '处理中', sending: '发送中', unknown: '结果未知', expired: '已过期', cancelled: '已取消',
  active: '已启用', disabled: '已停用', pending: '等待激活', scheduled: '等待到点', sent: '已确认发送', succeeded: '已成功', private: '私聊', mention: '@机器人', keyword: '触发词' };
const stages = { application_ready: '小狼已就绪', application_stopping: '小狼正在停止', application_failed: '启动失败', qq_connected: 'QQ 已连接', qq_disconnected: 'QQ 已断开',
  qq_connection_error: 'QQ 连接异常', qq_connection_failed: 'QQ 连接失败', adapter_group_messages_limited: '非 @ 群消息推送权限待验证', panel_listening: '面板已启动', feedback_started: '发送故障提示', feedback_sent: '故障提示已确认发送', feedback_failed: '故障提示发送失败', feedback_unknown: '故障提示结果未知', feedback_skipped: '未追加故障提示',
  message_received: '收到消息', message_ignored: '忽略消息', trigger_matched: '触发回复', turn_queued: '等待调度', turn_started: '开始处理',
  model_started: '调用模型', model_completed: '模型返回', model_failed: '模型调用失败', reply_generated: '生成回复',
  tool_started: '调用工具', tool_completed: '工具完成', tool_failed: '工具失败', tool_unknown: '工具结果未知',
  send_started: '发送回复', send_confirmed: 'QQ 已确认发送', send_failed: '发送失败', send_unknown: '发送结果未知', turn_completed: '本轮完成' };
Object.assign(stages, { memory_recalled: '读取聊天与记忆', memory_processing_started: '开始整理记忆', memory_processing_completed: '记忆整理完成', memory_processing_failed: '记忆整理失败', memory_vector_fallback: '向量不可用，使用关键词检索', memory_summary_failed: '聊天摘要整理失败', memory_image_unavailable: '图片暂时无法读取', memory_image_described: '图片描述已生成' });
Object.assign(stages, { persona_learning_started: '开始学习聊天表达', persona_learning_completed: '表达学习完成', persona_learning_failed: '表达学习未完成' });
const reasons = { private: '私聊默认回复', mention: '@机器人', keyword: '命中触发词', no_trigger: '未触发回复', duplicate: '重复消息', own_message: '机器人自身消息', group_not_allowed: '群不在白名单', chat_disabled: '聊天已停用', invalid_message: '格式无效', account_mismatch: '账号不匹配' };
const viewTitles = { overview: '主页', chats: '聊天记录', logs: '过程日志', usage: '模型用量', 'model-settings': '回复模型', 'qq-settings': 'QQ 接入', memories: '聊天与记忆', persona: '人设与学习', tooling: '工具与行动', reminders: '定时提醒', plugins: '插件' };
Object.assign(stages, { api_usage: 'API 用量记录', usage_record_failed: '用量记录写入失败' });
Object.assign(stages, { tool_image_attached: '原图已交给回复模型' });
Object.assign(stages, { reminder_created: '已创建提醒', reminder_cancelled: '已取消提醒', reminder_queued: '提醒等待发送', reminder_send_started: '开始发送提醒', reminder_sent: '提醒已确认发送', reminder_failed: '提醒发送失败', reminder_unknown: '提醒发送结果未知', reminder_scheduler_failed: '提醒调度异常', reminder_history_failed: '提醒已发出，聊天记录写入失败' });
Object.assign(stages, { mcp_connected: 'MCP 已连接', mcp_connection_failed: 'MCP 连接失败', mcp_tool_rejected: 'MCP 工具注册失败' });
Object.assign(stages, { proactive_state: '插话状态更新', proactive_observing: '收集待判断消息', proactive_judge_started: '判断是否接话', proactive_decided: '接话判断完成', proactive_skipped: '本次未接话', proactive_judge_failed: '接话判断失败，保持沉默' });
Object.assign(stages, { panel_tls_reloaded: '面板证书已重新加载', panel_tls_reload_failed: '面板新证书暂时无法加载，保留原证书' });
Object.assign(reasons, { proactive: '主动插话', no_trigger: '未命中直接触发条件' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let logs = [], cursor = 0, busy = false, selected, runStarted;
let settings, settingsLoading = false, applying = false;
const dirtyForms = new Set();
let pluginDetails, pluginDirty = false;
const triggerForm = $('trigger-form');
function parkTriggerForm() { $('trigger-settings').append(triggerForm); }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function time(value, full = false) { const date = new Date(value); return Number.isFinite(date.getTime()) ? (full ? dateFormat : timeFormat).format(date) : '—'; }
function tone(state) { return ['completed', 'connected', 'active', 'sent', 'succeeded', 'ready'].includes(state) ? 'good' : ['failed', 'error', 'unknown'].includes(state) ? 'bad' : ['queued', 'running', 'sending', 'pending', 'starting'].includes(state) ? 'waiting' : 'neutral'; }
function badge(state) { return element('span', `badge ${tone(state)}`, words[state] ?? state); }
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
let authenticationLost = false;
function checkAccess(response) {
  if (response.status === 401 && !authenticationLost) { authenticationLost = true; location.reload(); }
}
async function get(path) { const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(7000) }); checkAccess(response); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
let registeredPages = [], detailDeclarations = {}, customCleanup, customPageVersion = 0;
function showView(requested) {
  customCleanup?.(); customCleanup = undefined;
  const version = ++customPageVersion;
  const page = registeredPages.find(page => page.id === requested || page.view === requested);
  const view = page?.view ?? (page?.entry ? `registered-${page.id}` : requested);
  if (page?.entry && !$(view)) { const section = element('section', 'view'); section.id = view; $('notice').parentNode.insertBefore(section, document.querySelector('footer')); }
  if (!$(view)?.classList.contains('view')) return;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== view;
  for (const button of document.querySelectorAll('.nav')) { button.classList.toggle('active', button.dataset.view === (page?.id ?? view)); if (button.dataset.view === (page?.id ?? view)) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  $('page-title').textContent = page?.title ?? viewTitles[view] ?? requested;
  document.title = `小狼 · ${$('page-title').textContent}`;
  window.scrollTo(0, 0);
  if (page?.entry) mountPanelContent(page, $(view)).then(cleanup => { if (version === customPageVersion) customCleanup = cleanup; else cleanup?.(); }).catch(() => notice('页面加载失败'));
  if (view === 'overview') refreshSystem();
  if (view === 'chats') refreshChats();
  if (view === 'memories') refreshMemory();
  if (view === 'persona') refreshPersona();
  if (view === 'tooling') refreshTools();
  if (view === 'reminders') refreshReminders();
  if (view === 'logs') renderLogs();
  if (view === 'usage') refreshUsage();
  if (view.endsWith('-settings') && !settings) loadSettings();
}
async function mountPanelContent(content, root, plugin) {
  const controller = new AbortController();
  const target = element('div', 'plugin-content'); root.replaceChildren(target);
  const module = await import(content.entry);
  if (typeof module.mount !== 'function') throw new Error('invalid_panel_module');
  const cleanup = await module.mount({ root: target, plugin: plugin ?? { id: content.plugin }, signal: controller.signal,
    api: { get, request: async (path, body) => { if (!settings) await loadSettings(); const result = await settingsRequest(path, body); if (result.model && result.qq && result.trigger) fillSettings(result); return result; } },
    navigate: showView, openPlugin });
  return () => { controller.abort(); if (typeof cleanup === 'function') cleanup(); target.remove(); };
}
async function loadPanel() {
  try {
    const registration = await get('/api/panel'); registeredPages = registration.pages; detailDeclarations = registration.details;
    $('plugin-navigation').replaceChildren(...registeredPages.map(page => {
      const button = element('button', 'nav'), mark = element('span', 'nav-page-mark'); mark.setAttribute('aria-hidden', 'true');
      button.type = 'button'; button.dataset.view = page.id; button.append(mark, document.createTextNode(page.title));
      button.addEventListener('click', () => showView(page.id)); return button;
    }));
  } catch { notice('插件页面加载失败'); }
}
function bytes(value) { return value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GB` : `${(value / 1048576).toFixed(1)} MB`; }
async function refreshSystem() {
  try {
    const data = await get('/api/panel/system');
    $('host-cpu').textContent = data.machine.cpuModel; $('host-cores').textContent = data.machine.logicalCpus;
    $('host-memory').textContent = bytes(data.machine.memoryTotal); $('host-system').textContent = `${data.machine.platform} / ${data.machine.arch}`;
    $('process-memory').textContent = bytes(data.process.memoryBytes);
    $('process-cpu').textContent = `${data.process.cpuPercent.toFixed(2)}%`;
    $('process-cpu').title = '相对于全部逻辑核心'; $('process-heap').textContent = bytes(data.process.heapBytes); $('process-node').textContent = data.process.nodeVersion;
    $('container-limit-row').hidden = !data.container.memoryLimit; $('container-limit').textContent = data.container.memoryLimit ? bytes(data.container.memoryLimit) : '—';
  } catch { $('process-memory').textContent = '暂时无法读取'; }
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', event => {
  if (button.tagName === 'A') { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); }
  showView(button.dataset.view);
});
for (const button of document.querySelectorAll('[data-open-plugin]')) button.addEventListener('click', () => openPlugin(button.dataset.openPlugin));
function renderStatus(status) {
  $('hero-state').textContent = status.state === 'ready' && status.connection === 'connected' ? '运行正常' : status.state === 'ready' ? '等待连接' : '启动中';
  $('today-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  $('qq-state').textContent = words[status.connection] ?? status.connection;
  $('platform').textContent = status.platform?.includes('sandbox') ? 'QQ 官方机器人 · 沙箱环境' : status.platform === 'qq-official' ? 'QQ 官方机器人 · 正式环境' : status.platform ?? '正在启动接入';
  $('model').textContent = status.model;
  $('chat-state').textContent = status.chatEnabled ? '聊天链路已启用' : '聊天链路已停用';
  $('pending').textContent = `${(status.counts.running ?? 0) + (status.counts.sending ?? 0)} / ${status.counts.queued ?? 0}`;
  $('completed').textContent = `已完成 ${status.counts.completed ?? 0} 轮`;
  const seconds = Math.floor(status.uptimeMs / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  $('uptime').textContent = hours ? `${hours} 小时 ${minutes % 60} 分` : minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  $('memory').textContent = `进程内存 ${(status.memoryBytes / 1048576).toFixed(1)} MB`;
  $('app-state').textContent = words[status.state] ?? status.state;
  $('failures').textContent = ['failed', 'unknown', 'cancelled', 'expired'].reduce((total, key) => total + (status.counts[key] ?? 0), 0);
  $('last-message').textContent = status.lastMessage ? time(status.lastMessage, true) : '本次启动尚无消息';
  const active = status.plugins.filter(plugin => plugin.state === 'active').length;
  $('plugin-count').textContent = `${active} / ${status.plugins.length}`;
  const builtin = status.plugins.filter(plugin => plugin.kind === 'builtin').length;
  $('plugins-summary').textContent = `内置 ${builtin} · 外挂 ${status.plugins.length - builtin} · 已启用 ${active}`;
  $('plugin-empty').hidden = status.plugins.length > 0;
  renderPlugins(status.plugins);
}
let pluginCatalog = [];
function renderPlugins(plugins = pluginCatalog) {
  pluginCatalog = plugins;
  const query = $('plugin-search').value.trim().toLowerCase(), source = $('plugin-source').value;
  const filtered = plugins.filter(plugin => (!source || plugin.kind === source) && `${plugin.title} ${plugin.id}`.toLowerCase().includes(query));
  $('plugin-empty').hidden = filtered.length > 0;
  $('plugin-empty').textContent = '暂无匹配插件';
  $('plugin-rows').replaceChildren(...filtered.map(plugin => {
    const card = element('button', 'plugin-card'); card.type = 'button'; card.setAttribute('aria-label', `查看插件：${plugin.title ?? plugin.id}`);
    const head = element('div', 'plugin-card-heading'), mark = element('span', 'plugin-card-mark', plugin.kind === 'builtin' ? '◇' : '◈');
    head.append(mark, badge(plugin.state));
    const foot = element('div', 'plugin-card-footer'); foot.append(element('span', '', plugin.kind === 'builtin' ? '内置' : '外挂'), element('span', '', '↗'));
    card.append(head, element('strong', '', plugin.title ?? plugin.id), element('small', 'module', plugin.id), foot);
    card.addEventListener('click', () => openPlugin(plugin.id)); return card;
  }));
}
$('plugin-search').addEventListener('input', () => renderPlugins());
$('plugin-source').addEventListener('change', () => renderPlugins());

function logMeta(entry) {
  const values = [];
  if (entry.reason) values.push(reasons[entry.reason] ?? entry.reason);
  if (entry.code.startsWith('proactive_') && entry.state) values.push(({ active: '活跃', idle: '旁观', speak: '决定接话', silent: '保持沉默' })[entry.state] ?? entry.state);
  if (entry.model) values.push(entry.model);
  if (entry.imageCount !== undefined) values.push(`本次附图 ${entry.imageCount} 张`);
  if (entry.purpose) values.push(usageNames[entry.purpose] ?? entry.purpose);
  if (entry.inputTokens !== undefined) values.push(`输入 ${entry.inputTokens} Token`);
  if (entry.outputTokens !== undefined) values.push(`输出 ${entry.outputTokens} Token`);
  if (entry.totalTokens !== undefined) values.push(`合计 ${entry.totalTokens} Token`);
  if (entry.cachedTokens !== undefined) values.push(`缓存命中 ${entry.cachedTokens}`);
  if (entry.reasoningTokens !== undefined) values.push(`思考 ${entry.reasoningTokens}`);
  if (entry.attempt > 1) values.push(`第 ${entry.attempt} 次尝试`);
  if (entry.step) values.push(`步骤 ${entry.step}`);
  if (entry.tool) values.push(`工具 ${entry.tool}`);
  if (entry.waitMs !== undefined) values.push(`排队 ${entry.waitMs} ms`);
  if (entry.durationMs !== undefined) values.push(`耗时 ${entry.durationMs} ms`);
  if (entry.part) values.push(`第 ${entry.part}/${entry.parts} 段`);
  if (entry.errorCode) values.push(entry.errorCode);
  if (entry.turn) values.push(`turn=${entry.turn}`);
  if (entry.taskId) values.push(`提醒 ${entry.taskId}`);
  return values.join(' · ');
}
function renderLogs() {
  const filter = $('log-filter').value.trim().toLowerCase();
  const matched = logs.filter(({ entry }) => !filter || [stages[entry.code], JSON.stringify(entry)].join(' ').toLowerCase().includes(filter));
  $('log-count').textContent = matched.length;
  $('log-list').replaceChildren(...matched.map(({ entry }) => {
    const row = element('div', `log-line ${entry.level ?? 'info'}`), body = element('div');
    row.append(element('time', '', time(entry.time))); body.append(element('strong', '', stages[entry.code] ?? entry.code));
    if (entry.preview !== undefined) body.append(element('p', 'log-preview', entry.preview));
    body.append(element('div', 'log-meta', logMeta(entry))); row.append(body); return row;
  }));
  if (!matched.length) $('log-list').append(element('p', 'empty', '暂无匹配日志（仅显示本次启动的最近 500 条）'));
  if ($('follow').checked) $('log-list').scrollTop = $('log-list').scrollHeight;
  $('recent-events').replaceChildren(...logs.slice(-6).reverse().map(({ entry }) => {
    const row = element('div', 'activity'), body = element('div');
    body.append(element('div', '', stages[entry.code] ?? entry.code), element('p', '', entry.preview ?? logMeta({ ...entry, turn: undefined })));
    row.append(element('span', 'dot'), body, element('time', '', time(entry.time))); return row;
  }));
  if (!logs.length) $('recent-events').append(element('p', 'empty', '等待小狼的第一条动态'));
}
function detailSection(title, text, className = '') {
  const section = element('section', 'detail-section'); section.append(element('h3', '', title), element('div', `bubble ${className}`, text)); return section;
}
async function openDetail(id) {
  selected = id; $('detail-body').replaceChildren(element('p', 'empty', '正在读取…'));
  if (!$('detail').open) $('detail').showModal();
  try {
    const detail = await get(`/api/turns/${encodeURIComponent(id)}`);
    if (selected !== id) return;
    const body = $('detail-body'), meta = element('div', 'detail-meta');
    meta.append(badge(detail.state), element('span', '', time(detail.received, true)), element('span', '', reasons[detail.reason] ?? detail.reason));
    body.replaceChildren(meta, element('p', 'mono', `轮次 ${detail.id}`));
    if (detail.errorCode) body.append(element('p', 'error-box', `失败原因：${detail.errorCode}。发送结果未知时不会自动重发，请核对 QQ。`));
    body.append(detailSection(`收到消息${detail.inputTruncated ? '（已截断）' : ''}`, detail.input || '（非文字消息）'));
    body.append(detailSection(`已确认回复${detail.replyTruncated ? '（已截断）' : ''}`, detail.reply || '尚无已确认发送的回复', 'reply'));
    if (detail.sends.length) {
      const section = element('section', 'detail-section'); section.append(element('h3', '', '逐段发送结果'));
      for (const send of detail.sends) { const row = element('div', 'send-line'); row.append(element('span', 'muted', send.kind === 'feedback' ? '故障提示 ' : `第 ${send.part} 段 `), badge(send.state), element('p', '', send.text)); if (send.receipt) row.append(element('div', 'mono', `回执 ${send.receipt}`)); section.append(row); }
      body.append(section);
    }
    try { const recall = await get(`/api/memory-recalls/${encodeURIComponent(id)}`);
      if (selected === id && (recall.items?.length || recall.summary)) body.append(detailSection('本轮使用的记忆与摘要', [recall.summary ? `摘要：${recall.summary}` : '', ...(recall.items ?? []).map(item => `${item.content}\n记忆 ${item.id} · 来源 ${item.sources.join(', ')}`)].filter(Boolean).join('\n\n')));
    } catch { /* Older server versions may not expose memories. */ }
    if (detail.tools.length) body.append(detailSection('工具调用', detail.tools.map(tool => `${tool.name} · ${words[tool.state] ?? tool.state}`).join('\n')));
    try {
      const usage = await get(`/api/usage?range=all&turn=${encodeURIComponent(id)}`);
      if (selected === id) body.append(detailSection('本轮 API 用量', usage.summary.calls ? [
        `合计 ${numberText(usage.summary.total)} Token · ${usage.summary.calls} 次请求${usage.summary.unknown ? ` · ${usage.summary.unknown} 次用量未知` : ''}`,
        ...usage.byPurpose.map(row => `${usageNames[row.purpose] ?? row.purpose}：输入 ${numberText(row.input)}，输出 ${numberText(row.output)}，合计 ${numberText(row.total)} Token`),
      ].join('\n') : '这轮没有用量记录（更新前的调用无法补算）。'));
    } catch { /* Usage may be unavailable on an older server. */ }
    const button = element('button', 'secondary detail-log-button', '查看这一轮的过程日志');
    button.addEventListener('click', () => { $('detail').close(); selected = undefined; $('log-filter').value = detail.id; showView('logs'); }); body.append(button);
  } catch { $('detail-body').replaceChildren(element('p', 'error-box', '暂时无法读取详情，请关闭后重试。')); }
}
$('close-detail').addEventListener('click', () => { selected = undefined; $('detail').close(); });
$('detail').addEventListener('close', () => { selected = undefined; });
$('log-filter').addEventListener('input', renderLogs);
$('clear-filter').addEventListener('click', () => { $('log-filter').value = ''; renderLogs(); });
$('follow').addEventListener('change', renderLogs);
async function poll() {
  if (busy) return; busy = true;
  try {
    const [status, initialPage] = await Promise.all([get('/api/status'), get(`/api/logs?after=${cursor}`)]);
    let page = initialPage;
    if (runStarted !== undefined && runStarted !== status.started) { logs = []; page = await get('/api/logs?after=0'); }
    if (runStarted !== undefined && runStarted !== status.started) {
      settings = undefined; dirtyForms.clear(); await loadSettings(); await loadPanel();
    }
    if (applying && status.state === 'ready') { await loadSettings(); if (settings && !settings.pendingRestart) { applying = false; fillSettings(settings); } }
    runStarted = status.started;
    renderStatus(status);
    if (!$('overview').hidden) await refreshSystem();
    if (page.reset) logs = [];
    if (page.items.length || page.reset) { logs = [...logs, ...page.items].slice(-500); renderLogs(); }
    cursor = page.cursor;
    notice('');
    if (!$('chats').hidden) await refreshChats();
    if (!$('tooling').hidden) await refreshTools();
    if (!$('reminders').hidden) await refreshReminders();
    if (!$('usage').hidden && Date.now() - usageUpdated > 10000) await refreshUsage(false);
  } catch { notice('连接中断，显示上次数据。'); }
  finally { busy = false; }
}

const settingsErrors = {
  data_busy: '小狼正在处理消息或发送提醒，请稍后再删。', message_not_found: '这条消息已经不存在，请刷新。', invalid_delete_request: '删除请求无效，请刷新后重试。',
  conversation_conflict: '会话备注已被修改，请关闭窗口重新编辑。', invalid_conversation_request: '备注最多 80 字，不能包含换行。', conversation_not_found: '会话已不存在，请刷新列表。',
  persona_rate_limited: '已达到学习冷却时间或每日上限。', persona_not_enough_messages: '本批用户消息不足，继续聊天后再学习。', persona_catalog_full: '表达习惯已达上限，后续只更新已有习惯。', persona_busy: '正在学习，请稍后刷新。', invalid_persona_result: '本次学习结果未通过检查，没有修改已有习惯。',
  persona_conflict: '这条习惯已被修改，请重新打开。', invalid_persona_request: '表达习惯字段不正确，请检查内容与关键词。', persona_not_found: '这条习惯已不存在。', persona_disabled: '后台学习尚未开启。',
  reminder_not_found: '这条提醒已不存在，请刷新列表。', invalid_reminder_request: '提醒参数不正确。', reminders_unavailable: '定时提醒服务暂时不可用。',
  memory_conflict: '记忆已更新，请关闭详情重新读取后再修改。', invalid_memory_request: '记忆字段填写不正确，请检查内容、用户ID或有效期。', memory_not_found: '这条记忆已不存在。', memory_disabled: '记忆功能尚未启用，请先在插件配置中开启并应用。', embedding_key_missing: '尚未配置百炼 API Key。', embedding_http_401: '百炼鉴权失败，请检查 API Key 和业务空间地址。', embedding_http_403: '百炼未授权此模型，请检查模型权限和地址。', embedding_http_404: '百炼地址或模型标识不正确。', embedding_network: '向量服务暂时无法连接或请求超时。', settings_conflict: '配置已被其他页面修改，请重新读取后再保存。', settings_busy: '配置正在保存或应用，请稍后重试。',
  chat_busy: '小狼正在处理消息，请等回复结束后再应用。已保存的配置不会丢失。', no_pending_settings: '没有需要应用的新配置。',
  invalid_config: '参数不符合范围，请检查表单。', invalid_qq_config: 'QQ 配置不完整或超出范围，请检查。',
  invalid_saved_settings: '配置不符合要求，请检查字段和填写范围。', invalid_secret: '密钥格式不正确，请检查是否包含换行。',
  invalid_url: 'API 地址格式不正确，不能包含账号、密码或查询参数。',
  write_authorization_required: '页面连接已更新，请重新读取配置后再保存。', configuration_unavailable: '当前运行方式没有启用配置写入服务。',
  trigger_configuration_unavailable: '当前使用外部触发插件，请配置该插件。',
  plugin_required: '该插件没有可保存的启停配置。', plugin_not_configurable: '插件尚未声明可编辑的配置。', invalid_plugin_config: '插件配置不符合声明的格式，请检查。', plugin_not_found: '插件不存在，请刷新列表。',
  settings_write_failed: '配置未保存成功，请检查数据目录权限。', invalid_settings_request: '配置格式不正确，请重新读取后重试。',
};
async function settingsRequest(path, body) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(7000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaolang-Token': settings.writeToken }, body: JSON.stringify(body) }) });
  checkAccess(response);
  const result = await response.json();
  if (!response.ok) throw new Error(settingsErrors[result.error] ?? '操作未完成，请稍后重试。');
  return result;
}
function formMessage(section, message, kind = '') {
  const target = $(`${section}-settings-message`); target.textContent = message; target.className = kind ? `form-${kind}` : 'muted';
}
function formValue(form, name, value) { form.elements.namedItem(name).value = value ?? ''; }
function fillSettings(data, sections = ['model', 'qq', 'trigger']) {
  settings = data;
  $('settings-banner').hidden = !data.pendingRestart && !data.lastApplyFailed;
  $('settings-banner-text').textContent = data.lastApplyFailed ? '应用失败，已恢复原配置。' : '已保存，待应用。';
  $('apply-settings').disabled = !data.pendingRestart || applying;
  $('apply-settings').textContent = applying ? '正在应用…' : '应用配置并重启';
  $('model-active').textContent = data.active.model;
  $('qq-active').textContent = data.active.environment === 'production' ? '正式环境' : '沙箱环境';
  for (const section of sections) {
    if (dirtyForms.has(section)) continue;
    const form = $(`${section}-form`), values = data[section];
    if (section === 'model') {
      for (const name of ['baseUrl', 'name', 'maxOutputTokens', 'retries', 'temperature', 'topP', 'reasoningEffort']) formValue(form, name, values[name]);
      formValue(form, 'thinking', String(values.thinking)); formValue(form, 'timeoutSeconds', values.timeoutMs / 1000);
      formValue(form, 'stop', (values.stop ?? []).join('\n'));
      if (data.turnTimeoutMs) $('model-budget-note').textContent = `单轮上限 ${data.turnTimeoutMs / 1000} 秒`;
    } else if (section === 'qq') {
      for (const name of ['appId', 'environment', 'groupMessages']) formValue(form, name, values[name]);
      formValue(form, 'connectTimeoutSeconds', values.connectTimeoutMs / 1000); formValue(form, 'groupIds', (values.groupIds ?? []).join('\n'));
      for (const control of form.elements) control.disabled = values.supported === false;
    }
    if (section === 'trigger') {
      for (const name of ['privateReply', 'groupMention', 'groupKeywords']) form.elements.namedItem(name).checked = values[name];
      formValue(form, 'words', (values.words ?? []).join('\n'));
      form.elements.namedItem('proactiveEnabled').checked = values.proactive.enabled;
      formValue(form, 'proactiveGroups', values.proactive.excludedGroupIds.join('\n'));
      for (const name of ['activeSeconds', 'idleSeconds', 'idleMessages', 'historyMessages', 'maxRepliesPerMinute']) formValue(form, name, values.proactive[name]);
      for (const control of form.elements) control.disabled = values.supported === false;
      $('trigger-provider').textContent = values.supported === false ? '使用外部替换插件' : '内置默认插件';
      formMessage(section, values.supported === false ? '使用外部触发配置' : '');
      continue;
    }
    formValue(form, 'secret', '');
    $(`${section}-secret-state`).textContent = values.secretConfigured ? '已配置 · 留空保留' : '未配置';
    formMessage(section, '');
  }
  syncThinkingFields();
}
async function loadSettings(sections = ['model', 'qq', 'trigger']) {
  if (settingsLoading) return; settingsLoading = true;
  try { fillSettings(await settingsRequest('/api/settings'), sections); }
  catch (error) { for (const section of ['model', 'qq', 'trigger']) formMessage(section, error.message, 'error'); }
  finally { settingsLoading = false; }
}
function syncThinkingFields() {
  const form = $('model-form'), thinking = form.elements.namedItem('thinking').value === 'true';
  form.elements.namedItem('temperature').disabled = thinking;
  form.elements.namedItem('topP').disabled = !thinking;
  form.elements.namedItem('reasoningEffort').disabled = !thinking;
}
for (const section of ['model', 'qq', 'trigger']) {
  const form = $(`${section}-form`);
  form.addEventListener('input', () => { dirtyForms.add(section); formMessage(section, '有未保存的修改。'); syncThinkingFields(); });
  form.addEventListener('change', () => { dirtyForms.add(section); formMessage(section, '有未保存的修改。'); syncThinkingFields(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!settings) { await loadSettings(); return; }
    const control = name => form.elements.namedItem(name).value;
    const lines = value => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    let value;
    if (section === 'model') {
      value = { baseUrl: control('baseUrl').trim(), name: control('name').trim(), thinking: control('thinking') === 'true',
        maxOutputTokens: Number(control('maxOutputTokens')), timeoutMs: Number(control('timeoutSeconds')) * 1000, retries: Number(control('retries')) };
      for (const name of ['temperature', 'topP']) if (control(name) !== '') value[name] = Number(control(name));
      if (control('reasoningEffort')) value.reasoningEffort = control('reasoningEffort');
      if (lines(control('stop')).length) value.stop = lines(control('stop'));
    } else if (section === 'qq') value = { appId: control('appId').trim(), environment: control('environment'), groupMessages: control('groupMessages'),
      connectTimeoutMs: Number(control('connectTimeoutSeconds')) * 1000, groupIds: lines(control('groupIds')) };
    else value = { privateReply: form.elements.namedItem('privateReply').checked, groupMention: form.elements.namedItem('groupMention').checked,
      groupKeywords: form.elements.namedItem('groupKeywords').checked, words: [...new Set(lines(control('words')))],
      proactive: { enabled: form.elements.namedItem('proactiveEnabled').checked, excludedGroupIds: [...new Set(lines(control('proactiveGroups')))],
        ...Object.fromEntries(['activeSeconds', 'idleSeconds', 'idleMessages', 'historyMessages', 'maxRepliesPerMinute'].map(name => [name, Number(control(name))])) } };
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const result = await settingsRequest(`/api/settings/${section}`, { revision: settings.revision, value, ...(section === 'trigger' ? {} : { secret: control('secret') }) });
      dirtyForms.delete(section); fillSettings(result, [section]);
      formMessage(section, result.pendingRestart ? '已保存，待应用。' : '没有变更。', 'success');
    } catch (error) { formMessage(section, error.message, 'error'); }
    finally { button.disabled = false; }
  });
}
for (const button of document.querySelectorAll('[data-reload-settings]')) button.addEventListener('click', () => {
  const section = button.dataset.reloadSettings; dirtyForms.delete(section); loadSettings([section]);
});
$('apply-settings').addEventListener('click', async () => {
  if (!settings || applying) return;
  if (dirtyForms.size || pluginDirty) { $('settings-banner-text').textContent = '还有未保存的修改，请先保存，再应用配置。'; return; }
  applying = true; $('apply-settings').disabled = true;
  try {
    await settingsRequest('/api/settings/apply', { revision: settings.revision });
    $('settings-banner-text').textContent = '正在重启…'; $('apply-settings').textContent = '正在应用…';
  } catch (error) {
    applying = false; $('apply-settings').disabled = false; $('settings-banner-text').textContent = error.message;
  }
});


let detailCleanup, detailMountVersion = 0;
async function openPlugin(id) {
  detailCleanup?.(); detailCleanup = undefined; const version = ++detailMountVersion;
  parkTriggerForm();
  pluginDetails = undefined; pluginDirty = false;
  $('plugin-title').textContent = '正在读取…'; $('plugin-detail-body').replaceChildren();
  if (!$('plugin-detail').open) $('plugin-detail').showModal();
  try { const detail = await settingsRequest(`/api/plugins/${encodeURIComponent(id)}`); if (version === detailMountVersion) renderPlugin(detail); }
  catch (error) { $('plugin-detail-body').append(element('p', 'error-box', error.message)); }
}
function renderPlugin(detail) {
  parkTriggerForm();
  pluginDetails = detail; pluginDirty = false;
  $('plugin-title').textContent = detail.title;
  const body = $('plugin-detail-body'), meta = element('div', 'detail-meta');
  meta.append(badge(detail.state), element('span', '', detail.kind === 'builtin' ? '内置' : '外挂'));
  const technical = element('details', 'technical-details');
  technical.append(element('summary', '', '技术信息'), element('p', 'mono', `${detail.id} · ${detail.module}`));
  body.replaceChildren(meta);
  if (detail.missingDependencies?.length) body.append(detailSection('等待服务', detail.missingDependencies.join('、')));
  const relations = element('div', 'plugin-relations');
  relations.append(detailSection('依赖服务', detail.dependencies.join('、') || '无'), detailSection('提供服务', detail.provides.join('、') || '无')); body.append(relations);
  for (const page of registeredPages.filter(page => page.plugin === detail.id)) {
    const button = element('button', 'secondary detail-log-button', page.title); button.type = 'button';
    button.addEventListener('click', () => { $('plugin-detail').close(); showView(page.id); }); body.append(button);
  }
  const form = element('form', 'plugin-form'), fields = element('div', 'form-grid');
  if (detail.canToggle) {
    const line = element('label', 'switch-line'), text = element('span');
    text.append(element('strong', '', '启用插件'));
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.name = '_enabled'; enabled.checked = detail.enabled; enabled.disabled = !detail.canToggle;
    line.append(text, enabled); form.append(line);
  }
  for (const [name, definition] of Object.entries(detailDeclarations[detail.id] ? {} : detail.schema?.properties ?? {})) {
    const label = element('label', 'field'), required = detail.schema.required?.includes(name);
    label.append(element('span', '', definition.title || name));
    let input;
    if (definition.enum) {
      input = element('select');
      if (!required) { const option = element('option', '', '默认'); option.value = ''; input.append(option); }
      const labels = detail.id === 'xiaolang-output' ? { normal: '普通输出', streaming: '流式输出' }
        : (detail.id === 'xiaolang-memory' && name.endsWith('Thinking')) || (detail.id === 'xiaolang-persona' && name === 'learningThinking') ? { off: '关闭思考', low: '低 · low', high: '高 · high', max: '最高 · max' } : {};
      for (const item of definition.enum) { const option = element('option', '', labels[item] ?? String(item)); option.value = String(item); input.append(option); }
    } else if (definition.type === 'array' || (definition.type === 'string' && definition.maxLength > 4096)) { input = element('textarea'); input.rows = definition.type === 'array' ? 3 : 8; }
    else { input = element('input'); input.type = definition.writeOnly ? 'password' : definition.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(definition.type) ? 'number' : 'text'; }
    input.name = name;
    if (definition.type === 'boolean') input.checked = detail.config[name] ?? definition.default ?? false;
    else input.value = definition.writeOnly ? '' : definition.type === 'array' ? (detail.config[name] ?? definition.default ?? []).join('\n') : detail.config[name] ?? definition.default ?? '';
    if (definition.writeOnly) { input.autocomplete = 'new-password'; input.placeholder = detail.secretConfigured[name] ? '已有配置，留空保留' : '尚未配置'; }
    if (required && !definition.writeOnly) input.required = true;
    if (definition.minimum !== undefined) input.min = definition.minimum;
    if (definition.maximum !== undefined) input.max = definition.maximum;
    if (definition.type === 'integer') input.step = '1'; else if (definition.type === 'number') input.step = 'any';
    if (definition.maxLength !== undefined) input.maxLength = definition.maxLength;
    if (definition.description) input.title = definition.description;
    label.append(input); fields.append(label);
  }
  if (fields.children.length) form.append(fields);
  if (!detail.schema && !detailDeclarations[detail.id]) form.append(element('p', 'muted', '无配置项'));
  if (detail.canToggle || detail.schema) {
    const footer = element('div', 'form-footer'), message = element('p', 'muted', ''), save = element('button', 'primary', '保存');
    save.type = 'submit'; message.setAttribute('role', 'status'); footer.append(message, save); form.append(footer);
    form.addEventListener('input', () => { pluginDirty = true; message.textContent = '有未保存的修改。'; });
    form.addEventListener('change', () => { pluginDirty = true; message.textContent = '有未保存的修改。'; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      const payload = { revision: detail.revision };
      if (detail.canToggle) payload.enabled = form.elements.namedItem('_enabled').checked;
      if (detail.schema && !detailDeclarations[detail.id]) {
        payload.config = {};
        for (const [name, definition] of Object.entries(detail.schema.properties)) {
          const input = form.elements.namedItem(name);
          if (definition.type === 'boolean') payload.config[name] = input.checked;
          else if (definition.writeOnly) { if (input.value.trim()) payload.config[name] = input.value.trim(); }
          else if (input.value !== '') payload.config[name] = definition.type === 'array' ? input.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
            : ['number', 'integer'].includes(definition.type) ? Number(input.value) : input.value;
        }
      }
      try {
        const result = await settingsRequest(`/api/plugins/${encodeURIComponent(detail.id)}`, payload);
        pluginDirty = false; fillSettings(result); renderPlugin(result.plugin);
        $('plugin-detail').close(); showView('plugins');
      } catch (error) { message.textContent = error.message; message.className = 'form-error'; save.disabled = false; }
    });
  }
  body.append(form, technical);
  mountPluginDetail(detail);
}
$('close-plugin').addEventListener('click', () => $('plugin-detail').close());
$('plugin-detail').addEventListener('close', () => { detailCleanup?.(); detailCleanup = undefined; ++detailMountVersion; parkTriggerForm(); pluginDetails = undefined; pluginDirty = false; });


function mountPluginDetail(detail) {
  const content = detailDeclarations[detail.id];
  if (!content) return;
  const root = element('div', 'plugin-custom-detail'); $('plugin-detail-body').append(root);
  if (content.view) {
    const source = $(content.view); if (!source) return;
    const children = [...source.childNodes]; root.append(...children);
    detailCleanup = () => source.append(...children);
    if (content.view.endsWith('-settings')) loadSettings();
  } else if (content.entry) {
    const version = detailMountVersion;
    mountPanelContent(content, root, detail).then(cleanup => { if (version === detailMountVersion) detailCleanup = cleanup; else cleanup(); }).catch(() => root.append(element('p', 'form-error', '配置加载失败')));
  }
}

get('/api/auth/session').then(auth => { $('logout').hidden = !auth.enabled; }).catch(() => {});
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(7000) });
    if (response.ok) location.reload(); else notice('退出未完成，请重试。');
  } catch { notice('退出未完成，请检查连接后重试。'); }
});
async function refreshReminders() {
  try {
    const data = await get('/api/reminders');
    $('reminder-summary').textContent = `待执行 ${data.active} 个 · 共 ${data.total} 个${data.total > 100 ? '，显示前 100 个' : ''}`;
    $('reminder-empty').hidden = data.items.length > 0;
    $('reminder-rows').replaceChildren(...data.items.map(task => {
      const row = element('tr'), content = element('td'), schedule = element('td'), state = element('td'), actions = element('td');
      content.append(element('div', 'snippet', task.text), element('div', 'module', `${task.scope === 'group' ? '群聊' : '私聊'} ${task.recipient} · ${task.ownerName}`), element('div', 'module', task.id));
      schedule.append(element('div', '', task.nextAtBeijing), element('div', 'muted', ({ once: '一次性', daily: '每天', weekly: '每周' })[task.repeat]));
      state.append(badge(task.state));
      if (task.lastRun) state.append(element('div', 'module', `最近执行 ${time(task.lastRun.time, true)} · ${words[task.lastRun.state] ?? task.lastRun.state}`));
      if (task.lastRun?.receipt) state.append(element('div', 'module', `回执 ${task.lastRun.receipt}`));
      if (task.errorCode) state.append(element('div', 'form-error', ({ qq_push_permission_denied: '没有主动发送权限', qq_push_rate_limited: 'QQ 主动发送额度或频率限制', qq_push_refused: '对方不允许主动消息', qq_not_ready: 'QQ 连接未就绪，稍后重试', process_interrupted: '发送时服务重启，请核对是否已收到', qq_send_unknown: '发送结果不明，请核对是否已收到' })[task.errorCode] ?? task.errorCode));
      if (['scheduled', 'queued', 'sending', 'failed', 'unknown'].includes(task.state)) {
        const cancel = element('button', 'secondary', '取消'); cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          cancel.disabled = true;
          try {
            if (!settings) await loadSettings();
            const result = await settingsRequest('/api/reminders/cancel', { id: task.id });
            if (result.inFlight) alert(result.note);
            await refreshReminders();
          } catch (error) { alert(error.message); cancel.disabled = false; }
        }); actions.append(cancel);
      }
      row.append(content, schedule, state, actions); return row;
    }));
  } catch { $('reminder-summary').textContent = '提醒加载失败'; }
}
$('refresh-reminders').addEventListener('click', refreshReminders);
loadPanel();
poll();
loadSettings();
const timer = setInterval(poll, 2000);
window.addEventListener('pagehide', () => clearInterval(timer));

let memoryBefore, memoryNext, editingMemory;
async function refreshMemory() {
  try {
    const params = new URLSearchParams({ q: $('memory-search').value.trim(), kind: $('memory-kind').value });
    if (memoryBefore) params.set('before', memoryBefore);
    const data = await get(`/api/memory?${params}`), state = data.status;
    memoryNext = data.next; $('memory-older').disabled = !data.next;
    const vector = state.vectorState === 'ready' ? '混合检索可用' : state.vectorState === 'missing_key' ? '未配置百炼密钥 · 当前仅关键词检索' : `向量异常 · 当前使用关键词检索（${state.vectorError}）`;
    $('memory-status').textContent = `${state.enabled ? '已启用' : '已停用'} · ${state.total} 条记忆 · ${state.indexed} 已索引 · ${state.summaries} 份摘要${state.vectorState === 'ready' ? '' : ` · ${vector}`}${state.processing ? ' · 正在整理聊天' : ''}${state.extractionError ? ` · 整理异常：${state.extractionError}` : ''}`;
    $('memory-list').replaceChildren(...data.items.map(item => {
      const card = element('button', 'memory-card'); card.type = 'button';
      card.append(element('span', 'badge neutral', item.kind === 'profile' ? '人物资料' : '经历与计划'), element('p', '', item.content), element('small', 'muted', `${item.pinned ? '已置顶 · ' : ''}重要度 ${item.importance} · ${time(item.updated, true)} · ${item.sources.length} 条来源`));
      card.addEventListener('click', () => openMemory(item.id)); return card;
    }));
    if (!data.items.length) $('memory-list').append(element('p', 'empty', '暂无匹配记忆'));
  } catch { $('memory-status').textContent = '暂时无法读取记忆，请稍后重试。'; }
}
async function openMemory(id) {
  if (!settings) await loadSettings();
  editingMemory = id ? await get(`/api/memory/${encodeURIComponent(id)}`) : undefined;
  const form = $('memory-form'), item = editingMemory;
  for (const [key, value] of Object.entries({ content: item?.content ?? '', kind: item?.kind ?? 'profile', importance: item?.importance ?? 3, people: item?.people?.join('\n') ?? '', validUntil: item?.validUntil ? new Date(Date.parse(item.validUntil) + 8 * 3600000).toISOString().slice(0, 16) : '' })) form.elements.namedItem(key).value = value;
  form.elements.namedItem('pinned').checked = !!item?.pinned;
  $('memory-forget').hidden = !item;
  $('memory-form-message').textContent = '';
  $('memory-sources').replaceChildren(...(item?.sources ?? []).map(source => detailSection(`原文 ${source.seq} · ${time(source.time, true)} · ${source.name} · ${source.group ? `群 ${source.group}` : '私聊'}`, source.text)));
  renderMemoryHistory(item?.history);
  if (!$('memory-detail').open) $('memory-detail').showModal();
}
function renderMemoryHistory(history, append = false) {
  const box = $('memory-history');
  if (!append) {
    box.replaceChildren();
    if (!history) return;
    box.append(element('h3', '', '变化历史'));
  }
  box.querySelector('[data-history-more]')?.remove();
  for (const entry of history.items) {
    const label = ({ baseline: '升级时保留', add: '新记忆', update: '补充信息', supersede: '状态变化', correct: '手动编辑' })[entry.change] ?? entry.change;
    const section = detailSection(`v${entry.version} · ${label} · ${time(entry.updated, true)} · ${entry.current ? '当前版本' : entry.usable ? '历史版本' : '已纠正作废，不用于回复'}`, entry.content);
    section.append(element('p', 'module', (entry.origins ?? []).join('\n') || '没有原文来源')); box.append(section);
  }
  if (history.nextBeforeVersion) {
    const button = element('button', 'secondary', '查看更早版本'); button.type = 'button'; button.dataset.historyMore = 'true';
    const id = editingMemory.id;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const page = await get(`/api/memory/${encodeURIComponent(id)}?beforeVersion=${history.nextBeforeVersion}`);
        if (editingMemory?.id === id) renderMemoryHistory(page.history, true);
      } catch { button.textContent = '读取失败，点击重试'; button.disabled = false; }
    }); box.append(button);
  }
}
$('memory-config').addEventListener('click', () => openPlugin('xiaolang-memory'));
$('memory-refresh').addEventListener('click', () => { memoryBefore = undefined; refreshMemory(); });
$('memory-kind').addEventListener('change', () => { memoryBefore = undefined; refreshMemory(); });
$('memory-search').addEventListener('keydown', event => { if (event.key === 'Enter') { memoryBefore = undefined; refreshMemory(); } });
$('memory-latest').addEventListener('click', () => { memoryBefore = undefined; refreshMemory(); });
$('memory-older').addEventListener('click', () => { memoryBefore = memoryNext; refreshMemory(); });
$('memory-add').addEventListener('click', () => { openMemory().catch(() => notice('暂时无法打开记忆编辑。')); });
$('close-memory').addEventListener('click', () => $('memory-detail').close());
for (const action of ['process', 'test', 'reindex']) $('memory-' + action).addEventListener('click', async event => {
  event.target.disabled = true;
  try { if (!settings) await loadSettings(); const result = await settingsRequest('/api/memory/action', { action }); await refreshMemory(); $('memory-status').textContent += result.dimensions ? ` · 连接测试成功（${result.dimensions} 维）` : ' · 后台任务已提交'; }
  catch (error) { $('memory-status').textContent = error.message; }
  finally { event.target.disabled = false; }
});
$('memory-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, fields = new FormData(form);
  const value = { content: fields.get('content'), kind: fields.get('kind'), people: String(fields.get('people')).split('\n').map(p => p.trim()).filter(Boolean), importance: Number(fields.get('importance')), sources: editingMemory?.sources?.map(p => p.seq) ?? [], pinned: form.elements.namedItem('pinned').checked, validUntil: fields.get('validUntil') ? new Date(String(fields.get('validUntil'))).toISOString() : null };
  if (editingMemory) { value.id = editingMemory.id; value.version = editingMemory.version; }
  const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { await settingsRequest('/api/memory/mutate', { action: editingMemory ? 'update' : 'remember', value }); $('memory-detail').close(); await refreshMemory(); }
  catch (error) { $('memory-form-message').textContent = error.message; }
  finally { button.disabled = false; }
});
$('memory-forget').addEventListener('click', async () => {
  if (!editingMemory) return;
  if (!confirm('彻底删除这条记忆及全部版本、向量和召回记录？无法恢复。原始聊天记录仍保留。')) return;
  try { await eraseStoredData({ kind: 'memory', id: editingMemory.id, version: editingMemory.version }); $('memory-detail').close(); await refreshMemory(); }
  catch (error) { $('memory-form-message').textContent = error.message; }
});

async function refreshTools() {
  try {
    const data = await get('/api/tools');
    $('tool-rows').replaceChildren(...data.items.map(tool => {
      const row = element('tr'), name = element('td');
      name.append(element('strong', '', tool.description.slice(0, 80)), element('div', 'module', tool.name)); name.title = tool.description;
      row.append(name, element('td', 'mono', tool.source), element('td', '', tool.access === 'admin' ? '仅管理员' : '所有用户')); return row;
    }));
    $('tool-connections').textContent = data.mcp.length ? data.mcp.map(server => `MCP ${server.name}：${words[server.state] ?? server.state}，${server.tools} 个工具${server.errorCode ? '（'+server.errorCode+'）' : ''}`).join('；') : 'MCP 未配置';
    $('skill-catalog').textContent = data.skills.length ? '已安装 Skills：'+data.skills.map(skill => skill.name).join('、') : 'Skills 未配置';
  } catch { $('tool-connections').textContent = '暂时无法读取工具状态。'; }
}
for (const button of document.querySelectorAll('[data-tool-config]')) button.addEventListener('click', () => openPlugin(button.dataset.toolConfig));

let editingStyle;
async function refreshPersona() {
  try {
    const data = await get('/api/persona'), state = data.status;
    $('persona-status').textContent = `${state.enabled ? '学习已开启' : '学习已关闭'} · ${state.active}/${state.total} 条启用 · 今日 ${state.dailyCalls}/${state.maxDailyCalls} 次${state.processing ? ' · 正在学习' : ''}${state.error ? ` · ${settingsErrors[state.error] ?? state.error}` : ''}`;
    $('persona-list').replaceChildren(...data.items.map(item => {
      const card = element('button', 'memory-card'); card.type = 'button';
      card.append(element('strong', '', item.scene), element('p', '', item.rule), element('small', 'muted', `${item.enabled ? '启用' : '停用'} · 版本 ${item.version} · ${item.examples.length} 组真人示例`));
      card.addEventListener('click', () => openStyle(item.id).catch(() => notice('无法读取学习详情，请刷新后重试。'))); return card;
    }));
    if (!data.items.length) $('persona-list').append(element('p', 'empty', '暂无表达习惯'));
  } catch { $('persona-status').textContent = '暂时无法读取学习记录。'; }
}
async function openStyle(id) {
  editingStyle = await get(`/api/persona/${encodeURIComponent(id)}`);
  const form = $('persona-form'), item = editingStyle;
  form.elements.scene.value = item.scene; form.elements.rule.value = item.rule; form.elements.keywords.value = item.keywords.join('\n'); form.elements.enabled.checked = item.enabled;
  $('persona-message').textContent = '';
  $('persona-sources').replaceChildren(...item.sources.map(source => detailSection(`原文 ${source.seq} · ${source.name} · ${source.group ? `群 ${source.group}` : '私聊'}`, source.text)));
  $('persona-versions').replaceChildren(element('h3', '', '最近版本'));
  for (const version of item.versions) {
    const box = element('div', 'detail-section'); box.append(element('p', '', `版本 ${version.version} · ${version.scene}：${version.rule}`));
    if (version.version !== item.version) {
      const button = element('button', 'secondary', '恢复此版本'); button.type = 'button';
      button.addEventListener('click', async () => {
        try { if (!settings) await loadSettings(); await settingsRequest('/api/persona/mutate', { action: 'rollback', id, version: item.version, targetVersion: version.version }); await openStyle(id); await refreshPersona(); }
        catch (error) { $('persona-message').textContent = error.message; }
      }); box.append(button);
    } $('persona-versions').append(box);
  }
  if (!$('persona-detail').open) $('persona-detail').showModal();
}
$('persona-config').addEventListener('click', () => openPlugin('xiaolang-persona'));
$('persona-refresh').addEventListener('click', refreshPersona);
$('close-persona').addEventListener('click', () => $('persona-detail').close());
$('persona-learn').addEventListener('click', async () => {
  try { if (!settings) await loadSettings(); await settingsRequest('/api/persona/learn', {}); $('persona-status').textContent = '已提交学习'; }
  catch (error) { $('persona-status').textContent = error.message; }
});
$('persona-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    if (!settings) await loadSettings();
    await settingsRequest('/api/persona/mutate', { action: 'update', id: editingStyle.id, version: editingStyle.version, scene: form.elements.scene.value.trim(), rule: form.elements.rule.value.trim(), keywords: form.elements.keywords.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean), enabled: form.elements.enabled.checked });
    $('persona-detail').close(); await refreshPersona();
  } catch (error) { $('persona-message').textContent = error.message; }
});

let conversationItems = [], currentConversation, conversationNext, conversationRows = [], messageNext;
let timelineLoading;
let chatLoading = false, conversationFilterVersion = 0, timelineVersion = 0, namingConversation;
function conversationLabel(item) { return item.alias || (item.scope === 'group' && item.name === `群聊 ${item.recipient}` ? `群聊 · ${item.recipient.slice(0, 12)}` : item.name); }
function setConversationHeading(item) {
  $('conversation-title').textContent = conversationLabel(item);
  $('conversation-subtitle').textContent = `${item.scope === 'group' ? '群聊' : '私聊'} · ${item.messages} 条消息`; $('conversation-title').title = item.recipient;
  $('conversation-delete').disabled = false; $('conversation-name').disabled = false; $('message-latest').disabled = false;
}
function renderConversations() {
  $('conversation-list').replaceChildren(...conversationItems.map(item => {
    const button = element('button', `conversation-item${item.id === currentConversation?.id ? ' selected' : ''}`); button.type = 'button';
    if (item.id === currentConversation?.id) button.setAttribute('aria-current', 'true');
    button.append(element('small', 'muted', item.scope === 'group' ? '群聊' : '私聊'), element('strong', '', conversationLabel(item)), element('span', 'conversation-preview', item.preview || '（非文字消息）'));
    button.addEventListener('click', () => { selectConversation(item).catch(() => { $('conversation-message').textContent = '读取会话失败，请重试。'; }); }); return button;
  }));
  if (!conversationItems.length) $('conversation-list').append(element('p', 'empty', '暂无匹配会话'));
  $('conversation-more').hidden = !conversationNext;
}
async function refreshChats(more = false) {
  if (chatLoading) return; chatLoading = true;
  const version = conversationFilterVersion;
  try {
    const params = new URLSearchParams({ q: $('conversation-search').value.trim(), scope: $('conversation-scope').value });
    if (more && conversationNext) params.set('before', conversationNext);
    const data = await get(`/api/conversations?${params}`);
    if (version !== conversationFilterVersion) return;
    const disjoint = !more && data.items.length === 50 && conversationItems.length && !data.items.some(item => conversationItems.some(old => old.id === item.id));
    if (disjoint) conversationItems = [];
    if (more || !conversationItems.length) conversationNext = data.next;
    // Keep pages already opened while refreshing the first page.
    const map = new Map(conversationItems.map(item => [item.id, item])); for (const item of data.items) map.set(item.id, item);
    conversationItems = [...map.values()].sort((a, b) => b.lastSeq - a.lastSeq); renderConversations();
    if (!currentConversation && data.items.length) await selectConversation(data.items[0]);
    else if (currentConversation && !more) await loadTimeline(false);
    $('conversation-message').textContent = '';
  } catch { $('conversation-message').textContent = '暂时无法读取聊天记录，请检查连接后重试。'; }
  finally { chatLoading = false; }
}
async function selectConversation(item) {
  currentConversation = item; conversationRows = []; messageNext = undefined; timelineVersion++;
  setConversationHeading(item); renderConversations(); $('message-timeline').replaceChildren(element('p', 'empty', '正在读取…'));
  await loadTimeline(false, true);
}
function renderTimeline() {
  const nodes = conversationRows.map(item => {
    const article = element('article', `timeline-item ${item.direction === 'out' ? 'outgoing' : 'incoming'}`), meta = element('div', 'timeline-meta');
    meta.append(element('strong', '', item.name), element('span', '', time(item.time, true)));
    meta.title = `ID：${item.sender}`;
    if (item.kind === 'reminder') meta.append(element('span', '', '定时提醒'));
    const bubble = element('div', 'message-bubble');
    if (item.direction === 'out') bubble.textContent = item.parts?.[0] ?? item.text;
    else for (const segment of item.segments) {
      if (segment.type === 'text') bubble.append(document.createTextNode(segment.text));
      else if (segment.type === 'image') {
        const link = element('a', 'message-image-link', '[图片 · 打开 QQ 原图]');
        if (segment.url.startsWith('https://')) { link.href = segment.url; link.target = '_blank'; link.rel = 'noreferrer noopener'; }
        bubble.append(link);
      } else bubble.append(document.createTextNode(segment.type === 'mention' ? `[@ ${segment.userId}]` : segment.type === 'reply' ? `[引用消息 ${segment.messageId}]` : `[暂不支持：${segment.kind}]`));
    }
    const remove = element('button', 'link message-remove', '删除'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(item.direction === 'in' ? '彻底删除这条消息及对应回复？关联的记忆、摘要和表达学习也会清理，无法恢复。' : '彻底删除这条回复及关联记录？无法恢复。')) return;
      remove.disabled = true;
      try { await eraseStoredData({ kind: 'message', id: currentConversation.id, seq: item.seq }); await resetChatsAfterDelete(); }
      catch (error) { $('conversation-message').textContent = error.message; remove.disabled = false; }
    }); meta.append(remove);
    article.append(meta, bubble);
    if (item.direction === 'out' && item.parts?.length > 1) for (const part of item.parts.slice(1)) article.append(element('div', 'message-bubble', part));
    if (item.turn) {
      const button = element('button', 'link timeline-detail', `详情 · ${words[item.turn.state] ?? item.turn.state}`); button.type = 'button';
      button.addEventListener('click', () => openDetail(item.turn.id)); article.append(button);
    } else if (item.direction === 'in') article.append(element('small', 'muted', '未触发回复'));
    if (item.feedback) article.append(detailSection(`故障反馈 · ${words[item.feedback.state] ?? item.feedback.state}`, item.feedback.text));
    return article;
  });
  $('message-timeline').replaceChildren(...nodes);
  if (!nodes.length) $('message-timeline').append(element('p', 'empty', '这个会话暂无消息。'));
  $('message-older').disabled = !messageNext;
  $('message-page-note').textContent = `已显示 ${conversationRows.length} 条`;
}
async function loadTimeline(older = false, initial = false) {
  if (!currentConversation || (!initial && timelineLoading?.id === currentConversation.id)) return;
  const pending = { id: currentConversation.id }; timelineLoading = pending;
  try {
  const id = currentConversation.id, version = ++timelineVersion, box = $('message-timeline');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90, top = box.scrollTop, height = box.scrollHeight;
  const data = await get(`/api/conversations/${id}${older && messageNext ? `?before=${messageNext}` : ''}`);
  if (id !== currentConversation?.id || version !== timelineVersion) return;
  currentConversation = data.conversation; setConversationHeading(currentConversation);
  const existing = new Map(conversationRows.map(item => [item.seq, item]));
  // A burst larger than a page must not leave a hidden gap between old and new records.
  const disjoint = !older && data.items.length === 50 && conversationRows.length && !data.items.some(item => existing.has(item.seq));
  if (disjoint) existing.clear();
  for (const item of data.items) existing.set(item.seq, item);
  conversationRows = [...existing.values()].sort((a, b) => a.seq - b.seq);
  if (older || initial || disjoint) messageNext = data.next;
  renderTimeline();
  if (older) box.scrollTop = top + box.scrollHeight - height;
  else box.scrollTop = initial || (nearBottom && $('message-follow').checked) ? box.scrollHeight : top;
  } finally { if (timelineLoading === pending) timelineLoading = undefined; }
}
function filterConversations() {
  conversationFilterVersion++; timelineVersion++; conversationItems = []; currentConversation = undefined; conversationNext = undefined; conversationRows = []; messageNext = undefined;
  $('conversation-title').textContent = '选择一个会话'; $('conversation-subtitle').textContent = ''; $('conversation-delete').disabled = true; $('conversation-name').disabled = true; $('message-latest').disabled = true;
  $('message-older').disabled = true; $('message-timeline').replaceChildren(element('p', 'empty', '选择群聊或私聊，查看完整聊天记录。'));
  renderConversations(); refreshChats();
}
let conversationSearchTimer;
$('conversation-search').addEventListener('input', () => { clearTimeout(conversationSearchTimer); conversationSearchTimer = setTimeout(filterConversations, 250); });
$('conversation-scope').addEventListener('change', filterConversations);
$('conversation-more').addEventListener('click', () => refreshChats(true));
$('conversation-refresh').addEventListener('click', () => refreshChats());
$('message-older').addEventListener('click', () => { if (messageNext) loadTimeline(true).catch(() => { $('conversation-message').textContent = '无法读取更早消息，请重试。'; }); });
$('message-latest').addEventListener('click', () => { if (currentConversation) selectConversation(currentConversation).catch(() => { $('conversation-message').textContent = '读取会话失败，请重试。'; }); });
$('conversation-name').addEventListener('click', () => {
  namingConversation = structuredClone(currentConversation); $('conversation-name-form').elements.alias.value = namingConversation.alias;
  $('conversation-name-message').textContent = ''; $('conversation-name-dialog').showModal();
});
$('close-conversation-name').addEventListener('click', () => $('conversation-name-dialog').close());
$('conversation-name-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    if (!settings) await loadSettings();
    const updated = await settingsRequest(`/api/conversations/${namingConversation.id}/name`, { alias: form.elements.alias.value, version: namingConversation.version });
    const existing = conversationItems.findIndex(item => item.id === updated.id); if (existing >= 0) conversationItems[existing] = updated;
    if (currentConversation?.id === updated.id) { currentConversation = updated; setConversationHeading(updated); }
    renderConversations(); $('conversation-name-dialog').close();
  } catch (error) { $('conversation-name-message').textContent = error.message; }
  finally { button.disabled = false; }
});

async function eraseStoredData(input) {
  if (!settings) await loadSettings();
  const result = await settingsRequest('/api/data/delete', input);
  logs = []; cursor = 0; selected = undefined; renderLogs(); $('detail').close();
  return result;
}
async function resetChatsAfterDelete() {
  conversationFilterVersion++; timelineVersion++; conversationItems = []; conversationRows = []; conversationNext = undefined; messageNext = undefined; currentConversation = undefined;
  $('conversation-title').textContent = '选择一个会话'; $('conversation-subtitle').textContent = '';
  $('conversation-name').disabled = true; $('conversation-delete').disabled = true;
  $('message-timeline').replaceChildren(); renderConversations();
  // An already-running poll must finish before reloading the erased timeline.
  while (chatLoading || timelineLoading) await new Promise(resolve => setTimeout(resolve, 30));
  await refreshChats();
}
$('conversation-delete').addEventListener('click', async event => {
  if (!currentConversation || !confirm('彻底删除这个会话的全部聊天记录和回复？关联的记忆、摘要、表达学习及来源提醒也会清理，无法恢复。')) return;
  event.target.disabled = true;
  try { await eraseStoredData({ kind: 'conversation', id: currentConversation.id }); await resetChatsAfterDelete(); }
  catch (error) { $('conversation-message').textContent = error.message; event.target.disabled = false; }
});
$('persona-delete').addEventListener('click', async () => {
  if (!editingStyle || !confirm('彻底删除这条表达习惯、全部版本和示例关联？无法恢复。原始聊天记录仍保留。')) return;
  try { await eraseStoredData({ kind: 'persona', id: editingStyle.id, version: editingStyle.version }); $('persona-detail').close(); await refreshPersona(); }
  catch (error) { $('persona-message').textContent = error.message; }
});

let usageUpdated = 0, usageNext, usageBusy = false, usageKey = '';
const numberText = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN');
function usageTable(headings, rows) {
  const table = element('table', 'usage-table'), head = element('thead'), tr = element('tr'), body = element('tbody');
  for (const heading of headings) tr.append(element('th', '', heading));
  head.append(tr); table.append(head, body);
  for (const values of rows) {
    const row = element('tr');
    for (const value of values) { const cell = element('td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value))); row.append(cell); }
    body.append(row);
  }
  if (!rows.length) { const row = element('tr'), cell = element('td', 'empty', '这段时间还没有调用记录'); cell.colSpan = headings.length; row.append(cell); body.append(row); }
  return table;
}
function usageRecord(row) {
  const meta = element('details', 'usage-request'), label = element('summary', '', usageNames[row.purpose] ?? row.purpose);
  meta.append(label, element('p', 'mono', `${row.provider} · ${row.model}`), element('p', 'muted', `请求 #${row.id} · 第 ${row.attempt} 次尝试${row.step ? ` · 模型步骤 ${row.step}` : ''}`),
    element('p', 'muted', `${row.streaming ? '流式' : '普通'} · 思考 ${row.thinking === 'off' ? '关闭' : row.thinking}${row.scope ? ` · ${row.scope === 'group' ? '群聊' : '私聊'}` : ''}`),
    element('p', 'muted', `缓存命中 ${numberText(row.cached)} · 思考 Token ${numberText(row.reasoning)}`));
  if (row.requestId) meta.append(element('p', 'mono', `平台请求 ID：${row.requestId}`));
  if (row.errorCode) meta.append(element('p', 'error-box', row.errorCode));
  if (row.total === null) meta.append(element('p', 'muted', row.kind === 'web' ? '按次接口，未返回 Token 用量。' : '接口没有返回完整用量。此请求可能已产生消耗，无法据此计算。'));
  if (row.turn) {
    const reply = element('button', 'link', '查看对应消息与回复'); reply.type = 'button';
    reply.addEventListener('click', () => openDetail(row.turn)); meta.append(reply);
  }
  const status = ({ success: '成功', failed: '失败', running: '进行中', interrupted: '重启中断' })[row.state] ?? row.state;
  const state = element('span', `badge ${row.state === 'success' ? 'good' : row.state === 'running' ? 'waiting' : 'bad'}`, status);
  return [time(row.started, true), meta, state, numberText(row.input), numberText(row.output), numberText(row.total), row.durationMs === null ? '—' : `${numberText(row.durationMs)} ms`];
}
async function refreshUsage(reset = true, more = false) {
  if (usageBusy) { if (reset) usageKey = ''; return; }
  const query = new URLSearchParams({ range: $('usage-range').value, purpose: $('usage-purpose').value, provider: $('usage-provider').value });
  const key = query.toString();
  if (more && usageNext) query.set('before', usageNext);
  usageBusy = true;
  try {
    const page = await get(`/api/usage?${query}`);
    const currentKey = new URLSearchParams({ range: $('usage-range').value, purpose: $('usage-purpose').value, provider: $('usage-provider').value }).toString();
    if (key !== currentKey) return;
    usageKey = key;
    const summary = page.summary;
    $('usage-total').textContent = numberText(summary.total);
    $('usage-io').textContent = `${numberText(summary.input)} / ${numberText(summary.output)}`;
    $('usage-detail-tokens').textContent = `缓存命中 ${numberText(summary.cached)} · 思考 ${numberText(summary.reasoning)}`;
    $('usage-calls').textContent = `${numberText(summary.calls)} / ${numberText(summary.failures)}`;
    $('usage-unknown').textContent = numberText(summary.unknown);
    $('usage-note').textContent = '';
    $('usage-total').title = page.firstRecorded ? `开始统计：${time(page.firstRecorded, true)}` : '仅统计已返回的用量';
    $('usage-functions').replaceChildren(usageTable(['功能', '请求数', '失败', '输入 Token', '输出 Token', '总 Token', '缓存命中', '思考 Token', '用量未知', '平均耗时'],
      page.byPurpose.map(row => [usageNames[row.purpose] ?? row.purpose, numberText(row.calls), numberText(row.failures), numberText(row.input), numberText(row.output), numberText(row.total), numberText(row.cached), numberText(row.reasoning), numberText(row.unknown), `${numberText(Math.round(row.averageMs))} ms`])));
    $('usage-models').replaceChildren(usageTable(['模型', '请求数', '总 Token', '用量未知'], page.byModel.map(row => [`${row.provider} / ${row.model}`, numberText(row.calls), numberText(row.total), numberText(row.unknown)])));
    const maximum = Math.max(1, ...page.daily.map(row => Number(row.total)));
    $('usage-daily').replaceChildren(...(page.daily.length ? page.daily.map(row => {
      const line = element('div', 'usage-day'), bar = element('progress'); bar.max = maximum; bar.value = Number(row.total); bar.setAttribute('aria-label', `${row.day} 用量`);
      line.append(element('span', '', row.day), bar, element('strong', '', numberText(row.total)), element('small', 'muted', `${row.calls} 次${row.unknown ? ` · ${row.unknown} 次未知` : ''}`)); return line;
    }) : [element('p', 'empty', '还没有用量记录')]));
    // Auto-refresh keeps older pages in place; manual refresh starts from the latest page.
    if (more) {
      const body = $('usage-requests').querySelector('tbody');
      const extra = usageTable([], page.items.map(usageRecord));
      body.append(...extra.querySelector('tbody').children);
      usageNext = page.next;
    } else if (reset || !$('usage-requests').querySelector('tbody') || !$('usage-requests').dataset.expanded) {
      $('usage-requests').replaceChildren(usageTable(['时间', '调用详情', '状态', '输入', '输出', '合计 Token', '耗时'], page.items.map(usageRecord)));
      $('usage-requests').dataset.expanded = ''; usageNext = page.next;
    }
    if (more) $('usage-requests').dataset.expanded = '1';
    $('usage-more').hidden = !usageNext; usageUpdated = Date.now(); $('usage-updated').textContent = `更新于 ${time(usageUpdated)}`;
  } catch { $('usage-note').textContent = '暂时无法读取用量记录，请稍后刷新。'; }
  finally {
    usageBusy = false;
    const keyNow = new URLSearchParams({ range: $('usage-range').value, purpose: $('usage-purpose').value, provider: $('usage-provider').value }).toString();
    if (keyNow !== key) void refreshUsage();
  }
}
for (const [value, title] of Object.entries(usageNames)) { const option = element('option', '', title); option.value = value; $('usage-purpose').append(option); }
for (const id of ['usage-range', 'usage-purpose', 'usage-provider']) $(id).addEventListener('change', () => refreshUsage());
$('refresh-usage').addEventListener('click', () => refreshUsage());
$('usage-more').addEventListener('click', () => { if (usageKey) refreshUsage(false, true); });
