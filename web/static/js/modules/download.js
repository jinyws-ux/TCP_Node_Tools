// web/static/js/modules/download.js
import { showMessage } from '../core/messages.js';
import { escapeHtml } from '../core/utils.js';
import { setButtonLoading } from '../core/ui.js';

let inited = false;

const qs = (s, sc = document) => sc.querySelector(s);
const qsa = (s, sc = document) => Array.from(sc.querySelectorAll(s));
const $msg = (type, text) => showMessage(type, text, 'download-messages');

const state = {
  mode: 'normal', // normal | adding | selected
  selectedTemplate: null,
  // 分页
  pager: { page: 1, page_size: 20, total: 0, loading: false, q: '' },
  // 右侧过滤与联动
  filters: { factory: '', system: '' },
  templateCache: [], // 当前页累积

  // 搜索结果 & 选中状态（下载用）
  searchResults: [],
  selectedLogPaths: new Set(), // remote_path/path 作为 key
};

/* ---------- 本地工具：恢复按钮文案（配合现有 core/ui.js） ---------- */
function restoreSearchBtnLabel() {
  const btn = qs('#btn-search');
  if (!btn) return;
  btn.innerHTML = state.mode === 'selected'
    ? '<i class="fas fa-search"></i> 搜索日志（模板）'
    : '<i class="fas fa-search"></i> 搜索日志';
}
function restoreSaveTemplateBtnLabel() {
  const btn = qs('#btn-save-template');
  if (!btn) return;
  btn.innerHTML = '<i class="fas fa-save"></i> 保存区域';
}

function updateDownloadButton() {
  const btn = qs('#btn-download-logs');
  if (!btn) return;
  btn.disabled = !state.selectedLogPaths.size;
}

/* 根据 state.selectedLogPaths 同步勾选框 UI （重新渲染或全选时用） */
function syncLogCheckboxes() {
  const tbody = qs('#logs-search-body');
  if (!tbody) return;
  qsa('input[type="checkbox"].log-select', tbody).forEach(chk => {
    const path = chk.dataset.remotePath || chk.dataset.path || '';
    chk.checked = !!(path && state.selectedLogPaths.has(path));
  });
  updateDownloadButton();
}

export function init() {
  const tab = qs('#download-tab');
  if (!tab || inited) return;
  inited = true;

  bindLeftForm();
  bindRightPanel();

  // 初始化下拉：厂区 -> 系统（依赖后端）
  loadFactories().then(() => syncRightFiltersAndReload());
}

function bindLeftForm() {
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');

  factorySel?.addEventListener('change', async () => {
    await loadSystems(factorySel.value);
    state.filters.factory = factorySel.value || '';
    syncRightFiltersAndReload();
    if (state.mode === 'selected') unselectTemplateSilent();
  });

  systemSel?.addEventListener('change', () => {
    state.filters.system = systemSel.value || '';
    syncRightFiltersAndReload();
    if (state.mode === 'selected') unselectTemplateSilent();
  });

  // 归档 -> 日期显隐 + 必填
  const includeArchive = qs('#include-archive');
  const dateRange      = qs('#date-range');    // 需要在 index.html 的日期容器加 id="date-range"
  const dateStart      = qs('#date-start');
  const dateEnd        = qs('#date-end');
  const toggleDate = () => {
    const on = !!includeArchive?.checked;
    if (dateRange) dateRange.style.display = on ? '' : 'none';
    if (dateStart) dateStart.required = on;
    if (dateEnd)   dateEnd.required   = on;
  };
  includeArchive?.addEventListener('change', toggleDate);
  toggleDate(); // 初始化一次

  // 左侧按钮
  qs('#btn-search')?.addEventListener('click', onSearchClick);
  qs('#btn-refresh')?.addEventListener('click', refreshDownloadedList);
  qs('#btn-open-dir')?.addEventListener('click', openDownloadDir);

  // 下载选中日志
  qs('#btn-download-logs')?.addEventListener('click', onDownloadLogsClick);

  // 添加模板模式
  qs('#btn-save-template')?.addEventListener('click', onSaveTemplate);
  qs('#btn-cancel-template')?.addEventListener('click', exitAddTemplateMode);

  // 解除选择
  qs('#btn-unselect-template')?.addEventListener('click', () => {
    exitSelectedTemplateMode();
    $msg('info', '已解除模板选择');
  });

  // 可选：全选 checkbox（如果你在表头放了一个 id="logs-check-all" 的勾选框）
  qs('#logs-check-all')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    const tbody = qs('#logs-search-body');
    if (!tbody) return;
    state.selectedLogPaths.clear();
    qsa('input[type="checkbox"].log-select', tbody).forEach(chk => {
      chk.checked = checked;
      const path = chk.dataset.remotePath || chk.dataset.path || '';
      if (checked && path) state.selectedLogPaths.add(path);
    });
    updateDownloadButton();
  });

  // 默认载入一次系统（空）
  loadSystems('');
  // 初次拉已下载列表（如有接口，这里实现）——占位
  refreshDownloadedList();

  updateDownloadButton();
}

function bindRightPanel() {
  qs('#btn-add-template')?.addEventListener('click', enterAddTemplateMode);

  // 搜索框（防抖）
  let timer = null;
  qs('#template-search-input')?.addEventListener('input', (e) => {
    const q = (e.target.value || '').trim();
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.pager.q = q;
      reloadTemplates(true);
    }, 300);
  });
  qs('#template-clear-search')?.addEventListener('click', () => {
    const input = qs('#template-search-input');
    if (!input) return;
    input.value = '';
    state.pager.q = '';
    reloadTemplates(true);
  });

  qs('#btn-more-templates')?.addEventListener('click', () => {
    if (state.pager.loading) return;
    state.pager.page += 1;
    reloadTemplates(false);
  });

  // 初次加载模板
  reloadTemplates(true);
}

/* ---------------- 左侧：搜索 ---------------- */

async function onSearchClick() {
  const factory = qs('#factory-select')?.value || '';
  const system  = qs('#system-select')?.value || '';
  const include_realtime = !!qs('#include-realtime')?.checked;
  const include_archive  = !!qs('#include-archive')?.checked;
  const date_start = qs('#date-start')?.value || '';
  const date_end   = qs('#date-end')?.value || '';

  if (!factory || !system) {
    $msg('error', '请先选择厂区与系统');
    return;
  }
  if (include_archive && (!date_start || !date_end)) {
    $msg('error', '选择归档时必须填写开始/结束日期');
    return;
  }

  // 你的 server.py 暴露的是 /api/search-logs（单节点）
  const url = '/api/search-logs';
  const body = {
    factory,
    system,
    includeRealtime: include_realtime,
    includeArchive: include_archive,
    dateStart: date_start,
    dateEnd: date_end
  };

  if (state.mode === 'selected' && state.selectedTemplate) {
    // 后端目前只支持单节点：取模板里的第一个节点
    const first = (state.selectedTemplate.nodes || [])[0] || '';
    body.node = first;
    if (!first) {
      $msg('warning', '所选模板没有节点；请编辑模板或手工输入节点');
    }
  } else {
    // 普通模式
    const nodes = parseNodes(qs('#node-input')?.value || '');
    body.node = nodes[0] || '';
    if (!body.node) {
      $msg('warning', '建议填写至少一个节点，或使用右侧区域模板');
    }
  }

  try {
    setButtonLoading('btn-search', true);
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await res.json();

    // 后端响应：{ success, log_files: [...] }
    const list = data?.log_files || data?.logs || [];
    renderLogs(list);

    if (!list.length) $msg('info', '没有匹配的日志');
  } catch (e) {
    console.error(e);
    $msg('error', '搜索失败：' + (e?.message || e));
  } finally {
    setButtonLoading('btn-search', false);
    restoreSearchBtnLabel();
  }
}

async function refreshDownloadedList() {
  // 如果你希望在“下载”页也展示一个“已下载列表”，
  // 这里可以调用 /api/downloaded-logs 然后渲染到你自己的表格区域。
  // 目前先留空，不影响功能。
}

function openDownloadDir() {
  // 占位：若后端有打开目录的API，这里调用
}

/* ---------------- 下载功能：从搜索结果中选择并下载 ---------------- */

function buildSelectedFilesPayload() {
  const files = [];
  const results = state.searchResults || [];
  const selected = state.selectedLogPaths;

  if (!results.length || !selected.size) return files;

  for (const item of results) {
    const remote_path = item.remote_path || item.path || '';
    if (!remote_path || !selected.has(remote_path)) continue;

    files.push({
      name: item.name || '',
      remote_path,
      path: remote_path,       // 兼容后端 old 字段
      size: item.size || 0,
      mtime: item.mtime || item.timestamp || '',
      type: item.type || 'unknown',
      node: item.node || ''    // 后端会用实际节点分目录
    });
  }
  return files;
}

/** 计算 download-logs 请求中的 node 参数（search_node，用于记录） */
function resolveSearchNodeForDownload() {
  if (state.mode === 'selected' && state.selectedTemplate) {
    const nodes = state.selectedTemplate.nodes || [];
    if (nodes.length) return nodes.join(',');
  }
  const nodes = parseNodes(qs('#node-input')?.value || '');
  if (nodes.length) return nodes[0]; // 老接口只要求非空即可
  return 'mixed'; // 兜底给个标记值，避免后端报“缺少 node”
}

async function onDownloadLogsClick() {
  const factory = qs('#factory-select')?.value || '';
  const system  = qs('#system-select')?.value || '';

  if (!factory || !system) {
    $msg('error', '请先选择厂区与系统');
    return;
  }

  const files = buildSelectedFilesPayload();
  if (!files.length) {
    $msg('error', '请先在下方搜索结果中勾选要下载的日志');
    return;
  }

  const node = resolveSearchNodeForDownload();

  try {
    setButtonLoading('btn-download-logs', true);
    const res = await fetch('/api/download-logs', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        files,
        factory,
        system,
        node
      })
    });
    const data = await res.json();
    if (!data?.success) {
      throw new Error(data?.error || '下载失败');
    }

    const downloaded = data.downloaded_files || [];
    const count = downloaded.length;
    if (count > 0) {
      $msg('success', `下载完成，成功下载 ${count} 个日志文件`);
    } else {
      $msg('warning', '后端返回成功，但未包含任何已下载文件信息，请检查服务器日志');
    }

    // 清空选择
    state.selectedLogPaths.clear();
    syncLogCheckboxes();
    // 如有需要，这里可以刷新“已下载列表”或通知分析页
    refreshDownloadedList();
  } catch (e) {
    console.error(e);
    $msg('error', '下载失败：' + (e?.message || e));
  } finally {
    setButtonLoading('btn-download-logs', false);
    updateDownloadButton();
  }
}

/* ---------------- 模板：UI 状态切换 ---------------- */

function enterAddTemplateMode() {
  state.mode = 'adding';
  const hint = qs('#template-hint');
  const actDefault = qs('#download-actions-default');
  const actTpl = qs('#download-actions-template');
  if (hint) hint.style.display = '';
  if (actDefault) actDefault.style.display = 'none';
  if (actTpl) actTpl.style.display = '';

  const nodeInput = qs('#node-input');
  if (nodeInput) nodeInput.placeholder = '多个节点用英文逗号分隔，例如：2001,2002,2003';
}

function exitAddTemplateMode() {
  state.mode = 'normal';
  const hint = qs('#template-hint');
  const actDefault = qs('#download-actions-default');
  const actTpl = qs('#download-actions-template');
  if (hint) hint.style.display = 'none';
  if (actDefault) actDefault.style.display = '';
  if (actTpl) actTpl.style.display = 'none';
  restoreSaveTemplateBtnLabel();
}

function enterSelectedTemplateMode(tpl) {
  state.mode = 'selected';
  state.selectedTemplate = tpl;

  // 锁定左侧
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const nodeInput  = qs('#node-input');

  fillSelectValue(factorySel, tpl.factory);
  fillSelectValue(systemSel, tpl.system);
  if (nodeInput) {
    nodeInput.value = (tpl.nodes || []).join(',');
    nodeInput.setAttribute('disabled','disabled');
  }
  factorySel?.setAttribute('disabled','disabled');
  systemSel?.setAttribute('disabled','disabled');

  // 改按钮文案
  const searchBtn = qs('#btn-search');
  if (searchBtn) searchBtn.innerHTML = `<i class="fas fa-search"></i> 搜索日志（模板）`;

  // 徽标提示
  const nameEl = qs('#selected-template-name');
  const badge = qs('#selected-template-badge');
  if (nameEl) nameEl.textContent = tpl.name;
  if (badge) badge.style.display = '';
}

function exitSelectedTemplateMode() {
  state.mode = 'normal';
  state.selectedTemplate = null;
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const nodeInput  = qs('#node-input');

  factorySel?.removeAttribute('disabled');
  systemSel?.removeAttribute('disabled');
  nodeInput?.removeAttribute('disabled');

  const searchBtn = qs('#btn-search');
  if (searchBtn) searchBtn.innerHTML = `<i class="fas fa-search"></i> 搜索日志`;

  const badge = qs('#selected-template-badge');
  if (badge) badge.style.display = 'none';
}

function unselectTemplateSilent() {
  if (state.mode === 'selected') exitSelectedTemplateMode();
}

/* ---------------- 模板：CRUD 与列表 ---------------- */

function syncRightFiltersAndReload() {
  const f = qs('#factory-select')?.value || '';
  const s = qs('#system-select')?.value || '';
  state.filters.factory = f;
  state.filters.system = s;
  reloadTemplates(true);
}

function renderTemplateList(items, append = false) {
  const host = qs('#template-list');
  if (!host) return;

  if (!append) host.innerHTML = '';

  if (!items.length && !append) {
    host.innerHTML = `<div class="message-empty">暂无模板</div>`;
    return;
  }

  for (const t of items) {
    const nodes = Array.isArray(t.nodes) ? t.nodes : [];
    const nodesPreview = nodes.slice(0, 5).join(',');
    const el = document.createElement('div');
    el.className = 'config-item';
    el.innerHTML = `
      <div class="config-info" style="flex:1;">
        <h3>${escapeHtml(t.name)}</h3>
        <p>${escapeHtml(t.factory)} - ${escapeHtml(t.system)}</p>
        <p style="font-size:12px; color:#6b7280;">共 ${nodes.length} 节点${nodes.length ? ` · 示例：${escapeHtml(nodesPreview)}${nodes.length>5?'…':''}`:''}</p>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="btn btn-primary btn-sm tpl-select">选择区域</button>
        <div class="config-actions">
          <button class="btn btn-secondary btn-sm tpl-edit">编辑</button>
          <button class="btn btn-danger btn-sm tpl-del">删除</button>
        </div>
      </div>
    `;

    el.querySelector('.tpl-select')?.addEventListener('click', () => enterSelectedTemplateMode(t));
    el.querySelector('.tpl-edit')?.addEventListener('click', () => editTemplate(t));
    el.querySelector('.tpl-del')?.addEventListener('click', () => deleteTemplate(t));

    host.appendChild(el);
  }

  // 底部“加载更多”
  const moreBtn = qs('#btn-more-templates');
  const loadedCount = state.templateCache.length;
  if (moreBtn) {
    if (loadedCount < state.pager.total) {
      moreBtn.style.display = '';
    } else {
      moreBtn.style.display = 'none';
    }
  }
}

async function reloadTemplates(reset = true) {
  if (reset) {
    state.pager.page = 1;
    state.templateCache = [];
  }
  const params = new URLSearchParams({
    page: String(state.pager.page),
    page_size: String(state.pager.page_size),
  });
  if (state.pager.q) params.set('q', state.pager.q);
  if (state.filters.factory) params.set('factory', state.filters.factory);
  if (state.filters.system) params.set('system', state.filters.system);

  try {
    state.pager.loading = true;
    const res = await fetch(`/api/templates?${params.toString()}`);
    const raw = await res.json();
    const payload = (raw && raw.data) ? raw.data : raw; // 兼容两种返回
    const items = payload?.items || [];
    state.pager.total = payload?.total || items.length;

    state.templateCache = state.templateCache.concat(items);
    renderTemplateList(items, !reset);
  } catch (e) {
    console.error(e);
    $msg('error', '加载模板失败：' + (e?.message || e));
  } finally {
    state.pager.loading = false;
  }
}

async function onSaveTemplate() {
  const factory = qs('#factory-select')?.value || '';
  const system  = qs('#system-select')?.value || '';
  const nodes   = parseNodes(qs('#node-input')?.value || '');

  if (!factory || !system) {
    $msg('error', '请先选择厂区与系统');
    return;
  }
  if (!nodes.length) {
    $msg('error', '请至少填写一个节点');
    return;
  }

  const name = prompt('为该区域命名：', `${factory}-${system}-区域`);
  if (name == null || name.trim() === '') return;

  try {
    setButtonLoading('btn-save-template', true);
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: name.trim(), factory, system, nodes })
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '保存失败');

    exitAddTemplateMode();
    $msg('success', '模板已保存');
    reloadTemplates(true);
  } catch (e) {
    console.error(e);
    $msg('error', '保存失败：' + (e?.message || e));
  } finally {
    setButtonLoading('btn-save-template', false);
    restoreSaveTemplateBtnLabel();
  }
}

async function editTemplate(t) {
  const newName = prompt('模板名称：', t.name);
  if (newName == null) return;
  const newNodesStr = prompt('节点（英文逗号分隔）：', (t.nodes || []).join(','));
  if (newNodesStr == null) return;

  const nodes = parseNodes(newNodesStr);

  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(t.id)}`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: newName.trim(), nodes })
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '保存失败');
    $msg('success', '模板已更新');
    reloadTemplates(true);
  } catch (e) {
    $msg('error', '更新失败：' + (e?.message || e));
  }
}

async function deleteTemplate(t) {
  if (!confirm(`确认删除模板「${t.name}」？`)) return;
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '删除失败');
    if (state.selectedTemplate && state.selectedTemplate.id === t.id) exitSelectedTemplateMode();
    $msg('success', '模板已删除');
    reloadTemplates(true);
  } catch (e) {
    $msg('error', '删除失败：' + (e?.message || e));
  }
}

/* ---------------- 公共：下拉/节点/接口封装 ---------------- */

async function loadFactories() {
  const sel = qs('#factory-select');
  if (!sel) return;
  try {
    const res = await fetch('/api/factories');
    const list = await res.json();
    sel.innerHTML = `<option value="">-- 请选择厂区 --</option>`;
    (list || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id; opt.textContent = f.name;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

async function loadSystems(factoryId) {
  const sel = qs('#system-select');
  if (!sel) return;
  if (!factoryId) {
    sel.innerHTML = `<option value="">-- 请选择系统 --</option>`;
    return;
  }
  try {
    const res = await fetch(`/api/systems?factory=${encodeURIComponent(factoryId)}`);
    const list = await res.json();
    sel.innerHTML = `<option value="">-- 请选择系统 --</option>`;
    (list || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      sel.appendChild(opt);
    });
  } catch (e) {
    $msg('error','加载系统失败：' + (e?.message || e));
  }
}

function parseNodes(str) {
  return (str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(x => /^\d{1,6}$/.test(x))       // 简单校验：1~6位数字
    .filter((v, i, arr) => arr.indexOf(v) === i); // 去重
}

function fillSelectValue(sel, val) {
  if (!sel) return;
  const opt = Array.from(sel.options).find(o => o.value == val);
  if (opt) sel.value = val;
}

/* ---------------- 结果渲染（下载页的表格 + 勾选） ---------------- */

function renderLogs(list) {
  const tbody = qs('#logs-search-body'); // 下载页结果表
  if (!tbody) return;

  state.searchResults = Array.isArray(list) ? list : [];
  state.selectedLogPaths.clear();

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="message-empty">未找到日志</td></tr>`;
    updateDownloadButton();
    return;
  }

  tbody.innerHTML = '';

  list.forEach((item) => {
    const tr = document.createElement('tr');

    const size = humanSize(item.size || 0);
    const node = item.node || extractNodeFromName(item.name || '');
    const type = item.type || '-';
    const mtime = item.mtime || item.timestamp || '-';
    const path = item.path || item.remote_path || '';

    // 选择列
    const tdSel = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'log-select';
    chk.dataset.remotePath = item.remote_path || '';
    chk.dataset.path = path;
    chk.addEventListener('change', (e) => {
      const p = e.target.dataset.remotePath || e.target.dataset.path || '';
      if (!p) return;
      if (e.target.checked) {
        state.selectedLogPaths.add(p);
      } else {
        state.selectedLogPaths.delete(p);
        // 取消“全选”勾选（如果有）
        const allChk = qs('#logs-check-all');
        if (allChk && allChk.checked) allChk.checked = false;
      }
      updateDownloadButton();
    });
    tdSel.appendChild(chk);
    tr.appendChild(tdSel);

    // 文件名
    const tdName = document.createElement('td');
    tdName.textContent = item.name || '';
    tr.appendChild(tdName);

    // 节点
    const tdNode = document.createElement('td');
    tdNode.textContent = String(node);
    tr.appendChild(tdNode);

    // 类型
    const tdType = document.createElement('td');
    tdType.textContent = type;
    tr.appendChild(tdType);

    // 大小
    const tdSize = document.createElement('td');
    tdSize.textContent = size;
    tr.appendChild(tdSize);

    // 时间
    const tdTime = document.createElement('td');
    tdTime.textContent = mtime;
    tr.appendChild(tdTime);

    // 路径
    const tdPath = document.createElement('td');
    tdPath.title = path;
    tdPath.textContent = path;
    tr.appendChild(tdPath);

    tbody.appendChild(tr);
  });

  updateDownloadButton();
}

function humanSize(bytes) {
  const units = ['B','KB','MB','GB','TB']; let i = 0; let n = +bytes || 0;
  while (n >= 1024 && i < units.length-1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function extractNodeFromName(name='') {
  const m = name.match(/tcp_trace\.(\d+)/);
  return m ? m[1] : '';
}
