const API_URL = '/api/unassigned-tickets';
const REFRESH_MS = 5 * 60 * 1000;
const SEEN_IDS_KEY = 'unassigned-tickets.seen-ids.v1';

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const parsed = parseDate(value);
  if (!parsed) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(parsed);
}

function formatAge(value) {
  const parsed = parseDate(value);
  if (!parsed) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${minutes % 60}分钟`;
  return `${Math.floor(hours / 24)}天${hours % 24}小时`;
}

function readSeenIds() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_IDS_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (_) {
    return new Set();
  }
}

function saveSeenIds(ids) {
  try {
    window.localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(Array.from(ids).slice(-500)));
  } catch (_) { }
}

async function fetchTickets(force, signal) {
  const url = force ? `${API_URL}?refresh=1` : API_URL;
  const response = await fetch(url, { method: 'GET', signal, cache: 'no-store' });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    throw new Error(`服务器返回了无法识别的内容（HTTP ${response.status}）`);
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;

  const state = {
    data: null,
    filter: 'ALL',
    loading: false,
    firstLoad: true,
    seenIds: readSeenIds(),
    newIds: new Set(),
    controller: null,
    timer: null,
    countdown: null,
    nextRefreshAt: 0,
  };

  container.className = `ut-root${ctx?.standalone ? ' ut-standalone' : ''}`;

  const header = createElement('div', 'ut-header');
  const titleWrap = createElement('div', 'ut-title-wrap');
  const title = createElement('h2', 'ut-title', '未分配工单');
  const status = createElement('span', 'ut-online', '等待连接');
  titleWrap.append(title, status);
  const refreshButton = createElement('button', 'ut-refresh', '刷新');
  refreshButton.type = 'button';
  header.append(titleWrap, refreshButton);

  const counts = createElement('div', 'ut-counts');
  const list = createElement('div', 'ut-list');
  const footer = createElement('div', 'ut-footer');
  const message = createElement('div', 'ut-message');
  const updated = createElement('span', 'ut-updated', '尚未刷新');
  const nextRefresh = createElement('span', 'ut-next-refresh', '');
  footer.append(updated, nextRefresh);
  container.append(header, counts, message, list, footer);

  function setFilter(filter) {
    state.filter = filter;
    counts.querySelectorAll('[data-filter]').forEach((node) => {
      node.classList.toggle('active', node.dataset.filter === filter);
    });
    renderList();
  }

  function renderCounts() {
    const values = state.data?.counts || { total: 0, inc: 0, wo: 0 };
    counts.innerHTML = '';
    [
      ['ALL', '全部', values.total || 0],
      ['INC', 'INC', values.inc || 0],
      ['WO', 'WO', values.wo || 0],
    ].forEach(([filter, label, value]) => {
      const button = createElement('button', `ut-count ut-count-${filter.toLowerCase()}`);
      button.type = 'button';
      button.dataset.filter = filter;
      button.append(createElement('strong', '', value), createElement('span', '', label));
      button.classList.toggle('active', state.filter === filter);
      button.addEventListener('click', () => setFilter(filter));
      counts.appendChild(button);
    });
  }

  function renderList() {
    list.innerHTML = '';
    const allItems = Array.isArray(state.data?.items) ? state.data.items : [];
    const items = state.filter === 'ALL'
      ? allItems
      : allItems.filter((item) => item.type === state.filter);

    if (!items.length) {
      list.appendChild(createElement(
        'div',
        'ut-empty',
        allItems.length ? `当前没有${state.filter}工单` : '当前没有未分配工单',
      ));
      return;
    }

    items.forEach((item) => {
      const card = createElement('article', 'ut-ticket');
      if (state.newIds.has(String(item.id))) card.classList.add('is-new');

      const top = createElement('div', 'ut-ticket-top');
      const identity = createElement('div', 'ut-ticket-identity');
      identity.append(
        createElement('span', `ut-type ut-type-${String(item.type || '').toLowerCase()}`, item.type || 'OTHER'),
        createElement('strong', 'ut-id', item.id || '无编号'),
      );
      const priority = createElement(
        'span',
        `ut-priority ut-priority-${String(item.priority || 'unknown').toLowerCase()}`,
        item.priority || '无优先级',
      );
      top.append(identity, priority);

      const summary = createElement('div', 'ut-summary', item.summary || '无摘要');
      const meta = createElement('div', 'ut-meta');
      meta.append(
        createElement('span', '', formatDate(item.submit_time)),
        createElement('span', '', formatAge(item.submit_time)),
      );
      card.append(top, summary, meta);
      card.addEventListener('dblclick', async () => {
        try {
          await navigator.clipboard.writeText(String(item.id || ''));
          ctx?.showMessage?.('success', `已复制 ${item.id}`);
        } catch (_) { }
      });
      list.appendChild(card);
    });
  }

  function renderStatus() {
    const data = state.data;
    if (!data) return;
    status.textContent = data.stale ? '数据已过期' : '连接正常';
    status.className = `ut-online${data.stale ? ' is-stale' : ''}`;
    message.textContent = data.error || '';
    message.style.display = data.error ? 'block' : 'none';
    updated.textContent = `更新：${formatDate(data.refreshed_at)}`;
    const total = Number(data.counts?.total || 0);
    if (ctx?.standalone) document.title = `(${total}) 未分配工单`;
  }

  function updateCountdown() {
    if (!state.nextRefreshAt) {
      nextRefresh.textContent = '';
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    nextRefresh.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}后刷新`;
  }

  async function refresh(force = false) {
    if (state.loading) return;
    state.loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = '刷新中…';
    message.style.display = 'none';
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();

    try {
      const data = await fetchTickets(force, state.controller.signal);
      const currentIds = new Set((data.items || []).map((item) => String(item.id)));
      state.newIds = state.firstLoad && state.seenIds.size === 0
        ? new Set()
        : new Set(Array.from(currentIds).filter((id) => !state.seenIds.has(id)));
      state.firstLoad = false;
      currentIds.forEach((id) => state.seenIds.add(id));
      saveSeenIds(state.seenIds);
      state.data = data;
      renderCounts();
      renderList();
      renderStatus();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        message.textContent = error?.message || String(error);
        message.style.display = 'block';
        status.textContent = state.data ? '刷新失败' : '连接失败';
        status.className = 'ut-online is-error';
        if (!state.data) {
          state.data = { counts: { total: 0, inc: 0, wo: 0 }, items: [] };
          renderCounts();
          renderList();
        }
      }
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = '刷新';
      if (state.timer) window.clearTimeout(state.timer);
      state.nextRefreshAt = Date.now() + REFRESH_MS;
      state.timer = window.setTimeout(() => refresh(false), REFRESH_MS);
      updateCountdown();
    }
  }

  refreshButton.addEventListener('click', () => refresh(true));
  await refresh(false);
  state.countdown = window.setInterval(updateCountdown, 1000);

  return {
    unmount() {
      if (state.controller) state.controller.abort();
      if (state.timer) window.clearTimeout(state.timer);
      if (state.countdown) window.clearInterval(state.countdown);
      if (ctx?.standalone) document.title = '未分配工单';
      container.innerHTML = '';
    },
  };
}

export default { mount };
