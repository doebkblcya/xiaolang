'use strict';
const $ = id => document.getElementById(id);
const usageNames = { chat: '聊天回复', proactive: '插话判断', memory_extract: '记忆提炼', memory_summary: '聊天摘要', persona_learn: '表达学习',
  image_description: '图片描述', image_inspect: '重看图片', embedding_recall: '向量检索', embedding_index: '记忆向量入库', embedding_test: '向量连接测试',
  web_search: '网页搜索', web_fetch: '网页阅读', other: '其他调用' };
const words = { connected: '已连接', disconnected: '已断开', starting: '启动中', ready: '已就绪', stopping: '停止中', failed: '失败', error: '连接异常',
  completed: '已完成', queued: '等待处理', running: '处理中', sending: '发送中', unknown: '结果未知', expired: '已过期', cancelled: '已取消',
  no_trigger: '未触发回复', active: '已启用', disabled: '已停用', pending: '等待激活', scheduled: '等待到点', sent: '已确认发送', succeeded: '已成功', private: '私聊', mention: '@机器人', keyword: '触发词' };
const reasons = { private: '私聊默认回复', mention: '@机器人', keyword: '命中触发词', no_trigger: '未触发回复', duplicate: '重复消息', own_message: '机器人自身消息', group_not_allowed: '群不在白名单', chat_disabled: '聊天已停用', invalid_message: '格式无效', account_mismatch: '账号不匹配' };
const viewTitles = { overview: '主页', chats: '聊天记录', logs: '过程日志', usage: '模型用量', 'model-settings': '回复模型', 'qq-settings': 'QQ 接入', memories: '聊天与记忆', persona: '人设与学习', tooling: '工具与行动', reminders: '定时提醒', plugins: '插件' };
Object.assign(reasons, { proactive: '主动插话', no_trigger: '未命中直接触发条件' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let logs = [], cursor = 0, busy = false, selected, runStarted;
let logBefore = null, logHistory = false, logBusy = false, logVersion = 0, logGeneration;
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
  if (view === 'overview') { refreshSystem(); refreshHome(); }
  if (view === 'chats') refreshChats();
  if (view === 'memories') refreshMemory();
  if (view === 'persona') refreshPersona();
  if (view === 'tooling') refreshTools();
  if (view === 'reminders') refreshReminders();
  if (view === 'logs') { renderLogs(); if (!logHistory) refreshLogs(); }
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
let homeBusy = false;
async function refreshHome() {
  if (homeBusy) return;
  homeBusy = true;
  try {
    const data = await get('/api/panel/home');
    const cards = data.items.map(item => {
      const card = element('article', 'panel home-module'); card.dataset.home = item.id;
      card.append(element('span', 'home-module-title', item.title), element('strong', `home-module-value ${item.tone}`, item.value));
      if (item.detail) card.append(element('small', 'muted', item.detail));
      if (item.action) {
        const button = element('button', 'link card-link', '配置 →'); button.type = 'button';
        button.addEventListener('click', () => item.action.page ? showView(item.action.page) : openPlugin(item.action.plugin));
        card.append(button);
      }
      return card;
    });
    const root = $('home-modules');
    // Preserve focused controls while unchanged polling results arrive.
    const snapshot = JSON.stringify(data.items);
    if (root.dataset.snapshot !== snapshot) { root.replaceChildren(...cards); root.dataset.snapshot = snapshot; }
    root.hidden = !cards.length;
  } catch {
    for (const value of document.querySelectorAll('.home-module-value')) { value.textContent = '暂不可用'; value.className = 'home-module-value neutral'; }
    for (const detail of document.querySelectorAll('.home-module small')) detail.remove();
    delete $('home-modules').dataset.snapshot;
  } finally { homeBusy = false; }
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
  $('hero-state').textContent = ({ ready: '运行正常', starting: '启动中', stopping: '停止中', failed: '启动失败' })[status.state] ?? '暂不可用';
  $('today-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const counts = status.counts;
  $('pending').textContent = counts ? `${(counts.running ?? 0) + (counts.sending ?? 0)} / ${counts.queued ?? 0}` : '—';
  $('completed').textContent = counts ? `已完成 ${counts.completed ?? 0} 轮` : '会话存储未启用';
  const seconds = Math.floor(status.uptimeMs / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  $('uptime').textContent = hours ? `${hours} 小时 ${minutes % 60} 分` : minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  $('memory').textContent = `进程内存 ${(status.memoryBytes / 1048576).toFixed(1)} MB`;
  $('app-state').textContent = words[status.state] ?? status.state;
  $('failures').textContent = counts ? ['failed', 'unknown', 'cancelled', 'expired'].reduce((total, key) => total + (counts[key] ?? 0), 0) : '—';
  $('last-message').textContent = status.lastMessage ? time(status.lastMessage, true) : status.intakeEnabled ? '本次启动尚无消息' : '消息接收未启用';
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

function renderLogs() {
  $('log-count').textContent = logs.length;
  const box = $('log-list'), top = box.scrollTop;
  box.replaceChildren(...logs.map(({ entry, display }) => {
    const row = element('div', `log-line ${entry.level ?? 'info'}`), body = element('div');
    row.append(element('time', '', time(entry.time, true))); body.append(element('strong', '', display?.title ?? entry.label ?? entry.code));
    if (entry.preview !== undefined) body.append(element('p', 'log-preview', entry.preview));
    if (display?.meta) body.append(element('div', 'log-meta', display.meta)); row.append(body); return row;
  }));
  if (!logs.length) box.append(element('p', 'empty', '暂无日志'));
  $('log-older').disabled = logBusy || !logBefore;
  $('log-latest').hidden = !logHistory;
  box.scrollTop = !logHistory && $('follow').checked ? box.scrollHeight : top;
}
let logEventsBusy = false, logEventsUpdated = 0;
async function refreshLogEvents() {
  if (logEventsBusy || Date.now() - logEventsUpdated < 10000) return;
  logEventsBusy = true;
  try {
    const data = await get('/api/logs/events'), select = $('log-event'), selected = select.value;
    const options = [element('option', '', `全部事件（${data.total}）`)]; options[0].value = '';
    const labels = new Map(); for (const item of data.events) labels.set(item.label ?? item.code, (labels.get(item.label ?? item.code) ?? 0) + 1);
    for (const item of data.events) { const label = item.label ?? item.code; const option = element('option', '', labels.get(label) > 1 ? `${label} · ${item.code}` : label); option.value = item.code; options.push(option); }
    if (selected && !data.events.some(item => item.code === selected)) { const option = element('option', '', select.selectedOptions[0]?.textContent ?? selected); option.value = selected; options.push(option); }
    const snapshot = JSON.stringify(options.map(option => [option.value, option.textContent]));
    if (select.dataset.snapshot !== snapshot) { select.replaceChildren(...options); select.value = selected; select.dataset.snapshot = snapshot; }
    logEventsUpdated = Date.now();
  } catch { /* Keep the current selection; log reads have their own error state. */ }
  finally { logEventsBusy = false; }
}
function resetLogs() {
  logVersion++; logs = []; cursor = 0; logBefore = null; logHistory = false; renderLogs(); refreshLogs();
}
async function refreshLogs(older = false) {
  if (logBusy || logHistory && !older) return;
  logBusy = true; const version = logVersion;
  const box = $('log-list'), height = box.scrollHeight, top = box.scrollTop;
  let more = false;
  try {
    const query = new URLSearchParams({ limit: '200', q: $('log-filter').value.trim(), event: $('log-event').value, level: $('log-level').value });
    refreshLogEvents();
    if (older && logBefore) query.set('before', logBefore); else if (cursor) query.set('after', cursor);
    let page = await get(`/api/logs?${query}`);
    if (version !== logVersion) return;
    if (logGeneration && logGeneration !== page.generation || page.reset) {
      logs = []; cursor = 0; logBefore = null; logHistory = false;
      query.delete('after'); query.delete('before'); page = await get(`/api/logs?${query}`);
      if (version !== logVersion) return;
    }
    logGeneration = page.generation;
    const initial = !logs.length, merged = new Map(logs.map(item => [item.seq, item]));
    for (const item of page.items) merged.set(item.seq, item);
    const ordered = [...merged.values()].sort((a,b) => a.seq - b.seq);
    logs = older ? ordered.slice(0, 500) : ordered.slice(-500);
    if (older || initial) logBefore = page.before;
    else if (logBefore !== null || ordered.length > 500) logBefore = logs[0]?.seq ?? null;
    if (older) logHistory = true; else { cursor = page.cursor; more = page.hasMore; }
    $('log-status').textContent = page.degraded ? '部分日志未能保存' : page.persistent ? '' : '临时记录';
    renderLogs();
    if (older) box.scrollTop = top + box.scrollHeight - height;
  } catch (error) {
    if (version === logVersion) $('log-status').textContent = error.message === 'HTTP 503' ? '日志服务未启用' : '日志读取失败';
  } finally {
    logBusy = false; $('log-older').disabled = !logBefore;
    if (version !== logVersion || more) queueMicrotask(() => refreshLogs());
  }
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
    button.addEventListener('click', () => { $('detail').close(); selected = undefined; $('log-filter').value = detail.id; $('log-event').value = ''; $('log-level').value = ''; resetLogs(); showView('logs'); }); body.append(button);
  } catch { $('detail-body').replaceChildren(element('p', 'error-box', '暂时无法读取详情，请关闭后重试。')); }
}
$('close-detail').addEventListener('click', () => { selected = undefined; $('detail').close(); });
$('detail').addEventListener('close', () => { selected = undefined; });
let logSearchTimer;
$('log-filter').addEventListener('input', () => { clearTimeout(logSearchTimer); logSearchTimer = setTimeout(resetLogs, 250); });
$('clear-filter').addEventListener('click', () => { clearTimeout(logSearchTimer); $('log-filter').value = ''; $('log-event').value = ''; $('log-level').value = ''; resetLogs(); });
$('log-event').addEventListener('change', resetLogs);
$('log-level').addEventListener('change', resetLogs);
$('log-older').addEventListener('click', () => refreshLogs(true));
$('log-latest').addEventListener('click', resetLogs);
$('follow').addEventListener('change', renderLogs);
async function poll() {
  if (busy) return; busy = true;
  try {
    const status = await get('/api/status');
    if (runStarted !== undefined && runStarted !== status.started) {
      settings = undefined; dirtyForms.clear(); await loadSettings(); await loadPanel();
    }
    if (applying && status.state === 'ready') { await loadSettings(); if (settings && !settings.pendingRestart) { applying = false; fillSettings(settings); } }
    runStarted = status.started;
    renderStatus(status);
    if (!$('overview').hidden) await Promise.all([refreshSystem(), refreshHome()]);
    if (!$('logs').hidden && !logHistory) refreshLogs();
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
  chatAnchored = false; timelineSnapshot = undefined; $('message-new').hidden = true;
  currentConversation = item; conversationRows = []; messageNext = undefined; timelineVersion++;
  setConversationHeading(item); renderConversations(); $('message-timeline').replaceChildren(element('p', 'empty', '正在读取…'));
  await loadTimeline(false, true);
}
let messageSelection, messageRequest = 0, timelineSnapshot, chatAnchored = false, chatScrollTop = 0;
const imageErrors = { image_url_expired: '原图链接已过期', image_download_timeout: '下载超时', image_download_network: '网络异常', image_download_failed: '原图下载失败', image_host_not_allowed: '图片来源未支持', image_format_unsupported: '图片格式未支持', image_too_large: '图片过大' };
function imageDescription(image) {
  if (image?.state === 'ready') return image.description;
  if (image?.state === 'pending') return '描述生成中';
  if (image?.state === 'disabled') return '图片理解已关闭';
  if (image?.state === 'failed') return `${imageErrors[image.errorCode] ?? image.errorCode ?? '生成失败'}${image.retryAt ? ` · 下次重试 ${time(image.retryAt, true)}` : ''}`;
  return '暂无已保存的图片描述';
}
function externalLink(label, url) {
  const node = element('a', 'message-image-link', label);
  if (typeof url === 'string' && url.startsWith('https://')) { node.href = url; node.target = '_blank'; node.rel = 'noreferrer noopener'; }
  return node;
}
function renderMessageSegments(segments, root, item, counter = { image: 0 }, depth = 0) {
  if (depth > 5) return;
  for (const part of segments ?? []) {
    if (part.type === 'text') root.append(document.createTextNode(part.text));
    else if (part.type === 'mention') root.append(element('span', 'message-mention', part.all ? '@全体成员' : `@${part.self ? '小狼' : part.name ?? part.userId}`));
    else if (part.type === 'image') {
      counter.image++;
      const image = item.images?.find(image => image.imageId === `img_${item.seq}_${counter.image}`);
      const block = element('span', 'message-attachment'); block.append(externalLink(part.filename || '图片 · 原图 ↗', part.url));
      const caption = element('details', 'image-description'), title = element('summary', '', '图片描述');
      caption.append(title, element('p', '', imageDescription(image))); block.append(caption); root.append(block);
    } else if (part.type === 'reply') {
      const quote = element('div', 'message-quote'), heading = element('div', 'quote-heading');
      heading.append(element('strong', '', part.name ?? part.sender ?? '引用消息'));
      if (part.seq) { const jump = element('button', 'link', '定位 ↗'); jump.type = 'button'; jump.addEventListener('click', () => locateMessage(part.seq)); heading.append(jump); }
      quote.append(heading);
      if (part.segments?.length) renderMessageSegments(part.segments, quote, item, counter, depth + 1);
      else quote.append(element('span', 'muted', '引用原文不可用'));
      root.append(quote);
    } else if (part.type === 'bundle') {
      const block = element('details', 'message-bundle'); block.append(element('summary', '', `${part.kind === 'forward' ? '聊天记录' : '组合消息'} · ${part.items.length}`));
      for (const child of part.items) { const row = element('div', 'bundle-message'); row.append(element('strong', '', child.name ?? child.sender ?? '未知作者')); renderMessageSegments(child.segments, row, item, counter, depth + 1); block.append(row); }
      root.append(block);
    } else if (part.type === 'card') {
      const card = element('div', 'message-card'); card.append(element('small', 'muted', part.source ?? part.kind), element('strong', '', part.title ?? '卡片'));
      if (part.description) card.append(element('span', '', part.description));
      if (part.url) card.append(externalLink('打开链接 ↗', part.url)); root.append(card);
    } else if (part.type === 'attachment') {
      const block = element('span', 'message-attachment'), type = { voice: '语音', video: '视频', file: '文件' }[part.kind] ?? '附件';
      block.append(externalLink([type, part.filename, part.size === undefined ? '' : `${Math.ceil(part.size / 1024)} KB`].filter(Boolean).join(' · '), part.url));
      if (part.kind === 'voice') block.append(element('span', 'voice-transcript', part.transcript ? `转写 · ${part.transcript}` : '暂无语音转写'));
      root.append(block);
    } else root.append(element('span', 'muted', `[暂不支持：${part.kind}]`));
  }
}
async function locateMessage(seq) {
  if (!currentConversation) return;
  let node = document.querySelector(`#message-timeline [data-seq="${seq}"]`);
  if (!node) {
    if (timelineLoading) return;
    const id = currentConversation.id, version = ++timelineVersion, pending = { id }; timelineLoading = pending;
    try {
      const data = await get(`/api/conversations/${id}?before=${seq + 1}`);
      if (id !== currentConversation?.id || version !== timelineVersion) return;
      conversationRows = data.items; messageNext = data.next; chatAnchored = true; timelineSnapshot = undefined; renderTimeline();
      $('message-new').hidden = false; $('message-new').textContent = '回到最新 ↓';
      node = document.querySelector(`#message-timeline [data-seq="${seq}"]`);
    } catch { $('conversation-message').textContent = '无法定位原消息'; }
    finally { if (timelineLoading === pending) timelineLoading = undefined; }
  }
  if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.classList.add('message-highlight'); setTimeout(() => node.classList.remove('message-highlight'), 1800); }
}
async function openMessageProcessing(conversation, seq) {
  messageSelection = { conversation, seq };
  const version = ++messageRequest, root = $('message-processing-body');
  root.replaceChildren(element('p', 'empty', '正在读取…'));
  if (!$('message-processing').open) $('message-processing').showModal();
  try {
    const detail = await get(`/api/conversations/${conversation}/messages/${seq}`);
    if (version !== messageRequest) return;
    const message = detail.message, records = detail.logs?.items ?? [];
    const meta = element('div', 'detail-meta'); meta.append(element('strong', '', message.name), element('span', '', time(message.time, true)), badge(detail.turn?.state ?? 'no_trigger'));
    root.replaceChildren(meta);
    const direct = records.filter(item => item.entry.code === 'trigger_unmatched' || item.entry.code === 'trigger_matched').at(-1)?.entry;
    const decision = records.filter(item => ['proactive_observing', 'proactive_judge_started', 'proactive_decided', 'proactive_skipped', 'proactive_judge_failed'].includes(item.entry.code)).at(-1)?.entry;
    const facts = element('div', 'message-facts');
    const fact = (label, value) => { facts.append(element('span', 'muted', label), element('span', '', value)); };
    fact('直接触发', detail.turn && detail.turn.reason !== 'proactive' ? reasons[detail.turn.reason] ?? detail.turn.reason : direct?.reason ? reasons[direct.reason] ?? direct.reason : '未保存直接判断记录');
    if (decision) fact('最近插话判断', [decision.state === 'silent' ? '保持沉默' : decision.state === 'speak' ? '本批决定接话' : decision.label, decision.reason, ...(decision.fields ?? []).map(field => `${field.label}：${field.value}`)].filter(Boolean).join(' · '));
    else if (!detail.turn) fact('处理原因', records.findLast(item => item.entry.code === 'message_ignored')?.entry.reason === 'chat_disabled' ? '聊天链路已停用' : '未保存插话判断记录');
    root.append(facts);
    if (detail.images?.length) for (const image of detail.images) root.append(detailSection(`图片描述 · ${image.imageId}`, imageDescription(image)));
    const process = element('details', 'message-process-records'); process.append(element('summary', '', `处理记录 · ${records.length}`));
    if (records.length) {
      const list = element('ol', 'message-process-list');
      for (const item of records) { const entry = item.entry, row = element('li'); row.append(element('div', 'timeline-meta', `${time(Date.parse(entry.time), true)} · ${item.display?.title ?? entry.label ?? entry.code}`));
        const fields = [entry.reason ? reasons[entry.reason] ?? entry.reason : '', entry.errorCode, ...((entry.fields ?? []).map(field => `${field.label}：${field.value}`)), entry.durationMs === undefined ? '' : `${entry.durationMs} ms`].filter(Boolean);
        if (fields.length) row.append(element('p', '', fields.join(' · '))); list.append(row); }
      process.append(list);
    } else process.append(element('p', 'muted', detail.logs ? '未保存相关处理记录，或记录已过保留期。' : '日志服务暂不可用'));
    if (detail.logs && (!detail.logs.persistent || detail.logs.degraded)) process.append(element('p', 'muted', '当前日志未完整持久化'));
    root.append(process);
    const platform = element('details', 'message-process-records'); platform.append(element('summary', '', '消息与平台信息'));
    platform.append(element('pre', 'message-metadata', JSON.stringify({ seq: message.seq, sender: message.sender, messageId: message.id, ...message.metadata,
      platform: detail.platform ? { connection: detail.platform.connection, present: detail.platform.present ?? '未知', push: detail.platform.push ?? '未知', receive: detail.platform.receive ?? '未知', role: detail.platform.role ?? '未知' } : '暂不可用' }, null, 2)));
    root.append(platform);
    const actions = element('div', 'form-actions message-process-actions');
    if (detail.turn) { const turn = element('button', 'secondary', '回复详情'); turn.type = 'button'; turn.addEventListener('click', () => { $('message-processing').close(); openDetail(detail.turn.id); }); actions.append(turn); }
    const logsButton = element('button', 'secondary', '过程日志'); logsButton.type = 'button'; logsButton.addEventListener('click', () => { $('message-processing').close(); $('log-filter').value = detail.turn?.id ?? message.key; $('log-event').value = ''; $('log-level').value = ''; resetLogs(); showView('logs'); }); actions.append(logsButton);
    const triggerPage = registeredPages.find(page => page.view === 'trigger-settings');
    if (triggerPage) { const configure = element('button', 'secondary', '触发规则'); configure.type = 'button'; configure.addEventListener('click', () => { $('message-processing').close(); showView(triggerPage.id); }); actions.append(configure); }
    root.append(actions);
  } catch { if (version === messageRequest) root.replaceChildren(element('p', 'error-box', '消息已删除或暂时无法读取。')); }
}
$('close-message-processing').addEventListener('click', () => $('message-processing').close());
$('message-processing').addEventListener('close', () => { messageSelection = undefined; messageRequest++; });
$('refresh-message-processing').addEventListener('click', () => { if (messageSelection) openMessageProcessing(messageSelection.conversation, messageSelection.seq); });

function renderTimeline() {
  const snapshot = JSON.stringify(conversationRows);
  if (timelineSnapshot === snapshot) return;
  timelineSnapshot = snapshot;
  const nodes = conversationRows.map(item => {
    const article = element('article', `timeline-item ${item.direction === 'out' ? 'outgoing' : 'incoming'}`), meta = element('div', 'timeline-meta'); article.dataset.seq = item.seq;
    meta.append(element('strong', '', item.name), element('span', '', time(item.time, true)));
    meta.title = `ID：${item.sender}`;
    if (item.kind === 'reminder') meta.append(element('span', '', '定时提醒'));
    const bubble = element('div', 'message-bubble');
    if (item.direction === 'out') bubble.textContent = item.parts?.[0] ?? item.text;
    else renderMessageSegments(item.segments, bubble, item);
    const remove = element('button', 'link message-remove', '删除'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(item.direction === 'in' ? '彻底删除这条消息及对应回复？关联的记忆、摘要和表达学习也会清理，无法恢复。' : '彻底删除这条回复及关联记录？无法恢复。')) return;
      remove.disabled = true;
      try { await eraseStoredData({ kind: 'message', id: currentConversation.id, seq: item.seq }); await resetChatsAfterDelete(); }
      catch (error) { $('conversation-message').textContent = error.message; remove.disabled = false; }
    }); meta.append(remove);
    article.append(meta, bubble);
    if (item.direction === 'out' && item.parts?.length > 1) for (const part of item.parts.slice(1)) article.append(element('div', 'message-bubble', part));
    if (item.direction === 'in') {
      const conversation = currentConversation.id, button = element('button', 'link timeline-detail', item.turn ? `详情 · ${words[item.turn.state] ?? item.turn.state}` : '未触发回复');
      button.type = 'button'; button.title = '查看触发原因与处理记录'; button.addEventListener('click', () => openMessageProcessing(conversation, item.seq)); article.append(button);
    } else if (item.turn) {
      const button = element('button', 'link timeline-detail', `详情 · ${words[item.turn.state] ?? item.turn.state}`); button.type = 'button'; button.addEventListener('click', () => openDetail(item.turn.id)); article.append(button);
    }
    if (item.feedback) article.append(detailSection(`故障反馈 · ${words[item.feedback.state] ?? item.feedback.state}`, item.feedback.text));
    return article;
  });
  const expanded = new Set([...document.querySelectorAll('#message-timeline [data-seq]')].flatMap(node => [...node.querySelectorAll('details')].flatMap((detail, index) => detail.open ? [`${node.dataset.seq}:${index}`] : [])));
  $('message-timeline').replaceChildren(...nodes);
  for (const node of nodes) [...node.querySelectorAll('details')].forEach((detail, index) => { detail.open = expanded.has(`${node.dataset.seq}:${index}`); });
  if (!nodes.length) $('message-timeline').append(element('p', 'empty', '这个会话暂无消息。'));
  $('message-older').disabled = !messageNext;
  $('message-page-note').textContent = `已显示 ${conversationRows.length} 条`;
}
async function loadTimeline(older = false, initial = false) {
  if (!currentConversation || (!initial && timelineLoading?.id === currentConversation.id) || chatAnchored && !older && !initial) return;
  const pending = { id: currentConversation.id }; timelineLoading = pending;
  if (older) { $('message-older').disabled = true; $('message-older').textContent = '正在加载…'; }
  try {
  const id = currentConversation.id, version = ++timelineVersion, box = $('message-timeline');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90, top = box.scrollTop, height = box.scrollHeight;
  const data = await get(`/api/conversations/${id}${older && messageNext ? `?before=${messageNext}` : ''}`);
  if (id !== currentConversation?.id || version !== timelineVersion) return;
  currentConversation = data.conversation; setConversationHeading(currentConversation);
  const existing = new Map(conversationRows.map(item => [item.seq, item]));
  // A burst larger than a page must not leave a hidden gap between old and new records.
  const disjoint = !older && data.items.length === 50 && conversationRows.length && !data.items.some(item => existing.has(item.seq));
  if (disjoint && !nearBottom && !initial) { $('message-new').hidden = false; $('message-new').textContent = '有新消息 ↓'; return; }
  if (disjoint) existing.clear();
  const previousLast = conversationRows.at(-1)?.seq ?? 0;
  const unseen = data.items.filter(item => item.seq > previousLast).length;
  for (const item of data.items) existing.set(item.seq, item);
  conversationRows = [...existing.values()].sort((a, b) => a.seq - b.seq);
  if (older || initial || disjoint) messageNext = data.next;
  renderTimeline();
  if (!initial && !older && !nearBottom && unseen) { $('message-new').hidden = false; $('message-new').textContent = '有新消息 ↓'; }
  if (older) box.scrollTop = top + box.scrollHeight - height;
  else box.scrollTop = initial || (nearBottom && $('message-follow').checked) ? box.scrollHeight : top;
  } finally { if (timelineLoading === pending) { timelineLoading = undefined; $('message-older').disabled = !messageNext; $('message-older').textContent = '查看更早消息'; chatScrollTop = $('message-timeline').scrollTop; } }
}
function filterConversations() {
  timelineSnapshot = undefined; chatAnchored = false; $('message-new').hidden = true;
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
$('message-timeline').addEventListener('scroll', () => {
  const box = $('message-timeline'), upward = box.scrollTop < chatScrollTop; chatScrollTop = box.scrollTop;
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 90 && !chatAnchored) $('message-new').hidden = true;
  if (upward && box.scrollTop < 100 && messageNext && !timelineLoading) loadTimeline(true).catch(() => { $('conversation-message').textContent = '无法读取更早消息，请重试。'; });
}, { passive: true });
$('message-new').addEventListener('click', () => { if (currentConversation) selectConversation(currentConversation).catch(() => { $('conversation-message').textContent = '读取会话失败'; }); });
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
  logVersion++; logs = []; cursor = 0; logBefore = null; logHistory = false; selected = undefined; renderLogs(); $('detail').close();
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
