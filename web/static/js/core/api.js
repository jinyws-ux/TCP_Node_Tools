// core/api.js
async function get(url) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
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

export const api = {
  /* -------- 下载页 -------- */
  getFactories: () => get('/api/factories'),
  getSystems: (factoryId) => get(`/api/systems?factory=${encodeURIComponent(factoryId)}`),
  searchLogs: (payload) => post('/api/logs/search', payload),
  searchLogsByTemplate: (payload) => post('/api/logs/search_strict', payload),
  downloadLogs: (payload) => post('/api/logs/download', payload),

  /* -------- 分析页 -------- */
  getDownloadedLogs: () => get('/api/downloaded-logs'),
  openReportsDirectory: () => post('/api/open-reports-directory', {}),
  checkReport: (log_path) => post('/api/check-report', { log_path }),
  openInBrowser: (url) => post('/api/open-in-browser', { url }),
  openInEditor: (file_path) => post('/api/open-in-editor', { file_path }),
  exitBackend: () => post('/api/exit', {}),
  deleteLog: (id, path) => post('/api/delete-log', { id, path }),
  analyze: (logs, config) => post('/api/analyze', { logs, config }),
  getParserConfigs: () => get(`/api/parser-configs?_=${Date.now()}`),

  /* -------- 服务器配置页 -------- */
  async getServerConfigs() {
    const data = await get('/api/server-configs');
    const res = ensureSuccess(data, '加载服务器配置失败');
    return res.configs || [];
  },
  saveServerConfig: ({ factory, system, server }) => post('/api/save-config', { factory, system, server }),
  updateServerConfig: ({ id, factory, system, server }) => post('/api/update-config', { id, factory, system, server }),
  deleteServerConfig: (id) => post('/api/delete-config', { id }),

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
};
