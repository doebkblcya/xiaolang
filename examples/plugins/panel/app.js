'use strict';
const $ = id => document.getElementById(id);
const words = { connected: '已连接', disconnected: '已断开', starting: '启动中', ready: '已就绪', stopping: '停止中', failed: '失败', error: '连接异常',
  completed: '已完成', queued: '等待处理', running: '处理中', sending: '发送中', unknown: '结果未知', expired: '已过期', cancelled: '已取消',
  active: '已启用', disabled: '已停用', pending: '等待激活', sent: '已确认发送', succeeded: '已成功', private: '私聊', mention: '@机器人', keyword: '触发词' };
const stages = { application_ready: '小狼已就绪', application_stopping: '小狼正在停止', application_failed: '启动失败', qq_connected: 'QQ 已连接', qq_disconnected: 'QQ 已断开',
  qq_connection_error: 'QQ 连接异常', qq_connection_failed: 'QQ 连接失败', adapter_group_messages_limited: '非 @ 群消息推送权限待验证', panel_listening: '面板已启动', feedback_started: '发送故障提示', feedback_sent: '故障提示已确认发送', feedback_failed: '故障提示发送失败', feedback_unknown: '故障提示结果未知', feedback_skipped: '未追加故障提示',
  message_received: '收到消息', message_ignored: '忽略消息', trigger_matched: '触发回复', turn_queued: '等待调度', turn_started: '开始处理',
  model_started: '调用模型', model_completed: '模型返回', model_failed: '模型调用失败', reply_generated: '生成回复',
  tool_started: '调用工具', tool_completed: '工具完成', tool_failed: '工具失败', tool_unknown: '工具结果未知',
  send_started: '发送回复', send_confirmed: 'QQ 已确认发送', send_failed: '发送失败', send_unknown: '发送结果未知', turn_completed: '本轮完成' };
Object.assign(stages, { memory_recalled: '读取聊天与记忆', memory_processing_started: '开始整理记忆', memory_processing_completed: '记忆整理完成', memory_processing_failed: '记忆整理失败', memory_vector_fallback: '向量不可用，使用关键词检索', memory_summary_failed: '聊天摘要整理失败', memory_image_unavailable: '图片暂时无法读取', memory_image_described: '图片描述已生成' });
const reasons = { private: '私聊默认回复', mention: '@机器人', keyword: '命中触发词', no_trigger: '未触发回复', duplicate: '重复消息', own_message: '机器人自身消息', group_not_allowed: '群不在白名单', chat_disabled: '聊天已停用', invalid_message: '格式无效', account_mismatch: '账号不匹配' };
const descriptions = { memories: ['聊天与记忆', '看看小狼记住了什么，也可以帮它纠正。'], overview: ['运行概览', '看看小狼现在怎么样。'], chats: ['最近聊天', '收到的消息、生成的回复，以及每一轮的处理结果。'], logs: ['过程日志', '从收到消息到发送回复，跟着每一步看。'], plugins: ['插件列表', '查看当前的小狼由哪些插件组成。'], 'model-settings': ['回复模型', '配置模型连接与生成方式。'], 'qq-settings': ['QQ 接入', '配置小狼连接的机器人与消息范围。'] };
Object.assign(descriptions, { tooling: ['工具与行动', '查看工具、连接和权限，按插件扩展能力。'] });
Object.assign(stages, { mcp_connected: 'MCP 已连接', mcp_connection_failed: 'MCP 连接失败', mcp_tool_rejected: 'MCP 工具注册失败' });
Object.assign(stages, { proactive_state: '插话状态更新', proactive_observing: '收集待判断消息', proactive_judge_started: '判断是否接话', proactive_decided: '接话判断完成', proactive_skipped: '本次未接话', proactive_judge_failed: '接话判断失败，保持沉默' });
Object.assign(stages, { panel_tls_reloaded: '面板证书已重新加载', panel_tls_reload_failed: '面板新证书暂时无法加载，保留原证书' });
Object.assign(reasons, { proactive: '主动插话', no_trigger: '未命中直接触发条件' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let logs = [], cursor = 0, before, next = null, busy = false, turnRequest = 0, selected, runStarted;
let settings, settingsLoading = false, applying = false;
const dirtyForms = new Set();
let pluginDetails, pluginDirty = false;
const triggerForm = $('trigger-form');
function parkTriggerForm() { $('plugin-config-forms').append(triggerForm); }
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
function showView(view) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== view;
  for (const button of document.querySelectorAll('.nav')) { button.classList.toggle('active', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  [$('page-title').textContent, $('page-description').textContent] = descriptions[view];
  if (view === 'chats') refreshTurns();
  if (view === 'memories') refreshMemory();
  if (view === 'tooling') refreshTools();
  if (view === 'logs') renderLogs();
  if (view.endsWith('-settings') && !settings) loadSettings();
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
function renderStatus(status) {
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
  $('plugin-rows').replaceChildren(...status.plugins.map(plugin => {
    const row = element('tr'), name = element('td'), source = element('td');
    name.append(element('strong', '', plugin.title ?? plugin.id), element('div', 'module', plugin.id));
    source.append(element('span', 'badge neutral', plugin.kind === 'builtin' ? '内置' : '外挂'), element('div', 'module', plugin.module));
    row.classList.add('turn-row'); row.tabIndex = 0; row.setAttribute('aria-label', `查看插件：${plugin.title ?? plugin.id}`);
    row.addEventListener('click', () => openPlugin(plugin.id)); row.addEventListener('keydown', event => { if (event.key === 'Enter') openPlugin(plugin.id); });
    row.append(name, source, element('td', 'module', plugin.dependencies?.join('、') || '无'));
    const cell = element('td'); cell.append(badge(plugin.state)); row.append(cell); return row;
  }));
}
function logMeta(entry) {
  const values = [];
  if (entry.reason) values.push(reasons[entry.reason] ?? entry.reason);
  if (entry.code.startsWith('proactive_') && entry.state) values.push(({ active: '活跃', idle: '旁观', speak: '决定接话', silent: '保持沉默' })[entry.state] ?? entry.state);
  if (entry.model) values.push(entry.model);
  if (entry.step) values.push(`步骤 ${entry.step}`);
  if (entry.tool) values.push(`工具 ${entry.tool}`);
  if (entry.waitMs !== undefined) values.push(`排队 ${entry.waitMs} ms`);
  if (entry.durationMs !== undefined) values.push(`耗时 ${entry.durationMs} ms`);
  if (entry.part) values.push(`第 ${entry.part}/${entry.parts} 段`);
  if (entry.errorCode) values.push(entry.errorCode);
  if (entry.turn) values.push(`turn=${entry.turn}`);
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
    body.append(element('div', '', stages[entry.code] ?? entry.code), element('p', '', entry.preview ?? logMeta(entry) ?? ''));
    row.append(element('span', 'dot'), body, element('time', '', time(entry.time))); return row;
  }));
  if (!logs.length) $('recent-events').append(element('p', 'empty', '等待小狼的第一条动态'));
}
async function refreshTurns() {
  const version = ++turnRequest;
  const params = new URLSearchParams({ limit: '25', failures: $('failures-only').checked ? '1' : '0' });
  if (before) params.set('before', before);
  try {
    const result = await get(`/api/turns?${params}`);
    if (version !== turnRequest) return;
    next = result.next; $('older').disabled = next === null; $('chat-empty').hidden = result.items.length > 0;
    $('page-note').textContent = before ? '更早的 25 轮' : '最近 25 轮';
    $('turns').replaceChildren(...result.items.map(turn => {
      const row = element('tr', 'turn-row'); row.tabIndex = 0; row.setAttribute('aria-label', `查看对话：${turn.input.slice(0, 30)}`);
      const source = element('td', '', time(turn.received, true)); source.append(element('span', 'source', `${words[turn.scope] ?? '群聊'} · ${turn.sender}`));
      const input = element('td'), reply = element('td'), state = element('td');
      input.append(element('div', 'snippet', turn.input || '（非文字消息）'));
      reply.append(element('div', 'snippet', turn.reply || '—')); state.append(badge(turn.state));
      row.append(source, input, reply, state); row.addEventListener('click', () => openDetail(turn.id));
      row.addEventListener('keydown', event => { if (event.key === 'Enter') openDetail(turn.id); }); return row;
    }));
  } catch { notice('暂时无法读取聊天记录。请检查 SSH 隧道连接。'); }
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
    const button = element('button', 'secondary detail-log-button', '查看这一轮的过程日志');
    button.addEventListener('click', () => { $('detail').close(); selected = undefined; $('log-filter').value = detail.id; showView('logs'); }); body.append(button);
  } catch { $('detail-body').replaceChildren(element('p', 'error-box', '暂时无法读取详情，请关闭后重试。')); }
}
$('close-detail').addEventListener('click', () => { selected = undefined; $('detail').close(); });
$('detail').addEventListener('close', () => { selected = undefined; });
$('log-filter').addEventListener('input', renderLogs);
$('clear-filter').addEventListener('click', () => { $('log-filter').value = ''; renderLogs(); });
$('follow').addEventListener('change', renderLogs);
$('failures-only').addEventListener('change', () => { before = undefined; refreshTurns(); });
$('latest').addEventListener('click', () => { before = undefined; refreshTurns(); });
$('older').addEventListener('click', () => { if (next !== null) { before = next; refreshTurns(); } });
async function poll() {
  if (busy) return; busy = true;
  try {
    const [status, initialPage] = await Promise.all([get('/api/status'), get(`/api/logs?after=${cursor}`)]);
    let page = initialPage;
    if (runStarted !== undefined && runStarted !== status.started) { logs = []; page = await get('/api/logs?after=0'); }
    if (runStarted !== undefined && runStarted !== status.started) {
      settings = undefined; dirtyForms.clear(); await loadSettings();
    }
    if (applying && status.state === 'ready') { await loadSettings(); if (settings && !settings.pendingRestart) { applying = false; fillSettings(settings); } }
    runStarted = status.started;
    renderStatus(status);
    if (page.reset) logs = [];
    if (page.items.length || page.reset) { logs = [...logs, ...page.items].slice(-500); renderLogs(); }
    cursor = page.cursor;
    $('connection').textContent = '面板在线'; $('connection').className = 'badge good'; $('synced').textContent = time(Date.now()); notice('');
    if (!before && !$('chats').hidden) await refreshTurns();
    if (!$('tooling').hidden) await refreshTools();
  } catch { $('connection').textContent = '面板连接中断'; $('connection').className = 'badge bad'; notice('无法连接面板，当前保留上次显示的数据。请检查网络和访问地址，连接恢复后会自动更新。'); }
  finally { busy = false; }
}

const settingsErrors = {
  memory_conflict: '记忆已更新，请关闭详情重新读取后再修改。', invalid_memory_request: '记忆字段填写不正确，请检查内容、用户ID或有效期。', memory_not_found: '这条记忆已不存在。', memory_disabled: '记忆功能尚未启用，请先在插件配置中开启并应用。', embedding_key_missing: '尚未配置百炼 API Key。', embedding_http_401: '百炼鉴权失败，请检查 API Key 和业务空间地址。', embedding_http_403: '百炼未授权此模型，请检查模型权限和地址。', embedding_http_404: '百炼地址或模型标识不正确。', embedding_network: '向量服务暂时无法连接或请求超时。', settings_conflict: '配置已被其他页面修改，请重新读取后再保存。', settings_busy: '配置正在保存或应用，请稍后重试。',
  chat_busy: '小狼正在处理消息，请等回复结束后再应用。已保存的配置不会丢失。', no_pending_settings: '没有需要应用的新配置。',
  invalid_config: '参数不符合范围，请检查表单。', invalid_qq_config: 'QQ 配置不完整或超出范围，请检查。',
  invalid_saved_settings: '配置不符合要求，请检查字段和填写范围。', invalid_secret: '密钥格式不正确，请检查是否包含换行。',
  invalid_url: 'API 地址格式不正确，不能包含账号、密码或查询参数。',
  write_authorization_required: '页面连接已更新，请重新读取配置后再保存。', configuration_unavailable: '当前运行方式没有启用配置写入服务。',
  trigger_configuration_unavailable: '当前使用外部触发插件，请配置该插件。',
  plugin_required: '该插件仍被使用或属于管理入口，不能停用。', plugin_not_configurable: '插件尚未声明可编辑的配置。', invalid_plugin_config: '插件配置不符合声明的格式，请检查。', plugin_not_found: '插件不存在，请刷新列表。',
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
  $('settings-banner-text').textContent = data.lastApplyFailed ? '上次应用失败，已恢复上一份可用配置。请检查 QQ 凭证或连接设置。' : '配置已保存，尚未生效。应用时会短暂重启，处理中的消息结束后才可操作。';
  $('apply-settings').disabled = !data.pendingRestart || applying;
  $('apply-settings').textContent = applying ? '正在应用…' : '应用配置并重启';
  $('model-active').textContent = `运行中：${data.active.model}`;
  $('qq-active').textContent = data.active.environment === 'production' ? '运行中：正式环境' : '运行中：沙箱环境';
  for (const section of sections) {
    if (dirtyForms.has(section)) continue;
    const form = $(`${section}-form`), values = data[section];
    if (section === 'model') {
      for (const name of ['baseUrl', 'name', 'maxOutputTokens', 'retries', 'temperature', 'topP', 'reasoningEffort']) formValue(form, name, values[name]);
      formValue(form, 'thinking', String(values.thinking)); formValue(form, 'timeoutSeconds', values.timeoutMs / 1000);
      formValue(form, 'stop', (values.stop ?? []).join('\n'));
      if (data.turnTimeoutMs) $('model-budget-note').textContent = `仍受单轮 ${data.turnTimeoutMs / 1000} 秒总超时约束。`;
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
      formMessage(section, values.supported === false ? '当前由外部触发插件负责，请使用该插件的配置。' : '保存后应用配置生效。');
      continue;
    }
    formValue(form, 'secret', '');
    $(`${section}-secret-state`).textContent = values.secretConfigured ? '已有密钥 · 不回显；留空保留，填写则替换。' : '尚未配置密钥，请填写。';
    formMessage(section, '填写修改后保存；密钥留空会保留原值。');
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
      formMessage(section, result.pendingRestart ? (section === 'trigger' ? '已保存。关闭插件详情后，点击“应用配置并重启”生效。' : '已保存。点击上方“应用配置并重启”后生效。') : '配置与运行中的设置一致。', 'success');
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
    $('settings-banner-text').textContent = '正在应用配置并重新连接，页面会自动恢复。'; $('apply-settings').textContent = '正在应用…';
  } catch (error) {
    applying = false; $('apply-settings').disabled = false; $('settings-banner-text').textContent = error.message;
  }
});


async function openPlugin(id) {
  parkTriggerForm();
  pluginDetails = undefined; pluginDirty = false;
  $('plugin-title').textContent = '正在读取…'; $('plugin-detail-body').replaceChildren();
  if (!$('plugin-detail').open) $('plugin-detail').showModal();
  try { renderPlugin(await settingsRequest(`/api/plugins/${encodeURIComponent(id)}`)); }
  catch (error) { $('plugin-detail-body').append(element('p', 'error-box', error.message)); }
}
function renderPlugin(detail) {
  parkTriggerForm();
  pluginDetails = detail; pluginDirty = false;
  $('plugin-title').textContent = detail.title;
  const body = $('plugin-detail-body'), meta = element('div', 'detail-meta');
  meta.append(badge(detail.state), element('span', '', detail.kind === 'builtin' ? '内置 · 镜像内' : '外挂 · 挂载加载'));
  body.replaceChildren(meta, element('p', 'mono', `${detail.id} · ${detail.module}`),
    detailSection('依赖服务', detail.dependencies.join('、') || '无'), detailSection('提供服务', detail.provides.join('、') || '无'));
  if (detail.settingsPage && detail.settingsPage !== 'trigger-settings') {
    const button = element('button', 'secondary detail-log-button', '打开插件配置');
    button.type = 'button'; button.addEventListener('click', () => { $('plugin-detail').close(); showView(detail.settingsPage); }); body.append(button);
  }
  const form = element('form', 'plugin-form'), fields = element('div', 'form-grid');
  if (detail.kind === 'external') {
    const line = element('label', 'switch-line'), text = element('span');
    text.append(element('strong', '', '启用插件'), element('small', '', detail.toggleReason || '保存并应用后生效；停用不删除插件文件或数据。'));
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.name = '_enabled'; enabled.checked = detail.enabled; enabled.disabled = !detail.canToggle;
    line.append(text, enabled); form.append(line);
  } else form.append(element('p', 'muted', '内置插件不开放启停操作；后续可按需要调整部署归属。'));
  for (const [name, definition] of Object.entries(detail.schema?.properties ?? {})) {
    const label = element('label', 'field'), required = detail.schema.required?.includes(name);
    label.append(element('span', '', definition.title || name));
    let input;
    if (definition.enum) {
      input = element('select');
      if (!required) { const option = element('option', '', '默认'); option.value = ''; input.append(option); }
      for (const item of definition.enum) { const option = element('option', '', detail.id === 'xiaolang-output' ? ({ normal: '普通输出', streaming: '流式输出' }[item] ?? String(item)) : String(item)); option.value = String(item); input.append(option); }
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
    label.append(input); if (definition.description) label.append(element('small', '', definition.description)); fields.append(label);
  }
  if (fields.children.length) form.append(fields);
  if (!detail.schema && !detail.settingsPage) form.append(element('p', 'muted', '该插件尚未声明可编辑的配置项。'));
  if (detail.canToggle || detail.schema) {
    const footer = element('div', 'form-footer'), message = element('p', 'muted', '保存后应用配置生效。'), save = element('button', 'primary', '保存插件设置');
    save.type = 'submit'; message.setAttribute('role', 'status'); footer.append(message, save); form.append(footer);
    form.addEventListener('input', () => { pluginDirty = true; message.textContent = '有未保存的修改。'; });
    form.addEventListener('change', () => { pluginDirty = true; message.textContent = '有未保存的修改。'; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      const payload = { revision: detail.revision };
      if (detail.canToggle) payload.enabled = form.elements.namedItem('_enabled').checked;
      if (detail.schema) {
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
  body.append(form);
  if (detail.settingsPage === 'trigger-settings') { body.append(triggerForm); loadSettings(['trigger']); }
}
$('close-plugin').addEventListener('click', () => $('plugin-detail').close());
$('plugin-detail').addEventListener('close', () => { parkTriggerForm(); pluginDetails = undefined; pluginDirty = false; });

get('/api/auth/session').then(auth => { $('logout').hidden = !auth.enabled; }).catch(() => {});
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(7000) });
    if (response.ok) location.reload(); else notice('退出未完成，请重试。');
  } catch { notice('退出未完成，请检查连接后重试。'); }
});
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
    $('memory-status').textContent = `${state.enabled ? '已启用' : '尚未启用'} · ${state.total} 条记忆 · 向量已索引 ${state.indexed} 条 · ${state.summaries} 份摘要 · ${vector}${state.processing ? ' · 正在整理聊天' : ''}${state.extractionError ? ` · 整理异常：${state.extractionError}` : ''}`;
    $('memory-list').replaceChildren(...data.items.map(item => {
      const card = element('button', 'memory-card'); card.type = 'button';
      card.append(element('span', 'badge neutral', item.kind === 'profile' ? '人物资料' : '经历与计划'), element('p', '', item.content), element('small', 'muted', `${item.pinned ? '已置顶 · ' : ''}重要度 ${item.importance} · ${time(item.updated, true)} · ${item.sources.length} 条来源`));
      card.addEventListener('click', () => openMemory(item.id)); return card;
    }));
    if (!data.items.length) $('memory-list').append(element('p', 'empty', '还没有符合条件的记忆。聊天会在后台自动整理。'));
  } catch { $('memory-status').textContent = '暂时无法读取记忆，请稍后重试。'; }
}
async function openMemory(id) {
  if (!settings) await loadSettings();
  editingMemory = id ? await get(`/api/memory/${encodeURIComponent(id)}`) : undefined;
  const form = $('memory-form'), item = editingMemory;
  for (const [key, value] of Object.entries({ content: item?.content ?? '', kind: item?.kind ?? 'profile', importance: item?.importance ?? 3, people: item?.people?.join('\n') ?? '', validUntil: item?.validUntil ? new Date(Date.parse(item.validUntil) + 8 * 3600000).toISOString().slice(0, 16) : '' })) form.elements.namedItem(key).value = value;
  form.elements.namedItem('pinned').checked = !!item?.pinned;
  $('memory-forget').hidden = !item;
  $('memory-form-message').textContent = '保存后立即影响后续召回；原始聊天记录仍可追溯。';
  $('memory-sources').replaceChildren(...(item?.sources ?? []).map(source => detailSection(`原文 ${source.seq} · ${time(source.time, true)} · ${source.name} · ${source.group ? `群 ${source.group}` : '私聊'}`, source.text)));
  if (!$('memory-detail').open) $('memory-detail').showModal();
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
  try { await settingsRequest('/api/memory/mutate', { action: 'forget', id: editingMemory.id, version: editingMemory.version }); $('memory-detail').close(); await refreshMemory(); }
  catch (error) { $('memory-form-message').textContent = error.message; }
});

async function refreshTools() {
  try {
    const data = await get('/api/tools');
    $('tool-rows').replaceChildren(...data.items.map(tool => {
      const row = element('tr'), name = element('td');
      name.append(element('strong', 'mono', tool.name), element('p', 'muted', tool.description.slice(0, 160)));
      row.append(name, element('td', 'mono', tool.source), element('td', '', tool.access === 'admin' ? '仅管理员' : '所有用户')); return row;
    }));
    $('tool-connections').textContent = data.mcp.length ? data.mcp.map(server => `MCP ${server.name}：${words[server.state] ?? server.state}，${server.tools} 个工具${server.errorCode ? '（'+server.errorCode+'）' : ''}`).join('；') : '尚未配置 MCP 服务。';
    $('skill-catalog').textContent = data.skills.length ? '已安装 Skills：'+data.skills.map(skill => skill.name).join('、') : '尚未安装 Skill。放入 Skills 目录后，应用配置或重启发现。';
  } catch { $('tool-connections').textContent = '暂时无法读取工具状态。'; }
}
for (const button of document.querySelectorAll('[data-tool-config]')) button.addEventListener('click', () => openPlugin(button.dataset.toolConfig));
