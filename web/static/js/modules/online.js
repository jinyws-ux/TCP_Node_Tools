import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';

let inited = false;

const qs = (sel, scope = document) => scope.querySelector(sel);

const state = {
  configs: [],
  factories: [],
  systems: [],
  selected: { factory: '', system: '' },
  selectedConfig: null,
  categories: [],
  objects: [],
  nav: {
    mode: 'categories',
    filter: '',
  },
  active: {
    category: '',
    object: '',
    timer: null,
    cursor: 0,
    sizeInBytes: 0,
    bufferLines: [],
    lastTextKey: '',
    running: false,
    byteOverlap: 4096,
    parsedItems: [],
    parsedLastKey: '',
  },
};

function msg(type, text) {
  showMessage(type, text, 'online-messages');
}

export function init() {
  const tab = qs('#online-tab');
  if (!tab || inited) return;
  inited = true;

  bindEvents();
  bootstrap().catch((err) => {
    console.error('[online] init failed', err);
    msg('error', '在线日志初始化失败：' + (err?.message || err));
  });
}

function bindEvents() {
  qs('#enter-online-workspace-btn')?.addEventListener('click', () => {
    enterWorkspace().catch((err) => {
      console.error('[online] enter workspace failed', err);
      msg('error', '进入工作台失败：' + (err?.message || err));
    });
  });

  qs('#toggle-online-controls-btn')?.addEventListener('click', () => {
    const ws = qs('#online-workspace');
    if (!ws) return;
    const next = !ws.classList.contains('online-controls-collapsed');
    ws.classList.toggle('online-controls-collapsed', next);
    const btn = qs('#toggle-online-controls-btn');
    if (btn) {
      btn.innerHTML = next
        ? `<i class="fas fa-sliders-h"></i> 展开设置`
        : `<i class="fas fa-sliders-h"></i> 收起设置`;
    }
  });

  qs('#toggle-online-left-nav-btn')?.addEventListener('click', () => {
    const ws = qs('#online-workspace');
    if (!ws) return;
    const next = !ws.classList.contains('online-left-collapsed');
    ws.classList.toggle('online-left-collapsed', next);
    const btn = qs('#toggle-online-left-nav-btn');
    if (btn) {
      btn.innerHTML = next
        ? `<i class="fas fa-columns"></i> 展开左栏`
        : `<i class="fas fa-columns"></i> 折叠左栏`;
    }
  });

  qs('#toggle-online-fullscreen-btn')?.addEventListener('click', () => {
    const ws = qs('#online-workspace');
    if (!ws) return;
    const next = !ws.classList.contains('online-log-fullscreen');
    ws.classList.toggle('online-log-fullscreen', next);
    const btn = qs('#toggle-online-fullscreen-btn');
    if (btn) {
      btn.innerHTML = next
        ? `<i class="fas fa-compress"></i> 退出全屏`
        : `<i class="fas fa-expand"></i> 全屏`;
    }
  });

  qs('#exit-online-workspace-btn')?.addEventListener('click', () => {
    exitWorkspace();
  });

  qs('#btn-online-refresh')?.addEventListener('click', () => {
    refreshAll().catch((err) => {
      console.error('[online] refresh failed', err);
      msg('error', '刷新失败：' + (err?.message || err));
    });
  });

  qs('#btn-online-open')?.addEventListener('click', () => {
    startAutoRefresh().catch((err) => {
      console.error('[online] start failed', err);
      msg('error', '打开查看失败：' + (err?.message || err));
    });
  });

  qs('#btn-online-analyze-current')?.addEventListener('click', () => {
    analyzeCurrentLogs().catch((err) => {
      console.error('[online] analyze current failed', err);
      msg('error', '分析当前日志失败：' + (err?.message || err));
    });
  });

  qs('#btn-online-stop')?.addEventListener('click', stopAutoRefresh);

  qs('#online-lines-select')?.addEventListener('change', () => {
    if (state.active.running) {
      startAutoRefresh().catch((err) => {
        console.error('[online] restart failed', err);
        msg('error', '重新打开查看失败：' + (err?.message || err));
      });
    } else {
      renderFromBuffer();
    }
  });

  qs('#online-order-select')?.addEventListener('change', renderFromBuffer);
  qs('#online-filter-input')?.addEventListener('input', renderFromBuffer);
  qs('#online-view-select')?.addEventListener('change', () => {
    const v = (qs('#online-view-select')?.value || 'raw').toLowerCase();
    if (v === 'parsed') {
      startAutoRefresh({ forceRestart: true }).catch((err) => {
        console.error('[online] switch to parsed failed', err);
        msg('error', '切换解析视图失败：' + (err?.message || err));
      });
      return;
    }
    renderFromBuffer();
  });

  qs('#online-nav-search')?.addEventListener('input', () => {
    state.nav.filter = (qs('#online-nav-search')?.value || '').trim().toLowerCase();
    renderNavList();
  });
}

async function analyzeCurrentLogs() {
  const cfg = state.selectedConfig || resolveSelectedConfig();
  if (!cfg) throw new Error('请先选择厂区与系统并进入工作台');
  if (!state.active.category) throw new Error('请先选择分类');
  if (!state.active.object) throw new Error('请先选择对象');
  const raw = Array.isArray(state.active.bufferLines) ? state.active.bufferLines : [];
  if (!raw.length) throw new Error('请先打开查看并加载日志内容');

  const maxLines = 6000;
  const lines = raw.length > maxLines ? raw.slice(raw.length - maxLines) : raw.slice();

  setButtonLoading('btn-online-analyze-current', true, { text: '分析中...' });
  try {
    const res = await api.analyzeOnlineCurrent({
      factory: state.selected.factory,
      system: state.selected.system,
      serverAlias: cfg?.server?.alias || '',
      category: state.active.category,
      objectName: state.active.object,
      lines,
    });
    if (!res || res.success === false) {
      throw new Error(res?.error || '分析失败');
    }
    const reportId = res?.report_id || '';
    if (!reportId) {
      throw new Error('分析已完成，但未返回报告ID');
    }
    window.open(`${window.location.origin}/report/${encodeURIComponent(reportId)}`, '_blank');
    msg('success', '已生成分析报告，已在新标签页打开');
  } finally {
    setButtonLoading('btn-online-analyze-current', false);
  }
}

async function bootstrap() {
  await loadServerConfigs();
  await loadFactories();
  initFactorySystemSelectors();
  showSelection();
}

async function loadServerConfigs() {
  state.configs = await api.getServerConfigs();
}

async function loadFactories() {
  try {
    const list = await api.getFactories();
    state.factories = Array.isArray(list) ? list : [];
  } catch (err) {
    state.factories = [];
  }

  if (!state.factories.length && Array.isArray(state.configs) && state.configs.length) {
    const uniq = new Map();
    for (const cfg of state.configs) {
      const f = (cfg?.factory || '').trim();
      if (!f) continue;
      if (!uniq.has(f)) uniq.set(f, { id: f, name: f });
    }
    state.factories = Array.from(uniq.values());
  }
}

async function loadSystems(factoryId) {
  try {
    const list = await api.getSystems(factoryId || '');
    state.systems = Array.isArray(list) ? list : [];
  } catch (err) {
    state.systems = [];
  }

  if (!state.systems.length && Array.isArray(state.configs) && state.configs.length) {
    const uniq = new Map();
    for (const cfg of state.configs) {
      const f = (cfg?.factory || '').trim();
      if (f !== (factoryId || '').trim()) continue;
      const s = (cfg?.system || '').trim();
      if (!s) continue;
      if (!uniq.has(s)) uniq.set(s, { id: s, name: s });
    }
    state.systems = Array.from(uniq.values());
  }
}

function initFactorySystemSelectors() {
  const factorySel = qs('#online-factory-select');
  const systemSel = qs('#online-system-select');

  if (factorySel) {
    factorySel.innerHTML = `<option value="">请选择厂区</option>` +
      state.factories
        .map((f) => `<option value="${escapeHtmlAttr(f.id)}">${escapeHtmlText(f.name || f.id)}</option>`)
        .join('');
  }

  const renderSystems = () => {
    if (!systemSel) return;
    systemSel.innerHTML = `<option value="">请选择系统</option>` +
      state.systems
        .map((s) => `<option value="${escapeHtmlAttr(s.id)}">${escapeHtmlText(s.name || s.id)}</option>`)
        .join('');
  };

  factorySel?.addEventListener('change', async () => {
    state.selected.factory = factorySel.value || '';
    state.selected.system = '';
    state.selectedConfig = null;
    state.systems = [];
    renderSystems();
    resetRemoteSelection();
    if (state.selected.factory) {
      try {
        await loadSystems(state.selected.factory);
        renderSystems();
      } catch (err) {
        console.error('[online] loadSystems failed', err);
        msg('error', '加载系统失败：' + (err?.message || err));
      }
    }
  });

  systemSel?.addEventListener('change', () => {
    state.selected.system = systemSel.value || '';
    state.selectedConfig = resolveSelectedConfig();
    resetRemoteSelection();
    if (state.selected.factory && state.selected.system && !state.selectedConfig) {
      msg('warning', '未找到匹配的服务器配置（请检查服务器配置页是否存在对应厂区/系统）');
    }
  });

  renderSystems();

  if (factorySel && state.factories.length === 1) {
    factorySel.value = state.factories[0]?.id || '';
    factorySel.dispatchEvent(new Event('change'));
  }
}

function resolveSelectedConfig() {
  const f = state.selected.factory;
  const s = state.selected.system;
  if (!f || !s) return null;
  return state.configs.find((c) => c.factory === f && c.system === s) || null;
}

function showSelection() {
  const sel = qs('#online-selection');
  const ws = qs('#online-workspace');
  if (sel) sel.style.display = '';
  if (ws) ws.style.display = 'none';
  msg('info', '请选择厂区与系统后进入在线工作台');
}

function showWorkspace() {
  const sel = qs('#online-selection');
  const ws = qs('#online-workspace');
  if (sel) sel.style.display = 'none';
  if (ws) ws.style.display = '';
}

async function enterWorkspace() {
  state.selectedConfig = resolveSelectedConfig();
  if (!state.selectedConfig) throw new Error('请先选择厂区与系统');
  const f = state.selected.factory || '';
  const s = state.selected.system || '';
  const fEl = qs('#online-current-factory');
  const sEl = qs('#online-current-system');
  if (fEl) fEl.textContent = f || '未知厂区';
  if (sEl) sEl.textContent = s || '未知系统';
  showWorkspace();
  await loadCategoriesForNav();
}

function exitWorkspace() {
  stopAutoRefresh();
  resetRemoteSelection();
  state.nav.mode = 'categories';
  state.nav.filter = '';
  const inp = qs('#online-nav-search');
  if (inp) inp.value = '';
  const list = qs('#online-nav-list');
  if (list) list.innerHTML = '';
  const ws = qs('#online-workspace');
  if (ws) ws.classList.remove('online-controls-collapsed', 'online-left-collapsed', 'online-log-fullscreen');
  const btn = qs('#toggle-online-controls-btn');
  if (btn) btn.innerHTML = `<i class="fas fa-sliders-h"></i> 收起设置`;
  const leftBtn = qs('#toggle-online-left-nav-btn');
  if (leftBtn) leftBtn.innerHTML = `<i class="fas fa-columns"></i> 折叠左栏`;
  const fsBtn = qs('#toggle-online-fullscreen-btn');
  if (fsBtn) fsBtn.innerHTML = `<i class="fas fa-expand"></i> 全屏`;
  showSelection();
}

function resetRemoteSelection() {
  stopAutoRefresh();
  state.categories = [];
  state.objects = [];
  state.active.category = '';
  state.active.object = '';
  state.active.cursor = 0;
  state.active.sizeInBytes = 0;
  state.active.bufferLines = [];
  state.active.parsedItems = [];
  state.active.parsedLastKey = '';
  state.active.lastTextKey = '';
  state.nav.mode = 'categories';
  renderMeta(null);
  renderLines([]);
  renderNavList();
}

async function refreshAll() {
  if (!state.selectedConfig) {
    state.selectedConfig = resolveSelectedConfig();
  }
  if (!state.selectedConfig) throw new Error('请先选择厂区与系统');

  if (state.nav.mode === 'categories') {
    await loadCategoriesForNav();
    return;
  }

  if (state.nav.mode === 'objects') {
    if (!state.active.category) {
      await loadCategoriesForNav();
      return;
    }
    await loadObjectsForNav(state.active.category);
    if (state.active.object) {
      await loadMeta();
      await fetchAndRender();
    }
  }
}

async function loadCategoriesForNav() {
  const cfg = state.selectedConfig || resolveSelectedConfig();
  if (!cfg) throw new Error('请先选择厂区与系统');
  state.selectedConfig = cfg;

  const categories = await api.getOnlineCategories({ serverAlias: cfg?.server?.alias || '', system: state.selected.system });
  state.categories = Array.isArray(categories) ? categories : [];
  state.nav.mode = 'categories';
  state.active.category = '';
  state.active.object = '';
  renderMeta(null);
  renderLines([]);
  renderNavList();
}

async function loadObjectsForNav(categoryName) {
  const cfg = state.selectedConfig || resolveSelectedConfig();
  if (!cfg) throw new Error('请先选择厂区与系统');
  const cat = (categoryName || '').trim();
  if (!cat) return;
  const objects = await api.getOnlineObjects({
    serverAlias: cfg?.server?.alias || '',
    system: state.selected.system,
    category: cat
  });
  state.objects = Array.isArray(objects) ? objects : [];
  state.nav.mode = 'objects';
  renderNavList();
}

async function loadMeta() {
  const cfg = resolveSelectedConfig();
  if (!cfg) throw new Error('请先选择厂区与系统');
  if (!state.active.category || !state.active.object) return;
  const meta = await api.getOnlineMetadata({
    serverAlias: cfg?.server?.alias || '',
    system: state.selected.system,
    category: state.active.category,
    objectName: state.active.object
  });
  renderMeta(meta);
}

function renderNavList() {
  const list = qs('#online-nav-list');
  if (!list) return;
  const filter = state.nav.filter || '';
  const frag = document.createDocumentFragment();

  const mkCard = ({ title, subtitle, kind, active = false, isBack = false, onClick }) => {
    const el = document.createElement('div');
    el.className = `online-card${isBack ? ' online-card--back' : ''}${active ? ' online-card--active' : ''}`;
    el.dataset.kind = kind;
    const t = document.createElement('div');
    t.className = 'online-card-title';
    t.textContent = title;
    const sub = document.createElement('div');
    sub.className = 'online-card-subtitle';
    sub.textContent = subtitle || '';
    el.appendChild(t);
    if (subtitle) el.appendChild(sub);
    el.addEventListener('click', onClick);
    return el;
  };

  const matches = (txt) => {
    if (!filter) return true;
    return String(txt || '').toLowerCase().includes(filter);
  };

  if (state.nav.mode === 'objects') {
    frag.appendChild(mkCard({
      title: '返回分类',
      subtitle: '回到分类列表',
      kind: 'back',
      isBack: true,
      onClick: async () => {
        stopAutoRefresh();
        state.active.object = '';
        state.objects = [];
        state.nav.mode = 'categories';
        renderMeta(null);
        renderLines([]);
        renderNavList();
      }
    }));

    const catTitle = state.active.category ? `当前分类：${state.active.category}` : '未选择分类';
    frag.appendChild(mkCard({
      title: catTitle,
      subtitle: '点击对象卡片后可在右侧打开查看',
      kind: 'hint',
      isBack: true,
      onClick: () => { }
    }));

    (state.objects || []).forEach((o) => {
      const name = o?.name || '';
      const info = (o?.info || '').trim();
      const label = info ? `${name} ${info}` : name;
      if (!matches(label)) return;
      frag.appendChild(mkCard({
        title: name,
        subtitle: info || '',
        kind: 'object',
        active: name === state.active.object,
        onClick: async () => {
          stopAutoRefresh();
          state.active.object = name;
          state.active.cursor = 0;
          state.active.sizeInBytes = 0;
          state.active.bufferLines = [];
          state.active.parsedItems = [];
          state.active.parsedLastKey = '';
          state.active.lastTextKey = '';
          renderMeta(null);
          renderLines([]);
          try {
            await loadMeta();
          } catch (err) {
            msg('error', '加载元信息失败：' + (err?.message || err));
          }
          renderNavList();
        }
      }));
    });
  } else {
    (state.categories || []).forEach((c) => {
      const name = c?.name || '';
      const path = c?.path || '';
      const label = `${name} ${path}`;
      if (!matches(label)) return;
      frag.appendChild(mkCard({
        title: name,
        subtitle: path ? `路径：${path}` : '',
        kind: 'category',
        onClick: async () => {
          stopAutoRefresh();
          state.active.category = name;
          state.active.object = '';
          state.active.cursor = 0;
          state.active.sizeInBytes = 0;
          state.active.bufferLines = [];
          state.active.parsedItems = [];
          state.active.parsedLastKey = '';
          state.active.lastTextKey = '';
          renderMeta(null);
          renderLines([]);
          try {
            await loadObjectsForNav(name);
          } catch (err) {
            msg('error', '加载对象失败：' + (err?.message || err));
          }
        }
      }));
    });
  }

  list.innerHTML = '';
  list.appendChild(frag);
}

function renderMeta(meta) {
  const el = qs('#online-meta');
  if (!el) return;
  if (!meta) {
    el.style.display = 'none';
    el.textContent = '';
    state.active.sizeInBytes = 0;
    return;
  }
  const files = Array.isArray(meta.files) ? meta.files.join(', ') : '';
  const size = meta.size_in_bytes ?? meta.size ?? '';
  const ts = meta.modification_timestamp ?? meta.mtime ?? '';
  el.style.display = '';
  el.textContent = `文件：${files || '-'} | 大小：${size || '-'} | 更新时间：${ts || '-'}`;
  const sizeNum = Number(size);
  state.active.sizeInBytes = Number.isFinite(sizeNum) ? sizeNum : 0;
}

function stopAutoRefresh() {
  if (state.active.timer) {
    clearTimeout(state.active.timer);
    state.active.timer = null;
  }
  if (state.active.running) {
    state.active.running = false;
    msg('info', '已暂停在线查看');
  }
}

async function startAutoRefresh({ forceRestart = false } = {}) {
  const cfg = resolveSelectedConfig();
  if (!cfg) throw new Error('请先选择厂区与系统');
  if (!state.active.category) throw new Error('请先选择分类');
  if (!state.active.object) throw new Error('请先选择对象');

  if (state.active.timer) {
    clearTimeout(state.active.timer);
    state.active.timer = null;
  }

  await loadMeta();
  const linesLimit = parseInt(qs('#online-lines-select')?.value || '1000', 10) || 1000;
  const windowBytes = pickWindowBytes(linesLimit);
  const size = state.active.sizeInBytes || 0;
  state.active.cursor = Math.max(0, size - windowBytes);
  state.active.bufferLines = [];
  state.active.parsedItems = [];
  state.active.parsedLastKey = '';
  state.active.lastTextKey = '';
  await fetchAndRender({ forceTail: true, resetParser: true });
  const enabled = !!qs('#online-auto-refresh')?.checked;
  state.active.running = enabled;
  if (enabled) {
    scheduleNext(0);
  } else {
    msg('info', '已加载最新日志（未开启自动刷新）');
  }
}

function scheduleNext(delay) {
  if (state.active.timer) clearTimeout(state.active.timer);
  state.active.timer = setTimeout(async () => {
    const enabled = !!qs('#online-auto-refresh')?.checked;
    if (!enabled) {
      state.active.timer = null;
      state.active.running = false;
      return;
    }

    try {
      await fetchAndRender();
    } catch (err) {
      console.error('[online] refresh tick failed', err);
      msg('error', '刷新失败：' + (err?.message || err));
    }

    const interval = parseInt(qs('#online-interval-select')?.value || '1000', 10) || 1000;
    scheduleNext(interval);
  }, Math.max(0, delay || 0));
}

function renderFromBuffer() {
  const view = (qs('#online-view-select')?.value || 'raw').toLowerCase();
  const linesLimit = parseInt(qs('#online-lines-select')?.value || '1000', 10) || 1000;
  const order = (qs('#online-order-select')?.value || 'desc').toLowerCase();
  const keyword = (qs('#online-filter-input')?.value || '').trim();
  if (view === 'parsed') {
    const sliced = sliceParsed(state.active.parsedItems || [], { limit: linesLimit, order, keyword });
    renderLines(sliced, { order });
    return;
  }
  const sliced = sliceLines(state.active.bufferLines || [], { limit: linesLimit, order, keyword });
  renderLines(sliced, { order });
}

async function fetchAndRender({ forceTail = false, _retryRotate = false, resetParser = false } = {}) {
  const cfg = resolveSelectedConfig();
  if (!cfg) return;
  const serverAlias = cfg?.server?.alias || '';
  const category = state.active.category;
  const objectName = state.active.object;
  if (!serverAlias || !category || !objectName) return;

  const linesLimit = parseInt(qs('#online-lines-select')?.value || '1000', 10) || 1000;
  const order = (qs('#online-order-select')?.value || 'desc').toLowerCase();
  const keyword = (qs('#online-filter-input')?.value || '').trim();
  const windowBytes = pickWindowBytes(linesLimit);

  if (forceTail) {
    const size = state.active.sizeInBytes || 0;
    state.active.cursor = Math.max(0, size - windowBytes);
    state.active.bufferLines = [];
    state.active.parsedItems = [];
    state.active.parsedLastKey = '';
  }

  const cursor = Math.max(0, Number(state.active.cursor) || 0);
  const begin = forceTail ? cursor : Math.max(0, cursor - state.active.byteOverlap);
  const data = await api.getOnlineData({
    serverAlias,
    system: state.selected.system,
    category,
    objectName,
    begin,
    end: -1,
  });

  const meta = data?.metadata;
  if (meta && typeof meta === 'object') {
    renderMeta(meta);
  }

  const endSizeNum = Number(data?.end);
  const endSize = Number.isFinite(endSizeNum) ? endSizeNum : 0;
  if (endSize > 0 && endSize < begin && !_retryRotate) {
    state.active.sizeInBytes = endSize;
    state.active.cursor = Math.max(0, endSize - windowBytes);
    state.active.bufferLines = [];
    await fetchAndRender({ forceTail: true, _retryRotate: true });
    return;
  }

  const rawLines = Array.isArray(data?.result) ? data.result : [];
  const cleaned = rawLines
    .filter((l) => typeof l === 'string')
    .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ''));

  const view = (qs('#online-view-select')?.value || 'raw').toLowerCase();

  let normalized = cleaned;
  if (forceTail && begin > 0 && normalized.length) {
    normalized = normalized.slice(1);
  }

  if (forceTail) {
    state.active.bufferLines = normalized;
  } else if (normalized.length) {
    const merged = mergeWithOverlap(state.active.bufferLines, normalized, 80);
    state.active.bufferLines = merged;
  }

  const maxBuf = Math.max(linesLimit * 3, 6000);
  if (state.active.bufferLines.length > maxBuf) {
    state.active.bufferLines = state.active.bufferLines.slice(state.active.bufferLines.length - maxBuf);
  }

  if (endSize > 0) {
    state.active.cursor = endSize;
    state.active.sizeInBytes = endSize;
  }

  if (view === 'parsed') {
    const parseLines = normalized;
    if (parseLines.length) {
      const parsed = await api.parseOnlineIncremental({
        factory: state.selected.factory,
        system: state.selected.system,
        serverAlias,
        category,
        objectName,
        lines: parseLines,
        reset: !!resetParser,
      });
      const items = [];
      const txs = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
      const ents = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const t of txs) {
        items.push(formatTransaction(t));
      }
      for (const e of ents) {
        items.push(formatEntry(e));
      }
      if (items.length) {
        state.active.parsedItems = state.active.parsedItems.concat(items);
        const maxParsed = Math.max(linesLimit * 4, 8000);
        if (state.active.parsedItems.length > maxParsed) {
          state.active.parsedItems = state.active.parsedItems.slice(state.active.parsedItems.length - maxParsed);
        }
      }
    }

    const key = `${serverAlias}|${category}|${objectName}|${state.active.cursor}|${linesLimit}|${order}|${keyword}|${state.active.parsedItems.length}`;
    if (key !== state.active.parsedLastKey) {
      const sliced = sliceParsed(state.active.parsedItems, { limit: linesLimit, order, keyword });
      renderLines(sliced, { order });
      state.active.parsedLastKey = key;
    }
    return;
  }

  const key = `${serverAlias}|${category}|${objectName}|${state.active.cursor}|${linesLimit}|${order}|${keyword}|${state.active.bufferLines.length}`;
  if (key !== state.active.lastTextKey) {
    const sliced = sliceLines(state.active.bufferLines, { limit: linesLimit, order, keyword });
    renderLines(sliced, { order });
    state.active.lastTextKey = key;
  }
}

function mergeWithOverlap(existing, incoming, maxLookback = 60) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const maxK = Math.min(maxLookback, a.length, b.length);
  for (let k = maxK; k >= 1; k -= 1) {
    let ok = true;
    for (let i = 0; i < k; i += 1) {
      if (a[a.length - k + i] !== b[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return a.concat(b.slice(k));
    }
  }
  return a.concat(b);
}

function sliceParsed(items, { limit, order, keyword }) {
  let out = Array.isArray(items) ? items.filter((l) => typeof l === 'string') : [];
  if (keyword) {
    const q = keyword.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(q));
  }
  if (limit > 0 && out.length > limit) {
    out = out.slice(out.length - limit);
  }
  if (order === 'desc') {
    out = [...out].reverse();
  }
  return out;
}

function formatEntry(e) {
  const segs = Array.isArray(e?.segments) ? e.segments : [];
  const ts = pickSeg(segs, 'ts') || (e?.timestamp || '');
  const node = pickSeg(segs, 'node') || '';
  const dir = pickSeg(segs, 'dir') || '';
  const mt = pickSeg(segs, 'msg_type') || (e?.message_type || '');
  const fields = segs.filter(s => s && s.kind === 'field').map(s => s.text).slice(0, 6).join(' ');
  const tail = fields ? ` ${fields}` : '';
  return `[E] ${ts} Node=${node} ${dir} ${mt}${tail}`.trim();
}

function formatTransaction(t) {
  const node = t?.node_id || '';
  const trans = t?.trans_id || '';
  const req = t?.latest_request || {};
  const resp = t?.response || {};
  const rmt = req?.message_type || pickSeg(req?.segments || [], 'msg_type') || '';
  const smt = resp?.message_type || pickSeg(resp?.segments || [], 'msg_type') || '';
  const ts = (t?.start_time || req?.timestamp || '').toString();
  return `[T] ${ts} Node=${node} TransId=${trans} ${rmt} -> ${smt}`.trim();
}

function pickSeg(segs, kind) {
  for (const s of segs) {
    if (s && s.kind === kind) return String(s.text || '').trim();
  }
  return '';
}

function sliceLines(lines, { limit, order, keyword }) {
  let out = lines.filter((l) => typeof l === 'string');
  if (keyword) {
    const q = keyword.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(q));
  }

  if (limit > 0 && out.length > limit) {
    out = out.slice(out.length - limit);
  }

  if (order === 'desc') {
    out = [...out].reverse();
  }
  return out;
}

function renderLines(lines, { order } = {}) {
  const container = qs('#online-log-view');
  if (!container) return;
  const safe = (lines || []).map((l) => escapeHtmlText(l)).join('\n');
  container.innerHTML = `<pre class="online-log-pre">${safe || ''}</pre>`;
  const o = (order || (qs('#online-order-select')?.value || 'desc')).toLowerCase();
  if (o === 'asc') {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = 0;
  }
}

function pickWindowBytes(linesLimit) {
  if (linesLimit <= 200) return 128 * 1024;
  if (linesLimit <= 500) return 256 * 1024;
  if (linesLimit <= 1000) return 512 * 1024;
  return 1024 * 1024;
}

function escapeHtmlText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeHtmlAttr(text) {
  return escapeHtmlText(text).replace(/`/g, '&#096;');
}
