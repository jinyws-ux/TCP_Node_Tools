// core/api.js
async function get(url) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function ensureSuccess(data, fallbackMsg) {
  if (data && data.success !== false) {
    return data;
  }
  const err = data?.error || fallbackMsg || '接口调用失败';
  throw new Error(err);
}

function buildOnlineBaseUrl(serverAlias) {
  const alias = (serverAlias || '').trim();
  if (!alias) throw new Error('缺少服务器别名');
  return `https://${alias}.bmwbrill.cn:8080`;
}

async function onlineGet(serverAlias, path, query) {
  const toQueryString = (obj) => obj
    ? new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString()
    : '';

  const base = buildOnlineBaseUrl(serverAlias);
  const qs = toQueryString(query);
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;

  const isNetworkErr = (err) => {
    if (!err) return false;
    if (err instanceof TypeError) return true;
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('cors');
  };

  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    if (!isNetworkErr(err)) throw err;
    const proxyQs = toQueryString({ alias: serverAlias, path, ...(query || {}) });
    const proxyUrl = `/api/online/proxy?${proxyQs}`;
    const res = await fetch(proxyUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.success === false) {
      throw new Error(data.error || '在线日志代理请求失败');
    }
    return data;
  }
}

export const api = {
  /* -------- 下载页 -------- */
  getFactories: () => get('/api/factories'),
  getSystems: (factoryId) => get(`/api/systems?factory=${encodeURIComponent(factoryId)}`),
  searchLogs: (payload) => post('/api/logs/search', payload),
  searchLogsByTemplate: (payload) => post('/api/logs/search_strict', payload),
  downloadLogs: (payload) => post('/api/logs/download', payload),

  /* -------- 分析页 -------- */
  getDownloadedLogs: () => get('/api/downloaded-logs'),

  checkReport: (log_path) => post('/api/check-report', { log_path }),
  openInBrowser: (url) => post('/api/open-in-browser', { url }),
  openInEditor: (file_path) => post('/api/open-in-editor', { file_path }),
  getLogContent: (file_path) => post('/api/get-log-content', { file_path }),
  deleteLog: (id, path) => post('/api/logs/cleanup-single', { log_path: path }),
  toggleLogLock: (log_path) => post('/api/logs/toggle-lock', { log_path }),
  analyze: (logs, config) => post('/api/analyze', { logs, config }),
  getParserConfigs: () => get(`/api/parser-configs?_=${Date.now()}`),
  exitBackend: () => post('/api/exit', {}),

  /* -------- 服务器配置页 -------- */
  async getServerConfigs() {
    const data = await get('/api/server-configs');
    const res = ensureSuccess(data, '加载服务器配置失败');
    return res.configs || [];
  },
  saveServerConfig: ({ factory, system, server }) => post('/api/save-config', { factory, system, server }),
  updateServerConfig: ({ id, factory, system, server }) => post('/api/update-config', { id, factory, system, server }),
  deleteServerConfig: (id) => post('/api/delete-config', { id }),
  async testServerConfig(id) {
    const res = await fetch('/api/test-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) { }
    if (res.ok) return data;
    return data || { success: false, error: `HTTP ${res.status}` };
  },

  /* -------- 解析配置 -------- */
  async fetchParserConfig(factory, system) {
    const data = await get(`/api/parser-config?factory=${encodeURIComponent(factory)}&system=${encodeURIComponent(system)}&format=full`);
    const res = ensureSuccess(data, '加载解析配置失败');
    return res.config || {};
  },
  async fetchParserConfigTree(factory, system) {
    const data = await get(`/api/parser-config-tree?factory=${encodeURIComponent(factory)}&system=${encodeURIComponent(system)}`);
    const res = ensureSuccess(data, '加载解析配置树失败');
    return res.tree || [];
  },
  async fetchParserConfigStats(factory, system) {
    const data = await get(`/api/parser-config-stats?factory=${encodeURIComponent(factory)}&system=${encodeURIComponent(system)}`);
    const res = ensureSuccess(data, '加载解析配置统计失败');
    return res.stats || {};
  },
  saveParserConfig: ({ factory, system, config }) => post('/api/save-parser-config', { factory, system, config }),
  updateParserConfig: ({ factory, system, updates }) => post('/api/update-parser-config', { factory, system, updates }),
  async fetchFieldHistory(factory, system) {
    const data = await get(`/api/parser-field-history?factory=${encodeURIComponent(factory)}&system=${encodeURIComponent(system)}`);
    const res = ensureSuccess(data, '加载历史字段失败');
    return res.items || [];
  },

  /* -------- 报告管理 -------- */
  async getReportsList() {
    const data = await get('/api/reports-list');
    return ensureSuccess(data, '获取报告列表失败');
  },
  async deleteReport(reportId) {
    const data = await post('/api/delete-report', { report_id: reportId });
    return ensureSuccess(data, '删除报告失败');
  },

  /* -------- 在线日志（直连 log_file_viewer） -------- */
  async getOnlineCategories({ serverAlias }) {
    const data = await onlineGet(serverAlias, '/logging');
    return data?.collection || [];
  },
  async getOnlineObjects({ serverAlias, category }) {
    const data = await onlineGet(serverAlias, `/logging/${encodeURIComponent(category)}`);
    return data?.collection || [];
  },
  async getOnlineMetadata({ serverAlias, category, objectName }) {
    return onlineGet(
      serverAlias,
      `/logging/${encodeURIComponent(category)}/${encodeURIComponent(objectName)}`
    );
  },
  async getOnlineData({
    serverAlias,
    category,
    objectName,
    begin = 0,
    end = -1,
    encoding,
    reversed,
    positive_filter,
    negative_filter,
    surrounding_lines,
  }) {
    return onlineGet(
      serverAlias,
      `/logging/${encodeURIComponent(category)}/${encodeURIComponent(objectName)}/data`,
      {
        begin,
        end,
        encoding,
        reversed,
        positive_filter,
        negative_filter,
        surrounding_lines,
      }
    );
  },

  /* -------- 在线日志（本工具后端增量解析） -------- */
  parseOnlineIncremental: (payload) => post('/api/online/parse-incremental', payload),

  /* -------- 在线日志（快照分析） -------- */
  analyzeOnlineCurrent: (payload) => post('/api/online/analyze-current', payload),
};
