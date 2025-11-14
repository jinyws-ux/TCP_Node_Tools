// modules/parser-config.js
// 注意：本模块只做“解析逻辑配置”一栏的行为，其他三大模块互不影响
import { escapeHtml, escapeAttr } from '../core/utils.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';
import { api } from '../core/api.js';

let inited = false;

// 轻量状态
let workingFactory = '';
let workingSystem  = '';
let workingConfig  = {};   // 全量 JSON（内存）
let workingTree    = [];   // 树结构缓存
const historyStack = [];   // 本地撤销快照
const HISTORY_LIMIT = 15;
const escapeModalDefaults = { messageType: '', version: '', field: '' };
const TYPE_LABELS = {
  message_type: '报文类型',
  version: '版本',
  field: '字段',
  escape: '转义',
};
const clipboardState = {
  type: null,
  label: '',
  data: null,
  meta: {},
};

// 工具
const qs  = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

function selectHasOption(sel, val) {
  if (!sel || val === undefined || val === null) return false;
  return Array.from(sel.options || []).some((opt) => opt.value == val);
}

function setSelectValue(sel, val) {
  if (!sel) return false;
  if (selectHasOption(sel, val)) {
    sel.value = val;
    return true;
  }
  return false;
}

function deepCopy(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function cloneConfig(value) {
  return deepCopy(value);
}

function hasClipboard(type) {
  return clipboardState.type === type && clipboardState.data != null;
}

function formatClipboardLabel() {
  if (!clipboardState.type || !clipboardState.label) return '尚未复制任何配置';
  const typeLabel = TYPE_LABELS[clipboardState.type] || clipboardState.type;
  return `${typeLabel}：${clipboardState.label}`;
}

function formatClipboardHint() {
  if (!clipboardState.type) {
    return '从左侧选择项目后点击“复制”按钮';
  }
  const hintMap = {
    message_type: '任意报文类型列表',
    version: '目标报文类型中的“粘贴版本”',
    field: '目标版本中的“粘贴字段”',
    escape: '字段内的“粘贴转义”',
  };
  return `可粘贴到 ${hintMap[clipboardState.type] || '对应层级'}`;
}

function renderClipboardBanner() {
  const banner = qs('#parser-clipboard');
  if (!banner) return;
  const labelEl = qs('#clipboard-label');
  const hintEl = qs('#clipboard-hint');
  if (!clipboardState.type || !clipboardState.data) {
    banner.dataset.state = 'empty';
    if (labelEl) labelEl.textContent = '尚未复制任何配置';
    if (hintEl) hintEl.textContent = '从左侧选择项目后点击“复制”按钮';
    return;
  }
  banner.dataset.state = 'filled';
  if (labelEl) labelEl.textContent = formatClipboardLabel();
  if (hintEl) hintEl.textContent = formatClipboardHint();
}

function clearClipboard() {
  clipboardState.type = null;
  clipboardState.label = '';
  clipboardState.data = null;
  clipboardState.meta = {};
  renderClipboardBanner();
}

function setClipboard(type, label, data, meta = {}) {
  if (data == null) {
    showMessage('warning', '没有可复制的内容', 'parser-config-messages');
    return;
  }
  clipboardState.type = type;
  clipboardState.label = label;
  clipboardState.data = deepCopy(data);
  clipboardState.meta = meta;
  renderClipboardBanner();
  const typeLabel = TYPE_LABELS[type] || type;
  showMessage('success', `${typeLabel}已复制到剪贴板`, 'parser-config-messages');
}

function suggestName(base, existingList = []) {
  const normalized = (base || '复制项').trim() || '复制项';
  const baseName = normalized.replace(/\s+/g, '_');
  const existing = new Set(existingList);
  if (!existing.has(baseName)) return baseName;
  let counter = 2;
  let candidate = `${baseName}_${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${baseName}_${counter}`;
  }
  return candidate;
}

function notifyParserConfigChanged(action, detail = {}) {
  window.dispatchEvent(new CustomEvent('parser-config:changed', {
    detail: { action, ...detail }
  }));
}

// =============== 初始化入口（幂等） ===============
export function init() {
  const tab = qs('#parser-config-tab');
  if (!tab) return; // 当前页面没有这个 tab
  if (inited) return;
  inited = true;

  // 顶部选择器与进入按钮
  const factorySel = qs('#parser-factory-select');
  const systemSel  = qs('#parser-system-select');
  const enterBtn   = qs('#enter-workspace-btn');

  if (factorySel) {
    factorySel.addEventListener('change', loadParserSystems);
  }
  if (enterBtn) {
    enterBtn.addEventListener('click', async () => {
      const f = factorySel?.value || '';
      const s = systemSel?.value  || '';
      if (!f || !s) {
        showMessage('error', '请先选择厂区与系统', 'parser-config-messages');
        return;
      }
      await enterWorkspace(f, s);
    });
  }

  // 工具按钮（如果 HTML 有这些按钮，则绑定；没有就忽略）
  bindIfExists('[data-action="expand-all"]', 'click', expandAllLayers);
  bindIfExists('[data-action="collapse-all"]', 'click', collapseAllLayers);
  bindIfExists('[data-action="export-config"]', 'click', exportConfig);
  bindIfExists('[data-action="import-config"]', 'click', importConfig);
  bindIfExists('[data-action="copy-json"]', 'click', copyJsonPreview);
  bindIfExists('[data-action="open-add-message-type"]', 'click', showAddMessageTypeModal);
  bindIfExists('#undo-btn', 'click', undoLastOperation);
  bindIfExists('#msg-type-search', 'input', searchMessageType);
  bindIfExists('#parser-preview-toggle', 'click', togglePreviewPanel);
  bindIfExists('#parser-nav-toggle', 'click', toggleNavPanel);
  bindIfExists('[data-action="clear-clipboard"]', 'click', clearClipboard);

  // “添加”模态框 —— 兼容你现有 HTML
  bindIfExists('#mt-submit-btn', 'click', submitMessageTypeForm);
  bindIfExists('#ver-submit-btn', 'click', submitVersionForm);
  bindIfExists('#field-submit-btn', 'click', submitFieldForm);
  bindIfExists('#escape-submit-btn', 'click', submitEscapeForm);
  bindIfExists('#escape-message-type', 'change', handleEscapeMessageTypeChange);
  bindIfExists('#escape-version', 'change', handleEscapeVersionChange);
  bindIfExists('#escape-field', 'change', handleEscapeFieldChange);

  // 退出按钮（若 HTML 有）
  bindIfExists('#exit-workspace-btn', 'click', exitWorkspace);

  // 首次载入：填厂区列表（沿用你已有逻辑：在 app.js/其他模块里也会拉一次，这里兜底）
  loadParserFactoriesSafe();
  renderClipboardBanner();

  window.addEventListener('server-configs:changed', (evt) => {
    handleServerConfigsEvent(evt).catch((err) => {
      console.error('[parser-config] server-configs:changed 处理失败', err);
    });
  });
}

function bindIfExists(sel, evt, fn) {
  const el = qs(sel);
  if (el) el.addEventListener(evt, fn);
}

function togglePreviewPanel() {
  const panel = qs('#parser-preview-panel');
  const layout = qs('.parser-three-column');
  if (!panel || !layout) return;
  const collapsed = panel.classList.toggle('is-collapsed');
  panel.dataset.state = collapsed ? 'collapsed' : 'expanded';
  layout.classList.toggle('preview-collapsed', collapsed);
  const btn = qs('#parser-preview-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('title', collapsed ? '展开实时预览' : '收起实时预览');
    const icon = btn.querySelector('i');
    if (icon) {
      icon.className = collapsed ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
    }
  }
}

function toggleNavPanel() {
  const nav = qs('.parser-left-nav');
  const layout = qs('.parser-three-column');
  if (!nav || !layout) return;
  const collapsed = nav.classList.toggle('is-collapsed');
  layout.classList.toggle('nav-collapsed', collapsed);
  nav.dataset.state = collapsed ? 'collapsed' : 'expanded';
  const btn = qs('#parser-nav-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('title', collapsed ? '展开导航' : '收起导航');
    const icon = btn.querySelector('i');
    if (icon) {
      icon.className = collapsed ? 'fas fa-angle-double-right' : 'fas fa-angle-double-left';
    }
  }
}

// =============== 进入/退出工作台 ===============
async function enterWorkspace(factory, system) {
  workingFactory = factory;
  workingSystem  = system;

  // 面包屑
  const fCrumb = qs('#current-factory-breadcrumb');
  const sCrumb = qs('#current-system-breadcrumb');
  if (fCrumb) fCrumb.textContent = factory;
  if (sCrumb) sCrumb.textContent = system;

  // 切换视图
  qs('#factory-system-selection')?.setAttribute('style', 'display:none;');
  qs('.simple-config-workspace')?.setAttribute('style', 'display:block;');

  try {
    await Promise.all([refreshTree(), refreshFullConfig(), refreshStats()]);
    showMessage('success', '配置工作台已就绪', 'parser-config-messages');
  } catch (e) {
    console.error(e);
    showMessage('error', '进入工作台失败：' + (e?.message || e), 'parser-config-messages');
  }
}

function exitWorkspace() {
  qs('#factory-system-selection')?.setAttribute('style', 'display:block;');
  qs('.simple-config-workspace')?.setAttribute('style', 'display:none;');
  const treeHost = qs('#left-nav-tree');
  const jsonBox  = qs('#json-preview-content');
  const rightBox = qs('#full-layers-container');
  const nav      = qs('.parser-left-nav');
  const layout   = qs('.parser-three-column');

  if (nav) {
    nav.classList.remove('is-collapsed');
    nav.dataset.state = 'expanded';
  }
  if (layout) {
    layout.classList.remove('nav-collapsed');
  }
  const navBtn = qs('#parser-nav-toggle');
  if (navBtn) {
    navBtn.setAttribute('aria-expanded', 'true');
    navBtn.setAttribute('title', '收起导航');
    const icon = navBtn.querySelector('i');
    if (icon) icon.className = 'fas fa-angle-double-left';
  }

  if (treeHost) {
    treeHost.innerHTML = `
      <div class="parser-tree-placeholder">
        <i class="fas fa-folder-open"></i>
        <p>暂无报文类型，点击"添加报文类型"开始配置</p>
      </div>`;
  }
  if (jsonBox) {
    jsonBox.innerHTML = `
      <div class="parser-json-placeholder">
        <i class="fas fa-code"></i>
        <p>配置变更后实时刷新</p>
      </div>`;
  }
  if (rightBox) {
    rightBox.innerHTML = `
      <div class="parser-layers-placeholder">
        <i class="fas fa-mouse-pointer"></i>
        <p>请从左侧选择要配置的项</p>
      </div>`;
  }

  workingFactory = ''; workingSystem = ''; workingConfig = {}; workingTree = [];
  historyStack.length = 0;
  const histEl = qs('#history-count');
  if (histEl) histEl.textContent = `0/${HISTORY_LIMIT}`;
  const undoBtn = qs('#undo-btn');
  if (undoBtn) undoBtn.setAttribute('disabled', 'disabled');

  showMessage('info', '已退出配置工作台', 'parser-config-messages');
}

// =============== 加载下拉框（兜底） ===============
async function loadParserFactoriesSafe() {
  const sel = qs('#parser-factory-select');
  if (!sel) return;
  try {
    const list = await api.getFactories();
    sel.innerHTML = '<option value="">-- 请选择厂区 --</option>';
    (list || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id; opt.textContent = f.name;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

async function loadParserSystems() {
  const factoryId = qs('#parser-factory-select')?.value;
  const sel = qs('#parser-system-select');
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
      opt.value = s.id; opt.textContent = s.name;
      sel.appendChild(opt);
    });
  } catch (e) {
    showMessage('error', '加载系统失败：' + (e?.message || e), 'parser-config-messages');
  }
}

async function handleServerConfigsEvent(evt) {
  const factorySel = qs('#parser-factory-select');
  if (!factorySel) return;
  const systemSel = qs('#parser-system-select');
  const beforeFactory = factorySel.value || '';
  const beforeSystem = systemSel?.value || '';
  const detail = evt?.detail || {};
  const { action, config, previous } = detail;

  await loadParserFactoriesSafe();
  if (beforeFactory) {
    if (!setSelectValue(factorySel, beforeFactory)) {
      factorySel.value = '';
    }
  }

  if (action === 'update' && previous && config && beforeFactory === previous.factory) {
    setSelectValue(factorySel, config.factory);
  } else if (
    action === 'delete'
    && previous
    && beforeFactory === previous.factory
    && !selectHasOption(factorySel, beforeFactory)
  ) {
    factorySel.value = '';
  }

  await loadParserSystems();
  if (systemSel && beforeSystem) {
    if (!setSelectValue(systemSel, beforeSystem)) {
      systemSel.value = '';
    }
  }

  if (
    action === 'update'
    && previous
    && config
    && beforeFactory === previous.factory
    && beforeSystem === previous.system
    && systemSel
    && factorySel.value === (config.factory || previous.factory)
  ) {
    setSelectValue(systemSel, config.system);
  } else if (
    action === 'delete'
    && previous
    && systemSel
    && factorySel.value === previous.factory
    && !selectHasOption(systemSel, beforeSystem)
  ) {
    systemSel.value = '';
  }

  const afterFactory = factorySel.value || '';
  const afterSystem = systemSel?.value || '';
  const selectionChanged = afterFactory !== beforeFactory || afterSystem !== beforeSystem;
  const workspaceAffected = Boolean(
    previous
    && workingFactory
    && workingSystem
    && previous.factory === workingFactory
    && previous.system === workingSystem
  );

  if (workspaceAffected) {
    if (action === 'delete') {
      exitWorkspace();
      showMessage('warning', '当前工作台对应的厂区/系统已删除，请重新选择', 'parser-config-messages');
    } else if (action === 'update' && config) {
      workingFactory = config.factory;
      workingSystem  = config.system;
      const fCrumb = qs('#current-factory-breadcrumb');
      const sCrumb = qs('#current-system-breadcrumb');
      if (fCrumb) fCrumb.textContent = workingFactory;
      if (sCrumb) sCrumb.textContent = workingSystem;
      try {
        await Promise.all([refreshTree(), refreshFullConfig(), refreshStats()]);
        showMessage('info', '服务器配置改名，已同步至当前工作台', 'parser-config-messages');
      } catch (err) {
        console.error(err);
        showMessage('error', '重载解析配置失败：' + (err?.message || err), 'parser-config-messages');
      }
    }
  } else if (selectionChanged && action === 'delete') {
    showMessage('warning', '服务器配置调整后，请重新选择厂区与系统', 'parser-config-messages');
  }
}

// =============== 刷新树/配置/统计 ===============
async function refreshTree() {
  const tree = await api.fetchParserConfigTree(workingFactory, workingSystem);
  workingTree = tree;
  renderTree(workingTree);
}

async function refreshFullConfig() {
  workingConfig = await api.fetchParserConfig(workingFactory, workingSystem);
  renderJsonPreview();
}

async function refreshStats() {
  try {
    await api.fetchParserConfigStats(workingFactory, workingSystem);
  } catch(_) {}
}

// =============== 左侧树渲染 ===============
function renderTree(tree) {
  const host = qs('#left-nav-tree');
  if (!host) return;

  host.innerHTML = '';
  if (!tree || !tree.length) {
    host.innerHTML = `
      <div class="parser-tree-placeholder">
        <i class="fas fa-folder-open"></i>
        <p>暂无报文类型，点击"添加报文类型"开始配置</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  tree.forEach((node) => fragment.appendChild(buildTreeNode(node)));
  host.appendChild(fragment);

  host.querySelectorAll('.parser-item').forEach((el) => {
    el.addEventListener('click', () => {
      host.querySelectorAll('.parser-item.active').forEach((a) => a.classList.remove('active'));
      el.classList.add('active');
      const t = el.dataset.type;
      if (t === 'message_type') {
        renderEditorFor({ type: 'message_type', messageType: el.dataset.msg, path: el.dataset.path });
      } else if (t === 'version') {
        renderEditorFor({ type: 'version', messageType: el.dataset.msg, version: el.dataset.ver, path: el.dataset.path });
      } else if (t === 'field') {
        renderEditorFor({ type: 'field', messageType: el.dataset.msg, version: el.dataset.ver, field: el.dataset.field, path: el.dataset.path });
      } else if (t === 'escape') {
        renderEditorFor({ type: 'escape', messageType: el.dataset.msg, version: el.dataset.ver, field: el.dataset.field, escapeKey: el.dataset.escape });
      }
    });
  });
}

function buildTreeNode(node) {
  const wrapper = document.createElement('div');
  wrapper.className = 'parser-tree-node';

  const iconMap = {
    message_type: 'fa-envelope',
    version: 'fa-code-branch',
    field: 'fa-tag',
    escape: 'fa-exchange-alt',
  };

  const el = document.createElement('div');
  el.className = `parser-item parser-item-${node.type}`;
  el.dataset.type = node.type;
  if (node.path) el.dataset.path = node.path;

  if (node.type === 'message_type') {
    el.dataset.msg = node.name;
  } else if (node.type === 'version') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.name;
  } else if (node.type === 'field') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.version;
    el.dataset.field = node.name;
  } else if (node.type === 'escape') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.version;
    el.dataset.field = node.field;
    el.dataset.escape = node.name;
  }

  const icon = iconMap[node.type] || 'fa-circle';
  let meta = '';
  if (node.type === 'field') {
    const lenText = node.length == null ? -1 : node.length;
    meta = `<span class="meta">[Start=${node.start}, Length=${lenText}]</span>`;
    if (node.children && node.children.length) {
      meta += ' <span class="status-badge status-warning">转义</span>';
    }
  }
  if (node.type === 'escape') {
    meta = `<span class="meta">→ ${escapeHtml(String(node.value ?? ''))}</span>`;
  }

  const desc = node.description ? `<span class="desc">— ${escapeHtml(node.description)}</span>` : '';
  el.innerHTML = `
    <i class="fas ${icon}"></i>
    <span class="label">${escapeHtml(node.name || '')}</span>
    ${desc}
    ${meta}
  `;

  wrapper.appendChild(el);

  if (Array.isArray(node.children) && node.children.length) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'parser-children';
    node.children.forEach((child) => {
      childrenWrap.appendChild(buildTreeNode(child));
    });
    wrapper.appendChild(childrenWrap);
  }

  return wrapper;
}

// =============== 剪贴板：复制 / 粘贴 ===============
function copyMessageType(mt) {
  const data = workingConfig?.[mt];
  if (!data) {
    showMessage('error', '未找到报文类型', 'parser-config-messages');
    return;
  }
  setClipboard('message_type', mt, data, { messageType: mt });
}

function copyVersion(mt, ver) {
  const data = workingConfig?.[mt]?.Versions?.[ver];
  if (!data) {
    showMessage('error', '未找到版本', 'parser-config-messages');
    return;
  }
  setClipboard('version', `${mt} / ${ver}`, data, { messageType: mt, version: ver });
}

function copyField(mt, ver, field) {
  const data = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[field];
  if (!data) {
    showMessage('error', '未找到字段', 'parser-config-messages');
    return;
  }
  setClipboard('field', `${mt} / ${ver} / ${field}`, data, { messageType: mt, version: ver, field });
}

function copyEscape(mt, ver, field, key) {
  const data = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[field]?.Escapes?.[key];
  if (data === undefined) {
    showMessage('error', '未找到转义项', 'parser-config-messages');
    return;
  }
  setClipboard('escape', `${field} → ${key}`, data, { messageType: mt, version: ver, field, escapeKey: key });
}

async function pasteMessageType() {
  if (!hasClipboard('message_type')) {
    showMessage('warning', '剪贴板中没有报文类型', 'parser-config-messages');
    return;
  }
  const existing = Object.keys(workingConfig || {});
  const suggested = suggestName(clipboardState.meta?.messageType || clipboardState.label, existing);
  const newName = prompt('粘贴为新的报文类型：', suggested);
  if (!newName) return;
  if (existing.includes(newName)) {
    showMessage('error', '该报文类型已存在', 'parser-config-messages');
    return;
  }
  const updates = { [newName]: deepCopy(clipboardState.data) };
  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates,
    });
    showMessage('success', '报文类型已粘贴', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'message_type', messageType: newName });
    notifyParserConfigChanged('paste', { type: 'message_type', name: newName });
  } catch (err) {
    showMessage('error', '粘贴失败：' + err.message, 'parser-config-messages');
  }
}

async function pasteVersion(targetMt) {
  if (!targetMt) return;
  if (!hasClipboard('version')) {
    showMessage('warning', '剪贴板中没有版本', 'parser-config-messages');
    return;
  }
  const versions = workingConfig?.[targetMt]?.Versions || {};
  const base = clipboardState.meta?.version || clipboardState.label?.split('/')?.pop() || '新版本';
  const suggested = suggestName(base, Object.keys(versions));
  const newVersion = prompt(`粘贴到 ${targetMt} 的版本名称：`, suggested);
  if (!newVersion) return;
  if (versions[newVersion]) {
    showMessage('error', '该版本已存在', 'parser-config-messages');
    return;
  }
  const path = `${targetMt}.Versions.${newVersion}`;
  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates: { [path]: deepCopy(clipboardState.data) },
    });
    showMessage('success', '版本已粘贴', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'version', messageType: targetMt, version: newVersion });
    notifyParserConfigChanged('paste', { type: 'version', messageType: targetMt, version: newVersion });
  } catch (err) {
    showMessage('error', '粘贴失败：' + err.message, 'parser-config-messages');
  }
}

async function pasteField(targetMt, targetVer) {
  if (!targetMt || !targetVer) return;
  if (!hasClipboard('field')) {
    showMessage('warning', '剪贴板中没有字段', 'parser-config-messages');
    return;
  }
  const fields = workingConfig?.[targetMt]?.Versions?.[targetVer]?.Fields || {};
  const base = clipboardState.meta?.field || clipboardState.label?.split('/')?.pop() || '新字段';
  const suggested = suggestName(base, Object.keys(fields));
  const newField = prompt(`粘贴到 ${targetMt}/${targetVer} 的字段名：`, suggested);
  if (!newField) return;
  if (fields[newField]) {
    showMessage('error', '该字段已存在', 'parser-config-messages');
    return;
  }
  const path = `${targetMt}.Versions.${targetVer}.Fields.${newField}`;
  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates: { [path]: deepCopy(clipboardState.data) },
    });
    showMessage('success', '字段已粘贴', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: targetMt, version: targetVer, field: newField });
    notifyParserConfigChanged('paste', { type: 'field', messageType: targetMt, version: targetVer, field: newField });
  } catch (err) {
    showMessage('error', '粘贴失败：' + err.message, 'parser-config-messages');
  }
}

async function pasteEscape(targetMt, targetVer, targetField) {
  if (!targetMt || !targetVer || !targetField) return;
  if (!hasClipboard('escape')) {
    showMessage('warning', '剪贴板中没有转义', 'parser-config-messages');
    return;
  }
  const escMap = workingConfig?.[targetMt]?.Versions?.[targetVer]?.Fields?.[targetField]?.Escapes || {};
  const base = clipboardState.meta?.escapeKey || '新转义';
  const suggested = suggestName(base, Object.keys(escMap));
  const newKey = prompt(`粘贴到 ${targetField} 的转义键：`, suggested);
  if (!newKey) return;
  if (Object.prototype.hasOwnProperty.call(escMap, newKey)) {
    showMessage('error', '该转义键已存在', 'parser-config-messages');
    return;
  }
  const path = `${targetMt}.Versions.${targetVer}.Fields.${targetField}.Escapes.${newKey}`;
  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates: { [path]: deepCopy(clipboardState.data) },
    });
    showMessage('success', '转义已粘贴', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: targetMt, version: targetVer, field: targetField });
    notifyParserConfigChanged('paste', { type: 'escape', messageType: targetMt, version: targetVer, field: targetField, key: newKey });
  } catch (err) {
    showMessage('error', '粘贴失败：' + err.message, 'parser-config-messages');
  }
}

function expandAllLayers() {
  qsa('#left-nav-tree .parser-children').forEach(d => d.style.display = 'block');
}
function collapseAllLayers() {
  qsa('#left-nav-tree .parser-children').forEach(d => d.style.display = 'none');
}

// =============== 右侧编辑区域 ===============
function renderEditorFor(node) {
  const box = qs('#full-layers-container');
  if (!box) return;

  if (node.type === 'message_type') {
    const mt = node.messageType;
    const desc = (workingConfig?.[mt]?.Description) || '';
    const pasteTypeBtn = hasClipboard('message_type')
      ? '<button class="btn btn-outline" id="btn-paste-mt"><i class="fas fa-paste"></i> 粘贴报文类型</button>'
      : '';
    const pasteVersionBtn = hasClipboard('version')
      ? '<button class="btn btn-outline" id="btn-paste-version-into-mt"><i class="fas fa-paste"></i> 粘贴版本</button>'
      : '';
    box.innerHTML = `
      <h4><i class="fas fa-envelope"></i> 报文类型：${escapeHtml(mt)}</h4>
      <div class="form-group">
        <label>描述</label>
        <input id="mt-desc" type="text" value="${escapeAttr(desc)}">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="btn-save-mt"><i class="fas fa-save"></i> 保存描述</button>
        <button class="btn btn-secondary" id="btn-rename-mt"><i class="fas fa-i-cursor"></i> 重命名</button>
        <button class="btn btn-outline" id="btn-copy-mt"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-danger" id="btn-del-mt"><i class="fas fa-trash"></i> 删除</button>
        <button class="btn" id="btn-add-ver"><i class="fas fa-plus"></i> 添加版本</button>
        ${pasteTypeBtn}
        ${pasteVersionBtn}
      </div>`;
    qs('#btn-save-mt')?.addEventListener('click', () => saveMessageTypeDesc(mt));
    qs('#btn-rename-mt')?.addEventListener('click', () => renameMessageType(mt));
    qs('#btn-copy-mt')?.addEventListener('click', () => copyMessageType(mt));
    qs('#btn-del-mt')?.addEventListener('click', () => deleteConfigItem('message_type', mt));
    qs('#btn-add-ver')?.addEventListener('click', () => {
      showAddVersionModal(mt);
    });
    qs('#btn-paste-mt')?.addEventListener('click', () => pasteMessageType());
    qs('#btn-paste-version-into-mt')?.addEventListener('click', () => pasteVersion(mt));
    return;
  }

  if (node.type === 'version') {
    const { messageType: mt, version: ver } = node;
    const pasteFieldBtn = hasClipboard('field')
      ? '<button class="btn btn-outline" id="btn-paste-field"><i class="fas fa-paste"></i> 粘贴字段</button>'
      : '';
    box.innerHTML = `
      <h4><i class="fas fa-code-branch"></i> 版本：${escapeHtml(mt)} / ${escapeHtml(ver)}</h4>
      <div class="form-actions">
        <button class="btn btn-secondary" id="btn-rename-ver"><i class="fas fa-i-cursor"></i> 重命名</button>
        <button class="btn btn-outline" id="btn-copy-ver"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-danger" id="btn-del-ver"><i class="fas fa-trash"></i> 删除版本</button>
        <button class="btn" id="btn-add-field"><i class="fas fa-plus"></i> 添加字段</button>
        ${pasteFieldBtn}
      </div>`;
    qs('#btn-rename-ver')?.addEventListener('click', () => renameVersion(mt, ver));
    qs('#btn-copy-ver')?.addEventListener('click', () => copyVersion(mt, ver));
    qs('#btn-del-ver')?.addEventListener('click', () => deleteConfigItem('version', mt, ver));
    qs('#btn-add-field')?.addEventListener('click', () => showAddFieldModal(mt, ver));
    qs('#btn-paste-field')?.addEventListener('click', () => pasteField(mt, ver));
    return;
  }

  if (node.type === 'field') {
    const { messageType: mt, version: ver, field: fd } = node;
    const fcfg = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[fd] || { Start: 0, Length: null, Escapes: {} };
    const pasteEscapeBtn = hasClipboard('escape')
      ? '<button class="btn btn-outline" id="btn-paste-escape"><i class="fas fa-paste"></i> 粘贴转义</button>'
      : '';
    box.innerHTML = `
      <h4><i class="fas fa-tag"></i> 字段：${escapeHtml(mt)} / ${escapeHtml(ver)} / ${escapeHtml(fd)}</h4>
      <div class="form-row">
        <div class="form-group">
          <label>Start</label>
          <input id="fd-start" type="number" min="0" value="${escapeAttr(fcfg.Start ?? 0)}">
        </div>
        <div class="form-group">
          <label>Length（留空表示到结尾）</label>
          <input id="fd-length" type="number" min="-1" value="${fcfg.Length==null?'':escapeAttr(fcfg.Length)}" placeholder="空 = 到结尾">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="btn-save-fd"><i class="fas fa-save"></i> 保存</button>
        <button class="btn btn-secondary" id="btn-rename-fd"><i class="fas fa-i-cursor"></i> 重命名</button>
        <button class="btn btn-outline" id="btn-copy-fd"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-danger" id="btn-del-fd"><i class="fas fa-trash"></i> 删除字段</button>
        <button class="btn" id="btn-add-esc"><i class="fas fa-plus"></i> 添加转义</button>
        ${pasteEscapeBtn}
      </div>
      <h5 style="margin-top:12px;">Escapes</h5>
      <div id="esc-list"></div>`;

    qs('#btn-save-fd')?.addEventListener('click', () => saveField(mt, ver, fd));
    qs('#btn-rename-fd')?.addEventListener('click', () => renameField(mt, ver, fd));
    qs('#btn-copy-fd')?.addEventListener('click', () => copyField(mt, ver, fd));
    qs('#btn-del-fd')?.addEventListener('click', () => deleteConfigItem('field', mt, ver, fd));
    qs('#btn-add-esc')?.addEventListener('click', () => showAddEscapeModal(mt, ver, fd));
    qs('#btn-paste-escape')?.addEventListener('click', () => pasteEscape(mt, ver, fd));

    renderEscapesList(mt, ver, fd, fcfg.Escapes || {});
    return;
  }

  if (node.type === 'escape') {
    renderEscapeEditor(node);
    return;
  }

  // 默认
  box.innerHTML = `
    <div class="parser-layers-placeholder">
      <i class="fas fa-mouse-pointer"></i>
      <p>请从左侧选择要配置的项</p>
    </div>`;
}

function renderEscapeEditor(node) {
  const box = qs('#full-layers-container');
  if (!box) return;
  const { messageType: mt, version: ver, field: fd, escapeKey: key } = node;
  const value = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[fd]?.Escapes?.[key];
  box.innerHTML = `
    <h4><i class="fas fa-exchange-alt"></i> 转义：${escapeHtml(mt)} / ${escapeHtml(ver)} / ${escapeHtml(fd)} / ${escapeHtml(key)}</h4>
    <div class="form-group">
      <label>原始值</label>
      <input type="text" value="${escapeAttr(key)}" disabled>
    </div>
    <div class="form-group">
      <label>转义后值</label>
      <input id="escape-value-input" type="text" value="${value == null ? '' : escapeAttr(String(value))}">
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" id="btn-save-escape"><i class="fas fa-save"></i> 保存</button>
      <button class="btn btn-outline" id="btn-copy-escape"><i class="fas fa-copy"></i> 复制</button>
      <button class="btn btn-danger" id="btn-del-escape"><i class="fas fa-trash"></i> 删除</button>
    </div>`;

  qs('#btn-save-escape')?.addEventListener('click', () => saveEscapeValue(mt, ver, fd, key));
  qs('#btn-copy-escape')?.addEventListener('click', () => copyEscape(mt, ver, fd, key));
  qs('#btn-del-escape')?.addEventListener('click', () => {
    if (!confirm('确认删除此转义？')) return;
    deleteEscape(mt, ver, fd, key, { renderNode: { type: 'field', messageType: mt, version: ver, field: fd } });
  });
}

// =============== 右侧：保存/删除/重命名等 ===============
async function saveMessageTypeDesc(mt) {
  const desc = qs('#mt-desc')?.value ?? '';
  try {
    await postJSON('/api/update-message-type', {
      factory: workingFactory,
      system: workingSystem,
      old_name: mt,
      new_name: mt,
      description: desc
    });
    showMessage('success', '描述已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();

    notifyParserConfigChanged('update-desc', { mt });
  } catch (e) {
    showMessage('error', '保存失败：' + e.message, 'parser-config-messages');
  }
}

async function saveField(mt, ver, fd) {
  const start = parseInt(qs('#fd-start')?.value ?? '0', 10);
  const lenRaw = (qs('#fd-length')?.value ?? '').trim();
  const length = (lenRaw === '') ? null : parseInt(lenRaw, 10);

  const base = `${mt}.Versions.${ver}.Fields.${fd}`;
  const updates = {};
  if (!Number.isNaN(start)) updates[`${base}.Start`] = start;
  updates[`${base}.Length`] = (length === null ? null : (Number.isNaN(length) ? null : length));

  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates
    });
    showMessage('success', '字段已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: mt, version: ver, field: fd });

    notifyParserConfigChanged('update-field', { mt, ver, fd });
  } catch (e) {
    showMessage('error', '保存失败：' + e.message, 'parser-config-messages');
  }
}

async function deleteConfigItem(type, name1, name2 = '', name3 = '') {
  if (!confirm('确认删除？此操作不可恢复')) return;
  try {
    await postJSON('/api/delete-config-item', {
      factory: workingFactory,
      system: workingSystem,
      type,
      name1, name2, name3
    });
    showMessage('success', '删除成功', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();

    notifyParserConfigChanged('delete', { type, name1, name2, name3 });
    // 清空右侧
    const box = qs('#full-layers-container');
    if (box) {
      box.innerHTML = `
        <div class="parser-layers-placeholder">
          <i class="fas fa-mouse-pointer"></i>
          <p>请从左侧选择要配置的项</p>
        </div>`;
    }
  } catch (e) {
    showMessage('error', '删除失败：' + e.message, 'parser-config-messages');
  }
}

async function renameMessageType(oldName) {
  const newName = prompt('新报文类型名称：', oldName);
  if (!newName || newName === oldName) return;
  try {
    await postJSON('/api/update-message-type', {
      factory: workingFactory,
      system: workingSystem,
      old_name: oldName,
      new_name: newName,
      description: workingConfig?.[oldName]?.Description || ''
    });
    showMessage('success', '已重命名', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();

    notifyParserConfigChanged('rename-mt', { oldName, newName });
  } catch (e) {
    showMessage('error', '重命名失败：' + e.message, 'parser-config-messages');
  }
}

async function renameVersion(mt, oldVer) {
  const newVer = prompt('新版本号：', oldVer);
  if (!newVer || newVer === oldVer) return;
  // 整包保存：复制版本对象 -> 新 key；删除旧 key
  try {
    const clone = cloneConfig(workingConfig);
    if (!clone?.[mt]?.Versions?.[oldVer]) throw new Error('版本不存在');
    clone[mt].Versions[newVer] = clone[mt].Versions[oldVer];
    delete clone[mt].Versions[oldVer];

    await saveFullConfig(clone);
    showMessage('success', '已重命名', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'version', messageType: mt, version: newVer });

    notifyParserConfigChanged('rename-ver', { mt, oldVer, newVer });
  } catch (e) {
    showMessage('error', '重命名失败：' + e.message, 'parser-config-messages');
  }
}

async function renameField(mt, ver, oldField) {
  const newField = prompt('新字段名：', oldField);
  if (!newField || newField === oldField) return;
  try {
    const clone = cloneConfig(workingConfig);
    const verObj = clone?.[mt]?.Versions?.[ver];
    if (!verObj?.Fields?.[oldField]) throw new Error('字段不存在');
    verObj.Fields[newField] = verObj.Fields[oldField];
    delete verObj.Fields[oldField];

    await saveFullConfig(clone);
    showMessage('success', '已重命名', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: mt, version: ver, field: newField });

    notifyParserConfigChanged('rename-field', { mt, ver, oldField, newField });
  } catch (e) {
    showMessage('error', '重命名失败：' + e.message, 'parser-config-messages');
  }
}

// =============== Escapes 列表 & 增删 ===============
function renderEscapesList(mt, ver, fd, esc = {}) {
  const host = qs('#esc-list');
  if (!host) return;
  const keys = Object.keys(esc);
  if (!keys.length) {
    host.innerHTML = '<div style="color:#6c757d;">暂无转义</div>';
    return;
  }
  const tbl = document.createElement('table');
  tbl.innerHTML = `
    <thead><tr><th>Key</th><th>Value</th><th style="width:180px;">操作</th></tr></thead>
    <tbody>${keys.map(k=>`<tr data-k="${escapeAttr(k)}">
      <td>${escapeHtml(k)}</td><td>${escapeHtml(String(esc[k]))}</td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-outline esc-copy">复制</button>
        <button class="btn btn-sm btn-secondary esc-edit">编辑</button>
        <button class="btn btn-sm btn-danger esc-del">删除</button>
      </td>
    </tr>`).join('')}</tbody>`;
  host.innerHTML = ''; host.appendChild(tbl);

  host.querySelectorAll('.esc-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const key = e.currentTarget.closest('tr')?.dataset.k;
      if (!key) return;
      renderEditorFor({ type: 'escape', messageType: mt, version: ver, field: fd, escapeKey: key });
    });
  });

  host.querySelectorAll('.esc-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.currentTarget.closest('tr');
      const key = tr?.dataset.k;
      if (!key) return;
      if (!confirm(`删除转义 "${key}" ?`)) return;
      try {
        await deleteEscape(mt, ver, fd, key, { renderNode: { type: 'field', messageType: mt, version: ver, field: fd } });
      } catch (err) {
        showMessage('error', '删除失败：' + err.message, 'parser-config-messages');
      }
    });
  });
}

async function saveEscapeValue(mt, ver, fd, key) {
  const value = qs('#escape-value-input')?.value ?? '';
  const base = `${mt}.Versions.${ver}.Fields.${fd}.Escapes.${key}`;
  try {
    await postJSON('/api/update-parser-config', {
      factory: workingFactory,
      system: workingSystem,
      updates: { [base]: value }
    });
    showMessage('success', '转义已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'escape', messageType: mt, version: ver, field: fd, escapeKey: key });
    notifyParserConfigChanged('update-escape', { mt, ver, fd, key });
  } catch (err) {
    showMessage('error', '保存转义失败：' + err.message, 'parser-config-messages');
  }
}

async function deleteEscape(mt, ver, fd, key, opts = {}) {
  const clone = cloneConfig(workingConfig);
  const escMap = clone?.[mt]?.Versions?.[ver]?.Fields?.[fd]?.Escapes;
  if (!escMap || !Object.prototype.hasOwnProperty.call(escMap, key)) {
    throw new Error('未找到转义项');
  }
  delete escMap[key];
  await saveFullConfig(clone);
  showMessage('success', '已删除转义', 'parser-config-messages');
  await refreshFullConfig();
  await refreshTree();
  const nextNode = opts.renderNode || { type: 'field', messageType: mt, version: ver, field: fd };
  renderEditorFor(nextNode);
  notifyParserConfigChanged('delete-escape', { mt, ver, fd, key });
}

function showAddEscapeModal(mt, ver, fd) {
  const modal = qs('#add-escape-modal');
  if (!modal) {
    // 退化：弹窗输入
    const fallbackMt = prompt('所属报文类型：', mt || '')?.trim();
    const fallbackVer = prompt('所属版本：', ver || '')?.trim();
    const fallbackField = prompt('所属字段：', fd || '')?.trim();
    if (!fallbackMt || !fallbackVer || !fallbackField) {
      showMessage('error', '请完整填写转义所属层级', 'parser-config-messages');
      return;
    }
    const key = prompt('转义原值：', '');
    if (key == null || key === '') return;
    const val = prompt('转义后值：', '');
    if (val == null) return;
    submitEscapeRaw(fallbackMt, fallbackVer, fallbackField, key, val);
    return;
  }
  escapeModalDefaults.messageType = mt || escapeModalDefaults.messageType || '';
  escapeModalDefaults.version = ver || escapeModalDefaults.version || '';
  escapeModalDefaults.field = fd || escapeModalDefaults.field || '';
  rebuildEscapeModalOptions({ ...escapeModalDefaults });
  modal.style.display = 'flex';
  qs('#escape-original')?.focus();
}

function rebuildEscapeModalOptions(pref = {}) {
  const mtSel = qs('#escape-message-type');
  if (!mtSel) return;
  const mts = Object.keys(workingConfig || {});
  mtSel.innerHTML = '<option value="">-- 请选择报文类型 --</option>';
  mts.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    mtSel.appendChild(opt);
  });
  const targetMt = mts.includes(pref.messageType) ? pref.messageType : (mts[0] || '');
  setSelectValue(mtSel, targetMt);
  rebuildEscapeVersionOptions(targetMt, pref.version, pref.field);
}

function rebuildEscapeVersionOptions(mt, preferredVersion = '', preferredField = '') {
  const vSel = qs('#escape-version');
  if (!vSel) return;
  const versions = Object.keys(workingConfig?.[mt]?.Versions || {});
  vSel.innerHTML = '<option value="">-- 请选择版本 --</option>';
  versions.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    vSel.appendChild(opt);
  });
  const targetVer = versions.includes(preferredVersion) ? preferredVersion : (versions[0] || '');
  setSelectValue(vSel, targetVer);
  rebuildEscapeFieldOptions(mt, targetVer, preferredField);
}

function rebuildEscapeFieldOptions(mt, ver, preferredField = '') {
  const fSel = qs('#escape-field');
  const submitBtn = qs('#escape-submit-btn');
  if (!fSel) return;
  const fields = Object.keys(workingConfig?.[mt]?.Versions?.[ver]?.Fields || {});
  fSel.innerHTML = '<option value="">-- 请选择字段 --</option>';
  fields.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    fSel.appendChild(opt);
  });
  let targetField = preferredField;
  if (!fields.includes(targetField)) {
    targetField = fields[0] || '';
  }
  if (targetField) {
    setSelectValue(fSel, targetField);
  } else {
    fSel.value = '';
  }
  escapeModalDefaults.messageType = mt || '';
  escapeModalDefaults.version = ver || '';
  escapeModalDefaults.field = targetField || '';
  if (submitBtn) submitBtn.disabled = !targetField;
}

function handleEscapeMessageTypeChange(e) {
  const mt = e.target.value || '';
  rebuildEscapeVersionOptions(mt, '', '');
}

function handleEscapeVersionChange(e) {
  const mt = qs('#escape-message-type')?.value || '';
  rebuildEscapeFieldOptions(mt, e.target.value || '', '');
}

function handleEscapeFieldChange(e) {
  escapeModalDefaults.field = e.target.value || '';
  const submitBtn = qs('#escape-submit-btn');
  if (submitBtn) submitBtn.disabled = !escapeModalDefaults.field;
}

async function submitEscapeRaw(mt, ver, fd, key, val) {
  if (!fd) {
    showMessage('error', '请选择要添加转义的字段', 'parser-config-messages');
    return;
  }
  try {
    await postJSON('/api/add-escape', {
      factory: workingFactory, system: workingSystem,
      message_type: mt, version: ver, field: fd,
      escape_key: key, escape_value: val
    });
    showMessage('success', '转义已添加', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: mt, version: ver, field: fd });

    notifyParserConfigChanged('add-escape', { mt, ver, fd: fd, key, val });
  } catch (e) {
    showMessage('error', '添加失败：' + e.message, 'parser-config-messages');
  }
}

function submitEscapeForm() {
  const mt = qs('#escape-message-type')?.value?.trim();
  const ver= qs('#escape-version')?.value?.trim();
  const key = qs('#escape-original')?.value?.trim();
  const val = qs('#escape-target')?.value?.trim();
  const fd = qs('#escape-field')?.value?.trim();
  if (!mt || !ver || !key || !fd) {
    showMessage('error','请完整填写转义信息','parser-config-messages');
    return;
  }
  hideAddEscapeModal();
  submitEscapeRaw(mt, ver, fd, key, val);
}

function hideAddEscapeModal() {
  const m = qs('#add-escape-modal'); if (m) m.style.display = 'none';
}

// =============== “添加”模态框：报文类型/版本/字段 ===============
function showAddVersionModal(mt) {
  const modal = qs('#add-version-modal');
  if (!modal) {
    // 退化：弹窗输入
    const ver = prompt('输入新版本号：', '');
    if (!ver) return;
    submitVersionRaw(mt, ver, '');
    return;
  }
  modal.style.display = 'flex';
  const sel = qs('#version-message-type');
  if (sel) {
    sel.innerHTML = `<option value="${escapeAttr(mt)}">${escapeHtml(mt)}</option>`;
    sel.value = mt;
  }
}

function showAddFieldModal(mt, ver) {
  const modal = qs('#add-field-modal');
  if (!modal) {
    const name = prompt('字段名：','');
    if (!name) return;
    const start = parseInt(prompt('起始位置 Start（整数）','0')||'0',10);
    const lenStr = prompt('长度 Length（留空=到结尾）','') || '';
    const length = (lenStr === '' ? -1 : parseInt(lenStr,10));
    submitFieldRaw(mt, ver, name, isNaN(start)?0:start, isNaN(length)?-1:length);
    return;
  }
  modal.style.display = 'flex';
  const mtSel = qs('#field-message-type');
  const vSel  = qs('#field-version');
  if (mtSel) { mtSel.innerHTML = `<option value="${escapeAttr(mt)}">${escapeHtml(mt)}</option>`; mtSel.value = mt; }
  if (vSel)  { vSel.innerHTML  = `<option value="${escapeAttr(ver)}">${escapeHtml(ver)}</option>`; vSel.value = ver; }
}

function hideAddVersionModal() { const m=qs('#add-version-modal'); if (m) m.style.display='none'; }
function hideAddFieldModal()   { const m=qs('#add-field-modal');   if (m) m.style.display='none';  }
function showAddMessageTypeModal(){ const m=qs('#add-message-type-modal'); if (m) m.style.display='flex'; }
function hideAddMessageTypeModal(){ const m=qs('#add-message-type-modal'); if (m) m.style.display='none'; }

async function submitMessageTypeForm() {
  const name = qs('#message-type-name')?.value?.trim();
  const desc = qs('#message-type-description')?.value?.trim() || '';
  if (!name) { showMessage('error','请输入报文类型名称','parser-config-messages'); return; }
  try {
    await postJSON('/api/add-message-type', {
      factory: workingFactory, system: workingSystem,
      message_type: name, description: desc
    });
    hideAddMessageTypeModal();
    showMessage('success','报文类型已添加','parser-config-messages');
    await refreshFullConfig();
    await refreshTree();

    notifyParserConfigChanged('add-mt', { name });
  } catch (e) {
    showMessage('error','添加失败：' + e.message,'parser-config-messages');
  }
}

async function submitVersionRaw(mt, ver) {
  try {
    await postJSON('/api/add-version', {
      factory: workingFactory,
      system: workingSystem,
      msg_type: mt,
      version: ver
    });
    showMessage('success','版本已添加','parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type:'version', messageType: mt, version: ver });

    notifyParserConfigChanged('add-ver', { mt, ver });
  } catch (e) {
    showMessage('error','添加版本失败：' + e.message,'parser-config-messages');
  }
}

function submitVersionForm() {
  const mt  = qs('#version-message-type')?.value?.trim();
  const ver = qs('#version-number')?.value?.trim();
  if (!mt || !ver) {
    showMessage('error','请选择报文类型并填写版本','parser-config-messages');
    return;
  }
  hideAddVersionModal();
  submitVersionRaw(mt, ver);
}

async function submitFieldRaw(mt, ver, name, start, length) {
  try {
    await postJSON('/api/add-field', {
      factory: workingFactory, system: workingSystem,
      message_type: mt, version: ver,
      field: name, start, length
    });
    showMessage('success','字段已添加','parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type:'field', messageType: mt, version: ver, field: name });

    notifyParserConfigChanged('add-field', { mt, ver, field: name });
  } catch (e) {
    showMessage('error','添加字段失败：' + e.message,'parser-config-messages');
  }
}

function submitFieldForm() {
  const mt = qs('#field-message-type')?.value?.trim();
  const ver= qs('#field-version')?.value?.trim();
  const name = qs('#field-name')?.value?.trim();
  const start= parseInt(qs('#field-start')?.value ?? '0',10);
  const lenRaw= (qs('#field-length')?.value ?? '').trim();
  const length= lenRaw===''? -1 : parseInt(lenRaw,10);
  if (!mt || !ver || !name) { showMessage('error','请完整填写字段信息','parser-config-messages'); return; }
  hideAddFieldModal();
  submitFieldRaw(mt, ver, name, (isNaN(start)?0:start), (isNaN(length)?-1:length));
}

// =============== JSON 预览 / 撤销 / 搜索 / 导入导出 ===============
function renderJsonPreview() {
  const box = qs('#json-preview-content');
  if (!box) return;
  const pre = document.createElement('pre');
  try {
    pre.textContent = JSON.stringify(workingConfig, null, 2);
  } catch (e) {
    pre.textContent = '配置序列化失败：' + (e?.message || e);
  }
  box.innerHTML = ''; box.appendChild(pre);
}

function copyJsonPreview() {
  const pre = qs('#json-preview-content pre');
  if (!pre) return;
  navigator?.clipboard?.writeText(pre.textContent)
    .then(()=> showMessage('success', 'JSON 已复制', 'parser-config-messages'))
    .catch(err => showMessage('error', '复制失败：' + err.message, 'parser-config-messages'));
}

function pushHistory() {
  if (!workingConfig) return;
  historyStack.push(JSON.stringify(workingConfig));
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
  const histEl = qs('#history-count');
  if (histEl) histEl.textContent = `${historyStack.length}/${HISTORY_LIMIT}`;
  const undoBtn = qs('#undo-btn');
  if (undoBtn) undoBtn.removeAttribute('disabled');
}

function undoLastOperation() {
  if (!historyStack.length) return;
  const last = historyStack.pop();
  try {
    workingConfig = JSON.parse(last);
    saveFullConfig(workingConfig, { silent: true }) // 持久化到后端
      .then(async () => {
        await refreshFullConfig();
        await refreshTree();

        notifyParserConfigChanged('undo', {});
        showMessage('success', '已撤销上一步', 'parser-config-messages');
        const histEl = qs('#history-count');
        if (histEl) histEl.textContent = `${historyStack.length}/${HISTORY_LIMIT}`;
        if (!historyStack.length) qs('#undo-btn')?.setAttribute('disabled', 'disabled');
      })
      .catch(e => showMessage('error', '撤销保存失败：' + e.message, 'parser-config-messages'));
  } catch (e) {
    console.error(e);
  }
}

function searchMessageType() {
  const kw = (qs('#msg-type-search')?.value || '').trim().toLowerCase();
  const host = qs('#left-nav-tree');
  if (!host) return;
  host.querySelectorAll('.parser-item[data-type="message_type"]').forEach(el => {
    const label = el.querySelector('.label')?.textContent?.toLowerCase() || '';
    el.parentElement.style.display = (!kw || label.includes(kw)) ? '' : 'none';
  });
}

function exportConfig() {
  if (!workingFactory || !workingSystem) {
    showMessage('error', '请先进入配置工作台', 'parser-config-messages');
    return;
  }
  const url = `/api/export-parser-config?factory=${encodeURIComponent(workingFactory)}&system=${encodeURIComponent(workingSystem)}&format=json`;
  window.open(url, '_blank');
}

function importConfig() {
  if (!workingFactory || !workingSystem) {
    showMessage('error', '请先进入配置工作台', 'parser-config-messages');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.yaml,.yml';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('factory', workingFactory);
    fd.append('system', workingSystem);
    fd.append('file', file);
    try {
      const res = await fetch('/api/import-parser-config', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '导入失败');
      showMessage('success', '导入成功', 'parser-config-messages');
      await refreshFullConfig();
      await refreshTree();

      notifyParserConfigChanged('import', { factory: workingFactory, system: workingSystem });
    } catch (e) {
      showMessage('error', '导入失败：' + e.message, 'parser-config-messages');
    }
  };
  input.click();
}

// =============== 后端交互封装 ===============
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '操作失败');
  return data;
}

async function saveFullConfig(newConfig, opts = {}) {
  const data = await api.saveParserConfig({
    factory: workingFactory,
    system: workingSystem,
    config: newConfig
  });
  if (!data.success) throw new Error(data.error || '保存失败');
  workingConfig = cloneConfig(newConfig);
  if (!opts.silent) renderJsonPreview();
  return data;
}

// =============== 兼容旧 inline onclick（可选） ===============
if (typeof window !== 'undefined') {
  window.enterConfigWorkspace   = () => {
    const f = qs('#parser-factory-select')?.value || '';
    const s = qs('#parser-system-select')?.value || '';
    if (!f || !s) {
      showMessage('error', '请先选择厂区与系统', 'parser-config-messages');
      return;
    }
    enterWorkspace(f, s);
  };
  window.exitConfigWorkspace    = exitWorkspace;
  window.expandAllLayers        = expandAllLayers;
  window.collapseAllLayers      = collapseAllLayers;
  window.copyJsonPreview        = copyJsonPreview;
  window.showAddMessageTypeModal= showAddMessageTypeModal;
  window.hideAddMessageTypeModal= hideAddMessageTypeModal;
  window.showAddVersionModal    = showAddVersionModal;
  window.hideAddVersionModal    = hideAddVersionModal;
  window.showAddFieldModal      = showAddFieldModal;
  window.hideAddFieldModal      = hideAddFieldModal;
  window.showAddEscapeModal     = showAddEscapeModal;
  window.hideAddEscapeModal     = hideAddEscapeModal;
  window.submitMessageTypeForm  = submitMessageTypeForm;
  window.submitVersionForm      = submitVersionForm;
  window.submitFieldForm        = submitFieldForm;
  window.submitEscapeForm       = submitEscapeForm;
}
