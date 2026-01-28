function formatLocal(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = dt.getFullYear();
  const m = pad(dt.getMonth() + 1);
  const d = pad(dt.getDate());
  const hh = pad(dt.getHours());
  const mm = pad(dt.getMinutes());
  const ss = pad(dt.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;

  container.className = 'hc-root';

  const title = document.createElement('h3');
  title.className = 'hc-title';
  title.textContent = ctx?.widget?.name || '时钟';
  container.appendChild(title);

  const nowBox = document.createElement('div');
  nowBox.className = 'hc-now';
  container.appendChild(nowBox);

  const row = document.createElement('div');
  row.className = 'hc-row';
  container.appendChild(row);

  const btnCopyTs = document.createElement('button');
  btnCopyTs.type = 'button';
  btnCopyTs.className = 'btn btn-primary';
  btnCopyTs.innerHTML = '<i class="fas fa-copy"></i> 复制时间戳(ms)';
  row.appendChild(btnCopyTs);

  const btnCopyStr = document.createElement('button');
  btnCopyStr.type = 'button';
  btnCopyStr.className = 'btn btn-secondary';
  btnCopyStr.innerHTML = '<i class="fas fa-copy"></i> 复制时间字符串';
  row.appendChild(btnCopyStr);

  const hint = document.createElement('div');
  hint.className = 'hc-hint';
  hint.textContent = '可用于快速粘贴到日志/脚本中。';
  container.appendChild(hint);

  const render = () => {
    const dt = new Date();
    nowBox.textContent = `${formatLocal(dt)}  |  ${dt.getTime()}`;
  };

  render();
  const timer = window.setInterval(render, 1000);

  btnCopyTs.addEventListener('click', async () => {
    const text = String(Date.now());
    try {
      await copyText(text);
      ctx?.showMessage?.('success', '已复制当前时间戳');
    } catch (err) {
      ctx?.showMessage?.('error', `复制失败：${err?.message || String(err)}`);
    }
  });

  btnCopyStr.addEventListener('click', async () => {
    const text = formatLocal(new Date());
    try {
      await copyText(text);
      ctx?.showMessage?.('success', '已复制当前时间字符串');
    } catch (err) {
      ctx?.showMessage?.('error', `复制失败：${err?.message || String(err)}`);
    }
  });

  return {
    unmount() {
      window.clearInterval(timer);
      container.innerHTML = '';
    }
  };
}

