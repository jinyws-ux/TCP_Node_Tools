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

  state.configs.forEach((cfg) => {
    const item = document.createElement('div');
    item.className = 'config-item' + (state.editingId === cfg.id ? ' editing' : '');
    item.innerHTML = `
      <div class="config-info">
        <h3>${escapeHtml(cfg.factory || '')} - ${escapeHtml(cfg.system || '')}</h3>
        <p>服务器: ${escapeHtml(cfg.server?.alias || '')} (${escapeHtml(cfg.server?.hostname || '')})</p>
        <p class="config-meta">
          创建: ${escapeHtml(formatTimestamp(cfg.created_time))}${cfg.updated_time ? ` | 更新: ${escapeHtml(formatTimestamp(cfg.updated_time))}` : ''}
        </p>
      </div>
      <div class="config-actions">
        <button class="btn btn-sm btn-edit" data-act="edit" data-id="${escapeHtml(cfg.id)}">
          <i class="fas fa-edit"></i> 编辑
        </button>
        <button class="btn btn-sm btn-danger" data-act="delete" data-id="${escapeHtml(cfg.id)}">
          <i class="fas fa-trash"></i> 删除
        </button>
      </div>
    `;
    container.appendChild(item);
  });
}

async function loadServerConfigs(opts = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    state.configs = await api.getServerConfigs();
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

export function init() {
  if (state.initialized) return;
  state.initialized = true;
  bindFormEvents();
  bindListEvents();
  loadServerConfigs();
}
