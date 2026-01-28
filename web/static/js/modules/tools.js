import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';

const state = {
  initialized: false,
  widgets: [],
  activeId: null,
  activeHandle: null,
  activeCssHrefs: [],
  drawerOpen: false,
  modalOpen: false,
  fabDragging: false,
  fabPointerId: null,
  fabStartClientY: 0,
  fabStartTop: 0,
  fabMoved: false,
  modalDragging: false,
  modalPointerId: null,
  modalStartClientX: 0,
  modalStartClientY: 0,
  modalStartLeft: 0,
  modalStartTop: 0,
};

function cssEscape(value) {
  const v = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(v);
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function $(id) {
  return document.getElementById(id);
}

function clearHost() {
  const host = $('widget-modal-host');
  if (host) host.innerHTML = '';
}

function unloadActive() {
  const handle = state.activeHandle;
  state.activeHandle = null;
  state.activeId = null;
  if (handle && typeof handle.unmount === 'function') {
    try { handle.unmount(); } catch (_) { }
  }
  (state.activeCssHrefs || []).forEach((href) => {
    const node = document.querySelector(`link[data-widget-css="${cssEscape(href)}"]`);
    if (node) node.remove();
  });
  state.activeCssHrefs = [];
  clearHost();
  const list = $('widget-drawer-list');
  if (list) {
    list.querySelectorAll('[data-widget-id]').forEach((el) => el.classList.remove('active'));
  }
}

function ensureCss(cssUrls) {
  const urls = Array.isArray(cssUrls) ? cssUrls.filter(Boolean) : [];
  urls.forEach((href) => {
    if (document.querySelector(`link[data-widget-css="${cssEscape(href)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.widgetCss = href;
    document.head.appendChild(link);
  });
  state.activeCssHrefs = urls;
}

function buildWidgetCard(w) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'widget-drawer-item';
  el.style.width = '100%';
  el.dataset.widgetId = w.id;

  const title = document.createElement('div');
  title.className = 'widget-drawer-item-title';

  if (w.icon) {
    const icon = document.createElement('i');
    icon.className = w.icon;
    title.appendChild(icon);
  }

  const name = document.createElement('strong');
  name.textContent = w.name || w.id;
  title.appendChild(name);
  el.appendChild(title);

  if (w.description) {
    const desc = document.createElement('div');
    desc.className = 'widget-drawer-item-desc';
    desc.textContent = w.description;
    el.appendChild(desc);
  }

  el.addEventListener('click', () => loadWidget(w));
  return el;
}

function renderList() {
  const list = $('widget-drawer-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.widgets.length) {
    const empty = document.createElement('div');
    empty.className = 'message-empty';
    empty.textContent = '未发现可用小工具';
    list.appendChild(empty);
    return;
  }
  state.widgets.forEach((w) => list.appendChild(buildWidgetCard(w)));
}

function withVersion(url, version) {
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('v', version || String(Date.now()));
    return u.toString();
  } catch (_) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}v=${encodeURIComponent(version || String(Date.now()))}`;
  }
}

async function loadWidget(w) {
  if (!w || !w.id || !w.entryUrl) return;
  unloadActive();
  ensureCss(w.cssUrls || []);

  openModal(w);
  const host = $('widget-modal-host');
  if (!host) return;

  host.innerHTML = '';
  const container = document.createElement('div');
  container.style.minHeight = '180px';
  host.appendChild(container);

  try {
    const mod = await import(withVersion(w.entryUrl, w.version));
    const mount = mod?.mount || mod?.default?.mount;
    if (typeof mount !== 'function') {
      showMessage('error', `Widget ${w.id} 缺少 mount 导出`, 'widget-drawer-messages');
      return;
    }
    const handle = await mount({
      container,
      widget: w,
      api,
      showMessage: (type, message) => showMessage(type, message, 'widget-drawer-messages'),
    });
    state.activeId = w.id;
    state.activeHandle = handle && typeof handle === 'object' ? handle : null;
    const list = $('widget-drawer-list');
    if (list) {
      list.querySelectorAll('[data-widget-id]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-widget-id') === w.id);
      });
    }
  } catch (err) {
    const msg = err?.message || String(err);
    showMessage('error', `加载小工具失败：${msg}`, 'widget-drawer-messages');
  }
}

async function refresh() {
  try {
    const data = await api.getWidgetsManifest();
    state.widgets = Array.isArray(data?.items) ? data.items : [];
    renderList();
  } catch (err) {
    const msg = err?.message || String(err);
    showMessage('error', `获取小工具列表失败：${msg}`, 'widget-drawer-messages');
  }
}

function setDrawerOpen(open) {
  const drawer = $('widget-drawer');
  const backdrop = $('widget-drawer-backdrop');
  const fab = $('widget-fab');
  state.drawerOpen = !!open;
  if (drawer) {
    drawer.classList.toggle('open', state.drawerOpen);
    drawer.setAttribute('aria-hidden', state.drawerOpen ? 'false' : 'true');
  }
  if (backdrop) {
    backdrop.style.display = state.drawerOpen ? 'block' : 'none';
  }
  if (fab) {
    fab.setAttribute('aria-label', state.drawerOpen ? '关闭工具箱' : '打开工具箱');
    fab.classList.toggle('is-hidden', state.drawerOpen);
  }
  if (state.drawerOpen) {
    refresh();
  }
}

function isModalVisible() {
  const modal = $('widget-modal');
  if (!modal) return false;
  return modal.style.display !== 'none';
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function openModal(widget) {
  const modal = $('widget-modal');
  const backdrop = $('widget-modal-backdrop');
  const titleEl = $('widget-modal-title');
  if (!modal || !backdrop) return;

  state.modalOpen = true;
  modal.style.display = 'block';
  backdrop.style.display = 'block';
  modal.setAttribute('aria-hidden', 'false');

  if (titleEl) titleEl.textContent = widget?.name || widget?.id || '小工具';

  if (!modal.style.left && !modal.style.top) {
    const rect = modal.getBoundingClientRect();
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    modal.style.right = 'auto';
  }
}

function closeModal() {
  const modal = $('widget-modal');
  const backdrop = $('widget-modal-backdrop');
  if (!modal || !backdrop) return;

  state.modalOpen = false;
  unloadActive();
  modal.style.display = 'none';
  backdrop.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

function getFabTopDefault(fabEl) {
  const rect = fabEl.getBoundingClientRect();
  const h = rect.height || 64;
  return clamp(window.innerHeight - h - 18, 18, window.innerHeight - h - 18);
}

function applyFabTop(top) {
  const fab = $('widget-fab');
  if (!fab) return;
  const rect = fab.getBoundingClientRect();
  const h = rect.height || 64;
  const y = clamp(top, 18, window.innerHeight - h - 18);
  fab.style.top = `${y}px`;
  fab.style.bottom = 'auto';
  try { localStorage.setItem('widget_fab_top', String(y)); } catch (_) { }
}

function restoreFabPosition() {
  const fab = $('widget-fab');
  if (!fab) return;
  let top = null;
  try {
    const raw = localStorage.getItem('widget_fab_top');
    const num = raw ? Number(raw) : NaN;
    if (!Number.isNaN(num)) top = num;
  } catch (_) { }
  applyFabTop(top == null ? getFabTopDefault(fab) : top);
}

function bindFabDrag() {
  const fab = $('widget-fab');
  if (!fab) return;

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    state.fabDragging = true;
    state.fabMoved = false;
    state.fabPointerId = e.pointerId;
    state.fabStartClientY = e.clientY;
    const rect = fab.getBoundingClientRect();
    state.fabStartTop = rect.top;
    try { fab.setPointerCapture(e.pointerId); } catch (_) { }
    document.body.style.userSelect = 'none';
  });

  fab.addEventListener('pointermove', (e) => {
    if (!state.fabDragging) return;
    if (state.fabPointerId !== e.pointerId) return;
    const dy = e.clientY - state.fabStartClientY;
    if (Math.abs(dy) > 4) state.fabMoved = true;
    applyFabTop(state.fabStartTop + dy);
  });

  const end = (e) => {
    if (!state.fabDragging) return;
    if (state.fabPointerId != null && e.pointerId !== state.fabPointerId) return;
    state.fabDragging = false;
    state.fabPointerId = null;
    document.body.style.userSelect = '';
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', end);

  fab.addEventListener('click', (e) => {
    if (state.fabMoved) {
      e.preventDefault();
      e.stopPropagation();
      state.fabMoved = false;
      return;
    }
    setDrawerOpen(!state.drawerOpen);
  });
}

function bindControls() {
  const closeBtn = $('widget-drawer-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => setDrawerOpen(false));

  const refreshBtn = $('widget-drawer-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());

  const backdrop = $('widget-drawer-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => setDrawerOpen(false));

  const modalBackdrop = $('widget-modal-backdrop');
  if (modalBackdrop) modalBackdrop.addEventListener('click', () => closeModal());

  const modalCloseBtn = $('widget-modal-close-btn');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    modalCloseBtn.addEventListener('click', () => closeModal());
  }

  const modalHeader = $('widget-modal-header');
  const modal = $('widget-modal');
  if (modalHeader && modal) {
    modalHeader.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && typeof e.target.closest === 'function') {
        if (e.target.closest('button, a, input, select, textarea')) return;
      }
      state.modalDragging = true;
      state.modalPointerId = e.pointerId;
      state.modalStartClientX = e.clientX;
      state.modalStartClientY = e.clientY;
      const rect = modal.getBoundingClientRect();
      state.modalStartLeft = rect.left;
      state.modalStartTop = rect.top;
      try { modalHeader.setPointerCapture(e.pointerId); } catch (_) { }
      document.body.style.userSelect = 'none';
    });

    modalHeader.addEventListener('pointermove', (e) => {
      if (!state.modalDragging) return;
      if (state.modalPointerId !== e.pointerId) return;
      const dx = e.clientX - state.modalStartClientX;
      const dy = e.clientY - state.modalStartClientY;

      const rect = modal.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const left = clamp(state.modalStartLeft + dx, 12, window.innerWidth - w - 12);
      const top = clamp(state.modalStartTop + dy, 12, window.innerHeight - h - 12);
      modal.style.left = `${left}px`;
      modal.style.top = `${top}px`;
      modal.style.right = 'auto';
    });

    const end = (e) => {
      if (!state.modalDragging) return;
      if (state.modalPointerId != null && e.pointerId !== state.modalPointerId) return;
      state.modalDragging = false;
      state.modalPointerId = null;
      document.body.style.userSelect = '';
    };
    modalHeader.addEventListener('pointerup', end);
    modalHeader.addEventListener('pointercancel', end);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.modalOpen && isModalVisible()) {
      closeModal();
      return;
    }
    if (state.drawerOpen) setDrawerOpen(false);
  });

  window.addEventListener('resize', () => {
    const fab = $('widget-fab');
    if (!fab) return;
    const rect = fab.getBoundingClientRect();
    if (fab.style.top) applyFabTop(rect.top);

    const modal = $('widget-modal');
    if (modal && isModalVisible()) {
      const mr = modal.getBoundingClientRect();
      const left = clamp(mr.left, 12, window.innerWidth - mr.width - 12);
      const top = clamp(mr.top, 12, window.innerHeight - mr.height - 12);
      modal.style.left = `${left}px`;
      modal.style.top = `${top}px`;
      modal.style.right = 'auto';
    }
  });
}

export function initFloatingTools() {
  if (!state.initialized) {
    bindControls();
    bindFabDrag();
    restoreFabPosition();
    state.initialized = true;
  }
  const drawer = $('widget-drawer');
  if (drawer) drawer.setAttribute('aria-hidden', 'true');
}

export function deactivate() {}
