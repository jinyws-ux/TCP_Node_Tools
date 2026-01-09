import { showMessage } from '../core/messages.js';

/**
 * 初始化清理模块
 */
export function initCleanupModule() {
    const btn = document.getElementById('cleanup-settings-btn');
    if (btn) {
        btn.addEventListener('click', showCleanupModal);
    }

    // 模态框关闭按钮
    const closeBtn = document.getElementById('close-cleanup-modal');
    const cancelBtn = document.getElementById('cancel-cleanup-modal');
    if (closeBtn) closeBtn.addEventListener('click', hideCleanupModal);
    if (cancelBtn) cancelBtn.addEventListener('click', hideCleanupModal);

    // 保存按钮
    const saveBtn = document.getElementById('save-cleanup-config');
    if (saveBtn) saveBtn.addEventListener('click', saveCleanupConfig);

    // Tab 切换
    const tabBtns = document.querySelectorAll('.cleanup-tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // 切换 Tab 样式
            tabBtns.forEach(b => {
                b.classList.remove('active');
                b.style.borderBottom = '2px solid transparent';
            });
            e.target.classList.add('active');
            e.target.style.borderBottom = '2px solid #007bff';

            // 切换内容显示
            const targetId = e.target.dataset.target;
            document.querySelectorAll('.cleanup-tab-content').forEach(content => {
                content.style.display = 'none';
            });
            document.getElementById(targetId).style.display = 'block';

            // 如果切换到日志 Tab，加载日志列表
            if (targetId === 'cleanup-logs-tab') {
                loadCleanupLogs();
            }
        });
    });
}

// 显示模态框
async function showCleanupModal() {
    const modal = document.getElementById('cleanup-modal');
    if (modal) {
        modal.style.display = 'block';
        await loadCleanupConfig();
    }
}

// 隐藏模态框
function hideCleanupModal() {
    const modal = document.getElementById('cleanup-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 加载配置
async function loadCleanupConfig() {
    try {
        const response = await fetch('/api/cleanup/config');
        const config = await response.json();

        document.getElementById('cleanup-enabled').checked = config.enabled !== false; // 默认为 true
        document.getElementById('cleanup-time').value = config.schedule_time || '05:00';
        document.getElementById('cleanup-retention').value = config.retention_days || 14;
    } catch (error) {
        console.error('加载清理配置失败:', error);
        showMessage('error', '加载配置失败', 'analyze-messages');
    }
}

// 保存配置
async function saveCleanupConfig() {
    const enabled = document.getElementById('cleanup-enabled').checked;
    const time = document.getElementById('cleanup-time').value;
    const retention = parseInt(document.getElementById('cleanup-retention').value);

    if (!time) {
        showMessage('warning', '请设置执行时间', 'analyze-messages');
        return;
    }
    if (isNaN(retention) || retention < 1) {
        showMessage('warning', '保留天数无效', 'analyze-messages');
        return;
    }

    try {
        const response = await fetch('/api/cleanup/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                enabled: enabled,
                schedule_time: time,
                retention_days: retention
            })
        });

        const result = await response.json();
        if (result.success) {
            showMessage('success', '配置已保存', 'analyze-messages');
            hideCleanupModal();
        } else {
            showMessage('error', '保存失败: ' + result.error, 'analyze-messages');
        }
    } catch (error) {
        console.error('保存清理配置失败:', error);
        showMessage('error', '保存失败', 'analyze-messages');
    }
}

// 加载日志列表
async function loadCleanupLogs() {
    const tbody = document.getElementById('cleanup-logs-list');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">加载中...</td></tr>';

    try {
        const response = await fetch('/api/cleanup/logs');
        const logs = await response.json();

        if (!logs || logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">无日志文件</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        logs.forEach(log => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #2a2f45';
            
            const fileName = log.log_path.split(/[\\/]/).pop();
            const isLocked = log.is_locked;
            const statusClass = isLocked ? 'text-success' : 'text-warning';
            const statusText = isLocked ? '已锁定 (保护中)' : '未锁定 (可清理)';
            const lockBtnText = isLocked ? '解锁' : '锁定';
            const lockBtnClass = isLocked ? 'btn-warning' : 'btn-success';
            const lockBtnIcon = isLocked ? 'fa-unlock' : 'fa-lock';

            tr.innerHTML = `
                <td style="padding: 8px;">${fileName}</td>
                <td style="padding: 8px;">${log.file_age_days} 天前</td>
                <td style="padding: 8px; text-align: center;" class="${statusClass}">
                    ${statusText}
                </td>
                <td style="padding: 8px; text-align: center;">
                    <button class="btn btn-sm ${lockBtnClass}" onclick="window.toggleLogLock('${log.log_path.replace(/\\/g, '\\\\')}', ${!isLocked})">
                        <i class="fas ${lockBtnIcon}"></i> ${lockBtnText}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error('加载日志列表失败:', error);
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: red;">加载失败</td></tr>';
    }
}

// 暴露给全局以便 HTML onclick 调用
window.toggleLogLock = async function(logPath, locked) {
    try {
        const response = await fetch('/api/cleanup/lock', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                log_path: logPath,
                locked: locked
            })
        });

        const result = await response.json();
        if (result.success) {
            showMessage(locked ? 'success' : 'success', locked ? '日志已锁定' : '日志已解锁', 'analyze-messages');
            loadCleanupLogs(); // 刷新列表
            
            // 派发全局事件通知其他模块
            window.dispatchEvent(new CustomEvent('log-lock-changed', {
                detail: {
                    logPath: logPath,
                    isLocked: locked
                }
            }));
        } else {
            showMessage('error', '操作失败: ' + result.error, 'analyze-messages');
        }
    } catch (error) {
        console.error('切换锁定状态失败:', error);
        showMessage('error', '操作失败', 'analyze-messages');
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initCleanupModule);
