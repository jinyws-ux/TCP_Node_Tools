// modules/analyze.js
import { api } from '../core/api.js';
import { showMessage } from '../core/messages.js';
import { setButtonLoading } from '../core/ui.js';
import { formatFileSize, escapeHtml } from '../core/utils.js';

// 导入报告管理功能
import reportsModule from './reports.js';

/* ---------- 状态管理 ---------- */
let inited = false;
let selectedDownloadedLogs = new Set(); // 存储被选中的路径
let renderToken = 0;
let renderedPaths = new Set();
let logMetadataCache = {}; // 缓存日志完整对象 (path -> logObject)

// 分页与搜索状态
let allLogsCache = [];   // 存储 API 返回的所有日志（未过滤）
let filteredLogs = [];   // 存储搜索过滤后的日志
let currentPage = 1;
let pageSize = 20;
let searchQuery = '';

// 简化选择器
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

function bind(id, ev, fn) {
  const el = document.getElementById(id);
  if (!el) return console.warn('元素不存在:', id);
  el.addEventListener(ev, fn);
}

/* ---------- 动态 UI 注入 (工具栏 & 分页) ---------- */

// 注入 CSS
function injectStyles() {
  if (document.getElementById('analyze-module-styles')) return;
  const style = document.createElement('style');
  style.id = 'analyze-module-styles';
  style.textContent = `
    /* 工具栏样式 */
    .analyze-toolbar {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 15px; background: var(--bg-subtle, #f8f9fa);
        padding: 10px; border-radius: 6px; border: 1px solid var(--border-color, #eee);
    }
    .toolbar-left { display: flex; gap: 10px; align-items: center; }
    .toolbar-right { display: flex; gap: 10px; align-items: center; }
    
    .search-input {
        padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 200px; font-size: 14px;
    }
    .batch-del-btn {
        background-color: var(--danger, #dc3545); color: white; border: none;
        padding: 6px 12px; border-radius: 4px; cursor: pointer; display: none; /* 默认隐藏，有选中才显示 */
    }
    .batch-del-btn:hover { background-color: #c82333; }
    .batch-del-btn.visible { display: inline-block; }

    /* 分页控件样式 */
    .pagination-container {
        display: flex; justify-content: space-between; align-items: center;
        margin-top: 15px; padding: 10px 0; border-top: 1px solid var(--border-color, #eee);
    }
    .pagination-info { font-size: 14px; color: #666; }
    .pagination-controls { display: flex; gap: 5px; align-items: center; }
    .page-btn {
        padding: 5px 10px; border: 1px solid #ddd; background: #fff; cursor: pointer; border-radius: 4px;
    }
    .page-btn:disabled { background: #f5f5f5; color: #aaa; cursor: not-allowed; }
    .page-btn:hover:not(:disabled) { background: #e9ecef; }
    .page-size-select { padding: 5px; border-radius: 4px; border: 1px solid #ddd; }
  `;
  document.head.appendChild(style);
}

// 创建工具栏 (搜索 + 批量删除)
function createToolbar() {
    const tableContainer = document.querySelector('.table-container') || $('#logs-body')?.closest('div'); 
    // 尝试找表格的容器，如果没有，就插在表格前面
    const table = $('#logs-body')?.closest('table');
    
    if (!table || document.querySelector('.analyze-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'analyze-toolbar';
    toolbar.innerHTML = `
        <div class="toolbar-left">
            <input type="text" id="log-search-input" class="search-input" placeholder="搜索文件名/厂区/系统...">
            <button id="batch-delete-btn" class="batch-del-btn"><i class="fas fa-trash"></i> 批量删除</button>
        </div>
        <div class="toolbar-right">
            </div>
    `;

    table.parentNode.insertBefore(toolbar, table);

    // 绑定事件
    $('#log-search-input').addEventListener('input', (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        currentPage = 1; // 搜索后重置为第一页
        renderLogsTable();
    });

    $('#batch-delete-btn').addEventListener('click', batchDeleteLogs);
}

// 创建分页控件
function createPagination() {
    const table = $('#logs-body')?.closest('table');
    if (!table || document.querySelector('.pagination-container')) return;

    const div = document.createElement('div');
    div.className = 'pagination-container';
    div.innerHTML = `
        <div class="pagination-info" id="pagination-info">显示 0 - 0 共 0 条</div>
        <div class="pagination-controls">
            <select id="page-size-select" class="page-size-select">
                <option value="20">20 条/页</option>
                <option value="30">30 条/页</option>
                <option value="50">50 条/页</option>
            </select>
            <button id="prev-page-btn" class="page-btn"><i class="fas fa-chevron-left"></i></button>
            <span id="current-page-label" style="font-size: 12px; margin: 0 5px;">1</span>
            <button id="next-page-btn" class="page-btn"><i class="fas fa-chevron-right"></i></button>
        </div>
    `;

    table.parentNode.insertBefore(div, table.nextSibling);

    // 绑定事件
    $('#page-size-select').addEventListener('change', (e) => {
        pageSize = parseInt(e.target.value);
        currentPage = 1;
        renderLogsTable();
    });

    $('#prev-page-btn').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderLogsTable();
        }
    });

    $('#next-page-btn').addEventListener('click', () => {
        const totalPages = Math.ceil(filteredLogs.length / pageSize);
        if (currentPage < totalPages) {
            currentPage++;
            renderLogsTable();
        }
    });
}

/* ---------- 核心逻辑 ---------- */

// 处理数据并渲染表格 (核心入口)
function renderLogsTable() {
    // 1. 搜索过滤
    if (!searchQuery) {
        filteredLogs = allLogsCache;
    } else {
        filteredLogs = allLogsCache.filter(log => {
            const rawText = `${log.name} ${log.factory} ${log.system} ${log.node} ${log.path}`.toLowerCase();
            return rawText.includes(searchQuery);
        });
    }

    // 2. 计算分页
    const totalItems = filteredLogs.length;
    const totalPages = Math.ceil(totalItems / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalItems);
    
    // 3. 切片数据
    const logsToShow = filteredLogs.slice(startIdx, endIdx);

    // 4. 渲染 DOM
    displayDownloadedLogs(logsToShow); // 复用原有的渲染行函数

    // 5. 更新分页 UI
    const infoEl = $('#pagination-info');
    if (infoEl) {
        infoEl.textContent = totalItems === 0 
            ? '暂无数据' 
            : `显示 ${startIdx + 1} - ${endIdx} 条，共 ${totalItems} 条`;
    }
    
    $('#current-page-label').textContent = `${currentPage} / ${totalPages}`;
    $('#prev-page-btn').disabled = currentPage <= 1;
    $('#next-page-btn').disabled = currentPage >= totalPages;

    // 6. 更新批量删除按钮状态
    updateBatchDeleteButton();
}

function updateBatchDeleteButton() {
    const btn = $('#batch-delete-btn');
    if (!btn) return;
    
    if (selectedDownloadedLogs.size > 0) {
        btn.classList.add('visible');
        btn.textContent = `批量删除 (${selectedDownloadedLogs.size})`;
    } else {
        btn.classList.remove('visible');
    }
}

/* ---------- 辅助函数 ---------- */

function updateAnalyzeButton() {
  const btn = $('#analyze-logs-btn');
  if (btn) btn.disabled = selectedDownloadedLogs.size === 0;
  // 同时更新批量删除按钮
  updateBatchDeleteButton();
}

function updateSelectedLogs() {
  // 注意：这里我们不能简单清空 Set，因为跨页选择需要保留状态。
  // 但为了简化逻辑，通常全选复选框只控制当前页。
  
  // 1. 先从 Set 中移除当前页已渲染的所有路径 (确保反选生效)
  $$('#logs-body input[type="checkbox"].log-select').forEach(chk => {
      const path = chk.dataset.path || chk.value;
      if (!chk.checked) {
          selectedDownloadedLogs.delete(path);
      } else {
          selectedDownloadedLogs.add(path);
      }
  });

  updateAnalyzeButton();
  updateSelectAllIndicator();
}

function updateSelectAllIndicator() {
  const checkbox = $('#select-all-logs');
  if (!checkbox) return;
  
  // 检查当前页的所有 checkbox
  const pageCheckboxes = $$('#logs-body input[type="checkbox"].log-select');
  const totalOnPage = pageCheckboxes.length;
  if (totalOnPage === 0) {
      checkbox.checked = false;
      checkbox.indeterminate = false;
      return;
  }

  const selectedOnPage = pageCheckboxes.filter(chk => chk.checked).length;

  if (selectedOnPage === 0) {
    checkbox.checked = false;
    checkbox.indeterminate = false;
  } else if (selectedOnPage === totalOnPage) {
    checkbox.checked = true;
    checkbox.indeterminate = false;
  } else {
    checkbox.checked = false;
    checkbox.indeterminate = true;
  }
}

function toggleSelectAllLogs() {
  const checked = this.checked;
  // 只控制当前页
  $$('#logs-body input[type="checkbox"].log-select').forEach(chk => {
    chk.checked = checked;
    const path = chk.dataset.path || chk.value;
    if (checked) {
        selectedDownloadedLogs.add(path);
    } else {
        selectedDownloadedLogs.delete(path);
    }
  });
  updateAnalyzeButton();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(1)} ms`;
}

/**
 * 从日志列表中提取并格式化 Factory, System, 和 Node 信息
 */
function getLogMetadata(relatedLogs) {
    if (!relatedLogs || relatedLogs.length === 0) {
        return { factoryLabel: '未知', systemLabel: '未知', nodeLabels: '无节点信息' };
    }
    const factories = new Set();
    const systems = new Set();
    const nodes = new Set();
    relatedLogs.forEach(log => {
        if (log && log.factory) factories.add(log.factory);
        if (log && log.system) systems.add(log.system);
        if (log && log.node) nodes.add(log.node);
    });
    return {
        factoryLabel: Array.from(factories).join(', ') || '未知',
        systemLabel: Array.from(systems).join(', ') || '未知',
        nodeLabels: Array.from(nodes).join(', ') || '无节点信息'
    };
}

function formatReportDate(dateStr) {
  if (!dateStr) return '未知时间';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return dateStr; }
}

/* ---------- 批量删除 ---------- */

async function batchDeleteLogs() {
    if (selectedDownloadedLogs.size === 0) return;
    
    if (!confirm(`确定要删除选中的 ${selectedDownloadedLogs.size} 个日志文件吗？此操作不可恢复。`)) return;

    setButtonLoading('batch-delete-btn', true); // 这里的ID是我们动态创建的
    const btn = $('#batch-delete-btn');
    if(btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 删除中...';
    }

    try {
        const pathsToDelete = Array.from(selectedDownloadedLogs);
        // 并行删除请求
        const deletePromises = pathsToDelete.map(path => {
            const key = path.replace(/\\/g, '/');
            const logData = logMetadataCache[key];
            if (logData && logData.id) {
                return api.deleteLog(logData.id, path);
            }
            return Promise.resolve({ success: false, error: 'Log ID not found' });
        });

        await Promise.all(deletePromises);
        
        showMessage('success', '批量删除操作完成', 'analyze-messages');
        selectedDownloadedLogs.clear(); // 清空选择
        loadDownloadedLogs({ skipButton: true }); // 刷新列表

    } catch (err) {
        console.error('Batch delete error:', err);
        showMessage('error', '批量删除部分失败: ' + err.message, 'analyze-messages');
        loadDownloadedLogs({ skipButton: true });
    } finally {
        if(btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-trash"></i> 批量删除';
        }
    }
}

/* ---------- 日志列表渲染 (单行) ---------- */

function addLogRow(log) {
  const tbody = $('#logs-body');
  if (!tbody) return;

  const tr = document.createElement('tr');
  tr.className = 'log-row';

  const tdChk = document.createElement('td');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'log-select';
  chk.value = log.path;
  chk.dataset.path = log.path;
  // 检查 Set 中是否存在，以保持跨页选择状态
  chk.checked = selectedDownloadedLogs.has(log.path);
  chk.addEventListener('change', updateSelectedLogs);
  tdChk.appendChild(chk);
  tr.appendChild(tdChk);

  const tdName = document.createElement('td');
  tdName.textContent = log.name || '';
  tr.appendChild(tdName);

  const tdFactory = document.createElement('td');
  tdFactory.textContent = log.factory || '';
  tr.appendChild(tdFactory);

  const tdSystem = document.createElement('td');
  tdSystem.textContent = log.system || '';
  tr.appendChild(tdSystem);

  const tdNode = document.createElement('td');
  tdNode.textContent = log.node || '';
  tr.appendChild(tdNode);

  const tdLogTime = document.createElement('td');
  tdLogTime.textContent = log.log_time || log.source_mtime || log.remote_mtime || '';
  tr.appendChild(tdLogTime);

  const tdTime = document.createElement('td');
  const downloadTime = log.download_time || log.timestamp || '';
  tdTime.textContent = downloadTime ? new Date(downloadTime).toLocaleString('zh-CN', { hour12: false }) : '';
  tr.appendChild(tdTime);

  const tdSize = document.createElement('td');
  tdSize.textContent = formatFileSize(log.size);
  tr.appendChild(tdSize);

  const tdAct = document.createElement('td');
  tdAct.className = 'action-cell';

  const btnView = document.createElement('button');
  btnView.className = 'action-btn action-view';
  btnView.innerHTML = '<i class="fas fa-eye"></i> 查看';
  btnView.onclick = () => viewLogContent(log.path);
  tdAct.appendChild(btnView);

  const btnDel = document.createElement('button');
  btnDel.className = 'action-btn action-delete';
  btnDel.innerHTML = '<i class="fas fa-trash"></i> 删除';
  btnDel.onclick = () => deleteLog(log.id, log.path);
  tdAct.appendChild(btnDel);

  tr.appendChild(tdAct);
  tbody.appendChild(tr);

  // 报告行
  const reportRow = document.createElement('tr');
  reportRow.className = 'report-row';
  reportRow.dataset.logPath = log.path;
  reportRow.style.display = 'none'; 
  
  reportRow.innerHTML = `
    <td colspan="9" style="padding: 0; border: none;">
      <div class="reports-container" style="
        background-color: var(--bg-subtle, #f8f9fa); 
        padding: 12px 24px;
        border-left: 4px solid var(--primary, #2196f3); 
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.03);
      ">
        <div style="font-weight: 600; margin-bottom: 12px; color: #666; font-size: 0.9em; display: flex; align-items: center; gap: 8px;">
          <i class="fas fa-project-diagram"></i> 关联分析报告
        </div>
        <div class="reports-list" id="reports-list-${log.path.replace(/[^a-zA-Z0-9]/g, '-')}" data-log-path="${log.path}">
          <div class="message-empty">点击展开查看关联报告...</div>
        </div>
      </div>
    </td>
  `;
  tbody.appendChild(reportRow);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'action-btn action-toggle-reports';
  toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i> 报告';
  
  toggleBtn.onclick = () => {
    const isHidden = reportRow.style.display === 'none';
    if (isHidden) {
      reportRow.style.display = 'table-row';
      toggleBtn.innerHTML = '<i class="fas fa-chevron-up"></i> 报告';
      toggleBtn.classList.add('active');
      loadReportsForLog(log.path);
    } else {
      reportRow.style.display = 'none';
      toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i> 报告';
      toggleBtn.classList.remove('active');
    }
  };
  tdAct.appendChild(toggleBtn);
}

/* ---------- 报告逻辑 ---------- */

function renderReportsList(logPath, reports) {
  const reportsListId = `reports-list-${logPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const reportsList = document.getElementById(reportsListId);
  if (!reportsList) return;

  if (reports.length === 0) {
    reportsList.innerHTML = '<div class="message-empty">暂无关联分析报告</div>';
    return;
  }

  reportsList.innerHTML = `
    <div class="optimized-reports-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
      ${reports.map(report => {
        const { factoryLabel, systemLabel, nodeLabels } = getLogMetadata(report.related_logs);
        return `
        <div class="report-item-card" data-report-id="${report.report_id || report.name}" style="
          background: #fff; border: 1px solid #e1e4e8; border-radius: 6px; padding: 12px;
          display: flex; flex-direction: column; gap: 8px; transition: all 0.2s ease;
        " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'" onmouseout="this.style.transform='none';this.style.boxShadow='none'">
          
          <div class="report-header" style="display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid #f0f0f0;">
             <div style="flex: 1; min-width: 0;">
                <div class="report-name" style="font-weight: 600; color: #24292e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px;" title="${escapeHtml(report.name)}">${escapeHtml(report.name || '未知报告')}</div>
                <div class="report-time" style="font-size: 12px; color: #888; margin-top: 2px;">${formatReportDate(report.created_at)}</div>
             </div>
             <div class="report-icon" style="background: #e3f2fd; color: #2196f3; width: 32px; height: 32px; border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-left: 10px;">
                <i class="fas fa-file-alt"></i>
             </div>
          </div>

          <div class="report-metadata-labels" style="display: flex; flex-direction: column; gap: 4px; font-size: 12px;">
            <span class="meta-label meta-fs" style="display: block; color: #444; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="厂区/系统: ${escapeHtml(factoryLabel)} / ${escapeHtml(systemLabel)}">
              <strong style="color: #1976d2;">厂区/系统:</strong> ${escapeHtml(factoryLabel)} / ${escapeHtml(systemLabel)}
            </span>
            <span class="meta-label meta-node" style="display: block; color: #444; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="涉及节点: ${escapeHtml(nodeLabels)}">
              <strong style="color: #2e7d32;">节点:</strong> ${escapeHtml(nodeLabels)}
            </span>
          </div>

          <div class="report-actions-bar" style="display: flex; gap: 8px; margin-top: 4px; padding-top: 8px; border-top: 1px dashed #eee;">
            <button class="btn-action action-open" data-action="open" style="flex: 1; padding: 6px; font-size: 12px; cursor: pointer; background: #2196f3; color: white; border: none; border-radius: 4px;">
              <i class="fas fa-eye"></i> 查看
            </button>
            <button class="btn-action action-delete" data-action="delete" style="flex: 1; padding: 6px; font-size: 12px; cursor: pointer; background: #fff; color: #d32f2f; border: 1px solid #ffcdd2; border-radius: 4px;">
              <i class="fas fa-trash"></i> 删除
            </button>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;

  const newGrid = reportsList.querySelector('.optimized-reports-grid');
  if (newGrid) {
      newGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-action');
        if (!btn) return;
        const card = btn.closest('.report-item-card');
        const reportId = card?.dataset.reportId;
        const action = btn.dataset.action;
        if (reportId) {
            if (action === 'open') openReportById(reportId);
            else if (action === 'delete') deleteReportById(reportId, logPath);
        }
      });
  }
}

async function loadReportsForLog(logPath) {
  const reportsListId = `reports-list-${logPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const reportsList = document.getElementById(reportsListId);
  if (!reportsList) return;

  reportsList.innerHTML = `<div style="display: flex; align-items: center; gap: 8px; color: #888; padding: 10px 0;"><i class="fas fa-spinner fa-spin"></i> 正在加载报告列表...</div>`;

  try {
    const response = await api.getReportsList();
    if (response.success) {
      const allReports = response.reports || [];
      const logReports = allReports.filter(report => {
        const relatedLogs = report.related_logs || [];
        return relatedLogs.some(p => p === logPath || p.replace(/\\/g, '/') === logPath.replace(/\\/g, '/'));
      }).map(report => {
        report.related_logs = (report.related_logs || [])
            .map(path => logMetadataCache[path] || logMetadataCache[path.replace(/\\/g, '/')])
            .filter(log => log);
        return report;
      });
      renderReportsList(logPath, logReports);
    } else {
      reportsList.innerHTML = '<div class="message-empty error">加载报告失败</div>';
    }
  } catch (error) {
    reportsList.innerHTML = `<div class="message-empty error">加载报告失败: ${error.message}</div>`;
  }
}

function refreshReportsForLog(logPath) { loadReportsForLog(logPath); }

async function openReportById(reportId) {
  try {
    window.open(`${window.location.origin}/report/${encodeURIComponent(reportId)}`, '_blank');
  } catch (err) {
    showMessage('error', `打开报告失败：${err.message}`, 'analyze-messages');
  }
}

async function deleteReportById(reportId, logPath) {
  if (!confirm(`确定要删除报告 "${reportId}" 吗？`)) return;
  try {
    const response = await api.deleteReport(reportId);
    if (response.success) {
      showMessage('success', '报告删除成功', 'analyze-messages');
      if (logPath) refreshReportsForLog(logPath);
      else loadDownloadedLogs({ silent: true });
    } else {
      showMessage('error', `删除失败：${response.error}`, 'analyze-messages');
    }
  } catch (err) {
    showMessage('error', `删除报告失败：${err.message}`, 'analyze-messages');
  }
}

/* ---------- 日志内容查看 (带修复后的UI) ---------- */

async function viewLogContent(logPath) {
  if (!logPath) return showMessage('error', '日志路径无效', 'analyze-messages');
  try {
    showMessage('info', '正在加载日志内容...', 'analyze-messages');
    const res = await api.getLogContent(logPath);
    if (res.success) {
      showLogContentModal(res);
      showMessage('success', '日志内容加载成功', 'analyze-messages');
    } else showMessage('error', '获取失败: ' + res.error, 'analyze-messages');
  } catch (e) {
    showMessage('error', '获取失败: ' + e.message, 'analyze-messages');
  }
}

function showLogContentModal(data) {
  let modal = document.getElementById('log-content-modal');
  if (!modal) {
    modal = createLogContentModal();
    document.body.appendChild(modal);
  }
  const content = document.getElementById('log-content-text');
  const title = document.getElementById('log-content-title');
  const size = document.getElementById('log-content-size');
  
  if (content) content.textContent = data.content;
  if (title) title.textContent = data.file_name;
  if (size) size.textContent = formatFileSize(data.file_size);
  
  modal.style.display = 'block';
  requestAnimationFrame(() => modal.classList.add('visible'));
  
  const closeModal = () => { 
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 200); 
  };
  
  modal.querySelector('.close-btn').onclick = closeModal;
  modal.querySelector('.modal-overlay').onclick = (e) => { if (e.target === modal.querySelector('.modal-overlay')) closeModal(); };
  document.onkeydown = (e) => { if (e.key === 'Escape' && modal.style.display === 'block') closeModal(); };
}

function createLogContentModal() {
  const modal = document.createElement('div');
  modal.id = 'log-content-modal';
  const style = document.createElement('style');
  style.textContent = `
    #log-content-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9999; font-family: sans-serif; opacity: 0; transition: opacity 0.2s; }
    #log-content-modal.visible { opacity: 1; }
    #log-content-modal .modal-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); }
    #log-content-modal .modal-content { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.98); width: 90%; max-width: 1200px; height: 85%; background: #1e1e1e; color: #d4d4d4; border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,0.5); overflow: hidden; display: flex; flex-direction: column; transition: transform 0.2s; }
    #log-content-modal.visible .modal-content { transform: translate(-50%, -50%) scale(1); }
    #log-content-modal .modal-header { padding: 12px 20px; background: #252526; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
    #log-content-modal .modal-title h3 { margin: 0; font-size: 16px; color: #fff; }
    #log-content-modal .modal-title p { margin: 2px 0 0; font-size: 12px; color: #888; }
    #log-content-modal .close-btn { background: none; border: none; font-size: 24px; cursor: pointer; color: #888; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; }
    #log-content-modal .close-btn:hover { background: #c53030; color: white; }
    #log-content-modal .modal-body { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
    #log-content-modal .log-content-container { flex: 1; height: 100%; overflow: auto; background: #1e1e1e; padding: 20px; box-sizing: border-box; }
    #log-content-modal .log-content-container::-webkit-scrollbar { width: 14px; height: 14px; }
    #log-content-modal .log-content-container::-webkit-scrollbar-thumb { background-color: #424242; border: 3px solid #1e1e1e; border-radius: 7px; }
    #log-content-text { margin: 0; white-space: pre; font-family: 'Consolas', monospace; font-size: 13px; color: #ccc; display: inline-block; min-width: 100%; }
  `;
  document.head.appendChild(style);
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content">
      <div class="modal-header"><div class="modal-title"><h3 id="log-content-title"></h3><p id="log-content-size"></p></div><button class="close-btn">×</button></div>
      <div class="modal-body"><div class="log-content-container"><pre id="log-content-text"></pre></div></div>
    </div>`;
  return modal;
}

/* ---------- 核心入口与加载 ---------- */

async function deleteLog(logId, logPath) {
  if (!confirm('确定要删除此日志文件吗？')) return;
  try {
    const res = await api.deleteLog(logId, logPath);
    if (res.success) {
      showMessage('success', '日志删除成功', 'analyze-messages');
      // 删除后，从 allLogsCache 中移除该项，避免重新请求 API
      allLogsCache = allLogsCache.filter(l => l.path !== logPath);
      // 同时也清理 selectedDownloadedLogs 和 metadata
      selectedDownloadedLogs.delete(logPath);
      delete logMetadataCache[logPath.replace(/\\/g, '/')];
      renderLogsTable(); // 重新渲染当前页
    } else showMessage('error', '删除失败: ' + res.error, 'analyze-messages');
  } catch (e) { showMessage('error', '删除日志失败: ' + e.message, 'analyze-messages'); }
}

async function analyzeLogs() {
  if (selectedDownloadedLogs.size === 0) return showMessage('error', '请选择要分析的日志文件', 'analyze-messages');
  const configId = $('#config-select')?.value;
  if (!configId) return showMessage('error', '请选择解析配置', 'analyze-messages');

  setButtonLoading('analyze-logs-btn', true);
  try {
    const res = await api.analyze(Array.from(selectedDownloadedLogs), configId);
    setButtonLoading('analyze-logs-btn', false);
    if (res.success) {
      showMessage('success', `日志分析完成！生成 ${res.log_entries_count} 条日志记录`, 'analyze-messages');
      loadDownloadedLogs(); // 分析后刷新状态
      renderAnalysisStats(res.stats || []);
    } else showMessage('error', '分析失败: ' + res.error, 'analyze-messages');
  } catch (e) {
    setButtonLoading('analyze-logs-btn', false);
    showMessage('error', '分析日志失败: ' + e.message, 'analyze-messages');
  }
}

function renderAnalysisStats(stats = []) {
  const container = document.getElementById('analysis-stats-body');
  if (!container) return;
  if (!Array.isArray(stats) || stats.length === 0) return container.innerHTML = '<div class="message-empty">暂无阶段统计</div>';

  const table = document.createElement('table');
  table.className = 'analysis-stats-table';
  table.innerHTML = `<thead><tr><th>#</th><th>阶段</th><th>输入数量</th><th>输出数量</th><th>耗时</th></tr></thead><tbody>
    ${stats.map((s, i) => `<tr><td>${i+1}</td><td>${escapeHtml(s.stage||'-')}</td><td>${s.input_items||'-'}</td><td>${s.output_items||'-'}</td><td>${formatDuration(s.duration_ms)}</td></tr>`).join('')}
  </tbody>`;
  container.innerHTML = '';
  container.appendChild(table);
}

// 供 renderLogsTable 调用，负责渲染具体的 TR
function displayDownloadedLogs(logs) {
  const tbody = $('#logs-body');
  const empty = $('#no-logs-message');
  if (!tbody) return;

  tbody.innerHTML = '';
  renderedPaths.clear();
  
  if (!Array.isArray(logs) || logs.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  renderToken++;
  logs.forEach(log => {
    if (!log.path || renderedPaths.has(log.path)) return;
    renderedPaths.add(log.path);
    addLogRow(log);
  });
  
  // 更新全选框状态
  updateSelectAllIndicator();
}

// 主加载函数
async function loadDownloadedLogs(arg) {
  const options = (typeof Event !== 'undefined' && arg instanceof Event) ? {} : (arg || {});
  const { silent = false, skipButton = false } = options;
  const btnId = 'refresh-logs-btn';
  
  if (!skipButton) setButtonLoading(btnId, true);
  try {
    const data = await api.getDownloadedLogs();
    if (!skipButton) setButtonLoading(btnId, false);

    if (data.success) {
      // 1. 更新全局缓存
      allLogsCache = data.logs || [];
      logMetadataCache = {};
      allLogsCache.forEach(log => {
          logMetadataCache[log.path.replace(/\\/g, '/')] = log;
      });

      // 2. 调用带分页和搜索的渲染函数
      renderLogsTable(); 

      if (!silent) showMessage('success', `已加载 ${allLogsCache.length} 个日志文件`, 'analyze-messages');
    } else if (!silent) {
      showMessage('error', '加载失败: ' + (data.error || ''), 'analyze-messages');
    }
  } catch (e) {
    if (!skipButton) setButtonLoading(btnId, false);
    if (!silent) showMessage('error', '加载失败: ' + e.message, 'analyze-messages');
  }
}

async function openReportsDirectory() {
  try {
    const res = await api.openReportsDirectory();
    if (res.success) showMessage('success', '已打开报告目录', 'analyze-messages');
    else showMessage('error', '打开目录失败: ' + res.error, 'analyze-messages');
  } catch (e) { showMessage('error', '打开目录失败: ' + e.message, 'analyze-messages'); }
}

/* ---------- 解析配置部分 (保持不变) ---------- */

async function loadParserConfigs(options = {}) {
  const sel = $('#config-select');
  if (!sel) return;
  const { preferredId, preserveSelection = true } = options;
  const before = sel.value || '';
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
      if (preferredId) sel.value = preferredId;
      else if (preserveSelection && before) sel.value = before;
    }
  } catch (e) { console.warn('加载配置失败', e); }
}

function handleServerConfigsChanged(evt) {
  loadParserConfigs({ preserveSelection: true });
}

/* ---------- 初始化 ---------- */

export function init() {
  if (inited) return;
  inited = true;

  bind('select-all-logs', 'change', toggleSelectAllLogs);
  bind('analyze-logs-btn', 'click', analyzeLogs);
  bind('refresh-logs-btn', 'click', loadDownloadedLogs);
  bind('open-reports-dir-btn', 'click', openReportsDirectory);

  // 初始化动态UI
  injectStyles();
  createToolbar();
  createPagination();

  loadDownloadedLogs();
  loadParserConfigs();
  updateAnalyzeButton();
  renderAnalysisStats([]);

  window.addEventListener('parser-config:changed', () => loadParserConfigs({ preserveSelection: true }));
}

export function handleServerConfigsEvent(evt) { handleServerConfigsChanged(evt); }
export function refreshDownloadedLogs(options = {}) { return loadDownloadedLogs({ ...options, silent: true, skipButton: true }); }