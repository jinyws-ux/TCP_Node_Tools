// modules/server-config.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';

const state = {
  configs: [],
  editingId: null,
  loading: false,
  initialized: false,
  search: '',
  expandedFactories: new Set(),
};

const $ = (sel, scope = document) => scope.querySelector(sel);

function renderList() {
  const container = document.getElementById('server-configs-container');
  const empty = document.getElementById('no-server-configs-message');
  if (!container) return;

  container.innerHTML = '';
  if (!state.configs.length) {
    container.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  container.style.display = '';
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
  item.className = 'config-item config-item--compact server-config-card' + (state.editingId === cfg.id ? ' editing' : '');

  const factoryLabel = escapeHtml(cfg.factory || '未指定');
  const systemLabel = escapeHtml(cfg.system || '未指定');
  const aliasLabel = escapeHtml(cfg.server?.alias || '未命名');

  const info = document.createElement('div');
  info.className = 'config-compact-head';
  info.innerHTML = `
  <div class="config-compact-row">
    <p class="config-compact-subline">${factoryLabel} - ${systemLabel}</p>
    <div class="config-compact-alias-chip">${aliasLabel}</div>
  </div>`;
  item.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'config-compact-actions config-compact-actions--inline';
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
  const btnTest = document.createElement('button');
  btnTest.className = 'btn btn-sm btn-secondary';
  btnTest.dataset.act = 'test';
  btnTest.dataset.id = cfg.id;
  btnTest.innerHTML = '<i class="fas fa-vial"></i> 测试';
  actions.appendChild(btnEdit);
  actions.appendChild(btnDelete);
  actions.appendChild(btnTest);
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
    realtime_path: $('#server-realtime-path')?.value?.trim(),
    archive_path: $('#server-archive-path')?.value?.trim(),
  };

  if (!factory || !system || !server.alias || !server.hostname || !server.username || !server.password || !server.realtime_path || !server.archive_path) {
    throw new Error('请完整填写厂区、系统与服务器信息（含日志路径与归档路径）');
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
  $('#server-realtime-path') && ($('#server-realtime-path').value = cfg?.server?.realtime_path || '');
  $('#server-archive-path') && ($('#server-archive-path').value = cfg?.server?.archive_path || '');
}

function setEditMode(isEditing) {
  const form = document.querySelector('#server-config-tab .config-form');
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

function updatePasswordToggle(isVisible) {
  const btn = document.getElementById('toggle-password-visibility');
  if (!btn) return;
  btn.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
  btn.setAttribute('title', isVisible ? '点击隐藏密码' : '点击显示密码');
  btn.dataset.visible = isVisible ? 'true' : 'false';
}

function resetForm() {
  fillForm({ factory: '', system: '', server: {} });
  state.editingId = null;
  setEditMode(false);
  const pwdInput = $('#server-password');
  if (pwdInput) {
    pwdInput.setAttribute('type', 'password');
  }
  updatePasswordToggle(false);
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

async function handleTest(id) {
  if (!id) return;
  try {
    const btn = document.querySelector(`button[data-act="test"][data-id="${id}"]`);
    setButtonLoading(btn, true, { text: '测试中...' });
    const res = await api.testServerConfig(id);
    setButtonLoading(btn, false);

    if (!res) {
      showMessage('error', '测试接口返回为空', 'server-config-messages');
      return;
    }

    const parts = [];
    parts.push(res.connect_ok ? '连接：OK' : '连接：失败');
    parts.push(res.realtime_ok ? '实时路径：OK' : '实时路径：失败');
    parts.push(res.archive_ok ? '归档路径：OK' : '归档路径：失败');

    if (res.success) {
      showMessage('success', '测试通过。' + parts.join('，'), 'server-config-messages');
      return;
    }

    const errors = [];
    if (res.errors?.connect) errors.push('连接错误：' + res.errors.connect);
    if (res.errors?.realtime) errors.push('实时路径错误：' + res.errors.realtime);
    if (res.errors?.archive) errors.push('归档路径错误：' + res.errors.archive);
    const msg = (errors.length ? errors.join('；') + '。' : '') + parts.join('，');
    showMessage('error', msg || '测试失败', 'server-config-messages');
  } catch (e) {
    showMessage('error', '测试失败：' + (e?.message || e), 'server-config-messages');
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
    if (act === 'test') {
      handleTest(id);
    }
  });
}

function bindPasswordToggle() {
  const input = $('#server-password');
  const btn = document.getElementById('toggle-password-visibility');
  if (!input || !btn) return;
  updatePasswordToggle(false);
  btn.addEventListener('click', () => {
    const isHidden = input.getAttribute('type') === 'password';
    input.setAttribute('type', isHidden ? 'text' : 'password');
    updatePasswordToggle(isHidden);
  });
}

function bindFormEvents() {
  const saveBtn = document.getElementById('save-config-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  const genBtn = document.getElementById('gen-default-paths-btn');
  if (saveBtn) saveBtn.addEventListener('click', handleSave);
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    resetForm();
    renderList();
  });
  if (genBtn) genBtn.addEventListener('click', () => {
    const alias = $('#server-alias')?.value?.trim();
    if (!alias) {
      showMessage('error', '请先填写服务器别名', 'server-config-messages');
      return;
    }
    const realtime = `/${alias}/km/log`;
    const archive = `/nfs/${alias}/ips_log_archive/${alias}/km_log`;
    $('#server-realtime-path') && ($('#server-realtime-path').value = realtime);
    $('#server-archive-path') && ($('#server-archive-path').value = archive);
    showMessage('success', '已生成默认路径', 'server-config-messages');
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
  bindPasswordToggle();
  bindSearchBox();
  bindListEvents();
  loadServerConfigs();
}
