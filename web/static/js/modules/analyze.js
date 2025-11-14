// modules/analyze.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';
import { formatFileSize, escapeHtml } from '../core/utils.js';

let inited = false;
let selectedDownloadedLogs = [];

// 简化选择器
const $  = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

function bind(id, ev, fn) {
  const el = document.getElementById(id);
  if (!el) return console.warn('元素不存在:', id);
  el.addEventListener(ev, fn);
}

/* ---------- UI 刷新 ---------- */

function updateAnalyzeButton() {
  const btn = $('#analyze-logs-btn');
  if (btn) btn.disabled = selectedDownloadedLogs.length === 0;
}

function updateSelectedLogs() {
  selectedDownloadedLogs = [];
  $$('#logs-body input[type="checkbox"]:checked').forEach(chk => {
    selectedDownloadedLogs.push(chk.value);
  });
  updateAnalyzeButton();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return `${value.toFixed(1)} ms`;
}

function renderAnalysisStats(stats = []) {
  const container = document.getElementById('analysis-stats-body');
  if (!container) return;
  if (!Array.isArray(stats) || stats.length === 0) {
    container.innerHTML = '<div class="message-empty">暂无阶段统计</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'analysis-stats-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>阶段</th>
        <th>输入数量</th>
        <th>输出数量</th>
        <th>耗时</th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement('tbody');
  stats.forEach((stage, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(stage.stage || '-')}</td>
      <td>${Number.isFinite(stage.input_items) ? stage.input_items : '-'}</td>
      <td>${Number.isFinite(stage.output_items) ? stage.output_items : '-'}</td>
      <td>${formatDuration(stage.duration_ms)}</td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function toggleSelectAllLogs() {
  const checked = this.checked;
  $$('#logs-body input[type="checkbox"]').forEach(chk => (chk.checked = checked));
  updateSelectedLogs();
}

function addLogRow(log) {
  const tbody = $('#logs-body');
  if (!tbody) return;

  const tr = document.createElement('tr');

  // 选择框
  const tdChk = document.createElement('td');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.value = log.path;
  chk.addEventListener('change', updateSelectedLogs);
  tdChk.appendChild(chk);
  tr.appendChild(tdChk);

  // 文件名
  const tdName = document.createElement('td');
  tdName.textContent = log.name || '';
  tr.appendChild(tdName);

  // 厂区
  const tdFactory = document.createElement('td');
  tdFactory.textContent = log.factory || '';
  tr.appendChild(tdFactory);

  // 系统
  const tdSystem = document.createElement('td');
  tdSystem.textContent = log.system || '';
  tr.appendChild(tdSystem);

  // 节点
  const tdNode = document.createElement('td');
  tdNode.textContent = log.node || '';
  tr.appendChild(tdNode);

  // 日志时间
  const tdLogTime = document.createElement('td');
  tdLogTime.textContent = log.log_time || log.source_mtime || log.remote_mtime || '';
  tr.appendChild(tdLogTime);

  // 下载时间
  const tdTime = document.createElement('td');
  const downloadTime = log.download_time || log.timestamp || '';
  tdTime.textContent = downloadTime ? new Date(downloadTime).toLocaleString() : '';
  tr.appendChild(tdTime);

  // 大小
  const tdSize = document.createElement('td');
  tdSize.textContent = formatFileSize(log.size);
  tr.appendChild(tdSize);

  // 操作
  const tdAct = document.createElement('td');
  tdAct.className = 'action-cell';

  // 查看（外部编辑器）
  const btnView = document.createElement('button');
  btnView.className = 'action-btn action-view';
  btnView.innerHTML = '<i class="fas fa-eye"></i> 查看';
  btnView.onclick = () => viewLogContent(log.path);
  tdAct.appendChild(btnView);

  // 打开报告（有报告时才显示）
  if (log.hasReport) {
    const btnReport = document.createElement('button');
    btnReport.className = 'action-btn action-report';
    btnReport.innerHTML = '<i class="fas fa-chart-bar"></i> 打开报告';
    btnReport.onclick = () => openReport(log.path);
    tdAct.appendChild(btnReport);
  }

  // 删除
  const btnDel = document.createElement('button');
  btnDel.className = 'action-btn action-delete';
  btnDel.innerHTML = '<i class="fas fa-trash"></i> 删除';
  btnDel.onclick = () => deleteLog(log.id, log.path);
  tdAct.appendChild(btnDel);

  tr.appendChild(tdAct);
  tbody.appendChild(tr);
}

function displayDownloadedLogs(logs) {
  const tbody = $('#logs-body');
  const empty = $('#no-logs-message');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!Array.isArray(logs) || logs.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // 并发检查报告状态
  const checks = logs.map(async (log) => {
    try {
      const { success, has_report } = await api.checkReport(log.path);
      log.hasReport = success ? !!has_report : false;
    } catch {
      log.hasReport = false;
    }
    return log;
  });

  Promise.all(checks).then((enriched) => {
    enriched.forEach(addLogRow);
  });
}

/* ---------- 事件处理 ---------- */

async function loadDownloadedLogs() {
  const btnId = 'refresh-logs-btn';
  setButtonLoading(btnId, true);
  try {
    const data = await api.getDownloadedLogs();
    setButtonLoading(btnId, false);

    if (data.success) {
      displayDownloadedLogs(data.logs || []);
      showMessage('success', `已加载 ${data.logs.length} 个日志文件`, 'analyze-messages');
    } else {
      showMessage('error', '加载已下载日志失败: ' + (data.error || ''), 'analyze-messages');
    }
  } catch (e) {
    setButtonLoading(btnId, false);
    showMessage('error', '获取已下载日志失败: ' + e.message, 'analyze-messages');
  }
}

async function openReportsDirectory() {
  try {
    const res = await api.openReportsDirectory();
    if (res.success) {
      showMessage('success', '已打开报告目录', 'analyze-messages');
    } else {
      showMessage('error', '打开报告目录失败: ' + (res.error || ''), 'analyze-messages');
    }
  } catch (e) {
    showMessage('error', '打开报告目录失败: ' + e.message, 'analyze-messages');
  }
}

async function openReport(logPath) {
  if (!logPath) {
    showMessage('error', '日志路径无效', 'analyze-messages');
    return;
  }
  showMessage('info', '正在查找报告...', 'analyze-messages');
  try {
    const res = await api.checkReport(logPath);
    if (res.success && res.has_report && res.report_path) {
      const openRes = await api.openInBrowser(res.report_path);
      if (openRes.success) {
        showMessage('success', '报告已在默认浏览器中打开', 'analyze-messages');
      } else {
        showMessage('error', '打开报告失败: ' + (openRes.error || ''), 'analyze-messages');
      }
    } else {
      showMessage('warning', res.success ? '该日志没有对应的分析报告' : ('检查报告失败: ' + (res.error || '')), 'analyze-messages');
    }
  } catch (e) {
    showMessage('error', '检查报告状态失败: ' + e.message, 'analyze-messages');
  }
}

async function viewLogContent(logPath) {
  if (!logPath) {
    showMessage('error', '日志路径无效', 'analyze-messages');
    return;
  }
  try {
    const res = await api.openInEditor(logPath);
    if (res.success) {
      showMessage('success', '如果没自动打开日志，请自己选择文本编辑器', 'analyze-messages');
    } else {
      showMessage('error', '打开日志失败: ' + (res.error || ''), 'analyze-messages');
    }
  } catch (e) {
    showMessage('error', '打开日志失败: ' + e.message, 'analyze-messages');
  }
}

async function deleteLog(logId, logPath) {
  if (!confirm('确定要删除此日志文件吗？')) return;
  try {
    const res = await api.deleteLog(logId, logPath);
    if (res.success) {
      showMessage('success', '日志删除成功', 'analyze-messages');
      loadDownloadedLogs();
    } else {
      showMessage('error', '删除失败: ' + (res.error || ''), 'analyze-messages');
    }
  } catch (e) {
    showMessage('error', '删除日志失败: ' + e.message, 'analyze-messages');
  }
}

async function analyzeLogs() {
  if (selectedDownloadedLogs.length === 0) {
    showMessage('error', '请选择要分析的日志文件', 'analyze-messages');
    return;
  }
  const configId = $('#config-select')?.value;
  if (!configId) {
    showMessage('error', '请选择解析配置', 'analyze-messages');
    return;
  }

  setButtonLoading('analyze-logs-btn', true);
  try {
    const res = await api.analyze(selectedDownloadedLogs, configId);
    setButtonLoading('analyze-logs-btn', false);

    if (res.success) {
      showMessage('success', `日志分析完成！生成 ${res.log_entries_count} 条日志记录`, 'analyze-messages');
      // 刷新列表，显示新的报告按钮
      loadDownloadedLogs();
      renderAnalysisStats(res.stats || []);
    } else {
      showMessage('error', '分析失败: ' + (res.error || ''), 'analyze-messages');
    }
  } catch (e) {
    setButtonLoading('analyze-logs-btn', false);
    showMessage('error', '分析日志失败: ' + e.message, 'analyze-messages');
  }
}

/* ---------- 解析配置下拉 ---------- */

function selectHasOption(sel, val) {
  if (!sel) return false;
  return Array.from(sel.options || []).some((opt) => opt.value === val);
}

async function loadParserConfigs(options = {}) {
  const sel = $('#config-select');
  if (!sel) return;

  const { preferredId, preserveSelection = true } = options;
  const before = sel.value || '';
  const targetValue = preferredId !== undefined
    ? preferredId
    : (preserveSelection ? before : '');

  try {
    const data = await api.getParserConfigs();
    sel.innerHTML = '<option value="">-- 请选择解析配置 --</option>';
    if (data.success) {
      (data.configs || []).forEach(cfg => {
        const opt = document.createElement('option');
        opt.value = cfg.id;
        opt.textContent = (cfg.name || '').replace('.json', '');
        sel.appendChild(opt);
      });

      if (targetValue && selectHasOption(sel, targetValue)) {
        sel.value = targetValue;
      } else if (targetValue === '') {
        sel.value = '';
      }
    } else {
      showMessage('error', '加载解析配置失败: ' + (data.error || ''), 'analyze-messages');
    }
  } catch (e) {
    showMessage('error', '加载解析配置失败: ' + e.message, 'analyze-messages');
  }
}

function inferConfigFilename(factory, system) {
  if (!factory || !system) return '';
  return `${factory}_${system}.json`;
}

function handleServerConfigsChanged(evt) {
  const detail = evt?.detail || {};
  const action = detail.action;
  const config = detail.config || {};
  const previous = detail.previous || {};
  const currentSelect = $('#config-select');
  const currentValue = currentSelect?.value || '';

  const oldId = inferConfigFilename(previous.factory, previous.system);
  const newId = inferConfigFilename(config.factory, config.system);

  if (action === 'update' && currentValue && currentValue === oldId && newId) {
    loadParserConfigs({ preferredId: newId, preserveSelection: false });
    showMessage('info', '服务器配置改名，解析配置已自动同步', 'analyze-messages');
    return;
  }

  if (action === 'delete' && currentValue && currentValue === oldId) {
    loadParserConfigs({ preferredId: '', preserveSelection: false });
    showMessage('warning', '服务器配置被删除，请重新选择解析配置', 'analyze-messages');
    return;
  }

  loadParserConfigs({ preserveSelection: true });
}

/* ---------- 模块入口 ---------- */

export function init() {
  if (inited) return;
  inited = true;

  // 绑定事件（存在才绑定，不影响其它页面）
  bind('select-all-logs', 'change', toggleSelectAllLogs);
  bind('analyze-logs-btn', 'click', analyzeLogs);
  bind('refresh-logs-btn', 'click', loadDownloadedLogs);
  bind('open-reports-dir-btn', 'click', openReportsDirectory);

  // 首次进入时加载数据
  loadDownloadedLogs();
  loadParserConfigs();

  // 初始按钮状态
  updateAnalyzeButton();
  renderAnalysisStats([]);

  window.addEventListener('parser-config:changed', () => {
    console.log('[analyze] 解析配置变更 → 自动刷新配置列表');
    loadParserConfigs({ preserveSelection: true });
  });

  window.addEventListener('server-configs:changed', (evt) => {
    console.log('[analyze] 服务器配置变更 → 检查解析下拉');
    handleServerConfigsChanged(evt);
  });
}
