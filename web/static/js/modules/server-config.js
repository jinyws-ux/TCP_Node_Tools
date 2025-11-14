// modules/server-config.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';

const state = {
  configs: [],
  editingId: null,
  loading: false,
  initialized: false,
  search: '',
  expandedFactories: new Set(),
};

const $ = (sel, scope = document) => scope.querySelector(sel);

function formatTimestamp(tsSec) {
  if (!tsSec) return '';
  try {
    return new Date(tsSec * 1000).toLocaleString();
  } catch (_) {
    return '';
  }
}

function renderList() {
  const container = document.getElementById('server-configs-container');
  const empty = document.getElementById('no-server-configs-message');
  if (!container) return;

  container.innerHTML = '';
  if (!state.configs.length) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const filtered = getFilteredConfigs();
  if (!filtered.length) {
    container.innerHTML = '<div class="message-empty">未找到匹配的配置</div>';
    return;
  }

  const groups = groupByFactory(filtered);
  groups.forEach(([factoryKey, configs]) => {
    const groupEl = buildFactoryGroup(factoryKey, configs);
    container.appendChild(groupEl);
  });
}

function getFilteredConfigs() {
  if (!state.search) return [...state.configs];
  return state.configs.filter(matchesSearch);
}

function matchesSearch(cfg) {
  if (!state.search) return true;
  const term = state.search;
  const haystack = [
    cfg.factory,
    cfg.system,
    cfg.server?.alias,
    cfg.server?.hostname,
  ].map((txt) => (txt || '').toLowerCase());
  return haystack.some((txt) => txt.includes(term));
}

function groupByFactory(list) {
  const map = new Map();
  (list || []).forEach((cfg) => {
    const key = getFactoryKey(cfg);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(cfg);
  });
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
}

function buildFactoryGroup(factoryKey, configs) {
  const expanded = isFactoryExpanded(factoryKey);
  const group = document.createElement('div');
  group.className = 'server-config-group' + (expanded ? ' expanded' : '');
  group.dataset.factory = factoryKey;

  const header = document.createElement('div');
  header.className = 'server-factory-header';
  header.dataset.factoryToggle = factoryKey;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'factory-toggle';
  toggle.dataset.factoryToggle = factoryKey;
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.innerHTML = '<i class="fas fa-chevron-right"></i>';
  header.appendChild(toggle);

  const titleBox = document.createElement('div');
  titleBox.className = 'factory-title';
  const title = document.createElement('h4');
  title.textContent = factoryKey;
  const hint = document.createElement('span');
  hint.textContent = `${configs.length} 个系统`;
  titleBox.appendChild(title);
  titleBox.appendChild(hint);
  header.appendChild(titleBox);

  group.appendChild(header);

  const systems = document.createElement('div');
  systems.className = 'factory-systems';
  configs
    .slice()
    .sort((a, b) => (a.system || '').localeCompare(b.system || '', 'zh-CN'))
    .forEach((cfg) => systems.appendChild(buildConfigCard(cfg)));
  group.appendChild(systems);

  return group;
}

function buildConfigCard(cfg) {
  const item = document.createElement('div');
  item.className = 'config-item' + (state.editingId === cfg.id ? ' editing' : '');
  const info = document.createElement('div');
  info.className = 'config-info';
  const title = document.createElement('h3');
  title.textContent = `${cfg.factory || ''} - ${cfg.system || ''}`;
  info.appendChild(title);
  const serverLine = document.createElement('p');
  serverLine.textContent = `服务器: ${cfg.server?.alias || ''} (${cfg.server?.hostname || ''})`;
  info.appendChild(serverLine);
  const meta = document.createElement('p');
  meta.className = 'config-meta';
  const created = formatTimestamp(cfg.created_time);
  const updated = cfg.updated_time ? ` | 更新: ${formatTimestamp(cfg.updated_time)}` : '';
  meta.textContent = `创建: ${created}${updated}`;
  info.appendChild(meta);
  item.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'config-actions';
  const btnEdit = document.createElement('button');
  btnEdit.className = 'btn btn-sm btn-edit';
  btnEdit.dataset.act = 'edit';
  btnEdit.dataset.id = cfg.id;
  btnEdit.innerHTML = '<i class="fas fa-edit"></i> 编辑';
  const btnDelete = document.createElement('button');
  btnDelete.className = 'btn btn-sm btn-danger';
  btnDelete.dataset.act = 'delete';
  btnDelete.dataset.id = cfg.id;
  btnDelete.innerHTML = '<i class="fas fa-trash"></i> 删除';
  actions.appendChild(btnEdit);
  actions.appendChild(btnDelete);
  item.appendChild(actions);

  return item;
}

function getFactoryKey(cfg) {
  return (cfg?.factory || '').trim() || '未指定厂区';
}

function isFactoryExpanded(factoryKey) {
  if (!factoryKey) return true;
  if (state.search) return true;
  return state.expandedFactories.has(factoryKey);
}

function toggleFactorySection(factoryKey) {
  if (!factoryKey) return;
  const key = factoryKey;
  if (state.expandedFactories.has(key)) {
    state.expandedFactories.delete(key);
  } else {
    state.expandedFactories.add(key);
  }
  renderList();
}

function ensureFactoryExpanded(factoryKey) {
  if (!factoryKey) return;
  state.expandedFactories.add(factoryKey);
}

function pruneExpandedFactories() {
  const present = new Set(state.configs.map(getFactoryKey));
  const next = new Set();
  state.expandedFactories.forEach((key) => {
    if (present.has(key)) next.add(key);
  });
  state.expandedFactories = next;
}

async function loadServerConfigs(opts = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    state.configs = await api.getServerConfigs();
    pruneExpandedFactories();
    renderList();
    if (opts.flash) {
      showMessage('success', '服务器配置已刷新', 'server-config-messages');
    }
  } catch (e) {
    showMessage('error', '加载服务器配置失败：' + e.message, 'server-config-messages');
  } finally {
    state.loading = false;
  }
}

function collectFormPayload() {
  const factory = $('#factory-name')?.value?.trim();
  const system = $('#system-name')?.value?.trim();
  const server = {
    alias: $('#server-alias')?.value?.trim(),
    hostname: $('#server-hostname')?.value?.trim(),
    username: $('#server-username')?.value?.trim(),
    password: $('#server-password')?.value?.trim(),
  };

  if (!factory || !system || !server.alias || !server.hostname || !server.username || !server.password) {
    throw new Error('请完整填写厂区、系统与服务器信息');
  }
  return { factory, system, server };
}

function fillForm(cfg) {
  $('#factory-name') && ($('#factory-name').value = cfg?.factory || '');
  $('#system-name') && ($('#system-name').value = cfg?.system || '');
  $('#server-alias') && ($('#server-alias').value = cfg?.server?.alias || '');
  $('#server-hostname') && ($('#server-hostname').value = cfg?.server?.hostname || '');
  $('#server-username') && ($('#server-username').value = cfg?.server?.username || '');
  $('#server-password') && ($('#server-password').value = cfg?.server?.password || '');
}

function setEditMode(isEditing) {
  const form = document.querySelector('.config-form');
  const saveBtn = $('#save-config-btn');
  const cancelBtn = $('#cancel-edit-btn');

  if (isEditing) {
    form?.classList.add('editing');
    if (saveBtn) {
      saveBtn.classList.add('btn-update');
      saveBtn.innerHTML = '<i class="fas fa-save"></i> 更新配置';
    }
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
  } else {
    form?.classList.remove('editing');
    if (saveBtn) {
      saveBtn.classList.remove('btn-update');
      saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存配置';
    }
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

function resetForm() {
  fillForm({ factory: '', system: '', server: {} });
  state.editingId = null;
  setEditMode(false);
}

async function handleSave() {
  const btnId = 'save-config-btn';
  try {
    const payload = collectFormPayload();
    const previous = state.editingId
      ? (state.configs.find((c) => c.id === state.editingId) || null)
      : null;
    setButtonLoading(btnId, true);
    let res;
    if (state.editingId) {
      res = await api.updateServerConfig({ id: state.editingId, ...payload });
    } else {
      res = await api.saveServerConfig(payload);
    }
    setButtonLoading(btnId, false);

    if (!res.success) throw new Error(res.error || '保存失败');

    const message = state.editingId ? '配置更新成功' : '配置保存成功';
    showMessage('success', message, 'server-config-messages');
    const updatedConfig = res.config || { factory: payload.factory, system: payload.system };
    ensureFactoryExpanded(getFactoryKey(updatedConfig));
    window.dispatchEvent(new CustomEvent('server-configs:changed', {
      detail: {
        action: state.editingId ? 'update' : 'create',
        id: res.config?.id,
        config: res.config,
        previous: previous ? {
          id: previous.id,
          factory: previous.factory,
          system: previous.system,
        } : null,
      }
    }));
    resetForm();
    await loadServerConfigs();
  } catch (e) {
    setButtonLoading(btnId, false);
    showMessage('error', e.message || '保存配置失败', 'server-config-messages');
  }
}

async function handleDelete(id) {
  if (!id) return;
  if (!confirm('确定要删除此配置吗？')) return;
  const target = state.configs.find((c) => c.id === id) || null;
  try {
    const res = await api.deleteServerConfig(id);
    if (!res.success) throw new Error(res.error || '删除失败');
    showMessage('success', '配置删除成功', 'server-config-messages');
    if (target) {
      state.expandedFactories.delete(getFactoryKey(target));
    }
    window.dispatchEvent(new CustomEvent('server-configs:changed', {
      detail: {
        action: 'delete',
        id,
        previous: target ? {
          id: target.id,
          factory: target.factory,
          system: target.system,
        } : null,
      }
    }));
    if (state.editingId === id) {
      resetForm();
    }
    await loadServerConfigs();
  } catch (e) {
    showMessage('error', '删除配置失败：' + e.message, 'server-config-messages');
  }
}

function bindListEvents() {
  const container = document.getElementById('server-configs-container');
  if (!container) return;
  container.addEventListener('click', (evt) => {
    const toggle = evt.target.closest('[data-factory-toggle]');
    if (toggle) {
      toggleFactorySection(toggle.dataset.factoryToggle || toggle.dataset.factory || '');
      return;
    }
    const btn = evt.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    if (act === 'edit') {
      const cfg = state.configs.find((c) => c.id === id);
      if (!cfg) {
        showMessage('error', '未找到配置信息', 'server-config-messages');
        return;
      }
      state.editingId = id;
      ensureFactoryExpanded(getFactoryKey(cfg));
      fillForm(cfg);
      setEditMode(true);
      renderList();
      document.querySelector('.config-form-section')?.scrollIntoView({ behavior: 'smooth' });
    }
    if (act === 'delete') {
      handleDelete(id);
    }
  });
}

function bindFormEvents() {
  const saveBtn = document.getElementById('save-config-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  if (saveBtn) saveBtn.addEventListener('click', handleSave);
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    resetForm();
    renderList();
  });
}

function bindSearchBox() {
  const input = document.getElementById('server-config-search');
  const clearBtn = document.getElementById('server-config-search-clear');
  let timer = null;
  input?.addEventListener('input', (evt) => {
    const value = evt.target.value || '';
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search = value.trim().toLowerCase();
      renderList();
    }, 200);
  });
  clearBtn?.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    state.search = '';
    renderList();
  });
}

export function init() {
  if (state.initialized) return;
  state.initialized = true;
  bindFormEvents();
  bindSearchBox();
  bindListEvents();
  loadServerConfigs();
}
