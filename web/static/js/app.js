// app.js (entry, type="module")
import * as utils from './core/utils.js';
import * as messages from './core/messages.js';
import * as ui from './core/ui.js';
import { api } from './core/api.js';

// 模块缓存
const loadedModules = new Map();

// 暴露全局方法（兼容旧 onclick）
window.showMessage = messages.showMessage;
window.checkEmptyState = messages.checkEmptyState;
window.escapeHtml = utils.escapeHtml;
window.escapeAttr = utils.escapeAttr;
window.setButtonLoading = ui.setButtonLoading;

const qs  = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

/* ---------- 模块懒加载 ---------- */
async function loadModule(tabName) {
  if (loadedModules.has(tabName)) return loadedModules.get(tabName);

  let modPromise;
  switch (tabName) {
    case 'download':
      modPromise = import('./modules/download.js');
      break;
    case 'analyze':
      modPromise = import('./modules/analyze.js').catch(() => ({
        init: () => messages.showMessage('warning', '分析模块稍后提供', 'analyze-messages')
      }));
      break;
    case 'server-config':
      modPromise = import('./modules/server-config.js').catch(() => ({
        init: () => messages.showMessage('warning', '服务器配置模块稍后提供', 'server-config-messages')
      }));
      break;
    case 'parser-config':
      modPromise = import('./modules/parser-config.js')
        .catch((err) => {
          console.error('[app] 解析配置模块加载失败', err);
          const msg = err?.message || '解析配置模块暂不可用';
          messages.showMessage('error', `解析配置模块加载失败：${msg}`, 'parser-config-messages');
          return {
            init: () => messages.showMessage('warning', '解析配置模块暂不可用', 'parser-config-messages')
          };
        });
      break;
    default:
      modPromise = Promise.resolve({ init: () => {} });
  }

  const mod = await modPromise;
  loadedModules.set(tabName, mod);
  return mod;
}

/* ---------- tab 切换 ---------- */
function activateTab(tabName) {
  qsa('.tab-content').forEach(el => el.classList.remove('active'));
  const content = qs(`#${tabName}-tab`);
  if (content) content.classList.add('active');

  qsa('.tab').forEach(el => el.classList.remove('active'));
  const activeTab = qs(`.tab[data-tab="${tabName}"]`);
  if (activeTab) activeTab.classList.add('active');
}

async function switchTab(tabName) {
  const activeEl = document.activeElement;
  if (activeEl && typeof activeEl.blur === 'function') {
    activeEl.blur();
  }
  activateTab(tabName);
  const mod = await loadModule(tabName);
  if (mod && typeof mod.init === 'function') {
    mod.init();
  }
}

// 让分析模块即便未显式打开也能收到服务器配置变更
window.addEventListener('server-configs:changed', (evt) => {
  loadModule('analyze')
    .then((mod) => {
      if (mod && typeof mod.handleServerConfigsEvent === 'function') {
        mod.handleServerConfigsEvent(evt);
      }
    })
    .catch((err) => console.warn('[app] 无法通知分析模块服务器配置变化', err));
});

window.addEventListener('logs:downloaded', async (evt) => {
  const count = evt?.detail?.count;
  try {
    await switchTab('analyze');
    const mod = await loadModule('analyze');
    if (mod && typeof mod.refreshDownloadedLogs === 'function') {
      mod.refreshDownloadedLogs({ silent: true, skipButton: true, count });
    }
  } catch (err) {
    console.error('[app] 下载后跳转分析页失败', err);
  }
});

/* ---------- 初始化 ---------- */
function initTopTabs() {
  const firstTab = qs('.tab');
  const firstContent = qs('.tab-content');
  if (firstTab && firstContent) {
    firstTab.classList.add('active');
    firstContent.classList.add('active');
  }

  qsa('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');
      switchTab(tabName);
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  messages.initMessageContainers();
  initTopTabs();

  // 默认打开第一个 tab
  const first = qs('.tab')?.getAttribute('data-tab') || 'download';
  await switchTab(first);

  const exitBtn = qs('#btn-exit-backend');

  function tryCloseTab() {
    try { window.open('', '_self'); } catch {}
    try { window.close(); } catch {}
    try { window.location.href = 'about:blank'; } catch {}
  }

  exitBtn?.addEventListener('click', async () => {
    const ok = window.confirm('确定退出后台并关闭当前页面？');
    if (!ok) return;
    try {
      ui.setButtonLoading('btn-exit-backend', true, { text: '退出中...' });
      const res = await api.exitBackend();
      ui.setButtonLoading('btn-exit-backend', false);
      if (res && res.success !== false) {
        tryCloseTab();
      } else {
        messages.showMessage('error', '退出后台失败: ' + (res?.error || ''), 'download-messages');
      }
    } catch (err) {
      ui.setButtonLoading('btn-exit-backend', false);
      messages.showMessage('error', '退出后台失败: ' + (err?.message || err), 'download-messages');
    }
  });
});
