'use strict';
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { agents: [], conversations: [], harnesses: [], current: null, snapshot: null, filter: 'all', drafts: {}, uploads: {}, pending: new Set(), unread: new Set(), live: new Map(), loading: 0 };
function savedObject(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
const expandedAgents = savedObject('agent-room:expanded-agents');
const lastAgentSessions = savedObject('agent-room:last-agent-sessions');
const composerAdapters = {
  qoder: { placeholder: '描述你想让 Qoder 完成的任务…', heading: '和 Qoder 开始新会话' },
  zcode: { placeholder: '描述你想让 ZCode 完成的任务…', heading: '和 ZCode 开始新会话' },
  codex: { placeholder: '你想和这位 Agent 一起做什么？', mode: '只读对话', heading: '我们要做什么？' },
  dsh: { placeholder: '描述你的想法，或引用文件开始对话…', mode: '标准对话', heading: '探索未尽之境' },
};
const permissionNames = { default: '逐次确认', acceptEdits: '自动批准编辑', auto: '原生安全判断', dontAsk: '拒绝未授权操作', yolo: '跳过权限确认', plan: '规划', build: '逐次确认', 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完整访问' };
const presetNames = { native: '原生会话', standard: '标准模式', ptc: '程序化工具模式', minimal: '精简模式', cordis: 'Cordis 模式', default: '默认模式', plan: '规划模式' };
const roomApprovals = new Map();
function supportsSessions(agent) { return Boolean(composerAdapters[agent?.backend]); }
function agentSessions(id) { return state.conversations.filter(c => c.kind === 'direct' && c.agentIds[0] === id).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt)); }
function agentPinned(agent) { return agent.pinned ?? agentSessions(agent.id).some(c => c.pinned && !c.titleSource && c.title === agent.label); }
function expandAgent(id, expanded = true) { expandedAgents[id] = expanded; localStorage.setItem('agent-room:expanded-agents', JSON.stringify(expandedAgents)); }
let navigationSave = Promise.resolve();
function persistNavigation() {
  const view = { selected: state.current, expanded: { ...expandedAgents }, lastSessions: { ...lastAgentSessions } };
  navigationSave = navigationSave.catch(() => {}).then(() => api('/ui-state', view));
  return navigationSave;
}
let onSubmit = null;
let toastTimer;
async function api(route, body, method = 'POST') {
  const response = await fetch('/api' + route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function avatar(agent, group = false) { return `<span class="avatar ${group ? 'group' : escapeHtml(agent?.backend || '')}">${group ? '☷' : escapeHtml((agent?.label || 'A').slice(0, 1).toUpperCase())}</span>`; }
function harnessLabel(backend) {
  return ({ zcode: 'ZCode', codex: 'Codex', dsh: 'DSH', qoder: 'Qoder', claude: 'Claude Code', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI' })[backend] || backend || '';
}
function harnessBadge(agent) {
  return agent?.backend ? `<span class="harness-badge ${escapeHtml(agent.backend)}">${escapeHtml(harnessLabel(agent.backend))}</span>` : '';
}
function time(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''; }
function renderList() {
  const query = $('#search').value.trim().toLowerCase();
  const matches = row => (row.title + ' ' + (row.preview || '')).toLowerCase().includes(query) || row.agentIds.some(id => { const a = state.agents.find(a => a.id === id); return a && (a.label + ' ' + harnessLabel(a.backend)).toLowerCase().includes(query); });
  const rows = state.conversations.filter(row => (state.filter === 'all' || row.kind === state.filter) && matches(row));
  const entries = rows.filter(row => row.kind !== 'direct' || !supportsSessions(state.agents.find(a => a.id === row.agentIds[0]))).map(row => ({ row, pinned: row.pinned, updatedAt: row.updatedAt }));
  if (state.filter !== 'group') for (const agent of state.agents.filter(supportsSessions)) {
    const sessions = agentSessions(agent.id), matching = sessions.filter(matches);
    if (!matching.length && query && !(agent.label + ' ' + harnessLabel(agent.backend)).toLowerCase().includes(query)) continue;
    entries.push({ agent, sessions: query ? matching : sessions, pinned: agentPinned(agent), updatedAt: sessions.reduce((at, c) => c.updatedAt > at ? c.updatedAt : at, agent.createdAt || '') });
  }
  entries.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  $('#conversations').innerHTML = entries.length ? entries.map(({ row, agent, sessions, pinned }) => {
    if (agent) {
      const all = agentSessions(agent.id);
      const selected = all.find(c => c.id === state.current);
      const recent = all.find(c => c.id === lastAgentSessions[agent.id]) || all[0];
      const expanded = Boolean(query) || expandedAgents[agent.id] === true;
      return `<section class="agent-workspace ${selected ? 'selected-workspace' : ''}" data-agent="${escapeHtml(agent.id)}"><div class="agent-workspace-heading"><button class="agent-disclosure" data-expand-agent="${escapeHtml(agent.id)}" aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(agent.label)} 的会话" aria-expanded="${expanded}" aria-controls="sessions-${escapeHtml(agent.id)}">${expanded ? '⌄' : '›'}</button><button class="conversation agent-entry" data-open-agent="${escapeHtml(agent.id)}" ${recent ? `data-room="${escapeHtml(recent.id)}"` : ''}>${avatar(agent)}<div class="conversation-info"><div class="conversation-top"><strong>${pinned ? '<span class="pin-mark">⌃ </span>' : ''}${escapeHtml(agent.label)}</strong>${all.some(c => state.unread.has(c.id)) ? '<i class="unread"></i>' : ''}</div><p class="conversation-preview">${harnessBadge(agent)}<span>${all.length} 个会话</span></p></div></button><button class="agent-add-session" data-new-session="${escapeHtml(agent.id)}" aria-label="与 ${escapeHtml(agent.label)} 新建会话" title="新建会话">＋</button></div><div class="agent-sessions" id="sessions-${escapeHtml(agent.id)}" ${expanded ? '' : 'hidden'}>${sessions.map(c => `<div class="session-item"><button class="session-link ${c.id === state.current ? 'active' : ''}" data-session="${escapeHtml(c.id)}" aria-current="${c.id === state.current}" title="${escapeHtml(c.title)}"><span class="session-symbol">${c.pinned ? '⌃' : '◦'}</span><span class="session-title">${escapeHtml(c.title)}</span>${state.unread.has(c.id) ? '<i class="unread"></i>' : ''}</button><button class="session-more" data-session-menu="${escapeHtml(c.id)}" aria-label="管理会话 ${escapeHtml(c.title)}">⋯</button></div>`).join('') || '<p class="empty-sessions">还没有会话</p>'}<button class="new-session-link" data-new-session="${escapeHtml(agent.id)}">＋ 新建会话</button></div></section>`;
    }
    return `<button class="conversation ${row.id === state.current ? 'active' : ''}" data-room="${row.id}" aria-current="${row.id === state.current}">${avatar(state.agents.find(a => a.id === row.agentIds[0]), row.kind === 'group')}<div class="conversation-info"><div class="conversation-top"><strong>${row.pinned ? '<span class="pin-mark" aria-label="已置顶">⌃ </span>' : ''}${escapeHtml(row.title)}</strong><time>${time(row.updatedAt)}</time>${state.unread.has(row.id) ? '<i class="unread"></i>' : ''}</div><p class="conversation-preview">${row.kind === 'direct' ? harnessBadge(state.agents.find(a => a.id === row.agentIds[0])) : ''}<span>${escapeHtml(row.preview || '开始聊天吧')}</span></p></div></button>`;
  }).join('') : '<p class="empty-list">' + (query ? '没有找到匹配的会话' : state.filter === 'group' ? '还没有群聊<br>选择几位伙伴，一起聊聊' : '点击搜索框旁的 ＋<br>添加你的第一位 AI 伙伴') + '</p>';
  $('#welcome-add').textContent = state.agents.length ? '＋ 添加 Agent' : '＋ 添加第一个 Agent';
}
const creatingSessions = new Set();
async function newSession(agentId) {
  if (creatingSessions.has(agentId)) return;
  creatingSessions.add(agentId);
  try {
    const result = await api('/conversations', { agentId });
    expandAgent(agentId); await refresh(); await openConversation(result.conversation.id); $('#draft').focus();
  } catch (error) { toast(error.message); }
  finally { creatingSessions.delete(agentId); }
}
function renderConversationChrome() {
  const row = state.conversations.find(c => c.id === state.current); if (!row) return;
  const agent = row.kind === 'direct' ? state.agents.find(a => a.id === row.agentIds[0]) : null;
  const adapter = composerAdapters[agent?.backend];
  $('#chat-title').textContent = row.title;
  $('#group-actions').hidden = row.kind !== 'group';
  $('#session-actions').hidden = !adapter; $('#new-session').hidden = !adapter;
  const harnesses = [...new Set(row.agentIds.map(id => harnessLabel(state.agents.find(a => a.id === id)?.backend)).filter(Boolean))];
  $('#chat-subtitle').textContent = row.kind === 'group' ? `${row.agentIds.length} 位 Agent · ${harnesses.join(' / ')}` : `${agent?.label || 'Agent'} · ${harnesses[0] || 'Agent'} · 独立会话`;
  const composer = $('.composer'); composer.dataset.harness = adapter ? agent.backend : 'generic';
  $('#conversation-view').dataset.harness = composer.dataset.harness;
  $('#harness-context').hidden = !adapter; $('#harness-options').hidden = !adapter;
  $('#composer-permission').hidden = !adapter;
  $('#draft').placeholder = adapter?.placeholder || '发条消息，聊聊你的想法…';
  if (!adapter) return;
  $('#composer-workspace').textContent = '▱ ' + agent.label;
  $('#composer-workspace').title = agent.workspace || 'Agent 工作区';
  $('#composer-mode').textContent = (presetNames[row.sessionConfig?.preset] || (agent.backend === 'dsh' ? '标准模式' : '默认模式')) + ' ⌄';
  $('#composer-mode').hidden = ['qoder', 'zcode'].includes(agent.backend);
  $('#composer-mode').title = '选择当前会话的原生预设（首条消息前可更改）';
  $('#composer-permission').textContent = (permissionNames[row.sessionConfig?.permission] || '原有权限') + ' ⌄';
  $('#composer-permission').title = '只影响当前会话；打开菜单读取后端实际可用选项';
  $('#composer-model').textContent = agent.modelName || agent.model || '后端默认模型';
  $('#composer-model').title = '模型随 Agent 固定，可在 Agent 设置查看';
  $('#composer-effort').textContent = (row.efforts?.[agent.id] || agent.effort || '默认推理') + ' ⌄';
}
let composerMenuGeneration = 0;
function closeComposerMenu() { composerMenuGeneration++; $('#composer-menu')?.remove(); }
async function showComposerMenu(kind) {
  closeComposerMenu(); closeTools(); hideMentions();
  const roomId = state.current, row = state.conversations.find(c => c.id === roomId);
  const agent = state.agents.find(a => a.id === row?.agentIds[0]); if (!agent || row.kind !== 'direct') return;
  const anchor = $(kind === 'preset' ? '#composer-mode' : kind === 'permission' ? '#composer-permission' : '#composer-effort');
  const generation = composerMenuGeneration;
  const menu = document.createElement('div'); menu.id = 'composer-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', { preset: '会话预设', permission: '会话权限', effort: '推理强度' }[kind]);
  menu.innerHTML = '<p class="hint">正在读取后端选项…</p>'; document.body.append(menu);
  const position = () => {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, rect.top - menu.offsetHeight - 8) + 'px';
  }; position();
  try {
    let data, choices, selected, locked = false;
    if (kind === 'effort') {
      data = await api('/models', { backend: agent.backend, model: agent.model });
      const model = data.models.find(m => m.id === agent.model);
      choices = (model?.efforts || []).map(id => ({ id, label: id })); selected = row.efforts?.[agent.id] || agent.effort || model?.defaultEffort;
    } else {
      data = await api('/session-controls?room=' + encodeURIComponent(roomId));
      choices = kind === 'preset' ? data.presets : data.permissions; selected = data.config[kind]; locked = kind === 'preset' && data.presetLocked;
    }
    if (generation !== composerMenuGeneration || state.current !== roomId || !menu.isConnected) return;
    menu.innerHTML = '<div class="composer-menu-title">' + escapeHtml(menu.getAttribute('aria-label')) + '</div>' + choices.map(choice => `<button role="menuitemradio" aria-checked="${choice.id === selected}" data-choice="${escapeHtml(choice.id)}" ${choice.unavailable || locked ? 'disabled' : ''}><span>${escapeHtml(choice.label)}</span>${choice.id === selected ? '<span aria-hidden="true">✓</span>' : ''}${choice.unavailable ? `<small>${escapeHtml(choice.unavailable)}</small>` : ''}</button>`).join('') + '<p class="hint">' + (locked ? '预设已锁定，新建会话可选择其他模式。' : kind === 'permission' ? '仅用于当前会话，受后端权限约束。' : kind === 'preset' ? '使用后端原生预设，不修改全局默认设置。' : choices.length ? '仅用于当前会话。' : '当前模型未提供推理档位。') + '</p>';
    position(); menu.querySelector('button:not(:disabled)')?.focus();
    menu.onclick = async event => {
      const button = event.target.closest('[data-choice]'); if (!button || button.disabled) return;
      const value = button.dataset.choice; button.disabled = true;
      try {
        if (kind === 'effort') await api('/member-effort', { room: roomId, agent: agent.id, effort: value });
        else {
          const config = { ...data.config, [kind]: value };
          if (['danger-full-access', 'yolo'].includes(config.permission) && data.config.permission !== config.permission && !window.confirm('完整访问允许此会话在工作区之外修改文件和执行命令。确认仅为此会话启用？')) { button.disabled = false; return; }
          await api('/session-controls', { room: roomId, config, confirmFullAccess: config.permission === 'danger-full-access' });
        }
        closeComposerMenu(); await refresh(); if (state.current === roomId) { renderConversationChrome(); anchor.focus(); } toast('当前会话设置已保存');
      } catch (error) { button.disabled = false; toast(error.message); }
    };
    menu.onkeydown = event => {
      if (event.key === 'Escape') { closeComposerMenu(); anchor.focus(); return; }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
  } catch (error) { if (menu.isConnected && generation === composerMenuGeneration) { menu.innerHTML = '<p class="hint">' + escapeHtml(error.message) + '</p>'; position(); } }
}
function renderApprovals() {
  const rows = roomApprovals.get(state.current) || [], panel = $('#approval-panel'); panel.hidden = !rows.length;
  panel.innerHTML = rows.map(item => `<article class="approval-card"><strong>${escapeHtml(item.title)}</strong><pre>${escapeHtml(item.detail)}</pre><div><button data-approval="${escapeHtml(item.id)}" data-allow="false">拒绝</button><button data-approval="${escapeHtml(item.id)}" data-allow="true" class="primary">允许这一次</button></div></article>`).join('');
}
function attachmentsHtml(items, removable = false) {
  return items.map((file, index) => `<span class="file-chip">${file.isImage ? `<img alt="${escapeHtml(file.name)}" src="/api/attachment/${encodeURIComponent(file.id)}">` : '▤'}${escapeHtml(file.name)}${removable ? `<button data-remove-file="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button>` : ''}</span>`).join('');
}
function renderAttachments() { $('#attachments').innerHTML = attachmentsHtml(state.uploads[state.current] || [], true); }
const messageNodes = new Map();
let renderedRoom = null;
function renderMessages() {
  const panel = $('#messages');
  const stick = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
  const log = state.snapshot?.log || [];
  $('#conversation-view').dataset.empty = String(!log.some(r => ['user', 'agent'].includes(r.kind)));
  if (renderedRoom !== state.current) { panel.replaceChildren(); messageNodes.clear(); renderedRoom = state.current; }
  panel.querySelector('.empty-chat')?.remove();
  const retained = new Set();
  let previous = null;
  for (const [index, record] of log.entries()) {
    const key = record.id || 'seq:' + (record.seq ?? index); retained.add(key);
    const html = messageHtml(record);
    let cached = messageNodes.get(key);
    if (!cached || cached.html !== html || cached.node.parentNode !== panel) {
      const template = document.createElement('template'); template.innerHTML = html;
      const node = template.content.firstElementChild;
      if (cached?.node.parentNode === panel) cached.node.replaceWith(node);
      cached = { node, html }; messageNodes.set(key, cached);
    }
    const next = previous ? previous.nextSibling : panel.firstChild;
    if (next !== cached.node) panel.insertBefore(cached.node, next);
    previous = cached.node;
  }
  for (const [key, cached] of messageNodes) if (!retained.has(key)) { cached.node.remove(); messageNodes.delete(key); }
  updateLiveMessages(panel);
  if (!panel.children.length) {
    const row = state.conversations.find(c => c.id === state.current);
    const agent = row?.kind === 'direct' ? state.agents.find(a => a.id === row.agentIds[0]) : null;
    const adapter = composerAdapters[agent?.backend];
    panel.innerHTML = adapter ? `<div class="empty-chat harness-welcome">${avatar(agent)}<span class="eyebrow">${escapeHtml(harnessLabel(agent.backend))} · ${escapeHtml(agent.label)}</span><strong>${adapter.heading}</strong><p>新的会话，新的思路。<br>继续使用这位 Agent 的工作区与共享记忆。</p></div>` : '<div class="empty-chat"><strong>从一句「你好」开始</strong><p>文字、文件、图片，都可以分享。</p></div>';
  }
  if (stick) panel.scrollTop = panel.scrollHeight;
  updateActivity();
}
function messageHtml(record) {
    if (record.pollId) {
      const poll = state.snapshot?.polls?.find(p => p.id === record.pollId);
      if (poll) {
        if (record.pollPhase === 'open' || !state.snapshot?.log?.some(r => r.pollId === record.pollId && r.pollPhase === 'open')) return pollHtml(poll);
        const winners = poll.options.filter(o => poll.winners?.includes(o.id)).map(o => o.text);
        const summary = poll.status === 'cancelled' ? '已取消' : '已结束，' + (winners.length ? (winners.length > 1 ? '并列最多票：' : '最多票：') + winners.join('、') : '无有效选票');
        return `<div class="system-message">投票「${escapeHtml(poll.question)}」${escapeHtml(summary)}</div>`;
      }
    }
    if (record.kind === 'system') return `<div class="system-message">${escapeHtml(record.text)}</div>`;
    const isUser = record.kind === 'user';
    const agent = state.agents.find((a) => a.id === record.authorId) || { label: record.authorLabel };
    const files = (record.attachments || []).map((f) => f.isImage ? `<a href="/api/attachment/${encodeURIComponent(f.id)}" target="_blank" rel="noopener"><img class="message-image" src="/api/attachment/${encodeURIComponent(f.id)}" alt="${escapeHtml(f.name)}"></a>` : `<a class="file-chip" href="/api/attachment/${encodeURIComponent(f.id)}" download="${escapeHtml(f.name)}">▤ ${escapeHtml(f.name)}</a>`).join('');
    const privateMessage = record.visibility === 'private';
    const recipients = (record.recipientIds || []).map((id, i) => id === 'user' ? '用户' : (state.agents.find(a => a.id === id)?.label || record.recipientLabels?.[i] || id)).join('、');
    const scope = privateMessage ? `<span class="private-label">私聊 · ${escapeHtml(record.authorLabel)} → ${escapeHtml(recipients)} · 用户可见</span>` : '';
    return `<article class="message ${isUser ? 'user' : ''} ${privateMessage ? 'private-message' : ''}">${isUser ? '<span class="avatar">我</span>' : avatar(agent)}<div class="message-main"><div class="message-meta"><span>${escapeHtml(record.authorLabel)}</span>${isUser ? '' : harnessBadge(agent)}<time>${time(record.ts)}</time></div>${scope}<div class="bubble">${escapeHtml(record.text)}${files}</div></div></article>`;
}
// Coalesce streaming updates once per frame without rebuilding history DOM.
let messageFrame = null;
let fullMessageRender = false;
function scheduleMessages(full = false) {
  fullMessageRender ||= full;
  if (messageFrame !== null) return;
  messageFrame = requestAnimationFrame(() => {
    messageFrame = null;
    const rebuild = fullMessageRender; fullMessageRender = false;
    if (rebuild) renderMessages();
    else {
      const panel = $('#messages'); const stick = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
      updateLiveMessages(panel);
      if (stick) panel.scrollTop = panel.scrollHeight;
      updateActivity();
    }
  });
}
function updateLiveMessages(panel) {
  for (const node of panel.querySelectorAll('[data-live]')) {
    const live = state.live.get(node.dataset.live);
    if (!live || live.room !== state.current || !live.text) node.remove();
  }
  for (const [id, live] of state.live) {
    if (live.room !== state.current || !live.text) continue;
    panel.querySelector('.empty-chat')?.remove();
    let node = [...panel.querySelectorAll('[data-live]')].find(n => n.dataset.live === id);
    if (!node) {
      const agent = state.agents.find(a => a.id === live.memberId);
      node = document.createElement('article'); node.className = 'message live'; node.dataset.live = id;
      node.innerHTML = avatar(agent) + '<div class="message-main"><div class="message-meta"><span>' + escapeHtml(agent?.label || 'Agent') + '</span>' + harnessBadge(agent) + '<span>生成预览，仅用户可见，完成后投递</span></div><div class="bubble"></div></div>';
      panel.append(node);
    }
    const bubble = node.querySelector('.bubble'); const text = live.text;
    if (bubble.textContent !== text) bubble.textContent = text;
  }
}
function updateActivity() {
  const ids = new Set(state.snapshot?.busy || []);
  for (const live of state.live.values()) if (live.room === state.current) ids.add(live.memberId);
  const labels = [...ids].map(id => {
    const agent = state.agents.find(a => a.id === id);
    const live = [...state.live.values()].find(l => l.room === state.current && l.memberId === id);
    return (agent?.label || 'Agent') + ' · ' + (live?.retry ? '连接重试中' : live?.text ? '正在回复' : '正在思考');
  });
  const text = state.loading ? '正在上传…' : labels.length ? labels.join('　｜　') : state.pending.has(state.current) ? (state.snapshot?.connected ? '正在发送…' : '正在连接后端…') : '';
  if ($('#activity').textContent !== text) $('#activity').textContent = text;
  $('#activity').title = text;
  $('#send').disabled = !state.snapshot || state.pending.has(state.current) || state.loading > 0;
  $('#stop').hidden = !ids.size;
}
async function openConversation(id) {
  const row = state.conversations.find(c => c.id === id); if (!row) return;
  hideMentions();
  closeComposerMenu();
  closeTools();
  if (state.current) state.drafts[state.current] = $('#draft').value;
  state.current = id; state.snapshot = null; state.unread.delete(id);
  localStorage.setItem('agent-room:selected', id);
  $('#welcome').hidden = true; $('#conversation-view').hidden = false;
  if (row.kind === 'direct' && supportsSessions(state.agents.find(a => a.id === row.agentIds[0]))) {
    expandAgent(row.agentIds[0]); lastAgentSessions[row.agentIds[0]] = id;
    localStorage.setItem('agent-room:last-agent-sessions', JSON.stringify(lastAgentSessions));
  }
  renderConversationChrome();
  $('#draft').value = state.drafts[id] || '';
  $('#messages').innerHTML = '<div class="empty-chat">正在读取聊天记录…</div>';
  renderList(); renderAttachments(); updateActivity();
  renderApprovals();
  try {
    await persistNavigation().catch(error => toast('界面状态未保存：' + error.message));
    const result = await api('/conversation?id=' + encodeURIComponent(id));
    if (state.current !== id) return;
    state.snapshot = result.snapshot;
    const approvals = await api('/approvals?room=' + encodeURIComponent(id));
    if (state.current !== id) return;
    roomApprovals.set(id, approvals.approvals); renderApprovals();
    if (result.pending) state.pending.add(id); else state.pending.delete(id);
    renderMessages(); $('#messages').scrollTop = $('#messages').scrollHeight;
  } catch (error) { if (state.current === id) $('#messages').textContent = error.message; toast(error.message); }
}
function showModal(title, content, submit, submitLabel = '确定') {
  $('#modal').classList.toggle('history-dialog', title === '聊天记录');
  $('#modal-title').textContent = title; $('#modal-content').innerHTML = content; $('#modal-error').textContent = '';
  $('#modal-footer').hidden = !submit; $('#modal-submit').textContent = submitLabel; $('#modal-submit').disabled = false;
  onSubmit = submit; $('#modal').showModal();
}
function addAgent() {
  showModal('添加 Agent', `<p class="hint">给你的 AI 伙伴取个名字。相同后端也可以添加多位伙伴。</p><label class="field">名称<input name="label" required maxlength="40" placeholder="例如：灵感搭子" autofocus></label><label class="field">后端<select name="backend">${state.harnesses.map(h => h.id).map((id) => { const found = state.harnesses.find((h) => h.id === id); return `<option value="${id}">${escapeHtml(found?.label || id)} · ${found?.found || found?.configured ? '已发现 / 已配置' : '未检测到'}</option>`; }).join('')}</select></label><p class="hint" id="backend-hint"></p><label class="field">固定模型<select name="model" required></select></label><p class="hint" id="model-hint"></p><button type="button" id="reload-models">重新读取模型</button><label class="field">工作区文件夹<input name="workspace" placeholder="留空自动创建：后端名称/Agent 名称"></label><p class="hint" id="workspace-hint"></p><button type="button" id="choose-workspace">选择文件夹…</button><label class="field">角色设定 <span class="hint">（可选）</span><textarea name="persona" maxlength="2000" placeholder="例如：你是一位擅长发散思考的设计伙伴。"></textarea></label>`, async (form) => {
    const result = await api('/agents', Object.fromEntries(new FormData(form)));
    await refresh(); $('#modal').close(); await openConversation(result.conversation.id);
    if (result.agent.desktopSync?.status !== 'registered') toast(result.agent.desktopSync?.detail || '桌面同步待处理');
  }, '添加并开始聊天');
  const choose = $('#choose-workspace'); choose.hidden = !state.canChooseWorkspace;
  $('#workspace-hint').textContent = '留空将创建在 ' + state.workspaceRoot + ' 下；每位 Agent 使用独立文件夹和记忆，同一 Agent 跨单聊与群聊共享记忆。';
  choose.onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path && $('#modal-content [name="workspace"]')) $('#modal-content [name="workspace"]').value = result.path; } catch(error) { toast(error.message); } };
  const select = $('#modal-content select');
  const hint = () => { const found = state.harnesses.find((h) => h.id === select.value); $('#backend-hint').textContent = select.value === 'claude' ? '支持终端版，或复用 Claude 桌面端当前 Gateway API 配置；Room 中的会话独立。' : found?.found || found?.configured ? '使用本机后端的登录状态。首次发送时连接。' : '可以先添加。聊天前需安装并登录此后端，或在本地后端配置中指定启动路径。'; };
  let generation = 0;
  const loadModels = async () => {
    hint(); const ticket = ++generation; const backend = select.value;
    const models = $('#modal-content [name="model"]'); const note = $('#model-hint');
    models.innerHTML = '<option value="">正在读取…</option>'; $('#modal-submit').disabled = true;
    models.required = true;
    try {
      const data = await api('/models', { backend, refresh: true });
      if (ticket !== generation || !models.isConnected) return;
      models.innerHTML = data.models.map(m => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml([m.provider, m.name].filter(Boolean).join(' · ')) + '</option>').join('');
      models.value = data.selected; note.textContent = data.catalog ? (data.catalog.warning || '已读取 WorkBuddy 桌面在线目录快照' + (data.catalog.updatedAt ? '（' + new Date(data.catalog.updatedAt).toLocaleString() + '）' : '') + '；重新读取可同步桌面更新，模型权限由 WorkBuddy 校验。') : backend === 'claude' ? '模型随 Agent 固定；当前 Claude Code 桥接支持文本聊天，未开放推理档位。' : '模型随 Agent 固定，加入群聊后仅可调整推理强度。'; $('#modal-submit').disabled = !models.value;
    } catch (error) { if (ticket !== generation || !models.isConnected) return; models.innerHTML = '<option value="">读取失败</option>'; note.textContent = error.message; }
  };
  select.onchange = loadModels; $('#reload-models').onclick = loadModels; void loadModels();
  const configure = document.createElement('button');
  configure.type = 'button'; configure.textContent = '未找到后端？自动发现 / 手动配置';
  configure.className = 'text-button';
  configure.onclick = () => { void backendSettings(select.value); };
  $('#backend-hint').after(configure);
}
let discoveryPromptShown = false;
function discoveryPrompt(selectedId = 'codex', reset = false) {
  discoveryPromptShown = true;
  const choose = async choice => {
    await api('/discovery-consent', { choice });
    if (reset && choice === 'automatic') await api('/backends', { id: selectedId, automatic: true });
    await refresh(); await backendSettings(selectedId);
  };
  showModal('是否允许查找已安装的 Agent？', '<p>自动发现需要读取本机安装记录、运行程序路径、快捷方式和 PATH，并在相关安装目录中查找后端文件。不会扫描聊天内容或上传文件。</p><p>允许后会记住选择，并在后续启动时自动发现；可随时改为手动配置。</p><p class="hint">手动查找：在开始菜单或桌面右键 Agent 快捷方式，选择“打开文件所在的位置”；若打开的仍是快捷方式，查看“属性 → 目标”。复制程序文件的完整路径，或在桌面版中点击“浏览选择程序”。</p><button type="button" id="discovery-manual">不扫描，手动配置</button>', () => choose('automatic'), '允许扫描');
  $('#discovery-manual').onclick = async () => { try { await choose('manual'); } catch(error) { $('#modal-error').textContent = error.message; } };
}
async function backendSettings(selectedId = 'codex', force = false) {
  try {
    const result = await api('/backends' + (force ? '?refresh=1' : ''));
    state.harnesses = result.harnesses;
    showModal('后端管理', `<p class="hint">自动查找已安装的 CLI 和桌面后端。没有找到时，可手动填写程序或安装目录。发现入口不代表已经登录或连接成功。</p><label class="field">Agent 后端<select id="backend-id">${result.harnesses.map((row) => `<option value="${row.id}" ${row.id === selectedId ? 'selected' : ''}>${escapeHtml(row.label)} · ${row.found ? '已发现入口' : row.status === 'invalid' ? '配置失效' : row.status === 'installed' ? '需要配置' : '未发现'}</option>`).join('')}</select></label><p class="hint" id="backend-status"></p><button type="button" id="rescan">扫描设置 / 重新检测</button><label class="field">已发现的入口<select id="backend-candidates"></select></label><label class="field">程序或安装目录<input id="backend-path" placeholder="粘贴完整路径，例如 C:\\安装目录\\程序.exe" autocomplete="off"></label><button type="button" id="browse-backend" ${result.canBrowse ? '' : 'hidden'}>浏览选择程序…</button><p class="hint">手动查找：右键桌面或开始菜单快捷方式 → 打开文件所在的位置；若仍是快捷方式，查看属性中的“目标”。复制程序文件完整路径，桌面版也可浏览选择。手动模式不会扫描安装目录。</p><label class="field">仅此后端使用的代理（可选）<input id="backend-proxy" placeholder="留空跟随现有网络；例如 http://127.0.0.1:端口" autocomplete="off"></label><p class="hint" id="backend-proxy-hint">TUN 模式通常可留空；填写代理只影响 Room 启动的此后端，不更改系统代理或 Dot 设置。</p><details><summary>高级：启动参数</summary><label class="field">参数 JSON 数组<textarea id="backend-args" placeholder='留空自动推导；例如 ["--acp"]'></textarea></label><p class="hint">仅在自定义启动方式时填写。每个参数单独一项，不要填整条命令。Codex 会自动追加 app-server 参数。</p></details><button type="button" id="backend-auto">恢复自动选择</button>`, async () => {
      const args = $('#backend-args').value.trim();
      await api('/backends', { id: $('#backend-id').value, path: $('#backend-path').value, proxy: $('#backend-proxy').value.trim(), ...(args ? { args: JSON.parse(args) } : {}) });
      $('#modal').close(); await refresh(); if (state.current) await openConversation(state.current); toast('后端配置已保存，下次发送时使用；连接与登录尚未验证');
    }, '保存配置');
    const storageButton = document.createElement('button'); storageButton.type = 'button'; storageButton.id = 'data-location-settings'; storageButton.textContent = '数据目录与自动迁移…'; storageButton.onclick = () => void dataLocationSettings(); $('#modal-content').prepend(storageButton);
    function fields() {
      const row = result.harnesses.find((r) => r.id === $('#backend-id').value);

      $('#backend-status').textContent = [row.detail, row.selected && `来源：${row.selected.source}`, row.warning, row.id === 'claude' && '可选择终端版 claude，或已配置 Gateway API 的 Claude 桌面程序。桌面入口使用其内置 Code 与当前 API 配置；密钥不会保存到 Room。', ['workbuddy', 'workbuddy-ai'].includes(row.id) && '保持对应 WorkBuddy 桌面已登录并运行，先在桌面发送过一条消息。群聊复用当前 Windows 用户的桌面登录，无需重新授权；其他 Windows 用户需在该用户下运行连接程序。'].filter(Boolean).join(' · ');
      $('#backend-candidates').innerHTML = '<option value="">选择自动发现的入口</option>' + row.candidates.map((c) => `<option value="${escapeHtml(c.path)}">${escapeHtml(c.source + ' · ' + c.path)}</option>`).join('');
      $('#backend-path').value = row.preference?.path || row.selected?.path || '';
      $('#backend-args').value = row.preference?.args ? JSON.stringify(row.preference.args) : '';
      const desktopNetwork = ['workbuddy', 'workbuddy-ai'].includes(row.id);
      $('#backend-proxy').disabled = desktopNetwork;
      $('#backend-proxy').value = desktopNetwork ? '' : row.preference?.proxy || '';
      $('#backend-proxy-hint').textContent = desktopNetwork ? 'WorkBuddy 复用桌面应用的网络配置，请在对应桌面应用中设置代理。' : 'TUN 模式通常可留空；填写代理只影响 Room 启动的此后端，不更改系统代理或 Dot 设置。';
    }
    $('#backend-id').onchange = fields; fields();
    $('#backend-candidates').onchange = () => { if ($('#backend-candidates').value) { $('#backend-path').value = $('#backend-candidates').value; $('#backend-args').value = ''; } };
    $('#rescan').onclick = () => discoveryPrompt($('#backend-id').value);
    $('#browse-backend').onclick = async () => { try { const picked = await api('/backends/browse', {}); if (picked.path) $('#backend-path').value = picked.path; } catch (error) { $('#modal-error').textContent = error.message; } };
    $('#backend-auto').onclick = async () => {
      if (result.discoveryChoice !== 'automatic') { discoveryPrompt($('#backend-id').value, true); return; }
      try { await api('/backends', { id: $('#backend-id').value, automatic: true }); const id = $('#backend-id').value; await refresh(); await backendSettings(id); toast('已恢复自动选择'); }
      catch (error) { $('#modal-error').textContent = error.message; }
    };
  } catch (error) { toast(error.message); }
}
async function dataLocationSettings() {
  try {
    const info = await api('/data-location');
    showModal('数据目录与自动迁移', '<p>当前数据目录：</p><p class="data-path">' + escapeHtml(info.current) + '</p>' + (info.warning ? '<p class="hint">' + escapeHtml(info.warning) + '</p>' : '') + '<label class="field">新的数据目录<input name="dataPath" required value="' + escapeHtml(info.pending || info.current) + '"></label><button type="button" id="browse-data" ' + (info.canBrowse ? '' : 'hidden') + '>选择文件夹…</button><p class="hint">请选择空文件夹。' + (info.autoRestart ? '确认后应用将自动重启，复制并校验数据，再启用新目录。' : '保存后请重启服务，程序会自动复制并校验数据，再启用新目录。') + '数据较多时启动需要稍等。</p><p class="hint">旧目录会保留；迁移失败时继续使用旧目录，不会覆盖目标中的不同内容。数据目录内的工作区会随迁移更新路径，外部工作区保持原路径。</p>' + (info.pending ? '<button type="button" id="cancel-data-change">取消待切换目录</button>' : ''), info.configurable ? async form => {
      const result = await api('/data-location', { path: new FormData(form).get('dataPath') });
      if (result.restarting) { toast('即将重启并自动迁移，请稍候…'); return; }
      await dataLocationSettings(); toast(result.pending ? '已保存，重启服务后将自动迁移。' : '继续使用当前数据目录');
    } : null, info.autoRestart ? '迁移并重启' : '保存，重启后自动迁移');
    $('#browse-data').onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path) $('#modal-content [name="dataPath"]').value = result.path; } catch(e) { $('#modal-error').textContent = e.message; } };
    if ($('#cancel-data-change')) $('#cancel-data-change').onclick = async () => { try { await api('/data-location', { cancel: true }); await dataLocationSettings(); } catch(e) { $('#modal-error').textContent = e.message; } };
  } catch(e) { toast(e.message); }
}
function createGroup() {
  showModal('发起群聊', `<p class="hint">选择要邀请的伙伴，可以一次选择多位 Agent。</p><label class="field">群聊名称<input name="title" placeholder="例如：产品灵感小组" maxlength="60"></label><div class="picker">${state.agents.map((agent) => `<label class="pick-row">${avatar(agent)}<span>${escapeHtml(agent.label)}<small>${escapeHtml(agent.backend)} · ${escapeHtml(agent.modelName || agent.model || "后端默认")}</small></span><input type="checkbox" name="agentIds" value="${agent.id}" aria-label="选择 ${escapeHtml(agent.label)}"></label>`).join('') || '<p class="hint">还没有 Agent，请先点击左侧 ＋ 添加。</p>'}</div><p class="hint" id="selected-count">已选择 0 位 · 至少选择 2 位 Agent</p>`, async (form) => {
    const data = new FormData(form);
    const result = await api('/groups', { title: data.get('title'), agentIds: data.getAll('agentIds') });
    await refresh(); $('#modal').close(); await openConversation(result.conversation.id);
  }, '创建群聊');
  const count = () => { const n = $('#modal-content').querySelectorAll('input:checked').length; $('#selected-count').textContent = `已选择 ${n} 位 · 可选择 2–12 位 Agent`; $('#modal-submit').disabled = n < 2 || n > 12; };
  $('#modal-content').onchange = count; count();
}
async function memberEffort(agentId, roomId) {
  const agent = state.agents.find(a => a.id === agentId);
  const row = state.conversations.find(r => r.id === roomId);
  showModal('Agent 设置 · ' + agent.label, '<p>固定模型：' + escapeHtml(agent.modelName || agent.model || '后端默认') + '</p><label class="field">推理强度<select name="effort" disabled><option value="">正在读取…</option></select></label><p class="hint" id="effort-loading"></p><label class="field">工作区文件夹<input name="workspace" required value="' + escapeHtml(agent.workspace) + '"></label><button type="button" id="choose-workspace">选择文件夹…</button><p class="hint">推理强度仅用于当前会话。工作区用于这位 Agent 的所有会话；更改后将使用新的后端会话，历史记录保留，原文件不会搬移或删除。</p>', async form => {
    const data = new FormData(form);
    await api('/agents/settings', { id: agentId, room: roomId, workspace: data.get('workspace'), ...(data.has('effort') && data.get('effort') ? { effort: data.get('effort') } : {}) });
    await refresh(); $('#modal').close(); toast('设置已保存');
  }, '保存设置');
  const select = $('#modal-content [name="effort"]');
  const memoryNote = document.createElement('p'); memoryNote.className = 'hint'; memoryNote.id = 'agent-memory-status';
  memoryNote.textContent = '这位 Agent 在单聊和群聊中共享自己的记忆；其他 Agent 不会继承。改名或更换工作区后记忆仍保留。';
  const memoryButton = document.createElement('button'); memoryButton.type = 'button'; memoryButton.id = 'view-agent-memory'; memoryButton.textContent = '查看共享记忆';
  memoryButton.onclick = () => showAgentMemory(agent);
  $('#modal-content').append(memoryNote, memoryButton);
  if (agent.workspaceIssue) {
    const issue = document.createElement('p'); issue.className = 'hint'; issue.textContent = agent.workspaceIssue;
    $('#modal-content').append(issue);
  }
  const syncNote = document.createElement('p'); syncNote.className = 'hint'; syncNote.id = 'desktop-sync-status';
  syncNote.textContent = agent.desktopSync?.detail || '尚未检查桌面工作区登记。';
  const syncButton = document.createElement('button'); syncButton.type = 'button'; syncButton.id = 'check-desktop-sync'; syncButton.textContent = '检查桌面登记';
  $('#modal-content').append(syncNote, syncButton);
  syncButton.onclick = async () => {
    syncButton.disabled = true;
    try {
      const result = await api('/agents/sync', { id: agentId });
      syncNote.textContent = result.desktopSync.detail;
      agent.desktopSync = result.desktopSync;
    } catch (error) { syncNote.textContent = error.message; }
    finally { syncButton.disabled = false; }
  };
  $('#choose-workspace').hidden = !state.canChooseWorkspace;
  $('#choose-workspace').onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path && select.isConnected) $('#modal-content [name="workspace"]').value = result.path; } catch(e) { toast(e.message); } };
  try {
    const data = await api('/models', { backend: agent.backend, model: agent.model });
    if (!select.isConnected) return;
    const model = data.models.find(m => m.id === agent.model);
    const efforts = model?.efforts || [];
    select.innerHTML = efforts.length ? efforts.map(e => '<option value="' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>').join('') : '<option value="">后端默认</option>';
    select.disabled = !efforts.length;
    if (efforts.length) select.value = row.efforts?.[agentId] || agent.effort || model.defaultEffort || efforts[0];
    $('#effort-loading').textContent = efforts.length ? '' : '后端未提供可调整的推理档位，仍可修改工作区。';
  } catch(e) { if (select.isConnected) { select.innerHTML = '<option value="">保持原设置</option>'; $('#effort-loading').textContent = '推理档位读取失败：' + e.message + '。仍可修改工作区。'; } }
}
function showAgentMemory(agent) {
  showModal('共享记忆 · ' + agent.label, '<p class="hint">来自这位 Agent 的单聊和群聊。历史内容会自动记入，回复时按需检索；这里最多显示 50 条，搜索可以找到更早的记录。</p><label class="field">搜索记忆<input name="memoryQuery" maxlength="2000" placeholder="输入关键词，例如项目约定"></label><p class="hint" id="memory-count">正在读取…</p><div id="memory-entries"></div>', async form => {
    await load(new FormData(form).get('memoryQuery'));
  }, '搜索记忆');
  const container = $('#memory-entries'), count = $('#memory-count');
  let generation = 0;
  const load = async query => {
    const ticket = ++generation;
    try {
      const data = await api('/agents/memory?id=' + encodeURIComponent(agent.id) + '&q=' + encodeURIComponent(query || ''));
      if (!container.isConnected || ticket !== generation) return;
      count.textContent = '已保存 ' + data.count + ' 条记忆，本次显示 ' + data.entries.length + ' 条。';
      container.replaceChildren();
      for (const entry of data.entries) {
        const card = document.createElement('article'); card.className = 'memory-entry';
        const source = document.createElement('p'); source.className = 'hint';
        source.textContent = (entry.roomKind === 'direct' ? '单聊' : '群聊') + ' · ' + entry.roomTitle + ' · ' + entry.authorLabel +
          (entry.ts ? ' · ' + new Date(entry.ts).toLocaleString() : '') + (entry.visibility === 'private' ? ' · 私聊' : '');
        const text = document.createElement('p'); text.textContent = entry.text;
        card.append(source, text); container.append(card);
      }
      if (!data.entries.length) container.textContent = data.count ? '没有找到相关记忆。' : '还没有记忆，开始聊天后会自动记录。';
    } catch (error) { if (container.isConnected && ticket === generation) count.textContent = '记忆读取失败：' + error.message; }
  };
  void load('');
}
function showMembers(mention = false) {
  const row = state.conversations.find(c => c.id === state.current); if (!row) return;
  if (!mention && row.agentIds.length === 1) { void memberEffort(row.agentIds[0], row.id); return; }
  showModal(mention ? '提及 Agent' : '会话设置', '<div class="picker">' + row.agentIds.map(id => {
    const agent = state.agents.find(a => a.id === id);
    return '<button type="button" class="pick-row" data-member="' + id + '">' + avatar(agent) + '<span>' + escapeHtml(agent.label) + '<small>' + (mention ? '点击提及' : '修改推理强度和工作区') + '</small></span></button>';
  }).join('') + '</div>', null);
  if (mention && row.kind === 'group' && row.agentIds.length) $('#modal-content .picker').insertAdjacentHTML('afterbegin', '<button type="button" class="pick-row" data-member="__all__"><span class="avatar group">☷</span><span>所有人<small>提及当前群聊的全部成员</small></span></button>');
  $('#modal-content').onclick = event => {
    const button = event.target.closest('[data-member]'); if (!button) return;
    const agent = button.dataset.member === '__all__' ? { label: '所有人' } : state.agents.find(a => a.id === button.dataset.member);
    if (!mention) { $('#modal-content').onclick = null; void memberEffort(agent.id, row.id); return; }
    $('#draft').value += '@' + agent.label + ' '; state.drafts[state.current] = $('#draft').value; $('#modal').close(); $('#draft').focus();
  };
}
function renameConversation(row, agent) {
  showModal(agent ? '重命名 Agent' : '重命名群聊', '<label class="field">名称<input name="label" required maxlength="' + (agent ? 40 : 60) + '" value="' + escapeHtml(agent?.label || row.title) + '"></label><p class="hint">' + (agent ? '工作区目录保持不变，之后点名请使用新名称。' : '只修改群聊名称，成员和历史记录保持不变。') + '</p>', async form => {
    await api('/conversation/rename', { id: row.id, name: new FormData(form).get('label') });
    await refresh();
    const current = state.conversations.find(c => c.id === state.current); if (current) $('#chat-title').textContent = current.title;
    $('#modal').close(); toast('名称已修改');
  }, '保存名称');
}
function renameSession(row) {
  showModal('重命名会话', '<label class="field">会话名称<input name="title" required maxlength="60" value="' + escapeHtml(row.title) + '"></label><p class="hint">只修改此会话的标题，Agent 名称和工作区保持不变。</p>', async form => {
    await api('/conversation/title', { id: row.id, title: new FormData(form).get('title') });
    await refresh(); $('#modal').close(); toast('会话已重命名');
  }, '保存名称');
}
function showSessionMenu(row, x, y) {
  closeAgentMenu();
  const menu = document.createElement('div'); menu.id = 'agent-context-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = '<button role="menuitem" data-action="rename">重命名会话</button><button role="menuitem" data-action="pin">' + (row.pinned ? '取消置顶会话' : '置顶会话') + '</button><button role="menuitem" data-action="new">新建会话</button>';
  document.body.append(menu);
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.onclick = async event => {
    const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
    closeAgentMenu();
    if (action === 'rename') return renameSession(row);
    if (action === 'new') return void newSession(row.agentIds[0]);
    try { await api('/conversation/pin', { id: row.id, pinned: !row.pinned }); await refresh(); } catch (error) { toast(error.message); }
  };
  menu.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...menu.querySelectorAll('button')];
    buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length].focus();
  };
  menu.querySelector('button').focus();
}
function closeAgentMenu() { $('#agent-context-menu')?.remove(); }
$('#conversations').addEventListener('contextmenu', event => {
  closeAgentMenu();
  const session = event.target.closest('[data-session]');
  if (session) { event.preventDefault(); showSessionMenu(state.conversations.find(c => c.id === session.dataset.session), event.clientX, event.clientY); return; }
  const button = event.target.closest('[data-room]');
  const row = state.conversations.find(c => c.id === button?.dataset.room);
  if (!row) return;
  event.preventDefault();
  showConversationMenu(row, event.clientX, event.clientY);
});
$('#group-actions').onclick = () => {
  const row = state.conversations.find(c => c.id === state.current);
  const rect = $('#group-actions').getBoundingClientRect();
  if (row) showConversationMenu(row, rect.left, rect.bottom);
};
function showConversationMenu(row, x, y) {
  closeAgentMenu();
  const agent = row.kind === 'direct' ? state.agents.find(a => a.id === row.agentIds[0]) : null; if (row.kind === 'direct' && !agent) return;
  const menu = document.createElement('div'); menu.id = 'agent-context-menu'; menu.setAttribute('role', 'menu');
  const pinned = supportsSessions(agent) ? agentPinned(agent) : row.pinned;
  menu.innerHTML = '<button role="menuitem" data-action="pin">' + (pinned ? '取消置顶' : '置顶') + '</button><button role="menuitem" data-action="delete">删除</button>';
  if (supportsSessions(agent)) menu.insertAdjacentHTML('afterbegin', '<button role="menuitem" data-action="new">新建会话</button><button role="menuitem" data-action="settings">Agent 设置</button>');
  if (row.kind === 'group') menu.querySelector('[data-action="delete"]').textContent = '删除群聊';
  menu.insertAdjacentHTML('afterbegin', '<button role="menuitem" data-action="rename">重命名</button>');
  document.body.append(menu);
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.onclick = async e => {
    const action = e.target.closest('[data-action]')?.dataset.action; if (!action) return;
    closeAgentMenu();
    if (action === 'rename') { renameConversation(row, agent); return; }
    if (action === 'new') return void newSession(agent.id);
    if (action === 'settings') return void memberEffort(agent.id, row.id);
    if (action === 'delete') { if (row.kind === 'group') deleteGroup(row); else deleteAgent(agent); return; }
    try { await api(supportsSessions(agent) ? '/agents/pin' : '/conversation/pin', { id: supportsSessions(agent) ? agent.id : row.id, pinned: !pinned }); await refresh(); } catch(e) { toast(e.message); }
  };
  menu.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const buttons = [...menu.querySelectorAll('button')]; buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus(); } });
  menu.querySelector('button').focus();
}
function clearMissingConversation() {
  for (const id of Object.keys(state.drafts)) if (!state.conversations.some(c => c.id === id)) { delete state.drafts[id]; delete state.uploads[id]; state.pending.delete(id); state.unread.delete(id); }
  if (!state.current || state.conversations.some(c => c.id === state.current)) return;
  state.current = null; state.snapshot = null; state.live.clear();
  localStorage.removeItem('agent-room:selected');
  $('#draft').value = ''; $('#messages').replaceChildren(); $('#attachments').replaceChildren();
  $('#conversation-view').hidden = true; $('#welcome').hidden = false;
  hideMentions(); closeAgentMenu();
}
function deleteGroup(row) {
  showModal('删除群聊：' + row.title, '<p>将移除这个群聊并取消其待触发闹钟。删除后无法从会话列表打开。</p><p class="hint">Agent 联系人、其他会话、工作区和原后端对话不受影响。本地历史与附件文件保留，不做文件清理。</p>', async () => {
    await api('/groups/delete', { id: row.id });
    $('#modal').close(); await refresh(); clearMissingConversation(); toast('群聊已删除');
  }, '确认删除群聊');
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#agent-context-menu')) closeAgentMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAgentMenu(); });
window.addEventListener('resize', closeAgentMenu);
document.addEventListener('wheel', closeAgentMenu, { passive: true });
function deleteAgent(agent) {
  showModal('删除 Agent：' + agent.label, '<p>将从联系人和所有群聊中移除这位 Agent。群聊历史及原后端中的对话仍保留。</p><p>工作区：<code>' + escapeHtml(agent.workspace) + '</code></p><label class="field">工作区处理<select name="deleteWorkspace"><option value="false">保留文件夹和文件（默认）</option><option value="true">同时永久删除工作区及全部文件</option></select></label><label class="field" id="delete-path-field" hidden>确认删除时，请输入上面的完整路径<input name="confirmWorkspace" autocomplete="off"></label>', async form => {
    const data = new FormData(form);
    const result = await api('/agents/delete', { id: agent.id, deleteWorkspace: data.get('deleteWorkspace') === 'true', confirmWorkspace: data.get('confirmWorkspace') });
    $('#modal').close(); await refresh();
    if (state.conversations.some(c => c.id === state.current)) await openConversation(state.current);
    else { state.current = null; state.snapshot = null; localStorage.removeItem('agent-room:selected'); $('#conversation-view').hidden = true; $('#welcome').hidden = false; }
    toast(result.warning || 'Agent 已删除');
  }, '确认删除');
  $('#modal-content [name="deleteWorkspace"]').onchange = event => { const remove = event.target.value === 'true'; $('#delete-path-field').hidden = !remove; $('#modal-content [name="confirmWorkspace"]').required = remove; };
}
let themeData;
function applyTheme(theme) {
  themeData = theme;
  for (const [name, value] of Object.entries(theme.colors || {})) document.documentElement.style.setProperty(name, value);
  // Follow custom background colours as well as named presets.
  // The browser resolves every supported hex/rgb/hsl notation to sRGB here.
  const rgb = getComputedStyle(document.documentElement).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  const dark = rgb?.length === 3 && rgb.every(Number.isFinite) && (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722) < 140;
  document.documentElement.dataset.appearance = dark ? 'dark' : 'light';
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === theme.preset)));
  document.documentElement.style.setProperty('--wallpaper', theme.background?.kind === 'file' ? `url("/api/background?v=${theme.background.version}")` : 'none');
}
async function settings() {
  try {
    const result = await api('/theme'); applyTheme(result.theme);
    showModal('让房间更像你', `<p class="hint">选择一种氛围，让每段对话都有熟悉的感觉。<br>外观应用到所有会话，并保存在本机。</p><div class="themes">${result.presets.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${p.id === themeData.preset}"><span class="theme-preview" style="--preview-bg:${p.colors['--ar-bg']};--preview-panel:${p.colors['--ar-panel']};--preview-line:${p.colors['--ar-line']};--preview-text:${p.colors['--ar-text']}"><i></i><i></i><i></i></span><span class="theme-name"><span class="theme-swatch" style="background:${p.colors['--ar-bg']}"></span>${escapeHtml(p.label)}</span></button>`).join('')}</div><label class="colors">聊天背景色<input type="color" id="bg-color" value="${themeData.colors['--ar-bg']}"></label><label class="colors">正文颜色<input type="color" id="text-color" value="${themeData.colors['--ar-text']}"></label><label class="upload-background">聊天背景图片<input type="file" id="background-input" accept="image/png,image/jpeg,image/webp"></label><button type="button" id="remove-background">移除背景图片</button>`, null);
    $('#modal-content').onclick = async (event) => { const preset = event.target.closest('[data-preset]'); if (!preset) return; try { applyTheme((await api('/theme', { preset: preset.dataset.preset })).theme); $('#bg-color').value = themeData.colors['--ar-bg']; $('#text-color').value = themeData.colors['--ar-text']; } catch (error) { toast(error.message); } };
    for (const [id, token] of [['bg-color', '--ar-bg'], ['text-color', '--ar-text']]) $('#' + id).onchange = async (event) => { try { applyTheme((await api('/theme', { colors: { [token]: event.target.value } })).theme); } catch (error) { toast(error.message); } };
    $('#background-input').onchange = async (event) => { try { const file = event.target.files[0]; if (!file) return; if (file.size > 16 * 1024 * 1024) throw new Error('背景图片不能超过 16 MB'); const response = await fetch('/api/theme/background?type=' + encodeURIComponent(file.type), { method: 'POST', body: file }); const data = await response.json(); if (!response.ok) throw new Error(data.error); applyTheme(data.theme); } catch (error) { toast(error.message); } };
    $('#remove-background').onclick = async () => { try { applyTheme((await api('/theme', { background: null })).theme); } catch (error) { toast(error.message); } };
  } catch (error) { toast(error.message); }
}
async function uploadFiles(files) {
  const id = state.current; if (!id) return toast('请先选择一个会话');
  state.loading++; updateActivity();
  try {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { toast(file.name + ' 超过 20 MB'); continue; }
      const response = await fetch('/api/attach?name=' + encodeURIComponent(file.name) + '&type=' + encodeURIComponent(file.type), { method: 'POST', body: file });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      (state.uploads[id] ||= []).push(data.attachment);
      if (state.current === id) renderAttachments();
    }
  } catch (error) { toast(error.message); }
  finally { state.loading--; updateActivity(); }
}
let mentionState = null;
const mentionPopup = document.createElement('div'); mentionPopup.id = 'mention-suggestions'; mentionPopup.hidden = true; mentionPopup.setAttribute('role', 'listbox'); mentionPopup.setAttribute('aria-label', '提及成员'); $('.composer').append(mentionPopup);
$('#draft').setAttribute('aria-controls', mentionPopup.id);
function hideMentions() { mentionState = null; mentionPopup.hidden = true; $('#draft').removeAttribute('aria-activedescendant'); }
function paintMentions() {
  mentionPopup.innerHTML = mentionState.agents.map((a, i) => '<button type="button" role="option" id="mention-option-' + i + '" data-index="' + i + '" aria-selected="' + (i === mentionState.index) + '">' + avatar(a) + '<span>' + escapeHtml(a.label) + '</span></button>').join('');
  mentionPopup.hidden = false; $('#draft').setAttribute('aria-activedescendant', 'mention-option-' + mentionState.index);
  mentionPopup.children[mentionState.index]?.scrollIntoView({ block: 'nearest' });
}
function updateMentions() {
  const draft = $('#draft'); const caret = draft.selectionStart;
  if (caret !== draft.selectionEnd) { hideMentions(); return; }
  const prefix = draft.value.slice(0, caret); const start = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('#'));
  if (start < 0 || (start > 0 && /[\p{L}\p{N}_]/u.test(prefix[start - 1]))) { hideMentions(); return; }
  const query = prefix.slice(start + 1);
  const marker = prefix[start];
  if (/[\r\n]/.test(query)) { hideMentions(); return; }
  const row = state.conversations.find(c => c.id === state.current);
  const members = (row?.agentIds || []).map(id => state.agents.find(a => a.id === id)).filter(Boolean);
  if (marker === '@' && row?.kind === 'group' && members.length) members.unshift({ id: '__all__', label: '所有人', backend: 'group' });
  const agents = members.filter(a => a.label.toLowerCase().includes(query.toLowerCase()));
  if (!agents.length) { hideMentions(); return; }
  mentionState = { start, end: caret, agents, index: 0, marker }; paintMentions();
}
function acceptMention(index) {
  if (!mentionState) return;
  const draft = $('#draft'); const value = mentionState.marker + mentionState.agents[index].label + ' ';
  const caret = mentionState.start + value.length;
  draft.value = draft.value.slice(0, mentionState.start) + value + draft.value.slice(mentionState.end);
  state.drafts[state.current] = draft.value; hideMentions(); draft.focus(); draft.setSelectionRange(caret, caret);
}
mentionPopup.onmousedown = e => e.preventDefault();
mentionPopup.onclick = e => { const button = e.target.closest('[data-index]'); if (button) acceptMention(Number(button.dataset.index)); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#mention-suggestions') && e.target !== $('#draft')) hideMentions(); });
$('#draft').addEventListener('click', updateMentions);
$('#draft').addEventListener('compositionstart', hideMentions);
$('#draft').addEventListener('compositionend', updateMentions);
async function send() {
  const id = state.current; const text = $('#draft').value.trim(); const files = state.uploads[id] || [];
  if ((!text && !files.length) || $('#send').disabled) return;
  state.pending.add(id); updateActivity();
  // Clear immediately so an asynchronous failure can restore the draft safely.
  hideMentions(); $('#draft').value = ''; state.drafts[id] = ''; state.uploads[id] = []; renderAttachments();
  try { await api('/say', { room: id, text, attachments: files.map((f) => f.id) }); }
  catch (error) { state.pending.delete(id); restoreDraft(id, text, files); toast(error.message); }
  finally { updateActivity(); }
}
function restoreDraft(id, text, files) {
  const current = state.current === id ? $('#draft').value : state.drafts[id];
  state.drafts[id] = [text, current].filter(Boolean).join('\n');
  state.uploads[id] = [...files, ...(state.uploads[id] || [])];
  if (state.current === id) { $('#draft').value = state.drafts[id]; renderAttachments(); }
}
async function refresh() { const data = await api('/catalog'); Object.assign(state, { agents: data.agents, conversations: data.conversations, harnesses: data.harnesses, canChooseWorkspace: data.canChooseWorkspace, workspaceRoot: data.workspaceRoot, discoveryChoice: data.discoveryChoice }); renderList(); renderConversationChrome(); if (data.discoveryChoice === null && !discoveryPromptShown) discoveryPrompt(); }
$('#add-agent').onclick = $('#welcome-add').onclick = addAgent;
$('#new-group').onclick = createGroup; $('#settings').onclick = settings;
$('#backends').onclick = () => { void backendSettings(); };
$('#search').oninput = renderList;
document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => { const selected = b.dataset.filter === state.filter; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); });
  $('#list-view-label').textContent = ({ all: '聊天', direct: 'Agents', group: '群聊' })[state.filter];
  renderList();
}; });
$('#conversations').onclick = event => {
  const newButton = event.target.closest('[data-new-session]'); if (newButton) return void newSession(newButton.dataset.newSession);
  const disclosure = event.target.closest('[data-expand-agent]');
  if (disclosure) { const id = disclosure.dataset.expandAgent; expandAgent(id, disclosure.getAttribute('aria-expanded') !== 'true'); renderList(); $(`[data-expand-agent="${CSS.escape(id)}"]`)?.focus(); void persistNavigation().catch(e => toast('界面状态未保存：' + e.message)); return; }
  const more = event.target.closest('[data-session-menu]');
  if (more) { const rect = more.getBoundingClientRect(); showSessionMenu(state.conversations.find(c => c.id === more.dataset.sessionMenu), rect.right, rect.bottom); return; }
  const session = event.target.closest('[data-session]'); if (session) return void openConversation(session.dataset.session);
  const agent = event.target.closest('[data-open-agent]');
  if (agent) {
    const id = agent.dataset.openAgent; expandAgent(id);
    const sessions = agentSessions(id); const row = sessions.find(c => c.id === lastAgentSessions[id]) || sessions[0];
    if (row) void openConversation(row.id); else void newSession(id); return;
  }
  const button = event.target.closest('[data-room]'); if (button) void openConversation(button.dataset.room);
};
$('#new-session').onclick = () => { const row = state.conversations.find(c => c.id === state.current); if (row) void newSession(row.agentIds[0]); };
$('#session-actions').onclick = () => { const row = state.conversations.find(c => c.id === state.current), rect = $('#session-actions').getBoundingClientRect(); if (row) showSessionMenu(row, rect.left, rect.bottom); };
$('#composer-workspace').onclick = $('#composer-model').onclick = () => showMembers();
$('#composer-mode').onclick = () => void showComposerMenu('preset');
$('#composer-permission').onclick = () => void showComposerMenu('permission');
$('#composer-effort').onclick = () => void showComposerMenu('effort');
document.addEventListener('pointerdown', event => { if (!event.target.closest('#composer-menu, #composer-mode, #composer-permission, #composer-effort')) closeComposerMenu(); });
window.addEventListener('resize', closeComposerMenu);
$('#approval-panel').onclick = async event => {
  const button = event.target.closest('[data-approval]'); if (!button) return;
  button.disabled = true;
  try { await api('/approvals', { room: state.current, id: button.dataset.approval, allow: button.dataset.allow === 'true' }); }
  catch (error) { button.disabled = false; toast(error.message); }
};
$('#close-modal').onclick = $('#cancel-modal').onclick = () => $('#modal').close();
$('#modal').addEventListener('close', () => { $('#modal-content').onclick = null; $('#modal-content').onchange = null; });
$('#modal-form').onsubmit = async (event) => { event.preventDefault(); if (!onSubmit) return; $('#modal-submit').disabled = true; try { await onSubmit(event.target); } catch (error) { $('#modal-error').textContent = error.message; } finally { $('#modal-submit').disabled = false; } };
$('#attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (event) => { void uploadFiles([...event.target.files]); event.target.value = ''; };
$('#attachments').onclick = (event) => { const button = event.target.closest('[data-remove-file]'); if (button) { state.uploads[state.current].splice(Number(button.dataset.removeFile), 1); renderAttachments(); } };
$('#members').onclick = () => showMembers(); $('#mention').onclick = () => showMembers(true);
$('#send').onclick = send;
$('#draft').oninput = e => { state.drafts[state.current] = $('#draft').value; if (!e.isComposing) updateMentions(); };
$('#draft').onkeydown = (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (mentionState) {
    if (event.key === 'Escape') { event.preventDefault(); hideMentions(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionState.index = (mentionState.index + (event.key === 'ArrowDown' ? 1 : -1) + mentionState.agents.length) % mentionState.agents.length; paintMentions(); return; }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); acceptMention(mentionState.index); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } };
$('#draft').onpaste = (event) => { if (event.clipboardData.files.length) { event.preventDefault(); void uploadFiles([...event.clipboardData.files]); } };
$('#chat').ondragover = (event) => { event.preventDefault(); $('#chat').classList.add('dragging'); };
$('#chat').ondragleave = () => $('#chat').classList.remove('dragging');
$('#chat').ondrop = (event) => { event.preventDefault(); $('#chat').classList.remove('dragging'); void uploadFiles([...event.dataTransfer.files]); };
$('#stop').onclick = async () => { try { await api('/stop', { room: state.current }); } catch (error) { toast(error.message); } };
const events = new EventSource('/api/events');
events.onopen = async () => {
  $('#connection').className = 'online'; $('#connection').innerHTML = '<i></i>本地已连接';
  try { await refresh(); if (state.current) { const id = state.current; const data = await api('/conversation?id=' + encodeURIComponent(id)); if (id === state.current) { state.snapshot = data.snapshot; if (data.pending) state.pending.add(id); else state.pending.delete(id); state.live.clear(); renderMessages(); } } } catch (error) { toast(error.message); }
};
events.onerror = () => { $('#connection').className = ''; $('#connection').innerHTML = '<i></i>连接中断，正在重连'; };
events.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.type === 'approvals') {
    roomApprovals.set(data.room, data.approvals); if (data.room === state.current) renderApprovals();
    else if (data.approvals.length) { state.unread.add(data.room); renderList(); toast('另一会话有操作等待你确认'); }
  }
  if (data.type === 'poll-error') toast(data.message);
  if (data.type === 'polls' && data.room === state.current && state.snapshot) {
    state.snapshot.polls = data.polls; scheduleMessages(true);
    if ($('#modal').open && $('#poll-list')?.dataset.room === data.room) $('#poll-list').innerHTML = pollListHtml(data.polls);
  }
  if (data.type === 'catalog') { state.agents = data.catalog.agents; state.conversations = data.catalog.conversations; clearMissingConversation(); renderList(); renderConversationChrome(); }
  if (data.type === 'snapshot' && data.room === state.current) { state.snapshot = data.snapshot; scheduleMessages(true); }
  if (data.type === 'message' && data.room !== state.current) { state.unread.add(data.room); renderList(); }
  if (data.type === 'pending') { if (data.pending) state.pending.add(data.room); else state.pending.delete(data.room); updateActivity(); }
  if (data.type === 'failure') { restoreDraft(data.room, data.text, data.attachments); toast('发送失败，内容已恢复到草稿：' + data.error); }
  if (data.type === 'stream') {
    const event = data.event;
    if (event.type === 'agent-start') state.live.set(event.liveId, { room: data.room, memberId: event.memberId, text: '' });
    if (event.type === 'delta') { const live = state.live.get(event.liveId); if (live) { live.text += event.delta; live.retry = false; } }
    if (event.type === 'item' && event.item?.type === 'error') { const live = state.live.get(event.liveId); if (live) live.retry = true; }
    if (event.type === 'agent-end') { state.live.delete(event.liveId); if (event.error) toast('Agent 回复失败：' + event.error); }
    if (data.room === state.current) scheduleMessages();
  }
};
(async () => { try {
  const location = await api('/data-location'); if (location.warning) toast(location.warning);
  const navigation = await api('/ui-state');
  for (const key of Object.keys(expandedAgents)) delete expandedAgents[key];
  for (const key of Object.keys(lastAgentSessions)) delete lastAgentSessions[key];
  Object.assign(expandedAgents, navigation.expanded); Object.assign(lastAgentSessions, navigation.lastSessions);
  await refresh(); applyTheme((await api('/theme')).theme);
  const id = navigation.selected || localStorage.getItem('agent-room:selected');
  if (state.conversations.some(row => row.id === id)) await openConversation(id);
} catch (error) { toast(error.message); } })();


async function showAlarms() {
  if (!state.current) return;
  const room = state.current;
  try {
    const data = await api('/alarms?room=' + encodeURIComponent(room));
    const status = { pending: '等待触发', fired: '已触发', cancelled: '已取消' };
    showModal('会话闹钟', '<p class="hint">在输入框发送 /alarm 10m #成员 备注；@成员 为公开提醒。支持 s、m、h、d 或含时区的日期时间。应用关闭时不运行，重启后补发。</p><button type="button" id="alarm-compose">填入闹钟指令</button>' + (data.alarms.length ? data.alarms.slice().reverse().map(a => '<div class="alarm-row"><strong>' + escapeHtml((a.visibility === 'private' ? '#' : '@') + a.targetLabel) + '</strong> · ' + escapeHtml(new Date(a.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) + ' 北京时间 · ' + status[a.status] + '<p>' + escapeHtml(a.note) + '</p>' + (a.error ? '<p class="hint">投递失败，将重试：' + escapeHtml(a.error) + '</p>' : '') + (a.status === 'pending' ? '<button type="button" data-cancel-alarm="' + escapeHtml(a.id) + '">取消闹钟</button>' : '') + '</div>').join('') : '<p>当前没有闹钟。</p>'), null);
    $('#alarm-compose').onclick = () => {
      const row = state.conversations.find(c => c.id === room);
      const target = state.agents.find(a => a.id === row?.agentIds[0])?.label || '用户';
      $('#modal').close(); $('#draft').value = '/alarm 10m #' + target + ' 提醒备注'; state.drafts[room] = $('#draft').value; $('#draft').focus();
    };
    for (const button of document.querySelectorAll('[data-cancel-alarm]')) button.onclick = async () => {
      try { await api('/alarms/cancel', { room, id: button.dataset.cancelAlarm }); await showAlarms(); }
      catch (error) { toast(error.message); }
    };
  } catch (error) { toast(error.message); }
}
const toolsToggle = $('#tools-toggle');
const toolsMenu = $('#tools-menu');
function closeTools(focus = false) {
  toolsMenu.hidden = true; toolsToggle.setAttribute('aria-expanded', 'false');
  if (focus) toolsToggle.focus();
}
function openTools(focus = false) {
  hideMentions(); toolsMenu.hidden = false; toolsToggle.setAttribute('aria-expanded', 'true');
  if (focus) toolsMenu.querySelector('[role="menuitem"]').focus();
}
toolsToggle.onclick = () => toolsMenu.hidden ? openTools(true) : closeTools();
toolsToggle.onkeydown = e => { if (e.key === 'ArrowDown') { e.preventDefault(); openTools(true); } };
toolsMenu.onkeydown = e => {
  const items = [...toolsMenu.querySelectorAll('[role="menuitem"]')];
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); const index = items.indexOf(document.activeElement);
    items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
  }
};
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !toolsMenu.hidden) { e.preventDefault(); closeTools(true); } });
document.addEventListener('pointerdown', e => { if (!e.target.closest('.tools-dropdown')) closeTools(); });
document.addEventListener('focusin', e => { if (!e.target.closest('.tools-dropdown')) closeTools(); });
$('#alarms').onclick = () => { closeTools(true); void showAlarms(); };

function pollHtml(p) {
  const status = p.status === 'open' && p.invitationsPaused ? '邀请已暂停' : { open: '进行中', closed: '已结束', cancelled: '已取消' }[p.status];
  const details = p.participants ? '<details><summary>查看记名投票</summary><ul>' + p.participants.map(m => '<li>' + escapeHtml(m.label) + '：' +
    escapeHtml(m.status === 'voted' ? p.options.find(o => o.id === m.optionId)?.text : { pending: '未投票' + (m.attempts >= 2 ? '（可重试邀请）' : ''), abstained: '弃权', unavailable: '已离开' }[m.status]) + '</li>').join('') + '</ul></details>' : '';
  const result = p.status === 'closed' ? '<p class="poll-result">结果：' + escapeHtml(p.winners.length ? p.options.filter(o => p.winners.includes(o.id)).map(o => o.text).join('、') + (p.winners.length > 1 ? '（并列）' : '') : '无有效选票') + '</p>' : '';
  const privacy = p.visibility !== 'anonymous' ? '' : p.status === 'cancelled' ? '投票已取消，不公布匿名选票。' : p.status === 'closed' ? '已公布汇总结果，投票人保持匿名。' : '匿名选择不向群成员和用户界面公开；结束后揭晓票数。';
  return `<article class="poll-card" data-poll="${escapeHtml(p.id)}">
    <header><span class="poll-badge">${p.visibility === 'anonymous' ? '匿名投票' : '公开投票'}</span><span>${status}</span></header>
    <h3>${escapeHtml(p.question)}</h3><p class="hint">${escapeHtml(p.creatorLabel)} 发起 · ${p.completed}/${p.total} 位已参与</p>
    <ul class="poll-options">${p.options.map(o => `<li><span>${escapeHtml(o.text)}</span><strong>${o.count === undefined ? (p.status === 'cancelled' ? '不公布' : '待揭晓') : o.count + ' 票'}</strong></li>`).join('')}</ul>
    ${result}${details}<p class="hint">${privacy ? privacy + '<br>' : ''}截止：${escapeHtml(new Date(p.closesAt).toLocaleString('zh-CN'))}${p.abstained === undefined ? '' : ' · 弃权 ' + p.abstained + ' 位'}
    ${p.status === 'open' && p.needsRetry ? '<br>' + p.needsRetry + ' 位已邀请但尚未完成，可重试邀请。' : ''}
    ${p.unavailableCount ? '<br>' + p.unavailableCount + ' 位已离开，保留原参与人数。' : ''}</p>
    ${p.status === 'open' && p.canManage ? `<footer><button type="button" data-poll-action="retry" data-poll-id="${escapeHtml(p.id)}">重试邀请</button><button type="button" data-poll-action="close" data-poll-id="${escapeHtml(p.id)}">结束投票</button><button type="button" data-poll-action="cancel" data-poll-id="${escapeHtml(p.id)}">取消投票</button></footer>` : ''}</article>`;
}
function pollListHtml(polls) { return polls.length ? polls.slice().reverse().map(pollHtml).join('') : '<p class="hint">还没有投票。Agent 也可以通过投票工具发起。</p>'; }
async function showPolls() {
  const room = state.current;
  if (state.conversations.find(c => c.id === room)?.kind !== 'group') { toast('投票仅在群聊可用'); return; }
  try {
    const data = await api('/polls?room=' + encodeURIComponent(room));
    if (state.current !== room) return;
    showModal('群聊投票', '<button type="button" id="create-poll">发起投票</button><p class="hint">每位 Agent 独立投票，用户管理投票但不计票。应用退出期间暂停邀请，恢复后结算已过期投票。</p><div id="poll-list" data-room="' + escapeHtml(room) + '">' + pollListHtml(data.polls) + '</div>', null);
    $('#create-poll').onclick = () => composePoll(room);
  } catch (e) { toast(e.message); }
}
function composePoll(room) {
  const requestId = crypto.randomUUID();
  showModal('发起投票', `<label class="field">命题<input name="question" required maxlength="500" placeholder="希望伙伴们共同决定什么？"></label><label class="field">选项（每行一个，2–10 项）<textarea name="options" required rows="4" placeholder="方案 A&#10;方案 B"></textarea></label><label class="field">投票方式<select name="visibility"><option value="anonymous">匿名投票</option><option value="public">公开投票（记名）</option></select></label><p class="hint">匿名投票结束前隐藏票数，不展示谁投了哪项。此设置发布后不可更改。匿名不覆盖本机管理员或后端原生调用记录。</p><label class="field">持续时间（分钟）<input type="number" name="minutes" value="10" min="1" max="10080" required></label><p class="hint">全员选择或弃权后提前结束；结果不会自动执行。</p>`, async form => {
    const data = new FormData(form);
    await api('/polls/create', { room, poll: { question: data.get('question'), options: String(data.get('options')).split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      visibility: data.get('visibility'), duration_seconds: Number(data.get('minutes')) * 60, request_id: requestId } });
    $('#modal').close(); toast('投票已创建，正在邀请群内 Agent');
  }, '发布投票');
}
const pollsButton = document.createElement('button');
pollsButton.type = 'button'; pollsButton.id = 'polls'; pollsButton.setAttribute('role', 'menuitem');
pollsButton.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 9 2 2 5-5M8 16h8"/></svg><span>投票<small>匿名或公开，邀请全员参与</small></span>';
$('#tools-menu').append(pollsButton);
pollsButton.onclick = () => { closeTools(true); void showPolls(); };
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-poll-action]');
  if (!button) return;
  const room = state.current;
  button.disabled = true;
  try {
    await api('/polls/' + button.dataset.pollAction, { room, id: button.dataset.pollId });
    toast({ retry: '已安排重试；忙碌成员将在空闲时收到邀请', close: '投票已结束', cancel: '投票已取消' }[button.dataset.pollAction]);
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
});

function showHistory(roomId = '') {
  showModal('聊天记录', '<div class="history-controls"><label class="field">会话范围<select id="history-scope"><option value="">全部会话</option>' + state.conversations.map(c => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.title) + (c.kind === 'group' ? ' · 群聊' : ' · 单聊') + '</option>').join('') + '</select></label><div class="history-query"><input id="history-query" type="search" maxlength="200" placeholder="搜索正文、发送者或附件名称" aria-label="搜索聊天记录"><button id="history-find" type="button">搜索</button></div></div><div class="history-export"><button type="button" data-export="md">导出 Markdown</button><button type="button" data-export="json">导出 JSON</button></div><p class="hint">导出所选会话的全部记录（不受搜索词限制），包含用户可见的私聊；附件仅记录名称，不包含原文件。请选择一个会话后导出。</p><p id="history-count" class="hint" role="status"></p><div id="history-results"></div><div class="history-pages"><button id="history-prev" type="button">上一页</button><button id="history-next" type="button">下一页</button></div>', null);
  const scope = $('#history-scope'), query = $('#history-query'), list = $('#history-results'), count = $('#history-count');
  const previous = $('#history-prev'), next = $('#history-next');
  scope.value = roomId; let offset = 0, generation = 0;
  const highlight = text => {
    const value = String(text), needle = query.value.trim();
    if (!needle) return escapeHtml(value);
    const lower = value.toLocaleLowerCase(), wanted = needle.toLocaleLowerCase();
    let from = 0, found, html = '';
    while ((found = lower.indexOf(wanted, from)) !== -1) {
      html += escapeHtml(value.slice(from, found)) + '<mark>' + escapeHtml(value.slice(found, found + needle.length)) + '</mark>'; from = found + needle.length;
    }
    return html + escapeHtml(value.slice(from));
  };
  async function search() {
    const ticket = ++generation;
    previous.disabled = next.disabled = true; count.textContent = '正在搜索…'; list.replaceChildren();
    for (const button of document.querySelectorAll('[data-export]')) button.disabled = !scope.value;
    try {
      const data = await api('/history/search?' + new URLSearchParams({ room: scope.value, q: query.value.trim(), offset }));
      if (ticket !== generation || !list.isConnected || !$('#modal').open) return;
      count.textContent = `共 ${data.total} 条记录` + (data.total ? ` · 当前 ${offset + 1}–${offset + data.results.length}` : '') + (data.skipped ? ` · ${data.skipped} 条损坏记录无法读取` : '');
      list.innerHTML = data.results.length ? data.results.map(m => '<article class="history-result ' + (m.visibility === 'private' ? 'private-history' : '') + '"><div class="history-meta"><strong>' + escapeHtml(m.title) + '</strong><time>' + escapeHtml(m.ts ? new Date(m.ts).toLocaleString() : '') + '</time></div><div class="hint">' + highlight(m.authorLabel) + ' · ' + (m.visibility === 'private' ? '私聊 → ' + escapeHtml(m.recipients.join('、') || '指定接收者') : '公开') + '</div><pre>' + highlight(m.text) + '</pre>' + m.attachments.map(f => '<div class="file-chip">附件：' + highlight(f.name) + '</div>').join('') + '</article>').join('') : '<p class="empty-list">没有找到聊天记录</p>';
      previous.disabled = offset === 0; next.disabled = offset + data.limit >= data.total;
    } catch (e) { if (ticket === generation && count.isConnected) count.textContent = e.message; }
  }
  $('#history-find').onclick = () => { offset = 0; void search(); };
  query.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); offset = 0; void search(); } };
  scope.onchange = () => { offset = 0; void search(); };
  previous.onclick = () => { offset = Math.max(0, offset - 40); void search(); };
  next.onclick = () => { offset += 40; void search(); };
  for (const button of document.querySelectorAll('[data-export]')) button.onclick = async () => {
    const id = scope.value, format = button.dataset.export; if (!id) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/history/export?' + new URLSearchParams({ room: id, format }));
      if (!response.ok) throw new Error((await response.json()).error || '导出失败');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = (state.conversations.find(c => c.id === id)?.title || '会话').replace(/[\\/:*?"<>|\r\n]/g, '_') + '-聊天记录.' + format;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(e.message); }
    finally { button.disabled = !scope.value; }
  };
  void search(); query.focus();
}
$('#history-all').onclick = () => showHistory();
$('#history-current').onclick = () => showHistory(state.current);
