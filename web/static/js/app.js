// app.js (entry, type="module")
import * as utils from './core/utils.js';
import * as messages from './core/messages.js';
import * as ui from './core/ui.js';

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
      modPromise = import('./modules/parser-config.js').catch(() => ({
        init: () => messages.showMessage('warning', '解析配置模块稍后提供', 'parser-config-messages')
      }));
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
  activateTab(tabName);
  const mod = await loadModule(tabName);
  if (mod && typeof mod.init === 'function') {
    mod.init();
  }
}

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
});
