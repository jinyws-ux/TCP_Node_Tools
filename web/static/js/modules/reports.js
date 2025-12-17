// reports.js (报告管理模块)
import * as messages from '../core/messages.js';
import * as ui from '../core/ui.js';
import { api } from '../core/api.js';

const qs = (sel, scope = document) => scope.querySelector(sel);
const qsa = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

// 报告列表缓存
let reportsList = [];

// 初始化模块
async function init() {
  // 检查当前是否在analyze-tab中，只有在日志分析标签页中才初始化报告管理
  const analyzeTab = document.getElementById('analyze-tab');
  if (!analyzeTab || !analyzeTab.classList.contains('active')) {
    return;
  }
  
  // 绑定事件
  bindEvents();
  
  // 刷新报告列表
  await refreshReportsList();
}

// 绑定事件
function bindEvents() {
  // 刷新按钮
  const refreshBtn = qs('#refresh-reports-btn');
  refreshBtn?.addEventListener('click', refreshReportsList);
  
  // 搜索框
  const searchInput = qs('#reports-search');
  searchInput?.addEventListener('input', debounce(handleSearch, 300));
}

// 刷新报告列表
async function refreshReportsList() {
  try {
    ui.setButtonLoading('refresh-reports-btn', true);
    
    // 调用API获取报告列表
    const response = await api.getReportsList();
    
    if (response.success) {
      reportsList = response.reports || [];
      renderReportsList(reportsList);
      messages.showMessage('success', `刷新成功，共找到 ${reportsList.length} 个报告`, 'reports-messages');
    } else {
      messages.showMessage('error', `刷新失败：${response.error || '未知错误'}`, 'reports-messages');
    }
  } catch (err) {
    console.error('刷新报告列表失败:', err);
    messages.showMessage('error', `刷新失败：${err.message || '网络错误'}`, 'reports-messages');
  } finally {
    ui.setButtonLoading('refresh-reports-btn', false);
  }
}

// 渲染报告列表
function renderReportsList(reports) {
  const tbody = qs('#reports-list-body');
  const emptyMessage = qs('#no-reports-message');
  
  if (!tbody || !emptyMessage) return;
  
  if (reports.length === 0) {
    // 显示空状态
    tbody.innerHTML = '<tr><td colspan="5" class="message-empty">暂无报告</td></tr>';
    emptyMessage.style.display = 'block';
  } else {
    // 渲染报告列表
    tbody.innerHTML = reports.map(report => `
      <tr>
        <td>${report.name || '未知报告'}</td>
        <td>${formatDate(report.created_at)}</td>
        <td>${report.log_count || 0}</td>
        <td>${report.abnormal_count || 0}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="window.reportsModule.openReport('${report.report_id || report.name}')">
            <i class="fas fa-eye"></i> 查看
          </button>
          <button class="btn btn-danger btn-sm" onclick="window.reportsModule.deleteReport('${report.report_id || report.name}')">
            <i class="fas fa-trash"></i> 删除
          </button>
        </td>
      </tr>
    `).join('');
    emptyMessage.style.display = 'none';
  }
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return '未知时间';
  
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

// 处理搜索
function handleSearch() {
  const searchTerm = qs('#reports-search').value.trim().toLowerCase();
  
  if (!searchTerm) {
    // 无搜索词，显示全部
    renderReportsList(reportsList);
    return;
  }
  
  // 过滤报告
  const filtered = reportsList.filter(report => {
    const name = (report.name || '').toLowerCase();
    const filename = (report.filename || '').toLowerCase();
    return name.includes(searchTerm) || filename.includes(searchTerm);
  });
  
  renderReportsList(filtered);
}

// 打开报告
async function openReport(reportId) {
  try {
    // 构建报告URL
    const reportUrl = `${window.location.origin}/report/${encodeURIComponent(reportId)}`;
    
    // 在新窗口打开报告
    window.open(reportUrl, '_blank');
  } catch (err) {
    console.error('打开报告失败:', err);
    messages.showMessage('error', `打开报告失败：${err.message || '未知错误'}`, 'reports-messages');
  }
}

// 删除报告
async function deleteReport(reportId) {
  try {
    // 确认删除
    const confirmed = await showConfirm(`确定要删除报告 "${reportId}" 吗？此操作不可恢复。`);
    
    if (!confirmed) return;
    
    // 调用API删除报告
    const response = await api.deleteReport(reportId);
    
    if (response.success) {
      messages.showMessage('success', '报告删除成功', 'reports-messages');
      await refreshReportsList();
    } else {
      messages.showMessage('error', `删除失败：${response.error || '未知错误'}`, 'reports-messages');
    }
  } catch (err) {
    console.error('删除报告失败:', err);
    messages.showMessage('error', `删除失败：${err.message || '网络错误'}`, 'reports-messages');
  }
}

// 显示确认对话框
function showConfirm(message) {
  return new Promise((resolve) => {
    const modal = qs('#confirm-modal');
    const confirmText = qs('#confirm-text');
    const confirmOk = qs('#confirm-ok');
    const confirmCancel = qs('#confirm-cancel');
    
    if (!modal || !confirmText || !confirmOk || !confirmCancel) {
      resolve(false);
      return;
    }
    
    confirmText.textContent = message;
    modal.style.display = 'block';
    
    const okHandler = () => {
      modal.style.display = 'none';
      confirmOk.removeEventListener('click', okHandler);
      confirmCancel.removeEventListener('click', cancelHandler);
      resolve(true);
    };
    
    const cancelHandler = () => {
      modal.style.display = 'none';
      confirmOk.removeEventListener('click', okHandler);
      confirmCancel.removeEventListener('click', cancelHandler);
      resolve(false);
    };
    
    confirmOk.addEventListener('click', okHandler);
    confirmCancel.addEventListener('click', cancelHandler);
  });
}

// 防抖函数
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 暴露模块方法
window.reportsModule = {
    openReport,
    deleteReport
};

// 导出默认模块，方便在analyze.js中导入
const reportsModule = {
    openReport,
    deleteReport,
    init
};

export {
    openReport,
    deleteReport,
    init
};

export default reportsModule;
