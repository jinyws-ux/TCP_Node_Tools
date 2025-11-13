// modules/parser-config.js
// 注意：本模块只做“解析逻辑配置”一栏的行为，其他三大模块互不影响
import { escapeHtml, escapeAttr } from '../core/utils.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';

let inited = false;

// 轻量状态
let workingFactory = '';
let workingSystem  = '';
let workingConfig  = {};   // 全量 JSON（内存）
let workingTree    = [];   // 树结构缓存
const historyStack = [];   // 本地撤销快照
const HISTORY_LIMIT = 15;

// 工具
const qs  = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

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
  bindIfExists('#undo-btn', 'click', undoLastOperation);
  bindIfExists('#msg-type-search', 'input', searchMessageType);

  // “添加”模态框 —— 兼容你现有 HTML
  bindIfExists('#mt-submit-btn', 'click', submitMessageTypeForm);
  bindIfExists('#ver-submit-btn', 'click', submitVersionForm);
  bindIfExists('#field-submit-btn', 'click', submitFieldForm);
  bindIfExists('#escape-submit-btn', 'click', submitEscapeForm);

  // 退出按钮（若 HTML 有）
  bindIfExists('#exit-workspace-btn', 'click', exitWorkspace);

  // 首次载入：填厂区列表（沿用你已有逻辑：在 app.js/其他模块里也会拉一次，这里兜底）
  loadParserFactoriesSafe();
}

function bindIfExists(sel, evt, fn) {
  const el = qs(sel);
  if (el) el.addEventListener(evt, fn);
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
    const res = await fetch('/api/factories');
    const list = await res.json();
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
    const res = await fetch(`/api/systems?factory=${encodeURIComponent(factoryId)}`);
    const list = await res.json();
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

// =============== 刷新树/配置/统计 ===============
async function refreshTree() {
  const url = `/api/parser-config-tree?factory=${encodeURIComponent(workingFactory)}&system=${encodeURIComponent(workingSystem)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '加载树失败');
  workingTree = data.tree || [];
  renderTree(workingTree);
}

async function refreshFullConfig() {
  const url = `/api/parser-config?factory=${encodeURIComponent(workingFactory)}&system=${encodeURIComponent(workingSystem)}&format=full`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '加载配置失败');
  workingConfig = data.config || {};
  renderJsonPreview();
}

async function refreshStats() {
  try {
    await fetch(`/api/parser-config-stats?factory=${encodeURIComponent(workingFactory)}&system=${encodeURIComponent(workingSystem)}`);
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

  const ul = document.createElement('ul');
  tree.forEach(mt => {
    const liMt = document.createElement('li');
    liMt.innerHTML = `
      <div class="parser-item" data-type="message_type" data-msg="${escapeAttr(mt.name)}" data-path="${escapeAttr(mt.path)}">
        <i class="fas fa-envelope"></i>
        <span class="label">${escapeHtml(mt.name)}</span>
        ${mt.description ? `<span class="desc">— ${escapeHtml(mt.description)}</span>` : ''}
      </div>`;
    const chMt = document.createElement('div'); chMt.className = 'parser-children';

    (mt.children || []).forEach(ver => {
      const liV = document.createElement('div');
      liV.innerHTML = `
        <div class="parser-item" data-type="version" data-msg="${escapeAttr(mt.name)}" data-ver="${escapeAttr(ver.name)}" data-path="${escapeAttr(ver.path)}">
          <i class="fas fa-code-branch"></i>
          <span class="label">${escapeHtml(ver.name)}</span>
        </div>`;
      const chV = document.createElement('div'); chV.className = 'parser-children';

      (ver.children || []).forEach(f => {
        const liF = document.createElement('div');
        liF.innerHTML = `
          <div class="parser-item" data-type="field" data-msg="${escapeAttr(mt.name)}" data-ver="${escapeAttr(ver.name)}" data-field="${escapeAttr(f.name)}" data-path="${escapeAttr(f.path)}">
            <i class="fas fa-tag"></i>
            <span class="label">${escapeHtml(f.name)}</span>
            <span class="meta">[Start=${f.start}, Length=${f.length==null?-1:f.length}]</span>
            ${f.has_escapes ? '<span class="status-badge status-warning">Escapes</span>' : ''}
          </div>`;
        chV.appendChild(liF);
      });

      liV.appendChild(chV);
      chMt.appendChild(liV);
    });

    liMt.appendChild(chMt);
    ul.appendChild(liMt);
  });

  host.appendChild(ul);

  // 选择事件
  host.querySelectorAll('.parser-item').forEach(el => {
    el.addEventListener('click', () => {
      host.querySelectorAll('.parser-item.active').forEach(a => a.classList.remove('active'));
      el.classList.add('active');
      const t = el.dataset.type;
      if (t === 'message_type') {
        renderEditorFor({ type: 'message_type', messageType: el.dataset.msg, path: el.dataset.path });
      } else if (t === 'version') {
        renderEditorFor({ type: 'version', messageType: el.dataset.msg, version: el.dataset.ver, path: el.dataset.path });
      } else if (t === 'field') {
        renderEditorFor({ type: 'field', messageType: el.dataset.msg, version: el.dataset.ver, field: el.dataset.field, path: el.dataset.path });
      }
    });
  });
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
    box.innerHTML = `
      <h4><i class="fas fa-envelope"></i> 报文类型：${escapeHtml(mt)}</h4>
      <div class="form-group">
        <label>描述</label>
        <input id="mt-desc" type="text" value="${escapeAttr(desc)}">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="btn-save-mt"><i class="fas fa-save"></i> 保存描述</button>
        <button class="btn btn-secondary" id="btn-rename-mt"><i class="fas fa-i-cursor"></i> 重命名</button>
        <button class="btn btn-danger" id="btn-del-mt"><i class="fas fa-trash"></i> 删除</button>
        <button class="btn" id="btn-add-ver"><i class="fas fa-plus"></i> 添加版本</button>
      </div>`;
    qs('#btn-save-mt')?.addEventListener('click', () => saveMessageTypeDesc(mt));
    qs('#btn-rename-mt')?.addEventListener('click', () => renameMessageType(mt));
    qs('#btn-del-mt')?.addEventListener('click', () => deleteConfigItem('message_type', mt));
    qs('#btn-add-ver')?.addEventListener('click', () => {
      showAddVersionModal(mt);
    });
    return;
  }

  if (node.type === 'version') {
    const { messageType: mt, version: ver } = node;
    box.innerHTML = `
      <h4><i class="fas fa-code-branch"></i> 版本：${escapeHtml(mt)} / ${escapeHtml(ver)}</h4>
      <div class="form-actions">
        <button class="btn btn-secondary" id="btn-rename-ver"><i class="fas fa-i-cursor"></i> 重命名</button>
        <button class="btn btn-danger" id="btn-del-ver"><i class="fas fa-trash"></i> 删除版本</button>
        <button class="btn" id="btn-add-field"><i class="fas fa-plus"></i> 添加字段</button>
      </div>`;
    qs('#btn-rename-ver')?.addEventListener('click', () => renameVersion(mt, ver));
    qs('#btn-del-ver')?.addEventListener('click', () => deleteConfigItem('version', mt, ver));
    qs('#btn-add-field')?.addEventListener('click', () => showAddFieldModal(mt, ver));
    return;
  }

  if (node.type === 'field') {
    const { messageType: mt, version: ver, field: fd } = node;
    const fcfg = workingConfig?.[mt]?.Versions?.[ver]?.Fields?.[fd] || { Start: 0, Length: null, Escapes: {} };
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
        <button class="btn btn-danger" id="btn-del-fd"><i class="fas fa-trash"></i> 删除字段</button>
        <button class="btn" id="btn-add-esc"><i class="fas fa-plus"></i> 添加转义</button>
      </div>
      <h5 style="margin-top:12px;">Escapes</h5>
      <div id="esc-list"></div>`;

    qs('#btn-save-fd')?.addEventListener('click', () => saveField(mt, ver, fd));
    qs('#btn-rename-fd')?.addEventListener('click', () => renameField(mt, ver, fd));
    qs('#btn-del-fd')?.addEventListener('click', () => deleteConfigItem('field', mt, ver, fd));
    qs('#btn-add-esc')?.addEventListener('click', () => showAddEscapeModal(mt, ver, fd));

    renderEscapesList(mt, ver, fd, fcfg.Escapes || {});
    return;
  }

  // 默认
  box.innerHTML = `
    <div class="parser-layers-placeholder">
      <i class="fas fa-mouse-pointer"></i>
      <p>请从左侧选择要配置的项</p>
    </div>`;
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
    const clone = structuredClone(workingConfig);
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
    const clone = structuredClone(workingConfig);
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
    <thead><tr><th>Key</th><th>Value</th><th style="width:100px;">操作</th></tr></thead>
    <tbody>${keys.map(k=>`<tr data-k="${escapeAttr(k)}">
      <td>${escapeHtml(k)}</td><td>${escapeHtml(String(esc[k]))}</td>
      <td style="text-align:right;">
        <button class="btn btn-sm btn-danger esc-del">删除</button>
      </td>
    </tr>`).join('')}</tbody>`;
  host.innerHTML = ''; host.appendChild(tbl);

  host.querySelectorAll('.esc-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.currentTarget.closest('tr');
      const key = tr?.dataset.k;
      if (!key) return;
      if (!confirm(`删除转义 "${key}" ?`)) return;
      try {
        const clone = structuredClone(workingConfig);
        const escMap = clone?.[mt]?.Versions?.[ver]?.Fields?.[fd]?.Escapes;
        if (escMap && Object.prototype.hasOwnProperty.call(escMap, key)) {
          delete escMap[key];
        }
        await saveFullConfig(clone); // 整包保存，保证删除键
        showMessage('success', '已删除转义', 'parser-config-messages');
        await refreshFullConfig();
        await refreshTree();
        renderEditorFor({ type: 'field', messageType: mt, version: ver, field: fd });

        notifyParserConfigChanged('delete-escape', { mt, ver, fd, key });
      } catch (err) {
        showMessage('error', '删除失败：' + err.message, 'parser-config-messages');
      }
    });
  });
}

function showAddEscapeModal(mt, ver, fd) {
  const modal = qs('#add-escape-modal');
  if (!modal) {
    // 退化：弹窗输入
    const key = prompt('转义原值：', '');
    if (key == null || key === '') return;
    const val = prompt('转义后值：', '');
    if (val == null) return;
    submitEscapeRaw(mt, ver, fd, key, val);
    return;
  }
  modal.style.display = 'flex';
  const mtSel = qs('#escape-message-type'); const vSel = qs('#escape-version');
  if (mtSel) { mtSel.innerHTML = `<option value="${escapeAttr(mt)}">${escapeHtml(mt)}</option>`; mtSel.value = mt; }
  if (vSel)  { vSel.innerHTML  = `<option value="${escapeAttr(ver)}">${escapeHtml(ver)}</option>`; vSel.value = ver; }
  modal.dataset.field = fd || ''; // 如果是从字段页点开的
}

async function submitEscapeRaw(mt, ver, fd, key, val) {
  if (!fd) {
    // 如果没传 field，就选第一个字段（与旧逻辑一致）
    fd = guessFirstField(mt, ver);
    if (!fd) {
      showMessage('error', '当前版本暂无字段可添加转义', 'parser-config-messages');
      return;
    }
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
  const modal = qs('#add-escape-modal');
  const mt = qs('#escape-message-type')?.value?.trim();
  const ver= qs('#escape-version')?.value?.trim();
  const key = qs('#escape-original')?.value?.trim();
  const val = qs('#escape-target')?.value?.trim();
  let fd = modal?.dataset.field || '';
  if (!mt || !ver || !key) {
    showMessage('error','请完整填写转义信息','parser-config-messages');
    return;
  }
  if (!fd) fd = guessFirstField(mt, ver);
  hideAddEscapeModal();
  submitEscapeRaw(mt, ver, fd, key, val);
}

function guessFirstField(mt, ver) {
  const fields = workingConfig?.[mt]?.Versions?.[ver]?.Fields || {};
  const keys = Object.keys(fields);
  return keys.length ? keys[0] : '';
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
  // 验证/保存整包
  const res = await fetch('/api/save-parser-config', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      factory: workingFactory,
      system: workingSystem,
      config: newConfig
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '保存失败');
  workingConfig = structuredClone(newConfig);
  if (!opts.silent) renderJsonPreview();
  return data;
}

// =============== 兼容旧 inline onclick（可选） ===============
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
