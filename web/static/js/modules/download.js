// web/static/js/modules/download.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { escapeHtml } from '../core/utils.js';
import { setButtonLoading } from '../core/ui.js';

let inited = false;

const qs  = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
const $msg = (type, text) => showMessage(type, text, 'download-messages');

const SearchTypes = { MANUAL: 'manual', TEMPLATE: 'template' };

const state = {
  mode: 'normal',
  selectedTemplate: null,
  pager: { page: 1, page_size: 20, total: 0, loading: false, q: '' },
  filters: { factory: '', system: '' },
  templateCache: [],
  searchResults: [],
  selectedLogPaths: new Set(),
  lastSearch: null,
};

function restoreSearchBtnLabel() {
  const btn = qs('#btn-search');
  if (!btn) return;
  btn.innerHTML = state.mode === 'selected'
    ? '<i class="fas fa-search"></i> 搜索日志（模板）'
    : '<i class="fas fa-search"></i> 搜索日志';
}

function updateDownloadButton() {
  const btn = qs('#btn-download-logs');
  if (btn) btn.disabled = !state.selectedLogPaths.size;
  const btn2 = qs('#btn-download-and-analyze');
  if (btn2) btn2.disabled = !state.selectedLogPaths.size;
}

function updateRefreshButton() {
  const btn = qs('#btn-refresh');
  if (btn) btn.disabled = !state.lastSearch;
}

function updateSelectAllIndicator() {
  const checkbox = qs('#logs-check-all');
  if (!checkbox) return;
  const total = (state.searchResults || []).filter((item) => {
    return Boolean(item && (item.remote_path || item.path));
  }).length;
  const selected = state.selectedLogPaths.size;
  checkbox.indeterminate = false;
  if (!total) {
    checkbox.checked = false;
    return;
  }
  if (selected === 0) {
    checkbox.checked = false;
    return;
  }
  if (selected >= total) {
    checkbox.checked = true;
    return;
  }
  checkbox.checked = false;
  checkbox.indeterminate = true;
}

function clearLastSearch() {
  state.lastSearch = null;
  updateRefreshButton();
}

export function init() {
  const tab = qs('#download-tab');
  if (!tab || inited) return;
  inited = true;

  bindLeftForm();
  bindRightPanel();

  loadFactories().then(() => syncRightFiltersAndReload());
  updateRefreshButton();

  window.addEventListener('server-configs:changed', (evt) => {
    handleServerConfigsEvent(evt).catch((err) => {
      console.error('[download] server-configs:changed 处理失败', err);
    });
  });
}

function bindLeftForm() {
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');

  factorySel?.addEventListener('change', async () => {
    await loadSystems(factorySel.value);
    state.filters.factory = factorySel.value || '';
    syncRightFiltersAndReload();
    clearLastSearch();
    if (state.mode === 'selected') unselectTemplateSilent();
  });

  systemSel?.addEventListener('change', () => {
    state.filters.system = systemSel.value || '';
    syncRightFiltersAndReload();
    clearLastSearch();
    if (state.mode === 'selected') unselectTemplateSilent();
  });

  const includeArchive = qs('#include-archive');
  const dateRange      = qs('#date-range');
  const dateStart      = qs('#date-start');
  const dateEnd        = qs('#date-end');
  const toggleDate = () => {
    const on = !!includeArchive?.checked;
    if (dateRange) dateRange.style.display = on ? '' : 'none';
    if (dateStart) dateStart.required = on;
    if (dateEnd)   dateEnd.required   = on;
  };
  includeArchive?.addEventListener('change', toggleDate);
  toggleDate();

  qs('#btn-search')?.addEventListener('click', onSearchClick);
  const refreshBtn = qs('#btn-refresh');
  refreshBtn?.addEventListener('click', onRefreshClick);
  if (refreshBtn) refreshBtn.disabled = true;

  qs('#btn-download-logs')?.addEventListener('click', onDownloadLogsClick);
  qs('#btn-download-and-analyze')?.addEventListener('click', onDownloadAndAnalyzeClick);
  qs('#btn-save-template')?.addEventListener('click', onSaveTemplate);
  qs('#btn-cancel-template')?.addEventListener('click', exitAddTemplateMode);
  qs('#btn-unselect-template')?.addEventListener('click', () => {
    exitSelectedTemplateMode();
    $msg('info', '已解除模板选择');
  });

  qs('#logs-check-all')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    e.target.indeterminate = false;
    const tbody = qs('#logs-search-body');
    if (!tbody) return;
    state.selectedLogPaths.clear();
    qsa('input[type="checkbox"].log-select', tbody).forEach(chk => {
      chk.checked = checked;
      const path = chk.dataset.remotePath || chk.dataset.path || '';
      if (checked && path) state.selectedLogPaths.add(path);
    });
    updateDownloadButton();
    updateSelectAllIndicator();
  });

  loadSystems('');
  updateDownloadButton();
  updateSelectAllIndicator();
}

function bindRightPanel() {
  qs('#btn-add-template')?.addEventListener('click', enterAddTemplateMode);

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

  reloadTemplates(true);
}

/* ---------------- 搜索 ---------------- */

async function onSearchClick() {
  try {
    const descriptor = (state.mode === 'selected' && state.selectedTemplate)
      ? buildTemplateSearchDescriptor()
      : buildManualSearchDescriptor();
    await runSearch(descriptor, { remember: true, loadingTarget: 'btn-search', loadingText: '搜索中...' });
  } catch (err) {
    if (err?.message) {
      $msg('error', err.message);
    }
  }
}

async function onRefreshClick() {
  if (!state.lastSearch) {
    $msg('info', '请先搜索一次日志');
    return;
  }
  await runSearch(state.lastSearch, { remember: false, loadingTarget: 'btn-refresh', loadingText: '刷新中...' });
}

function buildManualSearchDescriptor() {
  const factory = qs('#factory-select')?.value || '';
  const system  = qs('#system-select')?.value || '';
  if (!factory || !system) {
    throw new Error('请先选择厂区与系统');
  }

  const includeRealtime = !!qs('#include-realtime')?.checked;
  const includeArchive  = !!qs('#include-archive')?.checked;
  const dateStart = qs('#date-start')?.value || '';
  const dateEnd   = qs('#date-end')?.value || '';
  if (includeArchive && (!dateStart || !dateEnd)) {
    throw new Error('选择归档时必须填写开始/结束日期');
  }

  const nodes = parseNodes(qs('#node-input')?.value || '');
  if (!nodes.length) {
    throw new Error('必须填写节点');
  }

  return {
    type: SearchTypes.MANUAL,
    payload: {
      factory,
      system,
      nodes,
      node: nodes[0] || '',
      includeRealtime,
      includeArchive,
      dateStart,
      dateEnd,
    }
  };
}

function buildTemplateSearchDescriptor() {
  const tpl = state.selectedTemplate;
  if (!tpl) throw new Error('请选择模板');

  const includeRealtime = !!qs('#include-realtime')?.checked;
  const includeArchive  = !!qs('#include-archive')?.checked;
  const dateStart = qs('#date-start')?.value || '';
  const dateEnd   = qs('#date-end')?.value || '';
  if (includeArchive && (!dateStart || !dateEnd)) {
    throw new Error('模板模式下，归档搜索同样需要填写开始/结束日期');
  }

  return {
    type: SearchTypes.TEMPLATE,
    payload: {
      template_id: tpl.id,
      includeRealtime,
      includeArchive,
      dateStart,
      dateEnd,
    }
  };
}

async function runSearch(descriptor, { remember = true, loadingTarget = 'btn-search', loadingText = '处理中...' } = {}) {
  if (!descriptor) return;
  setButtonLoading(loadingTarget, true, { text: loadingText });
  try {
    const request = descriptor.type === SearchTypes.TEMPLATE
      ? () => api.searchLogsByTemplate(descriptor.payload)
      : () => api.searchLogs(descriptor.payload);
    const data = await request();
    const list = data?.logs || data?.log_files || [];
    renderLogs(list);
    if (!list.length) $msg('info', '没有匹配的日志');

    if (remember) {
      state.lastSearch = {
        type: descriptor.type,
        payload: clonePayload(descriptor.payload),
      };
    }
  } catch (err) {
    console.error(err);
    $msg('error', '搜索失败：' + (err?.message || err));
  } finally {
    setButtonLoading(loadingTarget, false);
    if (loadingTarget === 'btn-search') restoreSearchBtnLabel();
    updateRefreshButton();
  }
}

function clonePayload(payload) {
  try {
    return JSON.parse(JSON.stringify(payload || {}));
  } catch (err) {
    return { ...(payload || {}) };
  }
}

/* ---------------- 下载 ---------------- */

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
      path: remote_path,
      size: item.size || 0,
      mtime: item.mtime || item.timestamp || '',
      type: item.type || 'unknown',
      node: item.node || ''
    });
  }
  return files;
}

function resolveNodesForDownload() {
  if (state.mode === 'selected' && state.selectedTemplate) {
    return Array.isArray(state.selectedTemplate.nodes) ? [...state.selectedTemplate.nodes] : [];
  }
  return parseNodes(qs('#node-input')?.value || '');
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
    $msg('error', '请先在下方结果中勾选要下载的日志');
    return;
  }

  const nodes = resolveNodesForDownload();

  try {
    setButtonLoading('btn-download-logs', true, { text: '下载中...' });
    const res = await api.downloadLogs({
      files,
      factory,
      system,
      nodes,
      node: nodes[0] || ''
    });
    if (!res?.success) {
      throw new Error(res?.error || '下载失败');
    }
    const downloaded = res.downloaded_files || [];
    if (downloaded.length) {
      $msg('success', `下载完成，成功下载 ${downloaded.length} 个日志文件`);
      window.dispatchEvent(new CustomEvent('logs:downloaded', {
        detail: { 
          count: downloaded.length,
          files: downloaded // 传递完整的文件列表，用于自动选中
        }
      }));
    } else {
      $msg('warning', '后端返回成功，但未包含已下载文件信息');
    }
    state.selectedLogPaths.clear();
    syncLogCheckboxes();
  } catch (err) {
    console.error(err);
    $msg('error', '下载失败：' + (err?.message || err));
  } finally {
    setButtonLoading('btn-download-logs', false);
    updateDownloadButton();
  }
}

async function onDownloadAndAnalyzeClick() {
  const factory = qs('#factory-select')?.value || '';
  const system  = qs('#system-select')?.value || '';
  if (!factory || !system) {
    $msg('error', '请先选择厂区与系统');
    return;
  }

  const files = buildSelectedFilesPayload();
  if (!files.length) {
    $msg('error', '请先在下方结果中勾选要下载的日志');
    return;
  }

  const nodes = resolveNodesForDownload();

  try {
    setButtonLoading('btn-download-and-analyze', true, { text: '下载并分析中...' });
    const res = await api.downloadLogs({
      files,
      factory,
      system,
      nodes,
      node: nodes[0] || ''
    });
    if (!res?.success) {
      throw new Error(res?.error || '下载失败');
    }
    const downloaded = res.downloaded_files || [];
    if (!downloaded.length) {
      $msg('warning', '后端返回成功，但未包含已下载文件信息');
      return;
    }
    $msg('success', `下载完成，成功下载 ${downloaded.length} 个日志文件，开始分析...`);

    const logPaths = downloaded.map(d => d.path).filter(Boolean);
    const configId = `${factory}_${system}.json`;
    const analyzeRes = await api.analyze(logPaths, configId);
    if (!analyzeRes?.success) {
      throw new Error(analyzeRes?.error || '分析失败');
    }

    const reportPath = analyzeRes.html_report || '';
    if (reportPath) {
      const openRes = await api.openInBrowser(reportPath);
      if (openRes?.success) {
        $msg('success', '分析完成，报告已自动打开');
      } else {
        $msg('warning', '分析完成，但自动打开报告失败');
      }
    } else {
      $msg('warning', '分析完成，但未生成 HTML 报告');
    }

    state.selectedLogPaths.clear();
    syncLogCheckboxes();
  } catch (err) {
    console.error(err);
    $msg('error', '下载或分析失败：' + (err?.message || err));
  } finally {
    setButtonLoading('btn-download-and-analyze', false);
    updateDownloadButton();
  }
}

/* ---------------- 模板 UI ---------------- */

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
  restoreSearchBtnLabel();
}

async function enterSelectedTemplateMode(tpl) {
  state.mode = 'selected';
  state.selectedTemplate = tpl;
  clearLastSearch();

  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const nodeInput  = qs('#node-input');
  const tplFactory = tpl.factory || tpl.factory_name || '';
  const tplSystem  = tpl.system || tpl.system_name || '';

  if (factorySel) {
    fillSelectValue(factorySel, tplFactory);
    factorySel.setAttribute('disabled', 'disabled');
  }
  if (systemSel) {
    await loadSystems(tplFactory);
    fillSelectValue(systemSel, tplSystem);
    systemSel.setAttribute('disabled', 'disabled');
  }
  if (nodeInput) {
    nodeInput.value = (tpl.nodes || []).join(',');
    nodeInput.setAttribute('disabled', 'disabled');
  }

  const searchBtn = qs('#btn-search');
  if (searchBtn) searchBtn.innerHTML = '<i class="fas fa-search"></i> 搜索日志（模板）';

  const nameEl = qs('#selected-template-name');
  const badge = qs('#selected-template-badge');
  if (nameEl) nameEl.textContent = tpl.name;
  if (badge) badge.style.display = '';
}

function exitSelectedTemplateMode() {
  state.mode = 'normal';
  state.selectedTemplate = null;
  clearLastSearch();
  const factorySel = qs('#factory-select');
  const systemSel  = qs('#system-select');
  const nodeInput  = qs('#node-input');
  factorySel?.removeAttribute('disabled');
  systemSel?.removeAttribute('disabled');
  nodeInput?.removeAttribute('disabled');
  restoreSearchBtnLabel();
  const badge = qs('#selected-template-badge');
  if (badge) badge.style.display = 'none';
}

function unselectTemplateSilent() {
  if (state.mode === 'selected') exitSelectedTemplateMode();
}

function syncRightFiltersAndReload() {
  state.filters.factory = qs('#factory-select')?.value || '';
  state.filters.system = qs('#system-select')?.value || '';
  reloadTemplates(true);
}

async function handleServerConfigsEvent(evt) {
  const factorySel = qs('#factory-select');
  const systemSel = qs('#system-select');
  if (!factorySel || !systemSel) return;

  const beforeFactory = factorySel.value || '';
  const beforeSystem = systemSel.value || '';
  const detail = evt?.detail || {};
  const { action, config, previous } = detail;

  await loadFactories();
  fillSelectValue(factorySel, beforeFactory);

  if (action === 'update' && previous && config && beforeFactory === previous.factory) {
    fillSelectValue(factorySel, config.factory);
  } else if (
    action === 'delete'
    && previous
    && beforeFactory === previous.factory
    && !selectHasOption(factorySel, beforeFactory)
  ) {
    factorySel.value = '';
  }

  await loadSystems(factorySel.value);
  fillSelectValue(systemSel, beforeSystem);

  if (
    action === 'update'
    && previous
    && config
    && beforeFactory === previous.factory
    && beforeSystem === previous.system
    && factorySel.value === (config.factory || previous.factory)
  ) {
    fillSelectValue(systemSel, config.system);
  } else if (
    action === 'delete'
    && previous
    && factorySel.value === previous.factory
    && !selectHasOption(systemSel, beforeSystem)
  ) {
    systemSel.value = '';
  }

  const afterFactory = factorySel.value || '';
  const afterSystem = systemSel.value || '';
  const selectionChanged = afterFactory !== beforeFactory || afterSystem !== beforeSystem;

  syncRightFiltersAndReload();
  if (selectionChanged) {
    clearLastSearch();
    if (state.mode === 'selected') {
      unselectTemplateSilent();
    }
  }
}

function renderTemplateList(items, append = false) {
  const host = qs('#template-list');
  if (!host) return;
  if (!append) host.innerHTML = '';

  if (!items.length && !append) {
    host.innerHTML = '<div class="message-empty">暂无模板</div>';
    return;
  }

  for (const t of items) {
    const nodes = Array.isArray(t.nodes) ? t.nodes : [];
    const factoryName = t.factory || t.factory_name || '-';
    const systemName = t.system || t.system_name || '-';
    const nodesPreview = nodes.slice(0, 4).join(', ');
    const el = document.createElement('div');
    const previewText = nodesPreview
      ? `${nodesPreview}${nodes.length > 4 ? ' …' : ''}`
      : '暂无示例';
    el.className = 'config-item config-item--compact template-card';
    el.innerHTML = `
      <p class="config-compact-subline">${escapeHtml(factoryName)} - ${escapeHtml(systemName)}</p>
      <div class="config-compact-title">
        <h3>${escapeHtml(t.name)}</h3>
        <span class="config-chip">${nodes.length} 节点</span>
      </div>
      <div class="config-compact-meta"><i class="fas fa-stream"></i> ${escapeHtml(previewText)}</div>
      <div class="config-compact-actions tpl-actions">
        <button class="btn btn-primary btn-sm tpl-select">选择区域</button>
        <button class="btn btn-secondary btn-sm tpl-edit">编辑</button>
        <button class="btn btn-danger btn-sm tpl-del">删除</button>
      </div>
    `;

    el.querySelector('.tpl-select')?.addEventListener('click', () => enterSelectedTemplateMode(t));
    el.querySelector('.tpl-edit')?.addEventListener('click', () => editTemplate(t));
    el.querySelector('.tpl-del')?.addEventListener('click', () => deleteTemplate(t));

    host.appendChild(el);
  }

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
    const payload = (raw && raw.data) ? raw.data : raw;
    const items = payload?.items || [];
    state.pager.total = payload?.total || items.length;
    state.templateCache = state.templateCache.concat(items);
    renderTemplateList(items, !reset);
  } catch (err) {
    console.error(err);
    $msg('error', '加载模板失败：' + (err?.message || err));
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
    $msg('error', '请填写至少一个节点');
    return;
  }

  const name = prompt('请输入区域名称（例如：大东厂区-区域A）');
  if (!name || !name.trim()) {
    $msg('warning', '已取消保存');
    return;
  }

  try {
    setButtonLoading('btn-save-template', true, { text: '保存中...' });
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ name: name.trim(), factory, system, nodes })
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '保存失败');
    $msg('success', '区域模板已保存');
    exitAddTemplateMode();
    reloadTemplates(true);
  } catch (err) {
    $msg('error', '保存失败：' + (err?.message || err));
  } finally {
    setButtonLoading('btn-save-template', false);
  }
}

async function editTemplate(t) {
  const newName = prompt('新的区域名称', t.name || '');
  if (!newName || !newName.trim()) {
    $msg('warning', '未输入名称，已取消编辑');
    return;
  }
  const nodes = prompt('更新节点（英文逗号分隔）', (t.nodes || []).join(',')) || '';
  const parsedNodes = parseNodes(nodes);
  if (!parsedNodes.length) {
    $msg('error', '请至少填写一个节点');
    return;
  }
  await updateTemplateNodes(t.id, newName, parsedNodes);
}

async function updateTemplateNodes(id, name, nodes) {
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ name: name.trim(), nodes })
    });
    const data = await res.json();
    if (!data?.success) throw new Error(data?.error || '保存失败');
    $msg('success', '模板已更新');
    reloadTemplates(true);
  } catch (err) {
    $msg('error', '更新失败：' + (err?.message || err));
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
  } catch (err) {
    $msg('error', '删除失败：' + (err?.message || err));
  }
}

/* ---------------- 公共工具 ---------------- */

async function loadFactories() {
  const sel = qs('#factory-select');
  if (!sel) return;
  try {
    const list = await api.getFactories();
    sel.innerHTML = '<option value="">-- 请选择厂区 --</option>';
    (list || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      sel.appendChild(opt);
    });
  } catch (err) {
    $msg('error', '加载厂区失败：' + (err?.message || err));
  }
}

async function loadSystems(factoryId) {
  const sel = qs('#system-select');
  if (!sel) return;
  if (!factoryId) {
    sel.innerHTML = '<option value="">-- 请选择系统 --</option>';
    return;
  }
  try {
    const list = await api.getSystems(factoryId);
    sel.innerHTML = '<option value="">-- 请选择系统 --</option>';
    (list || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  } catch (err) {
    $msg('error', '加载系统失败：' + (err?.message || err));
  }
}

function parseNodes(str) {
  return (str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(x => /^\d{1,6}$/.test(x))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function fillSelectValue(sel, val) {
  if (!sel) return;
  const opt = Array.from(sel.options).find(o => o.value == val);
  if (opt) sel.value = val;
}

function selectHasOption(sel, val) {
  if (!sel || val === undefined || val === null) return false;
  return Array.from(sel.options || []).some((o) => o.value == val);
}

function renderLogs(list) {
  const tbody = qs('#logs-search-body');
  if (!tbody) return;
  state.searchResults = Array.isArray(list) ? list : [];
  state.selectedLogPaths.clear();
  updateSelectAllIndicator();

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="message-empty">未找到日志</td></tr>';
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

    const tdSel = document.createElement('td');
    tdSel.classList.add('col-select');
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
        const allChk = qs('#logs-check-all');
        if (allChk && allChk.checked) allChk.checked = false;
      }
      updateDownloadButton();
      updateSelectAllIndicator();
    });
    tdSel.appendChild(chk);
    tr.appendChild(tdSel);

    const tdName = document.createElement('td');
    tdName.textContent = item.name || '';
    tr.appendChild(tdName);

    const tdNode = document.createElement('td');
    tdNode.textContent = String(node);
    tr.appendChild(tdNode);

    const tdType = document.createElement('td');
    tdType.textContent = type;
    tr.appendChild(tdType);

    const tdSize = document.createElement('td');
    tdSize.textContent = size;
    tr.appendChild(tdSize);

    const tdTime = document.createElement('td');
    tdTime.textContent = mtime;
    tr.appendChild(tdTime);

    const tdPath = document.createElement('td');
    tdPath.title = path;
    tdPath.textContent = path;
    tr.appendChild(tdPath);

    tbody.appendChild(tr);
  });

  updateDownloadButton();
}

function humanSize(bytes) {
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  let n = +bytes || 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function extractNodeFromName(name = '') {
  const m = name.match(/tcp_trace\.(\d+)/);
  return m ? m[1] : '';
}

function syncLogCheckboxes() {
  const tbody = qs('#logs-search-body');
  if (!tbody) return;
  qsa('input[type="checkbox"].log-select', tbody).forEach(chk => {
    const path = chk.dataset.remotePath || chk.dataset.path || '';
    chk.checked = !!(path && state.selectedLogPaths.has(path));
  });
  updateDownloadButton();
  updateSelectAllIndicator();
}
