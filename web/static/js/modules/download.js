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
  templateCache: [] // 当前页累积
};

/* ---------- 本地工具：恢复按钮文案（配合现有 core/ui.js） ---------- */
function getSelectedOptionText(sel) {
  if (!sel) return '';
  const opt = sel.options[sel.selectedIndex];
  return opt ? opt.textContent || '' : '';
}
function fillSelectByText(sel, text) {
  if (!sel || !text) return false;
  const opt = Array.from(sel.options).find(o => (o.textContent || '').trim() === String(text).trim());
  if (opt) { sel.value = opt.value; return true; }
  return false;
}
// 可选：从页面或全局状态拿 server_config_id（若没有就为空）
function getCurrentServerConfigId() {
  const el = document.querySelector('#current-config-id');
  if (el && el.value) return el.value;
  return ''; // 没有就留空，后端会当作未绑定
}

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

export function init() {
  const tab = qs('#download-tab');
  if (!tab || inited) return;
  inited = true;

  bindLeftForm();
  bindRightPanel();

  // 服务器配置有变动 -> 重新拉取厂区/系统，并刷新右侧模板列表
  window.addEventListener('server-configs:changed', async () => {
    const factorySel = qs('#factory-select');
    const currentFactory = factorySel?.value || '';

    await loadFactories();                  // 重新拉厂区
    const f = qs('#factory-select')?.value || currentFactory;
    if (f) await loadSystems(f);            // 选中项下再拉系统

    syncRightFiltersAndReload();            // 右侧模板跟着刷新
    $msg('success', '服务器配置已刷新');
  });

  // 解析配置有变动 -> 不影响左侧下拉，但可选择性刷新右侧模板（若你在模板里显示解析统计才需要）
  window.addEventListener('parser-configs:changed', () => {
    // 可按需：仅右侧模板搜索/刷新
    reloadTemplates(true);
  });

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

  // 添加模板模式
  qs('#btn-save-template')?.addEventListener('click', onSaveTemplate);
  qs('#btn-cancel-template')?.addEventListener('click', exitAddTemplateMode);

  // 解除选择
  qs('#btn-unselect-template')?.addEventListener('click', () => {
    exitSelectedTemplateMode();
    $msg('info', '已解除模板选择');
  });

  // 默认载入一次系统（空）
  loadSystems('');
  // 初次拉已下载列表（如有接口，这里实现）——占位
  refreshDownloadedList();
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

  let url = '/api/logs/search';
  let body = {
    factory,
    system,
    include_realtime,
    include_archive,
    date_start,
    date_end
  };

  if (state.mode === 'selected' && state.selectedTemplate) {
    // 严格模式：只给模板 ID，后端按模板的 factory/system/nodes 搜
    url = '/api/logs/search_strict';
    body = {
      template_id: state.selectedTemplate.id,
      include_realtime,
      include_archive,
      date_start,
      date_end
    };
  } else {
    // 普通模式：支持多节点；兼容老后端的 node 字段
    const nodes = parseNodes(qs('#node-input')?.value || '');
    body.nodes = nodes;
    body.node  = nodes[0] || '';
    if (!nodes.length) {
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

    // 新接口统一返回 { success, logs: [...] }；兼容历史字段
    const list = data?.logs || data?.log_files || [];
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
  // 占位：如有“已下载列表”的接口，可在此拉取并渲染
}

function openDownloadDir() {
  // 占位：若后端有打开目录的API，这里调用
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

async function enterSelectedTemplateMode(tpl) {
  state.mode = 'selected';
  state.selectedTemplate = tpl;

  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const nodeInput  = qs('#node-input');

  // 先设厂区：优先用 ID，没有就用名称兜底
  let targetFactoryId = tpl.factory_id || tpl.factoryId || '';
  if (targetFactoryId) {
    fillSelectValue(factorySel, targetFactoryId);
  } else {
    // 用名称匹配 option 文本
    fillSelectByText(factorySel, tpl.factory);
  }

  // 根据厂区重新载入系统，再设系统（优先 ID 没有就按名称）
  const fval = factorySel?.value || '';
  await loadSystems(fval);

  let targetSystemId = tpl.system_id || tpl.systemId || '';
  if (targetSystemId) {
    fillSelectValue(systemSel, targetSystemId);
  } else {
    fillSelectByText(systemSel, tpl.system);
  }

  if (nodeInput) {
    nodeInput.value = (tpl.nodes || []).join(',');
    nodeInput.setAttribute('disabled','disabled');
  }
  factorySel?.setAttribute('disabled','disabled');
  systemSel?.setAttribute('disabled','disabled');

  const searchBtn = qs('#btn-search');
  if (searchBtn) searchBtn.innerHTML = `<i class="fas fa-search"></i> 搜索日志（模板）`;

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

    el.querySelector('.tpl-select')?.addEventListener('click', () => { enterSelectedTemplateMode(t); });
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
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');

  const factory_id = factorySel?.value || '';
  const system_id  = systemSel?.value  || '';
  const factory    = getSelectedOptionText(factorySel);
  const system     = getSelectedOptionText(systemSel);

  const nodes = parseNodes(qs('#node-input')?.value || '');

  if (!factory_id || !system_id) {
    $msg('error', '请先选择厂区与系统');
    return;
  }
  if (!nodes.length) {
    $msg('error', '请至少填写一个节点');
    return;
  }

  const name = prompt('为该区域命名：', `${factory}-${system}-区域`);
  if (name == null || name.trim() === '') return;

  const server_config_id = getCurrentServerConfigId();

  try {
    setButtonLoading('btn-save-template', true);
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name: name.trim(),
        // 名称与ID都带上，后端会择优使用
        factory, system,
        factory_id, system_id,
        server_config_id,
        nodes
      })
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
  // 名称
  const newName = prompt('模板名称：', t.name);
  if (newName == null) return;

  // 节点
  const newNodesStr = prompt('节点（英文逗号分隔）：', (t.nodes || []).join(','));
  if (newNodesStr == null) return;
  const nodes = parseNodes(newNodesStr);

  // 绑定到当前左侧选择（像服务器配置一样可修改绑定）
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const factory_id = factorySel?.value || t.factory_id || '';
  const system_id  = systemSel?.value  || t.system_id  || '';
  const factory    = getSelectedOptionText(factorySel) || t.factory || '';
  const system     = getSelectedOptionText(systemSel)  || t.system  || '';

  const server_config_id = getCurrentServerConfigId() || t.server_config_id || '';

  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(t.id)}`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name: newName.trim(),
        nodes,
        factory, system,
        factory_id, system_id,
        server_config_id
      })
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '保存失败');

    $msg('success', '模板已更新');
    // 若当前处于已选择该模板，重新按更新后的模板重置左侧
    if (state.mode === 'selected' && state.selectedTemplate && state.selectedTemplate.id === t.id) {
      state.selectedTemplate = data.item || t;
      await enterSelectedTemplateMode(state.selectedTemplate);
    }
    reloadTemplates(true);
  } catch (e) {
    console.error(e);
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
    const res = await fetch('/api/factories?ts=' + Date.now(), { cache: 'no-store' });
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
    const res = await fetch(`/api/systems?factory=${encodeURIComponent(factoryId)}&ts=${Date.now()}`, { cache: 'no-store' });
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

/* ---------------- 结果渲染（下载页的表格） ---------------- */

function renderLogs(list) {
  const tbody = qs('#logs-search-body'); // 下载页结果表
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="message-empty">未找到日志</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(item => {
    const size = humanSize(item.size || 0);
    const node = item.node || extractNodeFromName(item.name || '');
    const type = item.type || '-';
    const mtime = item.mtime || item.timestamp || '-';
    const path = item.path || item.remote_path || '';
    return `
      <tr>
        <td>${escapeHtml(item.name || '')}</td>
        <td>${escapeHtml(String(node))}</td>
        <td>${escapeHtml(type)}</td>
        <td>${escapeHtml(size)}</td>
        <td>${escapeHtml(mtime)}</td>
        <td title="${escapeHtml(path)}">${escapeHtml(path)}</td>
      </tr>
    `;
  }).join('');
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
