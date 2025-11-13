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

export const api = {
  /* -------- 下载页 -------- */
  getFactories: () => get('/api/factories'),
  getSystems: (factoryId) => get(`/api/systems?factory=${encodeURIComponent(factoryId)}`),
  searchLogs: (payload) => post('/api/search-logs', payload),
  downloadLogs: (payload) => post('/api/download-logs', payload),

  /* -------- 分析页 -------- */
  getDownloadedLogs: () => get('/api/downloaded-logs'),
  openReportsDirectory: () => post('/api/open-reports-directory', {}),
  checkReport: (log_path) => post('/api/check-report', { log_path }),
  openInBrowser: (url) => post('/api/open-in-browser', { url }),
  openInEditor: (file_path) => post('/api/open-in-editor', { file_path }),
  deleteLog: (id, path) => post('/api/delete-log', { id, path }),
  analyze: (logs, config) => post('/api/analyze', { logs, config }),
  getParserConfigs: () => get('/api/parser-configs'),

  /* -------- 服务器配置页（本步新增） -------- */
  getServerConfigs: () => get('/api/server-configs'),
  saveServerConfig: ({ factory, system, server }) => post('/api/save-config', { factory, system, server }),
  updateServerConfig: ({ id, factory, system, server }) => post('/api/update-config', { id, factory, system, server }),
  deleteServerConfig: (id) => post('/api/delete-config', { id }),

  /* -------- 解析配置（第 4 步会补齐） -------- */
};
