const RECORDS_API = '/api/widgets/plc-switch-reports/records';
const REPORT_API = '/api/widgets/plc-switch-reports/report';
const UPSTREAM_PAGE_SIZE = 200;
const MAX_UPSTREAM_PAGES = 50;
const DISPLAY_PAGE_SIZE = 20;
const SUCCESS_STATUSES = new Set([
  'SUCCESS',
  'PRECHECK_SUCCESS',
  'FILE_CHANGE_SUCCESS',
]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function isSuccess(item) {
  return SUCCESS_STATUSES.has(String(item?.status || '').toUpperCase());
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatDirection(value) {
  const direction = String(value || '').toUpperCase();
  if (direction === 'PROD_TO_TEST') return 'PROD → INT';
  if (direction === 'TEST_TO_PROD') return 'INT → PROD';
  return direction || '-';
}

function formatPlcs(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : '-';
}

async function fetchPage(page, signal) {
  const response = await fetch(
    `${RECORDS_API}?page=${page}&page_size=${UPSTREAM_PAGE_SIZE}`,
    { method: 'GET', cache: 'no-store', signal },
  );
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new Error(`报告服务返回了无法识别的内容（HTTP ${response.status}）`);
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

async function fetchAllRecords(signal) {
  const first = await fetchPage(1, signal);
  const records = Array.isArray(first.items) ? [...first.items] : [];
  const totalPages = Math.max(1, Number(first.total_pages || 1));
  const pagesToRead = Math.min(totalPages, MAX_UPSTREAM_PAGES);
  for (let page = 2; page <= pagesToRead; page += 1) {
    const payload = await fetchPage(page, signal);
    if (Array.isArray(payload.items)) records.push(...payload.items);
  }
  return {
    records,
    truncated: totalPages > MAX_UPSTREAM_PAGES,
  };
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;
  container.className = 'psr-root';

  const state = {
    records: [],
    category: 'ALL',
    page: 1,
    loading: false,
    controller: null,
    truncated: false,
  };

  const header = el('div', 'psr-header');
  const heading = el('div', 'psr-heading');
  heading.append(
    el('h2', 'psr-title', 'PLC切换报告'),
    el('div', 'psr-subtitle', '报告数据来自本机PLC切换服务'),
  );
  const refreshButton = el('button', 'btn btn-primary btn-sm', '刷新');
  refreshButton.type = 'button';
  header.append(heading, refreshButton);

  const categories = el('div', 'psr-categories');
  const message = el('div', 'psr-message');
  const tableWrap = el('div', 'psr-table-wrap');
  const pager = el('div', 'psr-pager');
  container.append(header, categories, message, tableWrap, pager);

  function filteredRecords() {
    if (state.category === 'SUCCESS') return state.records.filter(isSuccess);
    if (state.category === 'FAILED') return state.records.filter((item) => !isSuccess(item));
    return state.records;
  }

  function categoryCounts() {
    const success = state.records.filter(isSuccess).length;
    return {
      ALL: state.records.length,
      SUCCESS: success,
      FAILED: state.records.length - success,
    };
  }

  function renderCategories() {
    categories.innerHTML = '';
    const counts = categoryCounts();
    [
      ['ALL', '全部'],
      ['SUCCESS', '成功'],
      ['FAILED', '失败'],
    ].forEach(([key, label]) => {
      const button = el('button', 'psr-category');
      button.type = 'button';
      button.dataset.category = key;
      button.classList.toggle('is-active', state.category === key);
      button.append(el('strong', '', counts[key]), el('span', '', label));
      button.addEventListener('click', () => {
        state.category = key;
        state.page = 1;
        render();
      });
      categories.appendChild(button);
    });
  }

  function createRow(item) {
    const row = document.createElement('tr');
    const statusOk = isSuccess(item);

    const idCell = document.createElement('td');
    const idText = el('div', 'psr-task-id', item.task_id || '-');
    const status = el(
      'span',
      `psr-status ${statusOk ? 'is-success' : 'is-failed'}`,
      statusOk ? '成功' : '失败',
    );
    idCell.append(idText, status);

    const timeCell = el('td', 'psr-time', formatTime(item.started_at));
    const plcCell = el('td', 'psr-plcs', formatPlcs(item.plcs));
    const directionCell = el('td', 'psr-direction', formatDirection(item.direction));
    const actionCell = document.createElement('td');
    actionCell.className = 'psr-action';
    const download = el('a', 'btn btn-outline btn-sm', '下载HTML');
    download.href = `${REPORT_API}/${encodeURIComponent(String(item.task_id || ''))}`;
    download.setAttribute('download', '');
    actionCell.appendChild(download);

    row.append(idCell, timeCell, plcCell, directionCell, actionCell);
    return row;
  }

  function renderTable() {
    tableWrap.innerHTML = '';
    const filtered = filteredRecords();
    const pageCount = Math.max(1, Math.ceil(filtered.length / DISPLAY_PAGE_SIZE));
    state.page = Math.min(state.page, pageCount);
    const start = (state.page - 1) * DISPLAY_PAGE_SIZE;
    const items = filtered.slice(start, start + DISPLAY_PAGE_SIZE);

    if (!items.length) {
      tableWrap.appendChild(el('div', 'psr-empty', '当前分类没有报告'));
      return;
    }

    const table = el('table', 'psr-table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['任务ID', '时间', 'PLC', '方向', '报告'].forEach((title) => {
      headRow.appendChild(el('th', '', title));
    });
    head.appendChild(headRow);

    const body = document.createElement('tbody');
    items.forEach((item) => body.appendChild(createRow(item)));
    table.append(head, body);
    tableWrap.appendChild(table);
  }

  function renderPager() {
    pager.innerHTML = '';
    const total = filteredRecords().length;
    const pageCount = Math.max(1, Math.ceil(total / DISPLAY_PAGE_SIZE));
    if (total <= DISPLAY_PAGE_SIZE) return;

    const previous = el('button', 'btn btn-secondary btn-sm', '上一页');
    previous.type = 'button';
    previous.disabled = state.page <= 1;
    previous.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        renderTable();
        renderPager();
      }
    });

    const info = el('span', 'psr-page-info', `${state.page} / ${pageCount}`);
    const next = el('button', 'btn btn-secondary btn-sm', '下一页');
    next.type = 'button';
    next.disabled = state.page >= pageCount;
    next.addEventListener('click', () => {
      if (state.page < pageCount) {
        state.page += 1;
        renderTable();
        renderPager();
      }
    });
    pager.append(previous, info, next);
  }

  function renderMessage(text, type = '') {
    message.textContent = text || '';
    message.className = `psr-message${type ? ` is-${type}` : ''}`;
    message.style.display = text ? 'block' : 'none';
  }

  function render() {
    renderCategories();
    renderTable();
    renderPager();
    if (state.truncated) {
      renderMessage('报告数量过多，目前仅加载最新10000条。', 'warning');
    } else {
      renderMessage('');
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = '刷新中…';
    renderMessage('正在读取报告…', 'info');
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    try {
      const result = await fetchAllRecords(state.controller.signal);
      state.records = result.records;
      state.truncated = result.truncated;
      state.page = 1;
      render();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        renderMessage(error?.message || String(error), 'error');
        state.records = [];
        renderCategories();
        renderTable();
        renderPager();
      }
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = '刷新';
    }
  }

  refreshButton.addEventListener('click', refresh);
  await refresh();

  return {
    unmount() {
      if (state.controller) state.controller.abort();
      container.innerHTML = '';
    },
  };
}

export default { mount };
