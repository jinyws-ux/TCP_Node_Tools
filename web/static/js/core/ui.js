// core/ui.js
export function setButtonLoading(target, isLoading, opts = {}) {
  // 兼容：既支持传字符串 id，也支持直接传按钮元素
  const button = typeof target === 'string'
    ? document.getElementById(target)
    : target;

  // 找不到就静默返回 false，避免控制台噪音
  if (!button) return false;

  const textMap = {
    'search-logs-btn': '<i class="fas fa-search"></i> 搜索日志',
    'download-selected-btn': '<i class="fas fa-download"></i> 下载选中文件',
    'analyze-logs-btn': '<i class="fas fa-play"></i> 开始分析',
    'save-config-btn': '<i class="fas fa-save"></i> 保存配置',
    'refresh-logs-btn': '<i class="fas fa-sync"></i> 刷新列表',
    'load-parser-config-btn': '<i class="fas fa-sync"></i> 刷新配置'
  };

  if (isLoading) {
    // 已经是 loading 就别重复处理
    if (button.dataset.loading === '1') return true;

    button.dataset.loading = '1';
    // 进入 loading 前缓存原来的 HTML，方便精准还原
    if (!button.dataset._html) button.dataset._html = button.innerHTML;
    // 也把 id 记一下（没有 id 也不影响）
    if (!button.dataset._id && button.id) button.dataset._id = button.id;

    button.disabled = true;
    const text = opts.text || '处理中...';
    button.innerHTML = `<span class="loading" style="margin-right:6px;"></span>${text}`;
    return true;
  }

  // 退出 loading
  if (button.dataset.loading !== '1') return false; // 没进过 loading，就不还原
  button.dataset.loading = '0';
  button.disabled = false;

  // 优先还原进入 loading 前缓存的 HTML；没有缓存再用映射表兜底
  const cached = button.dataset._html;
  const id = button.dataset._id || button.id;
  if (cached != null) {
    button.innerHTML = cached;
  } else {
    button.innerHTML = textMap[id] || '<i class="fas fa-check"></i> 完成';
  }

  delete button.dataset._html;
  delete button.dataset._id;
  return true;
}
