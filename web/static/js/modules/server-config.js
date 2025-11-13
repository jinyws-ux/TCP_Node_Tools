// modules/server-config.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';
import { escapeHtml } from '../core/utils.js';

let inited = false;
let currentEditingConfigId = null;

// 小工具
const $  = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

function bind(id, ev, fn){
  const el = document.getElementById(id);
  if (!el) return console.warn('元素不存在:', id);
  el.addEventListener(ev, fn);
}

function tsToLocalString(tsSec){
  if (!tsSec) return '';
  try { return new Date(tsSec * 1000).toLocaleString(); } catch { return ''; }
}

/* ---------------- 渲染列表 ---------------- */

async function loadServerConfigs(){
  try {
    const list = await api.getServerConfigs();
    const container = $('#server-configs-container');
    const empty = $('#no-server-configs-message');
    if (!container) return;

    container.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.forEach(cfg => {
      const item = document.createElement('div');
      item.className = 'config-item' + (currentEditingConfigId === cfg.id ? ' editing' : '');
      item.innerHTML = `
        <div class="config-info">
          <h3>${escapeHtml(cfg.factory || '')} - ${escapeHtml(cfg.system || '')}</h3>
          <p>服务器: ${escapeHtml(cfg.server?.alias || '')} (${escapeHtml(cfg.server?.hostname || '')})</p>
          <p class="config-meta">
            创建: ${escapeHtml(tsToLocalString(cfg.created_time))}${
              cfg.updated_time ? ` | 更新: ${escapeHtml(tsToLocalString(cfg.updated_time))}` : ''
            }
          </p>
        </div>
        <div class="config-actions">
          <button class="btn btn-sm btn-edit" data-act="edit" data-id="${escapeHtml(cfg.id)}">
            <i class="fas fa-edit"></i> 编辑
          </button>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${escapeHtml(cfg.id)}">
            <i class="fas fa-trash"></i> 删除
          </button>
        </div>
      `;
      container.appendChild(item);
    });

    // 事件委托
    container.addEventListener('click', onListAction, { once: true });
  } catch (e) {
    showMessage('error', '加载服务器配置失败: ' + e.message, 'server-config-messages');
  }
}

function onListAction(e){
  const btn = e.target.closest('button[data-act]');
  if (!btn) {
    // 继续监听后续点击
    e.currentTarget.addEventListener('click', onListAction, { once: true });
    return;
  }
  const act = btn.getAttribute('data-act');
  const id  = btn.getAttribute('data-id');
  if (act === 'edit') editServerConfig(id);
  if (act === 'del')  deleteServerConfig(id);
  // 保持委托（单次绑定，触发后重绑）
  e.currentTarget.addEventListener('click', onListAction, { once: true });
}

/* ---------------- 表单编辑 ---------------- */

async function editServerConfig(configId){
  try {
    const list = await api.getServerConfigs();
    const cfg = (list || []).find(c => c.id === configId);
    if (!cfg) {
      showMessage('error', '未找到配置信息', 'server-config-messages');
      return;
    }

    currentEditingConfigId = configId;
    setEditMode(true);

    $('#factory-name').value       = cfg.factory || '';
    $('#system-name').value        = cfg.system || '';
    $('#server-alias').value       = cfg.server?.alias || '';
    $('#server-hostname').value    = cfg.server?.hostname || '';
    $('#server-username').value    = cfg.server?.username || '';
    $('#server-password').value    = cfg.server?.password || '';

    // 高亮当前编辑项
    await loadServerConfigs();

    // 滚动到表单
    document.querySelector('.config-form-section')?.scrollIntoView({ behavior: 'smooth' });

    showMessage('info', `正在编辑配置: ${cfg.factory} - ${cfg.system}`, 'server-config-messages');
  } catch (e) {
    showMessage('error', '获取配置详情失败: ' + e.message, 'server-config-messages');
  }
}

async function deleteServerConfig(configId){
  if (!confirm('确定要删除此配置吗？')) return;
  try {
    const res = await api.deleteServerConfig(configId);
    if (res.success) {
      showMessage('success', '配置删除成功', 'server-config-messages');
      if (currentEditingConfigId === configId) {
        resetServerConfigForm();
      }
      await loadServerConfigs();

        window.dispatchEvent(new CustomEvent('server-configs:changed', {
          detail: { action: 'delete', id: configId }
        }));

        window.dispatchEvent(new CustomEvent('server-configs:changed', {
          detail: {
            action: currentEditingConfigId ? 'update' : 'create',
            id: currentEditingConfigId || ''
          }
        }));
    } else {
      showMessage('error', '删除失败: ' + (res.error || ''), 'server-config-messages');
    }
  } catch (e) {
    showMessage('error', '删除配置失败: ' + e.message, 'server-config-messages');
  }
}

async function saveServerConfig(){
  const payload = {
    factory: $('#factory-name')?.value?.trim(),
    system:  $('#system-name')?.value?.trim(),
    server: {
      alias:    $('#server-alias')?.value?.trim(),
      hostname: $('#server-hostname')?.value?.trim(),
      username: $('#server-username')?.value?.trim(),
      password: $('#server-password')?.value?.trim(),
    }
  };

  if (!payload.factory || !payload.system || !payload.server.alias || !payload.server.hostname ||
      !payload.server.username || !payload.server.password) {
    showMessage('error', '请填写所有字段', 'server-config-messages');
    return;
  }

  const btnId = 'save-config-btn';
  setButtonLoading(btnId, true);

  try {
    let res;
    if (currentEditingConfigId) {
      res = await api.updateServerConfig({ id: currentEditingConfigId, ...payload });
    } else {
      res = await api.saveServerConfig(payload);
    }

    setButtonLoading(btnId, false);

    if (res.success) {
      showMessage('success', currentEditingConfigId ? '配置更新成功' : '配置保存成功', 'server-config-messages');
      resetServerConfigForm();
      await loadServerConfigs();
    } else {
      showMessage('error', '保存失败: ' + (res.error || ''), 'server-config-messages');
    }
  } catch (e) {
    setButtonLoading(btnId, false);
    showMessage('error', '保存配置失败: ' + e.message, 'server-config-messages');
  }
}

function cancelServerEdit(){
  resetServerConfigForm();
}

function resetServerConfigForm(){
  $('#factory-name') && ($('#factory-name').value = '');
  $('#system-name') && ($('#system-name').value = '');
  $('#server-alias') && ($('#server-alias').value = '');
  $('#server-hostname') && ($('#server-hostname').value = '');
  $('#server-username') && ($('#server-username').value = '');
  $('#server-password') && ($('#server-password').value = '');

  currentEditingConfigId = null;
  setEditMode(false);
  $('#factory-name')?.focus();
}

function setEditMode(isEditing){
  const form = document.querySelector('.config-form');
  const save = $('#save-config-btn');
  const cancel = $('#cancel-edit-btn');

  if (isEditing) {
    form?.classList.add('editing');
    if (save) { save.classList.add('btn-update'); save.innerHTML = '<i class="fas fa-save"></i> 更新配置'; }
    if (cancel) cancel.style.display = 'inline-block';
  } else {
    form?.classList.remove('editing');
    if (save) { save.classList.remove('btn-update'); save.innerHTML = '<i class="fas fa-save"></i> 保存配置'; }
    if (cancel) cancel.style.display = 'none';
  }
}

/* ---------------- 模块入口 ---------------- */

export function init(){
  if (inited) return;
  inited = true;

  // 绑定表单按钮
  bind('save-config-btn', 'click', saveServerConfig);
  bind('cancel-edit-btn', 'click', cancelServerEdit);

  // 首次加载列表
  loadServerConfigs();
}
