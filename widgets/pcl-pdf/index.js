function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  });
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatTime(sec) {
  const n = Number(sec || 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const dt = new Date(n * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

async function fetchJson(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const msg = data?.error || `请求失败: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;

  container.className = 'pcl-root';

  const title = el('h3', { className: 'pcl-title', text: ctx?.widget?.name || 'PCL 转 PDF' });
  const subtitle = el('div', { className: 'pcl-subtitle', text: '选择厂区(OSM) → 自动加载文件列表 → 下载并转换 → 下载 PDF' });
  const header = el('div', { className: 'pcl-header' }, [title, subtitle]);

  const msg = el('div', { className: 'pcl-log pcl-box', style: 'display:none;' });

  const serverSelect = el('select', { className: 'pcl-select' });
  const fileSelect = el('select', { className: 'pcl-select' });

  const serverPath = el('div', { className: 'pcl-subtitle', text: '-' });
  const ghostpclInfo = el('div', { className: 'pcl-subtitle', text: '-' });

  const btnFiles = el('button', { type: 'button', className: 'btn btn-secondary', html: '<i class="fas fa-list"></i> 刷新文件列表' });
  const btnConvert = el('button', { type: 'button', className: 'btn btn-primary', html: '<i class="fas fa-play"></i> 下载并转换', disabled: 'true' });

  const dlLink = el('a', { className: 'btn btn-success', style: 'display:none;', target: '_blank', rel: 'noopener', html: '<i class="fas fa-download"></i> 下载 PDF' });

  const progressText = el('div', { className: 'pcl-subtitle', text: '尚未开始' });
  const progressInner = el('div');
  const progressBar = el('div', { className: 'pcl-bar' }, [progressInner]);
  const progressBox = el('div', { className: 'pcl-progress pcl-box' }, [progressText, progressBar]);

  const meta = el('div', { className: 'pcl-meta pcl-box' }, [
    el('div', {}, [el('div', { className: 'pcl-subtitle', text: '远程目录' }), serverPath]),
    el('div', {}, [el('div', { className: 'pcl-subtitle', text: 'GhostPCL' }), ghostpclInfo]),
  ]);

  const form = el('div', { className: 'pcl-form' }, [
    el('div', { className: 'pcl-field' }, [el('label', { text: '厂区（仅 OSM）' }), serverSelect]),
    el('div', { className: 'pcl-field' }, [el('label', { text: '文件' }), fileSelect]),
    el('div', { className: 'pcl-field', style: 'grid-column: 1 / -1;' }, [el('label', { text: '操作' }), el('div', { className: 'pcl-actions' }, [btnFiles, btnConvert, dlLink])]),
  ]);

  container.appendChild(header);
  container.appendChild(form);
  container.appendChild(meta);
  container.appendChild(progressBox);
  container.appendChild(msg);

  let servers = [];
  let files = [];
  let activeJobId = null;
  let pollTimer = null;

  function showMsg(text) {
    msg.style.display = '';
    msg.textContent = text || '';
  }

  function clearMsg() {
    msg.style.display = 'none';
    msg.textContent = '';
  }

  function setProgress(pct, text) {
    const p = Math.max(0, Math.min(100, Number(pct || 0)));
    progressInner.style.width = `${p}%`;
    progressText.textContent = text || '';
  }

  function updateConvertEnabled() {
    const ok = !!serverSelect.value && !!fileSelect.value;
    if (ok) btnConvert.removeAttribute('disabled');
    else btnConvert.setAttribute('disabled', 'true');
  }

  function fillServers() {
    serverSelect.innerHTML = '';
    const empty = el('option', { value: '', text: '请选择厂区' });
    serverSelect.appendChild(empty);
    servers.forEach((s) => {
      const opt = el('option', { value: s.id, text: s.factory || s.name || s.id });
      serverSelect.appendChild(opt);
    });
  }

  function fillFiles() {
    fileSelect.innerHTML = '';
    const empty = el('option', { value: '', text: '请选择文件' });
    fileSelect.appendChild(empty);
    files.forEach((f) => {
      const label = `${f.filename}  |  ${formatBytes(f.size)}  |  ${formatTime(f.mtime)}`;
      fileSelect.appendChild(el('option', { value: f.filename, text: label }));
    });
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function loadServers() {
    clearMsg();
    setProgress(0, '加载服务器列表...');
    dlLink.style.display = 'none';
    dlLink.removeAttribute('href');
    stopPolling();
    activeJobId = null;

    const data = await fetchJson('/api/pcl/servers');
    servers = Array.isArray(data.items) ? data.items : [];
    fillServers();
    serverPath.textContent = servers?.[0]?.path || '-';
    const ghost = data.ghostpclExe || '-';
    const ghostOk = !!data.ghostpclExists;
    ghostpclInfo.textContent = ghostOk ? `已就绪：${ghost}` : `未找到：${ghost}`;
    setProgress(0, '服务器列表已加载');
    updateConvertEnabled();
  }

  async function loadFiles() {
    clearMsg();
    dlLink.style.display = 'none';
    dlLink.removeAttribute('href');
    stopPolling();
    activeJobId = null;

    const serverId = serverSelect.value;
    if (!serverId) {
      showMsg('请先选择服务器');
      return;
    }

    const s = servers.find((x) => x.id === serverId);
    serverPath.textContent = s?.path || '-';

    setProgress(10, '连接服务器并加载文件列表...');
    const data = await fetchJson('/api/pcl/files', {
      method: 'POST',
      body: { serverId },
    });
    files = Array.isArray(data.files) ? data.files : [];
    fillFiles();
    setProgress(0, files.length ? `已加载 ${files.length} 个文件` : '目录为空或无可用文件');
    updateConvertEnabled();
  }

  async function pollJob(jobId) {
    stopPolling();
    const data = await fetchJson(`/api/pcl/jobs/${encodeURIComponent(jobId)}`);
    const job = data.job || {};
    setProgress(job.progress || 0, `${job.step || job.status} (${job.progress || 0}%)`);
    if (job.status === 'done') {
      const href = `/api/pcl/jobs/${encodeURIComponent(jobId)}/pdf`;
      dlLink.setAttribute('href', href);
      dlLink.style.display = '';
      setProgress(100, '完成：可下载 PDF');
      return;
    }
    if (job.status === 'error') {
      showMsg(job.error || '任务失败');
      return;
    }
    pollTimer = window.setTimeout(() => pollJob(jobId), 900);
  }

  async function startConvert() {
    clearMsg();
    dlLink.style.display = 'none';
    dlLink.removeAttribute('href');

    const serverId = serverSelect.value;
    const filename = fileSelect.value;
    if (!serverId || !filename) {
      showMsg('请选择服务器与文件');
      return;
    }

    setProgress(5, '任务已提交...');
    const data = await fetchJson('/api/pcl/convert', {
      method: 'POST',
      body: { serverId, filename },
    });
    activeJobId = data.jobId;
    setProgress(10, '开始处理...');
    pollJob(activeJobId);
  }

  btnFiles.addEventListener('click', () => loadFiles().catch((e) => showMsg(e.message)));
  btnConvert.addEventListener('click', () => startConvert().catch((e) => showMsg(e.message)));
  serverSelect.addEventListener('change', () => {
    files = [];
    fillFiles();
    updateConvertEnabled();
    const s = servers.find((x) => x.id === serverSelect.value);
    serverPath.textContent = s?.path || '-';
    if (serverSelect.value) {
      loadFiles().catch((e) => showMsg(e.message));
    }
  });
  fileSelect.addEventListener('change', updateConvertEnabled);

  try {
    await loadServers();
  } catch (e) {
    showMsg(e?.message || String(e));
  }

  return {
    unmount() {
      stopPolling();
      container.innerHTML = '';
    },
  };
}
