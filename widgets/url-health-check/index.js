const CONFIG_API = '/api/widgets/url-health-check/config';
const CONFIG_FILE_HINT = 'widgets/url-health-check/config.json';

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (k === 'className') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'value') node.value = String(v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, String(v));
    });
  }
  children.flat().forEach((c) => {
    if (c === undefined || c === null) return;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  });
  return node;
}

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function normalizeFactoriesConfig(raw) {
  const factories = Array.isArray(raw?.factories) ? raw.factories : [];
  const out = [];
  factories.forEach((f) => {
    let id = String(f?.id || '').trim();
    let name = String(f?.name || '').trim();
    if (!id && name) id = name;
    if (!name && id) name = id;
    const urls = Array.isArray(f?.urls) ? f.urls : [];
    const normalizedUrls = urls.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 2);
    if (!id || !name || normalizedUrls.length !== 2) return;
    out.push({ id, name, urls: normalizedUrls });
  });
  return out;
}

function normalizeStore(raw) {
  const profilesRaw = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const profiles = profilesRaw.map((p) => {
    const id = String(p?.id || '').trim() || uid('profile');
    const name = String(p?.name || '').trim();
    const factories = normalizeFactoriesConfig(p);
    return { id, name, factories };
  }).filter((p) => p.name);

  const activeProfileId = String(raw?.activeProfileId || '').trim();
  const activeId = profiles.some((p) => p.id === activeProfileId) ? activeProfileId : (profiles[0]?.id || '');
  return { profiles, activeProfileId: activeId };
}

function migrateLegacyIfNeeded(raw) {
  return raw;
}

async function apiGetStore() {
  const res = await fetch(CONFIG_API, { method: 'GET' });
  const text = await res.text();
  const parsed = safeJsonParse(text);
  if (!res.ok) {
    const msg = parsed.ok ? (parsed.value?.error || `HTTP ${res.status}`) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!parsed.ok) throw new Error('配置读取失败：响应不是合法 JSON');
  const payload = parsed.value;
  if (!payload?.success) throw new Error(payload?.error || '配置读取失败');
  return normalizeStore(migrateLegacyIfNeeded(payload?.data || {}));
}

async function apiSaveStore(obj) {
  const res = await fetch(CONFIG_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  const text = await res.text();
  const parsed = safeJsonParse(text);
  if (!res.ok) {
    const msg = parsed.ok ? (parsed.value?.error || `HTTP ${res.status}`) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!parsed.ok) throw new Error('配置保存失败：响应不是合法 JSON');
  if (!parsed.value?.success) throw new Error(parsed.value?.error || '配置保存失败');
}

function classifyStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'OK') return { ok: true, text: 'OK' };
  if (!s) return { ok: false, text: '-' };
  return { ok: false, text: s };
}

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.responseText = text;
      throw err;
    }
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      const err = new Error(`JSON 解析失败：${parsed.error}`);
      err.responseText = text;
      throw err;
    }
    return parsed.value;
  } finally {
    window.clearTimeout(timer);
  }
}

function extractItems(payload) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  return targets.map((t) => ({
    target: String(t?.target || '').trim(),
    status: String(t?.status || '').trim(),
    message: t?.message === undefined || t?.message === null ? '' : String(t.message),
  })).filter((x) => x.target);
}

function renderStatusBadge(status) {
  const st = classifyStatus(status);
  const cls = st.ok ? 'uhc-badge uhc-badge--ok' : 'uhc-badge uhc-badge--bad';
  const icon = st.ok ? 'fas fa-check' : 'fas fa-times';
  return el('span', { className: cls }, el('i', { className: icon }), st.text);
}

function renderSection({ factoryName, url, payload, error }) {
  const section = el('div', { className: 'uhc-section' });
  const head = el('div', { className: 'uhc-section-head' });
  const title = el('h4', { className: 'uhc-section-title', text: factoryName });
  const urlEl = el('div', { className: 'uhc-section-url', text: url, title: url });
  head.appendChild(el('div', { className: 'uhc-row' }, title, urlEl));
  section.appendChild(head);

  if (error) {
    const badge = renderStatusBadge('ERROR');
    head.appendChild(badge);
    const body = el('div', { style: 'padding: 10px 12px;' },
      el('div', { className: 'uhc-item-msg' }, el('pre', { text: String(error) }))
    );
    section.appendChild(body);
    return section;
  }

  const items = extractItems(payload);
  const badCount = items.filter((x) => !classifyStatus(x.status).ok).length;
  const okCount = items.length - badCount;

  const badgeText = badCount ? `异常 ${badCount}` : `通过 ${okCount}`;
  const badge = renderStatusBadge(badCount ? 'BAD' : 'OK');
  badge.appendChild(el('span', { style: 'margin-left:6px;font-weight:700;' }, badgeText));
  head.appendChild(badge);

  const table = el('table', { className: 'uhc-table' });
  table.appendChild(el('thead', null,
    el('tr', null,
      el('th', { text: '检测项' }),
      el('th', { text: '状态' }),
      el('th', { text: '信息' })
    )
  ));

  const tbody = el('tbody');
  items.forEach((it) => {
    const msg = it.message ? el('div', { className: 'uhc-item-msg' }, el('pre', { text: it.message })) : el('span', { className: 'uhc-item-msg', text: '-' });
    tbody.appendChild(el('tr', null,
      el('td', null, el('div', { className: 'uhc-item-name', text: it.target })),
      el('td', null, renderStatusBadge(it.status)),
      el('td', null, msg)
    ));
  });
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function findActiveProfile(store) {
  const id = String(store?.activeProfileId || '').trim();
  const profiles = Array.isArray(store?.profiles) ? store.profiles : [];
  return profiles.find((p) => p.id === id) || profiles[0] || null;
}

function cleanUrl(url) {
  return String(url || '').trim();
}

function validateProfileDraft(draft) {
  const name = String(draft?.name || '').trim();
  if (!name) return { ok: false, error: '请填写配置名' };
  const factories = Array.isArray(draft?.factories) ? draft.factories : [];
  if (!factories.length) return { ok: false, error: '请至少添加一个厂区' };
  for (const f of factories) {
    const fid = String(f?.id || '').trim();
    const fname = String(f?.name || '').trim();
    const urls = Array.isArray(f?.urls) ? f.urls : [];
    const u1 = cleanUrl(urls[0]);
    const u2 = cleanUrl(urls[1]);
    const label = fname || fid;
    if (!label) return { ok: false, error: '厂区不能为空' };
    if (!u1 || !u2) return { ok: false, error: `厂区「${label}」必须填写 2 个 URL` };
  }
  return { ok: true };
}

export async function mount(ctx) {
  const container = ctx?.container;
  if (!container) return null;
  container.className = 'uhc-root';

  const title = el('h3', { className: 'uhc-title', text: ctx?.widget?.name || 'URL 健康检查' });
  const subtitle = el('p', { className: 'uhc-subtitle', text: '先选择配置与厂区，再点击检查：每个厂区会请求 2 个 URL，并解析返回 JSON 的 targets[].target/status。' });
  container.appendChild(title);
  container.appendChild(subtitle);

  const state = {
    store: { profiles: [], activeProfileId: '' },
    selected: new Set(),
    running: false,
  };

  const cfgCard = el('div', { className: 'uhc-card' });
  const cfgRow = el('div', { className: 'uhc-row' });
  const cfgLeft = el('div', null, el('strong', { text: '选择配置' }));
  const cfgActions = el('div', { className: 'uhc-actions' });
  const profileSelect = el('select', { className: 'uhc-select' });
  const btnManage = el('button', { type: 'button', className: 'btn btn-outline btn-sm', html: '<i class="fas fa-sliders-h"></i> 配置' });
  const btnSelectAll = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', html: '<i class="fas fa-check-double"></i> 全选' });
  const btnSelectNone = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', html: '<i class="fas fa-ban"></i> 清空' });
  const btnRun = el('button', { type: 'button', className: 'btn btn-primary btn-sm', html: '<i class="fas fa-play"></i> 检查' });
  cfgActions.append(btnManage, btnSelectAll, btnSelectNone, btnRun);
  cfgRow.append(cfgLeft, el('div', { className: 'uhc-profile-row' }, profileSelect, cfgActions));
  cfgCard.appendChild(cfgRow);

  const factoryList = el('div', { className: 'uhc-factory-list' });
  cfgCard.appendChild(factoryList);

  const configPanel = el('div', { className: 'uhc-config' });
  const configModal = el('div', { className: 'uhc-config-modal' });
  const configHead = el('div', { className: 'uhc-config-head' },
    el('div', null,
      el('div', { className: 'uhc-config-title', text: '配置管理' }),
      el('div', { className: 'uhc-config-sub', text: `配置文件：${CONFIG_FILE_HINT}（服务器共享）` }),
    ),
    el('button', { type: 'button', className: 'btn btn-secondary btn-xs', html: '<i class="fas fa-times"></i>', title: '关闭' })
  );
  const configStatus = el('div', { className: 'uhc-config-status' });
  const configBody = el('div', { className: 'uhc-config-body' });
  configModal.append(configHead, configStatus, configBody);
  configPanel.appendChild(configModal);

  const results = el('div', { className: 'uhc-results' });
  container.append(cfgCard, configPanel, results);

  const setRunning = (running) => {
    state.running = !!running;
    btnRun.disabled = state.running;
    btnManage.disabled = state.running;
    btnSelectAll.disabled = state.running;
    btnSelectNone.disabled = state.running;
    factoryList.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.disabled = state.running));
  };

  const getActiveProfile = () => findActiveProfile(state.store);

  const setConfigStatus = (type, message) => {
    const t = String(type || '').trim();
    configStatus.className = `uhc-config-status${t ? ` uhc-config-status--${t}` : ''}`;
    configStatus.textContent = message ? String(message) : '';
    configStatus.style.display = message ? 'block' : 'none';
  };

  const closeConfig = () => {
    setConfigStatus('', '');
    configPanel.classList.remove('is-open');
  };
  const openConfig = () => {
    if (state.running) return;
    setConfigStatus('', '');
    configPanel.classList.add('is-open');
    renderConfigEditor();
  };

  const renderFactories = () => {
    factoryList.innerHTML = '';
    const profile = getActiveProfile();
    const factories = profile?.factories || [];
    if (!factories.length) {
      factoryList.appendChild(el('div', { className: 'message-empty', text: '暂无配置。请先点“配置”创建配置。' }));
      return;
    }

    factories.forEach((f) => {
      const checked = state.selected.has(f.id);
      const chk = el('input', { type: 'checkbox' });
      chk.checked = checked;
      chk.addEventListener('change', () => {
        if (chk.checked) state.selected.add(f.id);
        else state.selected.delete(f.id);
      });

      const left = el('div', { className: 'uhc-factory-left' },
        chk,
        el('div', { style: 'min-width:0;display:flex;flex-direction:column;gap:2px;' },
          el('div', { className: 'uhc-factory-name', text: f.name }),
        )
      );

      factoryList.appendChild(el('div', { className: 'uhc-factory-item' }, left));
    });
  };

  const renderResults = (nodes) => {
    results.innerHTML = '';
    nodes.forEach((n) => results.appendChild(n));
  };

  const buildRequests = () => {
    const profile = getActiveProfile();
    const factories = Array.isArray(profile?.factories) ? profile.factories : [];
    const selectedFactories = factories.filter((f) => state.selected.has(f.id));
    const tasks = [];
    selectedFactories.forEach((f) => {
      f.urls.forEach((url) => tasks.push({ factoryId: f.id, factoryName: f.name, url }));
    });
    return tasks;
  };

  const renderProfileSelect = () => {
    const profiles = Array.isArray(state.store?.profiles) ? state.store.profiles : [];
    profileSelect.innerHTML = '';
    if (!profiles.length) {
      profileSelect.appendChild(el('option', { value: '', text: '未配置' }));
      profileSelect.disabled = true;
      btnSelectAll.disabled = true;
      btnSelectNone.disabled = true;
      btnRun.disabled = true;
      return;
    }
    profileSelect.disabled = false;
    btnSelectAll.disabled = false;
    btnSelectNone.disabled = false;
    btnRun.disabled = false;
    profiles.forEach((p) => {
      profileSelect.appendChild(el('option', { value: p.id, text: p.name }));
    });
    profileSelect.value = String(state.store.activeProfileId || profiles[0].id);
  };

  const renderConfigEditor = () => {
    const profiles = Array.isArray(state.store?.profiles) ? state.store.profiles : [];
    const active = getActiveProfile();

    const draft = {
      id: active?.id || '',
      name: active?.name || '',
      factories: Array.isArray(active?.factories) ? active.factories.map((f) => ({
        id: f.id || f.name,
        name: f.name || f.id,
        urls: [f.urls?.[0] || '', f.urls?.[1] || ''],
      })) : [],
    };

    const profilePicker = el('select', { className: 'uhc-select' });
    profilePicker.appendChild(el('option', { value: '', text: '新建配置' }));
    profiles.forEach((p) => profilePicker.appendChild(el('option', { value: p.id, text: p.name })));
    profilePicker.value = draft.id || '';

    const inputName = el('input', { className: 'uhc-input', value: draft.name, placeholder: '配置名' });

    const btnNewProfile = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', html: '<i class="fas fa-plus"></i> 新建' });
    const btnDeleteProfile = el('button', { type: 'button', className: 'btn btn-danger btn-sm', html: '<i class="fas fa-trash"></i> 删除' });
    const btnSaveProfile = el('button', { type: 'button', className: 'btn btn-primary btn-sm', html: '<i class="fas fa-save"></i> 保存' });

    const header = el('div', { className: 'uhc-editor-head' },
      el('div', { className: 'uhc-editor-row' },
        el('div', { className: 'uhc-field' }, el('div', { className: 'uhc-label', text: '当前配置' }), profilePicker),
        el('div', { className: 'uhc-field', style: 'flex:1;min-width:220px;' }, el('div', { className: 'uhc-label', text: '配置名' }), inputName),
        el('div', { className: 'uhc-actions' }, btnNewProfile, btnDeleteProfile, btnSaveProfile),
      )
    );

    const table = el('table', { className: 'uhc-edit-table' });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', { text: '厂区' }),
        el('th', { text: 'URL 1' }),
        el('th', { text: 'URL 2' }),
        el('th', { text: '' }),
      )
    ));
    const tbody = el('tbody');
    table.appendChild(tbody);

    const addRow = (row) => {
      const labelValue = String(row?.name || row?.id || '').trim();
      const labelInput = el('input', { className: 'uhc-input', value: labelValue, placeholder: '例如：大东' });
      const url1Input = el('input', { className: 'uhc-input', value: row?.urls?.[0] || '', placeholder: 'https://.../health' });
      const url2Input = el('input', { className: 'uhc-input', value: row?.urls?.[1] || '', placeholder: 'https://.../health' });
      const btnRemove = el('button', { type: 'button', className: 'btn btn-danger btn-xs', html: '<i class="fas fa-minus"></i>', title: '删除厂区' });

      const tr = el('tr', null,
        el('td', null, labelInput),
        el('td', null, url1Input),
        el('td', null, url2Input),
        el('td', null, btnRemove),
      );

      btnRemove.addEventListener('click', () => {
        tr.remove();
      });

      tbody.appendChild(tr);
    };

    const syncDraftFromUi = () => {
      const name = String(inputName.value || '').trim();
      const factories = [];
      Array.from(tbody.querySelectorAll('tr')).forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        const label = String(tds[0]?.querySelector('input')?.value || '').trim();
        const u1 = cleanUrl(tds[1]?.querySelector('input')?.value || '');
        const u2 = cleanUrl(tds[2]?.querySelector('input')?.value || '');
        if (!label && !u1 && !u2) return;
        factories.push({ id: label, name: label, urls: [u1, u2] });
      });
      draft.name = name;
      draft.factories = factories;
      return draft;
    };

    const btnAddFactory = el('button', { type: 'button', className: 'btn btn-secondary btn-sm', html: '<i class="fas fa-plus"></i> 添加厂区' });
    const footer = el('div', { className: 'uhc-editor-footer' }, btnAddFactory);

    btnAddFactory.addEventListener('click', () => addRow({ id: '', name: '', urls: ['', ''] }));

    const setEditorProfile = (profileId) => {
      const p = profiles.find((x) => x.id === profileId) || null;
      draft.id = p?.id || '';
      draft.name = p?.name || '';
      draft.factories = Array.isArray(p?.factories)
        ? p.factories.map((f) => ({ id: f.id || f.name, name: f.name || f.id, urls: [f.urls?.[0] || '', f.urls?.[1] || ''] }))
        : [];
      inputName.value = draft.name;
      tbody.innerHTML = '';
      (draft.factories.length ? draft.factories : []).forEach((r) => addRow(r));
      btnDeleteProfile.disabled = !draft.id;
    };

    profilePicker.addEventListener('change', () => {
      const pid = String(profilePicker.value || '');
      setEditorProfile(pid);
    });

    btnNewProfile.addEventListener('click', () => {
      profilePicker.value = '';
      setEditorProfile('');
      inputName.focus();
    });

    btnDeleteProfile.addEventListener('click', async () => {
      if (!draft.id) return;
      const p = profiles.find((x) => x.id === draft.id);
      if (!p) return;
      if (!confirm(`确认删除配置「${p.name}」？`)) return;
      state.store.profiles = profiles.filter((x) => x.id !== draft.id);
      if (state.store.activeProfileId === draft.id) {
        state.store.activeProfileId = state.store.profiles[0]?.id || '';
      }
      setConfigStatus('info', '删除中…');
      try {
        await apiSaveStore(state.store);
      } catch (err) {
        setConfigStatus('error', `删除失败：${err?.message || String(err)}`);
        return;
      }
      renderProfileSelect();
      state.selected.clear();
      renderFactories();
      setConfigStatus('success', '已删除');
      window.setTimeout(closeConfig, 200);
      ctx?.showMessage?.('success', '配置已删除');
    });

    btnSaveProfile.addEventListener('click', async () => {
      const d = syncDraftFromUi();
      const check = validateProfileDraft(d);
      if (!check.ok) {
        setConfigStatus('error', check.error);
        ctx?.showMessage?.('error', check.error);
        return;
      }
      const nextProfile = {
        id: d.id || uid('profile'),
        name: String(d.name || '').trim(),
        factories: d.factories.map((f) => {
          const label = String(f.name || f.id || '').trim();
          return { id: label, name: label, urls: [cleanUrl(f.urls[0]), cleanUrl(f.urls[1])] };
        }),
      };
      const existed = profiles.find((x) => x.id === nextProfile.id);
      if (existed) {
        state.store.profiles = profiles.map((x) => x.id === nextProfile.id ? nextProfile : x);
      } else {
        state.store.profiles = profiles.concat(nextProfile);
      }
      state.store.activeProfileId = nextProfile.id;
      setConfigStatus('info', '保存中…');
      try {
        await apiSaveStore(state.store);
      } catch (err) {
        setConfigStatus('error', `保存失败：${err?.message || String(err)}`);
        ctx?.showMessage?.('error', `保存配置失败：${err?.message || String(err)}`);
        return;
      }
      renderProfileSelect();
      profileSelect.value = nextProfile.id;
      state.selected.clear();
      renderFactories();
      setConfigStatus('success', '已保存');
      window.setTimeout(closeConfig, 200);
      ctx?.showMessage?.('success', '配置已保存');
    });

    configBody.innerHTML = '';
    configBody.append(header, table, footer);
    setEditorProfile(draft.id);
    btnDeleteProfile.disabled = !draft.id;
    if (!draft.factories.length) {
      addRow({ id: '', name: '', urls: ['', ''] });
    }
  };

  btnManage.addEventListener('click', openConfig);
  configHead.querySelector('button')?.addEventListener('click', closeConfig);

  profileSelect.addEventListener('change', () => {
    if (state.running) return;
    state.store.activeProfileId = String(profileSelect.value || '');
    apiSaveStore(state.store).catch((err) => {
      ctx?.showMessage?.('error', `保存配置失败：${err?.message || String(err)}`);
    });
    state.selected.clear();
    renderFactories();
  });

  btnSelectAll.addEventListener('click', () => {
    if (state.running) return;
    const profile = getActiveProfile();
    (profile?.factories || []).forEach((f) => state.selected.add(f.id));
    renderFactories();
  });

  btnSelectNone.addEventListener('click', () => {
    if (state.running) return;
    state.selected.clear();
    renderFactories();
  });

  btnRun.addEventListener('click', async () => {
    if (state.running) return;
    if (!getActiveProfile()) {
      ctx?.showMessage?.('warning', '请先创建配置');
      return;
    }
    const tasks = buildRequests();
    if (!tasks.length) {
      ctx?.showMessage?.('warning', '请先勾选至少一个厂区');
      return;
    }

    setRunning(true);
    renderResults([el('div', { className: 'message-empty', text: '检查中…' })]);

    const sections = [];
    await Promise.all(tasks.map(async (t) => {
      try {
        const payload = await fetchJson(t.url, { timeoutMs: 12000 });
        sections.push(renderSection({ factoryName: t.factoryName, url: t.url, payload }));
      } catch (err) {
        const msg = err?.message || String(err);
        sections.push(renderSection({ factoryName: t.factoryName, url: t.url, error: msg }));
      }
    }));

    sections.sort((a, b) => {
      const ta = a.querySelector('.uhc-section-title')?.textContent || '';
      const tb = b.querySelector('.uhc-section-title')?.textContent || '';
      return ta.localeCompare(tb);
    });

    renderResults(sections);
    setRunning(false);
  });

  renderResults([el('div', { className: 'message-empty', text: '读取配置中…' })]);
  try {
    state.store = await apiGetStore();
  } catch (err) {
    ctx?.showMessage?.('error', `读取共享配置失败：${err?.message || String(err)}`);
    state.store = { profiles: [], activeProfileId: '' };
  }
  renderResults([]);
  renderProfileSelect();
  renderFactories();

  return {
    unmount() {
      container.innerHTML = '';
    }
  };
}
