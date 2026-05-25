function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (k === 'className') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  });
  (children || []).forEach((child) => {
    if (child) node.appendChild(child);
  });
  return node;
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

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || ''));
}

function bytesToHex(bytes) {
  return Array.from(bytes || []).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(bin);
}

function base64ToBytes(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return new Uint8Array();
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

async function digestText(text, algorithm) {
  const data = utf8Bytes(text);
  const digest = await crypto.subtle.digest(algorithm, data);
  return bytesToHex(new Uint8Array(digest));
}

async function encryptAesGcm(text, secret) {
  const keySeed = await crypto.subtle.digest('SHA-256', utf8Bytes(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keySeed,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8Bytes(text)
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptAesGcm(text, secret) {
  const value = String(text || '').trim();
  const parts = value.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('AES-GCM 解密内容格式不正确，应为 iv:cipher');
  }
  const keySeed = await crypto.subtle.digest('SHA-256', utf8Bytes(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    keySeed,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const iv = base64ToBytes(parts[0]);
  const cipher = base64ToBytes(parts[1]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipher
  );
  return bytesToUtf8(new Uint8Array(plain));
}

function canDecrypt(algorithm) {
  return algorithm === 'base64' || algorithm === 'url' || algorithm === 'aes-gcm';
}

function getAlgorithmNote(mode, algorithm) {
  if (algorithm === 'base64') {
    return mode === 'decrypt'
      ? 'Base64 反解会把 Base64 内容还原成原始文本。'
      : 'Base64 编码适合快速转码，不是严格意义上的加密。';
  }
  if (algorithm === 'url') {
    return mode === 'decrypt'
      ? 'URL 解码会把 `%xx` 这类内容还原成原始文本。'
      : 'URL 编码适合拼接参数或处理特殊字符。';
  }
  if (algorithm === 'sha256') return 'SHA-256 是单向摘要，只能生成，不能反解。';
  if (algorithm === 'sha512') return 'SHA-512 是单向摘要，只能生成，不能反解。';
  return mode === 'decrypt'
    ? 'AES-GCM 解密需要输入密钥，且内容格式必须为 iv:cipher。'
    : 'AES-GCM 对称加密需要输入密钥，结果格式为 iv:cipher。';
}

async function transformText(mode, text, algorithm, secret) {
  const value = String(text || '');
  if (!value) throw new Error('请先输入要处理的文本');
  if (mode === 'decrypt' && !canDecrypt(algorithm)) {
    throw new Error('当前方式不支持解密');
  }
  if (mode === 'encrypt') {
    if (algorithm === 'base64') return bytesToBase64(utf8Bytes(value));
    if (algorithm === 'url') return encodeURIComponent(value);
    if (algorithm === 'sha256') return digestText(value, 'SHA-256');
    if (algorithm === 'sha512') return digestText(value, 'SHA-512');
    if (!String(secret || '').trim()) throw new Error('AES-GCM 需要输入密钥');
    return encryptAesGcm(value, secret);
  }
  if (algorithm === 'base64') return bytesToUtf8(base64ToBytes(value));
  if (algorithm === 'url') return decodeURIComponent(value);
  if (!String(secret || '').trim()) throw new Error('AES-GCM 解密需要输入密钥');
  return decryptAesGcm(value, secret);
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;

  container.className = 'tc-root';

  const title = el('h3', { className: 'tc-title', text: ctx?.widget?.name || '文本加密' });
  const subtitle = el('div', {
    className: 'tc-subtitle',
    text: '输入文本，选择加密或解密方式，直接生成结果。'
  });

  const modeSelect = el('select', { className: 'tc-select' });
  [
    ['encrypt', '加密'],
    ['decrypt', '解密']
  ].forEach(([value, label]) => {
    modeSelect.appendChild(el('option', { value, text: label }));
  });

  const algorithmSelect = el('select', { className: 'tc-select' });
  [
    ['base64', 'Base64'],
    ['url', 'URL 编码'],
    ['sha256', 'SHA-256'],
    ['sha512', 'SHA-512'],
    ['aes-gcm', 'AES-GCM']
  ].forEach(([value, label]) => {
    algorithmSelect.appendChild(el('option', { value, text: label }));
  });

  const sourceInput = el('textarea', {
    className: 'tc-textarea',
    placeholder: '请输入要处理的文本'
  });
  const secretInput = el('input', {
    className: 'tc-input',
    type: 'text',
    placeholder: '仅 AES-GCM 需要输入密钥'
  });
  const resultOutput = el('textarea', {
    className: 'tc-textarea tc-textarea--result',
    readonly: 'readonly',
    placeholder: '处理结果会显示在这里'
  });

  const note = el('div', { className: 'tc-note', text: getAlgorithmNote(modeSelect.value, algorithmSelect.value) });
  const status = el('div', { className: 'tc-status', style: 'display:none;' });
  const sourceLabel = el('label', { className: 'tc-label', text: '原文' });
  const resultLabel = el('label', { className: 'tc-label', text: '结果' });

  const secretField = el('div', { className: 'tc-field tc-secret', style: 'display:none;' }, [
    el('label', { className: 'tc-label', text: '密钥' }),
    secretInput
  ]);

  const form = el('div', { className: 'tc-grid' }, [
    el('div', { className: 'tc-field' }, [
      el('label', { className: 'tc-label', text: '模式' }),
      modeSelect
    ]),
    el('div', { className: 'tc-field' }, [
      el('label', { className: 'tc-label', text: '处理方式' }),
      algorithmSelect
    ]),
    secretField,
    el('div', { className: 'tc-field tc-field--wide' }, [
      sourceLabel,
      sourceInput
    ]),
    el('div', { className: 'tc-field tc-field--wide' }, [
      resultLabel,
      resultOutput
    ])
  ]);

  const btnRun = el('button', {
    type: 'button',
    className: 'btn btn-primary',
    html: '<i class="fas fa-bolt"></i> 生成结果'
  });
  const btnCopy = el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    html: '<i class="fas fa-copy"></i> 复制结果'
  });
  const btnClear = el('button', {
    type: 'button',
    className: 'btn btn-outline',
    html: '<i class="fas fa-eraser"></i> 清空'
  });

  const actions = el('div', { className: 'tc-actions' }, [btnRun, btnCopy, btnClear]);

  container.append(title, subtitle, note, form, actions, status);

  function setStatus(type, message) {
    status.textContent = String(message || '');
    status.className = 'tc-status';
    if (!message) {
      status.style.display = 'none';
      return;
    }
    status.style.display = 'block';
    if (type === 'error') status.classList.add('tc-status--error');
    if (type === 'success') status.classList.add('tc-status--success');
  }

  function refreshMode() {
    const mode = modeSelect.value;
    const algorithm = algorithmSelect.value;
    const isAes = algorithmSelect.value === 'aes-gcm';
    secretField.style.display = isAes ? '' : 'none';
    note.textContent = getAlgorithmNote(mode, algorithm);
    sourceLabel.textContent = mode === 'decrypt' ? '待解内容' : '原文';
    resultLabel.textContent = mode === 'decrypt' ? '解密结果' : '结果';
    sourceInput.placeholder = mode === 'decrypt' ? '请输入要解密或解码的内容' : '请输入要处理的文本';
    resultOutput.placeholder = mode === 'decrypt' ? '解密结果会显示在这里' : '处理结果会显示在这里';
    btnRun.innerHTML = mode === 'decrypt'
      ? '<i class="fas fa-unlock"></i> 开始解密'
      : '<i class="fas fa-bolt"></i> 生成结果';
    setStatus('', '');
    if (mode === 'decrypt' && !canDecrypt(algorithm)) {
      setStatus('error', '当前方式只支持加密，不能反解');
    }
  }

  modeSelect.addEventListener('change', refreshMode);
  algorithmSelect.addEventListener('change', refreshMode);

  btnRun.addEventListener('click', async () => {
    setStatus('', '');
    try {
      const result = await transformText(modeSelect.value, sourceInput.value, algorithmSelect.value, secretInput.value);
      resultOutput.value = result;
      setStatus('success', modeSelect.value === 'decrypt' ? '解密完成' : '处理完成');
    } catch (err) {
      resultOutput.value = '';
      setStatus('error', err?.message || String(err));
      ctx?.showMessage?.('error', err?.message || String(err));
    }
  });

  btnCopy.addEventListener('click', async () => {
    if (!resultOutput.value) {
      setStatus('error', '当前没有可复制的结果');
      return;
    }
    try {
      await copyText(resultOutput.value);
      setStatus('success', '结果已复制');
      ctx?.showMessage?.('success', '结果已复制');
    } catch (err) {
      setStatus('error', `复制失败：${err?.message || String(err)}`);
    }
  });

  btnClear.addEventListener('click', () => {
    sourceInput.value = '';
    secretInput.value = '';
    resultOutput.value = '';
    setStatus('', '');
  });

  refreshMode();

  return {
    unmount() {
      container.innerHTML = '';
    }
  };
}
