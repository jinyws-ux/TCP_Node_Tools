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
let pendingPreviewPath = '';
const expandedTreeNodes = new Set();

const cssEscape = (value) => {
  if (typeof value !== 'string') value = String(value ?? '');
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
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

function buildNodePath(meta = {}) {
  const type = meta.type;
  const mt = meta.messageType || meta.parent || meta.msg || meta.name;
  if (!type) return '';
  if (type === 'message_type') {
    return mt ? `mt:${mt}` : '';
  }
  if (type === 'version') {
    const ver = meta.version || meta.name;
    if (!mt || !ver) return '';
    return `mt:${mt}/ver:${ver}`;
  }
  if (type === 'field') {
    const ver = meta.version || meta.ver;
    const field = meta.field || meta.name;
    if (!mt || !ver || !field) return '';
    return `mt:${mt}/ver:${ver}/field:${field}`;
  }
  if (type === 'escape') {
    const ver = meta.version || meta.ver;
    const field = meta.field || meta.fieldName;
    const key = meta.escapeKey || meta.name;
    if (!mt || !ver || !field || !key) return '';
    return `mt:${mt}/ver:${ver}/field:${field}/escape:${key}`;
  }
  return '';
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

function updatePreviewToggleUI(collapsed) {
  const btn = qs('#parser-preview-toggle');
  if (!btn) return;
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  btn.setAttribute('title', collapsed ? '点击展开实时预览' : '收起实时预览');
  const textEl = btn.querySelector('.toggle-text');
  if (textEl) {
    textEl.textContent = collapsed ? '点击展开实时预览' : '收起实时预览';
  }
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = collapsed ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
  }
}

function togglePreviewPanel() {
  const panel = qs('#parser-preview-panel');
  const layout = qs('.parser-three-column');
  if (!panel || !layout) return;
  const collapsed = panel.classList.toggle('is-collapsed');
  panel.dataset.state = collapsed ? 'collapsed' : 'expanded';
  layout.classList.toggle('preview-collapsed', collapsed);
  updatePreviewToggleUI(collapsed);
  if (collapsed) {
    const focused = qs('#json-preview-content .json-line.is-focused');
    pendingPreviewPath = focused?.dataset?.path || pendingPreviewPath || '';
    return;
  }
  const nextPath = pendingPreviewPath;
  if (!collapsed && nextPath) {
    requestAnimationFrame(() => focusPreviewPath(nextPath));
  }
}

function focusPreviewPath(path) {
  if (!path) return;
  const box = qs('#json-preview-content');
  if (!box) return;
  const selector = `[data-path="${cssEscape(path)}"]`;
  const target = box.querySelector(selector);
  if (!target) return;
  box.querySelectorAll('.json-line.is-focused').forEach((el) => el.classList.remove('is-focused'));
  target.classList.add('is-focused');
  const panel = qs('#parser-preview-panel');
  const isCollapsed = panel?.classList.contains('is-collapsed');
  if (isCollapsed) {
    pendingPreviewPath = path;
    return;
  }
  pendingPreviewPath = '';
  if (box.scrollHeight <= box.clientHeight) return;
  const desiredTop = target.offsetTop - (box.clientHeight / 2) + (target.offsetHeight / 2);
  const top = Math.max(0, desiredTop);
  box.scrollTo({ top, behavior: 'smooth' });
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
  const layout   = qs('.parser-three-column');
  const panel    = qs('#parser-preview-panel');
  pendingPreviewPath = '';
  expandedTreeNodes.clear();
  if (layout) {
    layout.classList.add('preview-collapsed');
  }
  if (panel) {
    panel.classList.add('is-collapsed');
    panel.dataset.state = 'collapsed';
  }
  updatePreviewToggleUI(true);

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
  renderJsonPreview();
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
      const nodePath = el.dataset.path || '';
      if (t === 'message_type') {
        renderEditorFor({ type: 'message_type', messageType: el.dataset.msg, path: el.dataset.path });
      } else if (t === 'version') {
        renderEditorFor({ type: 'version', messageType: el.dataset.msg, version: el.dataset.ver, path: el.dataset.path });
      } else if (t === 'field') {
        renderEditorFor({ type: 'field', messageType: el.dataset.msg, version: el.dataset.ver, field: el.dataset.field, path: el.dataset.path });
      } else if (t === 'escape') {
        renderEditorFor({ type: 'escape', messageType: el.dataset.msg, version: el.dataset.ver, field: el.dataset.field, escapeKey: el.dataset.escape, path: el.dataset.path });
      }
      if (nodePath) {
        focusPreviewPath(nodePath);
      }
    });
  });

  const validPaths = new Set(Array.from(host.querySelectorAll('.parser-item[data-path]')).map((item) => item.dataset.path));
  Array.from(expandedTreeNodes).forEach((path) => {
    if (!validPaths.has(path)) {
      expandedTreeNodes.delete(path);
    }
  });
}

function setTreeToggleState(btn, expanded) {
  if (!btn) return;
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = expanded ? 'fas fa-chevron-down' : 'fas fa-chevron-right';
  }
}

function buildTreeNode(node) {
  const wrapper = document.createElement('div');
  wrapper.className = 'parser-tree-node';

  const el = document.createElement('div');
  el.className = `parser-item parser-item-${node.type}`;
  el.dataset.type = node.type;
  const pathMeta = { type: node.type };
  if (node.type === 'message_type') {
    el.dataset.msg = node.name;
    pathMeta.messageType = node.name;
  } else if (node.type === 'version') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.name;
    pathMeta.messageType = node.parent;
    pathMeta.version = node.name;
  } else if (node.type === 'field') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.version;
    el.dataset.field = node.name;
    pathMeta.messageType = node.parent;
    pathMeta.version = node.version;
    pathMeta.field = node.name;
  } else if (node.type === 'escape') {
    el.dataset.msg = node.parent;
    el.dataset.ver = node.version;
    el.dataset.field = node.field;
    el.dataset.escape = node.name;
    pathMeta.messageType = node.parent;
    pathMeta.version = node.version;
    pathMeta.field = node.field;
    pathMeta.escapeKey = node.name;
  }

  const nodePath = node.path || buildNodePath(pathMeta);
  if (nodePath) {
    el.dataset.path = nodePath;
  }

  const hasChildren = Array.isArray(node.children) && node.children.length;
  if (hasChildren) {
    el.dataset.hasChildren = 'true';
  } else if (el.dataset.hasChildren) {
    delete el.dataset.hasChildren;
  }

  let meta = '';
  if (node.type === 'field') {
    const lenText = node.length == null ? '到结尾' : node.length;
    const startText = node.start == null ? 0 : node.start;
    const hasEscape = node.children && node.children.length ? ' · 转义' : '';
    meta = `<span class="meta">起点 ${startText} / 长度 ${lenText}${hasEscape}</span>`;
  } else if (node.type === 'escape') {
    meta = `<span class="meta">→ ${escapeHtml(String(node.value ?? ''))}</span>`;
  } else if (node.description && node.type !== 'message_type' && node.type !== 'version') {
    meta = `<span class="meta">${escapeHtml(node.description)}</span>`;
  }

  const desc = (node.description && (node.type === 'message_type' || node.type === 'version'))
    ? `<span class="desc">— ${escapeHtml(node.description)}</span>`
    : '';
  el.innerHTML = `
    <span class="label">${escapeHtml(node.name || '')}</span>
    ${desc}
    ${meta}
  `;

  let childrenWrap = null;
  if (hasChildren) {
    const shouldExpand = !!(nodePath && expandedTreeNodes.has(nodePath));
    childrenWrap = document.createElement('div');
    childrenWrap.className = 'parser-children' + (shouldExpand ? '' : ' is-collapsed');
    node.children.forEach((child) => {
      childrenWrap.appendChild(buildTreeNode(child));
    });
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tree-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');
    toggleBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    toggleBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (!childrenWrap) return;
      const collapsed = childrenWrap.classList.toggle('is-collapsed');
      setTreeToggleState(toggleBtn, !collapsed);
      if (nodePath) {
        if (collapsed) {
          expandedTreeNodes.delete(nodePath);
        } else {
          expandedTreeNodes.add(nodePath);
        }
      }
    });
    setTreeToggleState(toggleBtn, shouldExpand);
    el.prepend(toggleBtn);
  } else {
    const dot = document.createElement('span');
    dot.className = 'tree-dot';
    el.prepend(dot);
  }

  wrapper.appendChild(el);
  if (childrenWrap) {
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
  qsa('#left-nav-tree .parser-children').forEach((d) => d.classList.remove('is-collapsed'));
  qsa('#left-nav-tree .tree-toggle').forEach((btn) => setTreeToggleState(btn, true));
  const host = qs('#left-nav-tree');
  expandedTreeNodes.clear();
  host?.querySelectorAll('.parser-item[data-has-children="true"]').forEach((el) => {
    const path = el.dataset.path;
    if (path) expandedTreeNodes.add(path);
  });
}
function collapseAllLayers() {
  qsa('#left-nav-tree .parser-children').forEach((d) => d.classList.add('is-collapsed'));
  qsa('#left-nav-tree .tree-toggle').forEach((btn) => setTreeToggleState(btn, false));
  expandedTreeNodes.clear();
}

// =============== 右侧编辑区域 ===============
function renderEditorFor(node) {
  const box = qs('#full-layers-container');
  if (!box) return;
  const nodePath = node.path || buildNodePath(node);

  if (node.type === 'message_type') {
    const mt = node.messageType;
    const desc = (workingConfig?.[mt]?.Description) || '';
    const pasteTypeBtn = hasClipboard('message_type')
      ? '<button class="btn btn-outline btn-compact" id="btn-paste-mt"><i class="fas fa-paste"></i> 粘贴报文类型</button>'
      : '';
    const pasteVersionBtn = hasClipboard('version')
      ? '<button class="btn btn-outline btn-compact" id="btn-paste-version-into-mt"><i class="fas fa-paste"></i> 粘贴版本</button>'
      : '';
    box.innerHTML = `
      <div class="parser-card-actions parser-card-actions--top">
        <button class="btn btn-outline btn-compact" id="btn-copy-mt"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-compact" id="btn-add-ver"><i class="fas fa-plus"></i> 添加版本</button>
        ${pasteTypeBtn}
        ${pasteVersionBtn}
      </div>
      <p class="parser-edit-label">报文类型</p>
      <div class="form-group">
        <label>报文类型名称</label>
        <input id="mt-name" type="text" value="${escapeAttr(mt)}">
      </div>
      <div class="form-group">
        <label>描述</label>
        <input id="mt-desc" type="text" value="${escapeAttr(desc)}">
      </div>
      <div class="parser-card-actions parser-card-actions--bottom">
        <button class="btn btn-primary" id="btn-save-mt"><i class="fas fa-save"></i> 保存信息</button>
        <button class="btn btn-danger" id="btn-del-mt"><i class="fas fa-trash"></i> 删除</button>
      </div>`;
    qs('#btn-save-mt')?.addEventListener('click', () => saveMessageType(mt));
    qs('#btn-copy-mt')?.addEventListener('click', () => copyMessageType(mt));
    qs('#btn-del-mt')?.addEventListener('click', () => deleteConfigItem('message_type', mt));
    qs('#btn-add-ver')?.addEventListener('click', () => {
      addVersionInline(mt);
    });
    qs('#btn-paste-mt')?.addEventListener('click', () => pasteMessageType());
    qs('#btn-paste-version-into-mt')?.addEventListener('click', () => pasteVersion(mt));
    focusPreviewPath(nodePath);
    return;
  }

  if (node.type === 'version') {
    const { messageType: mt, version: ver } = node;
    const pasteFieldBtn = hasClipboard('field')
      ? '<button class="btn btn-outline btn-compact" id="btn-paste-field"><i class="fas fa-paste"></i> 粘贴字段</button>'
      : '';
    box.innerHTML = `
      <div class="parser-card-actions parser-card-actions--top">
        <button class="btn btn-outline btn-compact" id="btn-copy-ver"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-compact" id="btn-add-field"><i class="fas fa-plus"></i> 添加字段</button>
        ${pasteFieldBtn}
      </div>
      <p class="parser-edit-label">版本</p>
      <div class="form-group">
        <label>版本号</label>
        <input id="ver-name" type="text" value="${escapeAttr(ver)}">
      </div>
      <div class="parser-card-actions parser-card-actions--bottom">
        <button class="btn btn-primary" id="btn-save-ver"><i class="fas fa-save"></i> 保存版本</button>
        <button class="btn btn-danger" id="btn-del-ver"><i class="fas fa-trash"></i> 删除版本</button>
      </div>`;
    qs('#btn-save-ver')?.addEventListener('click', () => saveVersion(mt, ver));
    qs('#btn-copy-ver')?.addEventListener('click', () => copyVersion(mt, ver));
    qs('#btn-del-ver')?.addEventListener('click', () => deleteConfigItem('version', mt, ver));
    qs('#btn-add-field')?.addEventListener('click', () => addFieldInline(mt, ver));
    qs('#btn-paste-field')?.addEventListener('click', () => pasteField(mt, ver));
    focusPreviewPath(nodePath);
    return;
  }

  if (node.type === 'field') {
    const { messageType: mt, version: ver, field: fd } = node;
    const fcfg = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[fd] || { Start: 0, Length: null, Escapes: {} };
    const pasteEscapeBtn = hasClipboard('escape')
      ? '<button class="btn btn-outline btn-compact" id="btn-paste-escape"><i class="fas fa-paste"></i> 粘贴转义</button>'
      : '';
    box.innerHTML = `
      <div class="parser-card-actions parser-card-actions--top">
        <button class="btn btn-outline btn-compact" id="btn-copy-fd"><i class="fas fa-copy"></i> 复制</button>
        <button class="btn btn-compact" id="btn-add-esc"><i class="fas fa-plus"></i> 添加转义</button>
        ${pasteEscapeBtn}
      </div>
      <p class="parser-edit-label">字段</p>
      <div class="form-group">
        <label>字段名称</label>
        <input id="fd-name" type="text" value="${escapeAttr(fd)}">
      </div>
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
      <div class="parser-card-actions parser-card-actions--bottom">
        <button class="btn btn-primary" id="btn-save-fd"><i class="fas fa-save"></i> 保存</button>
        <button class="btn btn-danger" id="btn-del-fd"><i class="fas fa-trash"></i> 删除字段</button>
      </div>`;

    qs('#btn-save-fd')?.addEventListener('click', () => saveField(mt, ver, fd));
    qs('#btn-copy-fd')?.addEventListener('click', () => copyField(mt, ver, fd));
    qs('#btn-del-fd')?.addEventListener('click', () => deleteConfigItem('field', mt, ver, fd));
    qs('#btn-add-esc')?.addEventListener('click', () => addEscapeInline(mt, ver, fd));
    qs('#btn-paste-escape')?.addEventListener('click', () => pasteEscape(mt, ver, fd));

    focusPreviewPath(nodePath);
    return;
  }

  if (node.type === 'escape') {
    renderEscapeEditor(node);
    focusPreviewPath(nodePath);
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
      <label>转义键</label>
      <input id="escape-key-input" type="text" value="${escapeAttr(key)}">
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
async function saveMessageType(mt) {
  const name = (qs('#mt-name')?.value || '').trim() || mt;
  const desc = (qs('#mt-desc')?.value || '').trim();
  try {
    await postJSON('/api/update-message-type', {
      factory: workingFactory,
      system: workingSystem,
      old_name: mt,
      new_name: name,
      description: desc
    });
    showMessage('success', '报文类型已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'message_type', messageType: name });

    notifyParserConfigChanged(mt === name ? 'update-mt' : 'rename-mt', { oldName: mt, newName: name, mt: name });
  } catch (e) {
    showMessage('error', '保存失败：' + e.message, 'parser-config-messages');
  }
}

async function saveVersion(mt, ver) {
  const newVer = (qs('#ver-name')?.value || '').trim() || ver;
  if (newVer === ver) {
    showMessage('info', '版本名称未变化', 'parser-config-messages');
    return;
  }
  try {
    const clone = cloneConfig(workingConfig);
    if (!clone?.[mt]?.Versions?.[ver]) throw new Error('版本不存在');
    if (clone[mt].Versions[newVer]) throw new Error('版本已存在');
    clone[mt].Versions[newVer] = clone[mt].Versions[ver];
    delete clone[mt].Versions[ver];
    await saveFullConfig(clone);
    showMessage('success', '版本已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'version', messageType: mt, version: newVer });

    notifyParserConfigChanged('rename-ver', { mt, oldVer: ver, newVer, ver: newVer });
  } catch (e) {
    showMessage('error', '保存失败：' + e.message, 'parser-config-messages');
  }
}

async function saveField(mt, ver, fd) {
  const start = parseInt(qs('#fd-start')?.value ?? '0', 10);
  const lenRaw = (qs('#fd-length')?.value ?? '').trim();
  const length = (lenRaw === '') ? null : parseInt(lenRaw, 10);

  const newFieldName = (qs('#fd-name')?.value || '').trim() || fd;
  const startValue = Number.isNaN(start) ? 0 : start;
  const lengthValue = (length === null || Number.isNaN(length)) ? null : length;
  const needsRename = newFieldName !== fd;

  try {
    if (needsRename) {
      const clone = cloneConfig(workingConfig);
      const verObj = clone?.[mt]?.Versions?.[ver];
      if (!verObj?.Fields?.[fd]) throw new Error('字段不存在');
      if (verObj.Fields[newFieldName]) throw new Error('字段已存在');
      const fieldData = deepCopy(verObj.Fields[fd]);
      fieldData.Start = startValue;
      fieldData.Length = lengthValue;
      verObj.Fields[newFieldName] = fieldData;
      delete verObj.Fields[fd];
      await saveFullConfig(clone);
    } else {
      const base = `${mt}.Versions.${ver}.Fields.${fd}`;
      const updates = {};
      updates[`${base}.Start`] = startValue;
      updates[`${base}.Length`] = lengthValue;
      await postJSON('/api/update-parser-config', {
        factory: workingFactory,
        system: workingSystem,
        updates
      });
    }
    showMessage('success', '字段已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'field', messageType: mt, version: ver, field: newFieldName });

    notifyParserConfigChanged(needsRename ? 'rename-field' : 'update-field', { mt, ver, oldField: fd, field: newFieldName, fd: newFieldName });
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

async function saveEscapeValue(mt, ver, fd, key) {
  const value = qs('#escape-value-input')?.value ?? '';
  const newKey = (qs('#escape-key-input')?.value || '').trim() || key;
  const needsRename = newKey !== key;
  try {
    if (needsRename) {
      const clone = cloneConfig(workingConfig);
      const escMap = clone?.[mt]?.Versions?.[ver]?.Fields?.[fd]?.Escapes;
      if (!escMap || !Object.prototype.hasOwnProperty.call(escMap, key)) {
        throw new Error('转义不存在');
      }
      if (Object.prototype.hasOwnProperty.call(escMap, newKey)) {
        throw new Error('转义键已存在');
      }
      delete escMap[key];
      escMap[newKey] = value;
      await saveFullConfig(clone);
    } else {
      const base = `${mt}.Versions.${ver}.Fields.${fd}.Escapes.${key}`;
      await postJSON('/api/update-parser-config', {
        factory: workingFactory,
        system: workingSystem,
        updates: { [base]: value }
      });
    }
    showMessage('success', '转义已保存', 'parser-config-messages');
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'escape', messageType: mt, version: ver, field: fd, escapeKey: newKey });
    notifyParserConfigChanged(needsRename ? 'rename-escape' : 'update-escape', { mt, ver, fd, field: fd, oldKey: key, key: newKey, escapeKey: newKey });
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
  modal.style.display = 'block';
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

async function submitEscapeRaw(mt, ver, fd, key, val, opts = {}) {
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
    if (opts.focusEscape) {
      renderEditorFor({ type: 'escape', messageType: mt, version: ver, field: fd, escapeKey: key });
    } else {
      renderEditorFor({ type: 'field', messageType: mt, version: ver, field: fd });
    }

    notifyParserConfigChanged('add-escape', { mt, ver, fd: fd, field: fd, key, val });
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
  submitEscapeRaw(mt, ver, fd, key, val, { focusEscape: true });
}

function hideAddEscapeModal() {
  const m = qs('#add-escape-modal'); if (m) m.style.display = 'none';
}

function addVersionInline(mt) {
  const versions = Object.keys(workingConfig?.[mt]?.Versions || {});
  const newName = suggestName('新版本', versions);
  submitVersionRaw(mt, newName);
}

function addFieldInline(mt, ver) {
  const fields = Object.keys(workingConfig?.[mt]?.Versions?.[ver]?.Fields || {});
  const name = suggestName('新字段', fields);
  submitFieldRaw(mt, ver, name, 0, -1);
}

async function addEscapeInline(mt, ver, fd) {
  const clone = cloneConfig(workingConfig);
  const fieldRef = clone?.[mt]?.Versions?.[ver]?.Fields?.[fd];
  if (!fieldRef) {
    showMessage('error', '未找到字段，无法添加转义', 'parser-config-messages');
    return;
  }
  if (!fieldRef.Escapes) fieldRef.Escapes = {};
  const key = suggestName('新转义', Object.keys(fieldRef.Escapes));
  fieldRef.Escapes[key] = '';
  try {
    await saveFullConfig(clone, { silent: true });
    await refreshFullConfig();
    await refreshTree();
    renderEditorFor({ type: 'escape', messageType: mt, version: ver, field: fd, escapeKey: key });
    notifyParserConfigChanged('add-escape', { mt, ver, fd, field: fd, key, escapeKey: key });
    showMessage('success', '已添加新的转义占位，请完善内容', 'parser-config-messages');
  } catch (err) {
    showMessage('error', '添加转义失败：' + err.message, 'parser-config-messages');
  }
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
  modal.style.display = 'block';
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
  modal.style.display = 'block';
  const mtSel = qs('#field-message-type');
  const vSel  = qs('#field-version');
  if (mtSel) { mtSel.innerHTML = `<option value="${escapeAttr(mt)}">${escapeHtml(mt)}</option>`; mtSel.value = mt; }
  if (vSel)  { vSel.innerHTML  = `<option value="${escapeAttr(ver)}">${escapeHtml(ver)}</option>`; vSel.value = ver; }
}

function hideAddVersionModal() { const m=qs('#add-version-modal'); if (m) m.style.display='none'; }
function hideAddFieldModal()   { const m=qs('#add-field-modal');   if (m) m.style.display='none';  }
function showAddMessageTypeModal(){ const m=qs('#add-message-type-modal'); if (m) m.style.display='block'; }
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
  box.innerHTML = '';
  const config = workingConfig && Object.keys(workingConfig).length ? workingConfig : null;
  if (!config) {
    box.innerHTML = `
      <div class="parser-json-placeholder">
        <i class="fas fa-code"></i>
        <p>选择左侧配置查看结构</p>
      </div>`;
    return;
  }
  const lines = buildJsonLinesFromConfig(config);
  const pre = document.createElement('pre');
  pre.className = 'json-code';
  lines.forEach((line, idx) => {
    const span = document.createElement('span');
    span.className = 'json-line';
    span.textContent = line.text;
    if (line.path) {
      span.dataset.path = line.path;
    }
    pre.appendChild(span);
    if (idx !== lines.length - 1) {
      pre.appendChild(document.createTextNode('\n'));
    }
  });
  box.appendChild(pre);
}

function copyJsonPreview() {
  const pre = qs('#json-preview-content .json-code');
  if (!pre) return;
  navigator?.clipboard?.writeText(pre.textContent)
    .then(()=> showMessage('success', 'JSON 已复制', 'parser-config-messages'))
    .catch(err => showMessage('error', '复制失败：' + err.message, 'parser-config-messages'));
}

function formatJsonValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

function buildJsonLinesFromConfig(config) {
  const indentUnit = '  ';
  const lines = [];
  const pushLine = (text, level, path) => {
    lines.push({ text: `${indentUnit.repeat(level)}${text}`, path });
  };
  const mtKeys = Object.keys(config || {});
  if (!mtKeys.length) {
    pushLine('{}', 0);
    return lines;
  }
  pushLine('{', 0);
  mtKeys.forEach((mtKey, mtIndex) => {
    const mtObj = config[mtKey] || {};
    const versions = mtObj.Versions || {};
    const versionKeys = Object.keys(versions);
    const mtPath = buildNodePath({ type: 'message_type', messageType: mtKey });
    pushLine(`"${mtKey}": {`, 1, mtPath);
    if (mtObj.Description !== undefined && mtObj.Description !== '') {
      pushLine(`"Description": ${JSON.stringify(mtObj.Description)}${versionKeys.length ? ',' : ''}`, 2);
    }
    if (versionKeys.length) {
      pushLine('"Versions": {', 2);
      versionKeys.forEach((verKey, verIndex) => {
        const verPath = buildNodePath({ type: 'version', messageType: mtKey, version: verKey });
        const fields = versions[verKey]?.Fields || {};
        const fieldKeys = Object.keys(fields);
        pushLine(`"${verKey}": {`, 3, verPath);
        if (fieldKeys.length) {
          pushLine('"Fields": {', 4);
          fieldKeys.forEach((fdKey, fdIndex) => {
            const field = fields[fdKey] || {};
            const escapes = field.Escapes || {};
            const escapeKeys = Object.keys(escapes);
            const fieldPath = buildNodePath({ type: 'field', messageType: mtKey, version: verKey, field: fdKey });
            pushLine(`"${fdKey}": {`, 5, fieldPath);
            pushLine(`"Start": ${formatJsonValue(field.Start ?? 0)},`, 6);
            pushLine(`"Length": ${formatJsonValue(field.Length ?? null)},`, 6);
            if (escapeKeys.length) {
              pushLine('"Escapes": {', 6);
              escapeKeys.forEach((escKey, escIndex) => {
                const escPath = buildNodePath({ type: 'escape', messageType: mtKey, version: verKey, field: fdKey, escapeKey: escKey });
                const suffix = escIndex === escapeKeys.length - 1 ? '' : ',';
                pushLine(`"${escKey}": ${formatJsonValue(escapes[escKey])}${suffix}`, 7, escPath);
              });
              pushLine('}', 6);
            } else {
              pushLine('"Escapes": {}', 6);
            }
            const fieldSuffix = fdIndex === fieldKeys.length - 1 ? '' : ',';
            pushLine(`}${fieldSuffix}`, 5);
          });
          pushLine('}', 4);
        } else {
          pushLine('"Fields": {}', 4);
        }
        const verSuffix = verIndex === versionKeys.length - 1 ? '' : ',';
        pushLine(`}${verSuffix}`, 3);
      });
      pushLine('}', 2);
    } else {
      pushLine('"Versions": {}', 2);
    }
    const mtSuffix = mtIndex === mtKeys.length - 1 ? '' : ',';
    pushLine(`}${mtSuffix}`, 1);
  });
  pushLine('}', 0);
  return lines;
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

async function exportConfig() {
  if (!workingFactory || !workingSystem) {
    showMessage('error', '请先进入配置工作台', 'parser-config-messages');
    return;
  }

  const btn = qs('[data-action="export-config"]');
  setButtonLoading(btn, true, { text: '导出中...' });
  try {
    const url = `/api/export-parser-config?factory=${encodeURIComponent(workingFactory)}&system=${encodeURIComponent(workingSystem)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) {
      let errorMsg = res.statusText || '导出失败';
      try {
        const data = await res.json();
        errorMsg = data.error || errorMsg;
      } catch (_) {}
      throw new Error(errorMsg);
    }
    const blob = await res.blob();
    let filename = `config_${workingFactory}_${workingSystem}.json`;
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    if (match && match[1]) {
      filename = decodeURIComponent(match[1]);
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 0);
    showMessage('success', '配置已导出', 'parser-config-messages');
  } catch (e) {
    showMessage('error', '导出失败：' + (e?.message || e), 'parser-config-messages');
  } finally {
    setButtonLoading(btn, false);
  }
}

function showImportMode() {
  const modal = document.getElementById('import-mode-modal');
  const btnMerge = document.getElementById('import-mode-merge');
  const btnOverwrite = document.getElementById('import-mode-overwrite');
  const btnCancel = document.getElementById('import-mode-cancel');
  if (!modal || !btnMerge || !btnOverwrite || !btnCancel) return Promise.resolve(null);
  modal.style.display = 'block';
  return new Promise((resolve) => {
    function cleanup(val) {
      btnMerge.removeEventListener('click', onMerge);
      btnOverwrite.removeEventListener('click', onOverwrite);
      btnCancel.removeEventListener('click', onCancel);
      modal.style.display = 'none';
      resolve(val);
    }
    function onMerge() { cleanup('merge'); }
    function onOverwrite() { cleanup('overwrite'); }
    function onCancel() { cleanup(null); }
    btnMerge.addEventListener('click', onMerge);
    btnOverwrite.addEventListener('click', onOverwrite);
    btnCancel.addEventListener('click', onCancel);
  });
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
    const mode = await showImportMode();
    if (!mode) return;
    const fd = new FormData();
    fd.append('factory', workingFactory);
    fd.append('system', workingSystem);
    fd.append('mode', mode);
    fd.append('file', file);
    try {
      const res = await fetch('/api/import-parser-config', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '导入失败');
      showMessage('success', mode === 'merge' ? '增量导入成功' : '全覆盖导入成功', 'parser-config-messages');
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
