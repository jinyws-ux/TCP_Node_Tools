const CONFIG_API = '/api/widgets/template-fill/config';
const DEFAULT_TIME_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSS';

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (k === 'className') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'value') node.value = String(v);
      else if (k === 'checked') node.checked = Boolean(v);
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

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeTemplateType(value) {
  const type = String(value || '').trim().toLowerCase();
  return ['text', 'json', 'sql'].includes(type) ? type : 'text';
}

function normalizeInputType(value) {
  const type = String(value || '').trim().toLowerCase();
  return ['text', 'textarea', 'select', 'generated_time'].includes(type) ? type : 'text';
}

function normalizeOptions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractPlaceholders(content) {
  const found = new Set();
  const list = [];
  const regex = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let match = regex.exec(String(content || ''));
  while (match) {
    const key = String(match[1] || '').trim();
    if (key && !found.has(key)) {
      found.add(key);
      list.push(key);
    }
    match = regex.exec(String(content || ''));
  }
  return list;
}

function normalizeField(raw, keyOverride) {
  const key = String(keyOverride || raw?.key || '').trim();
  if (!key) return null;
  const inputType = normalizeInputType(raw?.inputType);
  const options = normalizeOptions(raw?.options);
  const format = String(raw?.format || '').trim() || DEFAULT_TIME_FORMAT;
  let defaultValue = raw?.defaultValue === undefined || raw?.defaultValue === null ? '' : String(raw.defaultValue);
  if (inputType === 'select' && !defaultValue && options.length) defaultValue = options[0];
  if (inputType === 'generated_time') defaultValue = '';
  return {
    key,
    label: String(raw?.label || key).trim() || key,
    required: Boolean(raw?.required),
    inputType,
    defaultValue,
    options,
    format
  };
}

function mergeFieldsFromContent(content, fields) {
  const placeholders = extractPlaceholders(content);
  const map = new Map();
  (Array.isArray(fields) ? fields : []).forEach((field) => {
    const normalized = normalizeField(field);
    if (normalized) map.set(normalized.key, normalized);
  });
  return placeholders.map((key) => normalizeField(map.get(key) || {}, key));
}

function normalizeTemplate(raw) {
  const id = String(raw?.id || '').trim() || uid('tpl');
  const name = String(raw?.name || '').trim() || '未命名模板';
  const type = normalizeTemplateType(raw?.type);
  const content = raw?.content === undefined || raw?.content === null ? '' : String(raw.content);
  const fields = mergeFieldsFromContent(content, raw?.fields);
  return { id, name, type, content, fields };
}

function normalizeStore(raw) {
  const templates = (Array.isArray(raw?.templates) ? raw.templates : []).map(normalizeTemplate);
  const activeTemplateId = String(raw?.activeTemplateId || '').trim();
  const nextActive = templates.some((item) => item.id === activeTemplateId) ? activeTemplateId : (templates[0]?.id || '');
  return { templates, activeTemplateId: nextActive };
}

function getTypeLabel(type) {
  const value = normalizeTemplateType(type);
  if (value === 'json') return 'JSON';
  if (value === 'sql') return 'SQL';
  return '纯文本';
}

function getInputTypeLabel(type) {
  const value = normalizeInputType(type);
  if (value === 'textarea') return '多行';
  if (value === 'select') return '下拉';
  if (value === 'generated_time') return '时间';
  return '文本';
}

function excerpt(text, limit = 220) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function pad(value, len = 2) {
  return String(value).padStart(len, '0');
}

function formatCurrentTime(format) {
  const dt = new Date();
  const tokenMap = {
    YYYY: String(dt.getFullYear()),
    MM: pad(dt.getMonth() + 1),
    DD: pad(dt.getDate()),
    HH: pad(dt.getHours()),
    mm: pad(dt.getMinutes()),
    ss: pad(dt.getSeconds()),
    SSS: pad(dt.getMilliseconds(), 3)
  };
  return String(format || DEFAULT_TIME_FORMAT).replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (token) => tokenMap[token] || token);
}

function getAutoValue(field) {
  if (field?.inputType !== 'generated_time') return '';
  return formatCurrentTime(field?.format || DEFAULT_TIME_FORMAT);
}

function getEffectiveValue(field, values) {
  if (field?.inputType === 'generated_time') return getAutoValue(field);
  return values?.[field.key] === undefined || values?.[field.key] === null ? '' : String(values[field.key]);
}

async function apiGetStore() {
  const res = await fetch(CONFIG_API, { method: 'GET' });
  const text = await res.text();
  const parsed = safeJsonParse(text);
  if (!res.ok) {
    const msg = parsed.ok ? (parsed.value?.error || `HTTP ${res.status}`) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!parsed.ok) throw new Error('模板读取失败：响应不是合法 JSON');
  if (!parsed.value?.success) throw new Error(parsed.value?.error || '模板读取失败');
  return {
    store: normalizeStore(parsed.value?.data || {}),
    configPath: String(parsed.value?.configPath || '').trim()
  };
}

async function apiSaveStore(payload) {
  const res = await fetch(CONFIG_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  const parsed = safeJsonParse(text);
  if (!res.ok) {
    const msg = parsed.ok ? (parsed.value?.error || `HTTP ${res.status}`) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!parsed.ok) throw new Error('模板保存失败：响应不是合法 JSON');
  if (!parsed.value?.success) throw new Error(parsed.value?.error || '模板保存失败');
}

function createEmptyStore() {
  return { templates: [], activeTemplateId: '' };
}

function createTemplate(name = '') {
  return normalizeTemplate({
    id: uid('tpl'),
    name: name || '新模板',
    type: 'text',
    content: '',
    fields: []
  });
}

function getTemplateById(store, id) {
  const templates = Array.isArray(store?.templates) ? store.templates : [];
  return templates.find((item) => item.id === id) || templates[0] || null;
}

function buildValuesFromTemplate(template, currentValues = {}) {
  const values = {};
  (template?.fields || []).forEach((field) => {
    if (field.inputType === 'generated_time') values[field.key] = getAutoValue(field);
    else if (currentValues[field.key] !== undefined && currentValues[field.key] !== null) values[field.key] = String(currentValues[field.key]);
    else values[field.key] = String(field.defaultValue || '');
  });
  return values;
}

function buildSubmissionValues(template, currentValues = {}) {
  const values = {};
  (template?.fields || []).forEach((field) => {
    values[field.key] = getEffectiveValue(field, currentValues);
  });
  return values;
}

function getTemplateStats(template) {
  const fields = Array.isArray(template?.fields) ? template.fields : [];
  return {
    total: fields.length,
    required: fields.filter((field) => field.required).length
  };
}

function getMissingRequiredFields(template, values) {
  const fields = Array.isArray(template?.fields) ? template.fields : [];
  return fields.filter((field) => field.required && !String(getEffectiveValue(field, values) || '').trim());
}

function validateStore(store) {
  const templates = Array.isArray(store?.templates) ? store.templates : [];
  const names = new Set();
  for (const rawTemplate of templates) {
    const template = normalizeTemplate(rawTemplate);
    if (!template.name.trim()) return { ok: false, error: '模板名称不能为空' };
    if (!template.content.trim()) return { ok: false, error: `模板「${template.name}」内容不能为空` };
    if (names.has(template.name)) return { ok: false, error: `模板名称重复：${template.name}` };
    names.add(template.name);
    for (const field of template.fields) {
      if (field.inputType === 'select' && !field.options.length) {
        return { ok: false, error: `模板「${template.name}」中的变量「${field.key}」下拉选项不能为空` };
      }
      if (field.inputType === 'generated_time' && !String(field.format || '').trim()) {
        return { ok: false, error: `模板「${template.name}」中的时间变量「${field.key}」格式不能为空` };
      }
    }
  }
  return { ok: true };
}

function validateValues(template, values) {
  const missing = getMissingRequiredFields(template, values);
  if (missing.length) return { ok: false, error: `请填写「${missing[0].label || missing[0].key}」` };
  return { ok: true };
}

function renderTemplate(content, values) {
  return String(content || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = values?.[key];
    return value === undefined || value === null ? '' : String(value);
  });
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

  container.className = 'ttf-root';

  const state = {
    store: createEmptyStore(),
    values: {},
    result: '',
    loading: false,
    saving: false,
    draftStore: createEmptyStore(),
    draftTemplateId: '',
    managerOpen: false,
    generatorOpen: false,
    configPath: ''
  };

  const title = el('h3', { className: 'ttf-title', text: ctx?.widget?.name || '模板填充' });
  const subtitle = el('p', { className: 'ttf-subtitle', text: '先选模板，再点击生成，填写变量后输出结果。模板正文使用 {{变量名}} 占位。' });
  const flowCard = el('div', { className: 'ttf-flow' },
    el('div', { className: 'ttf-flow-item' }, el('strong', { text: '1' }), el('span', { text: '选择模板' })),
    el('div', { className: 'ttf-flow-item' }, el('strong', { text: '2' }), el('span', { text: '填写变量' })),
    el('div', { className: 'ttf-flow-item' }, el('strong', { text: '3' }), el('span', { text: '输出结果' }))
  );
  container.append(title, subtitle, flowCard);

  const topCard = el('div', { className: 'ttf-card' });
  const topRow = el('div', { className: 'ttf-row' });
  const selectField = el('div', { className: 'ttf-field ttf-field--wide' });
  const templateSelect = el('select', { className: 'ttf-select' });
  const topActions = el('div', { className: 'ttf-actions' });
  const btnOpenGenerator = el('button', { type: 'button', className: 'btn btn-primary btn-sm' });
  btnOpenGenerator.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> 生成文本';
  const btnNewFromMain = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnNewFromMain.innerHTML = '<i class="fas fa-plus"></i> 新建模板';
  const btnManage = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnManage.innerHTML = '<i class="fas fa-pen-to-square"></i> 编辑模板';
  const btnReload = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' });
  btnReload.innerHTML = '<i class="fas fa-rotate-right"></i> 刷新';
  topActions.append(btnOpenGenerator, btnNewFromMain, btnManage, btnReload);
  const topMeta = el('div', { className: 'ttf-meta' });
  selectField.append(el('div', { className: 'ttf-label', text: '当前模板' }), templateSelect);
  topRow.append(selectField, topActions);
  topCard.append(topRow, topMeta);

  const mainGrid = el('div', { className: 'ttf-main-grid' });
  const leftCol = el('div', { className: 'ttf-column' });
  const rightCol = el('div', { className: 'ttf-column' });

  const summaryCard = el('div', { className: 'ttf-card' });
  const summaryHead = el('div', { className: 'ttf-row' });
  const summaryTitle = el('strong', { text: '模板预览' });
  const summaryBadge = el('div', { className: 'ttf-badges' });
  const typeBadge = el('span', { className: 'ttf-badge' });
  const fieldBadge = el('span', { className: 'ttf-badge' });
  const requiredBadge = el('span', { className: 'ttf-badge' });
  summaryBadge.append(typeBadge, fieldBadge, requiredBadge);
  summaryHead.append(summaryTitle, summaryBadge);
  const summaryText = el('textarea', { className: 'ttf-textarea ttf-preview', readonly: 'readonly', placeholder: '选择模板后，这里显示模板正文。' });
  const summaryHint = el('div', { className: 'ttf-meta' });
  summaryCard.append(summaryHead, summaryText, summaryHint);

  const resultCard = el('div', { className: 'ttf-card ttf-card--sticky' });
  const resultHead = el('div', { className: 'ttf-row' });
  const resultTitle = el('strong', { text: '生成结果' });
  const resultActions = el('div', { className: 'ttf-actions' });
  const btnCopy = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' });
  btnCopy.innerHTML = '<i class="fas fa-copy"></i> 复制';
  const btnClear = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnClear.innerHTML = '<i class="fas fa-eraser"></i> 清空结果';
  resultActions.append(btnCopy, btnClear);
  resultHead.append(resultTitle, resultActions);
  const resultStatus = el('div', { className: 'ttf-note' });
  const resultTextarea = el('textarea', { className: 'ttf-textarea ttf-result', readonly: 'readonly', placeholder: '生成后，这里会显示最终文本。' });
  resultCard.append(resultHead, resultStatus, resultTextarea);

  leftCol.append(summaryCard);
  rightCol.append(resultCard);
  mainGrid.append(leftCol, rightCol);
  container.append(topCard, mainGrid);

  const generator = el('div', { className: 'ttf-generator' });
  const generatorPanel = el('div', { className: 'ttf-generator-panel' });
  const generatorHead = el('div', { className: 'ttf-modal-head' });
  const generatorHeadText = el('div', null,
    el('div', { className: 'ttf-modal-title', text: '变量填写' }),
    el('div', { className: 'ttf-modal-sub', text: '确认变量后点击下方“生成文本”。时间变量会在生成时自动取当前时间，例如 YYYY-MM-DDTHH:mm:ss.SSS。' })
  );
  const btnGeneratorClose = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnGeneratorClose.innerHTML = '<i class="fas fa-xmark"></i> 关闭';
  generatorHead.append(generatorHeadText, btnGeneratorClose);
  const generatorStatus = el('div', { className: 'ttf-note' });
  const generatorBody = el('div', { className: 'ttf-generator-body' });
  const generatorFields = el('div', { className: 'ttf-generator-grid' });
  const generatorActions = el('div', { className: 'ttf-modal-actions' });
  const btnGeneratorConfirm = el('button', { type: 'button', className: 'btn btn-primary btn-sm' });
  btnGeneratorConfirm.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> 生成文本';
  generatorActions.append(btnGeneratorConfirm);
  generatorBody.append(generatorFields);
  generatorPanel.append(generatorHead, generatorStatus, generatorBody, generatorActions);
  generator.appendChild(generatorPanel);
  container.appendChild(generator);

  const manager = el('div', { className: 'ttf-modal' });
  const managerPanel = el('div', { className: 'ttf-modal-panel' });
  const managerHead = el('div', { className: 'ttf-modal-head' });
  const managerHeadText = el('div', null,
    el('div', { className: 'ttf-modal-title', text: '模板管理' }),
    el('div', { className: 'ttf-modal-sub', text: '先写正文，再识别变量；变量很多时会并排显示，尽量减少滚动。' })
  );
  const btnManagerClose = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnManagerClose.innerHTML = '<i class="fas fa-xmark"></i> 关闭';
  managerHead.append(managerHeadText, btnManagerClose);

  const managerStatus = el('div', { className: 'ttf-status' });
  const managerGuide = el('div', { className: 'ttf-guide' },
    el('div', { className: 'ttf-guide-item', text: '正文里的 {{变量名}} 会被自动识别。' }),
    el('div', { className: 'ttf-guide-item', text: '时间变量支持自定义输出格式，例如 YYYY-MM-DDTHH:mm:ss.SSS。' })
  );
  const managerBody = el('div', { className: 'ttf-modal-body' });

  const listPane = el('div', { className: 'ttf-list' });
  const listHead = el('div', { className: 'ttf-row' });
  const listTitle = el('strong', { text: '模板列表' });
  const listActions = el('div', { className: 'ttf-actions' });
  const btnAddTemplate = el('button', { type: 'button', className: 'btn btn-primary btn-sm' });
  btnAddTemplate.innerHTML = '<i class="fas fa-plus"></i> 新增';
  const btnDeleteTemplate = el('button', { type: 'button', className: 'btn btn-outline btn-sm' });
  btnDeleteTemplate.innerHTML = '<i class="fas fa-trash"></i> 删除';
  listActions.append(btnAddTemplate, btnDeleteTemplate);
  listHead.append(listTitle, listActions);
  const listItems = el('div', { className: 'ttf-list-items' });
  listPane.append(listHead, listItems);

  const editorPane = el('div', { className: 'ttf-editor' });
  const editorGrid = el('div', { className: 'ttf-editor-grid' });
  const nameField = el('div', { className: 'ttf-field' });
  const nameInput = el('input', { className: 'ttf-input', type: 'text', placeholder: '模板名称' });
  nameField.append(el('div', { className: 'ttf-label', text: '模板名称' }), nameInput);
  const typeField = el('div', { className: 'ttf-field' });
  const typeSelect = el('select', { className: 'ttf-select' });
  [
    ['text', '纯文本'],
    ['json', 'JSON'],
    ['sql', 'SQL']
  ].forEach(([value, label]) => typeSelect.appendChild(el('option', { value, text: label })));
  typeField.append(el('div', { className: 'ttf-label', text: '模板类型' }), typeSelect);
  editorGrid.append(nameField, typeField);

  const contentField = el('div', { className: 'ttf-field' });
  const contentRow = el('div', { className: 'ttf-row' });
  const contentTitle = el('div', { className: 'ttf-label', text: '模板正文' });
  const btnSyncFields = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' });
  btnSyncFields.innerHTML = '<i class="fas fa-arrows-rotate"></i> 识别变量';
  contentRow.append(contentTitle, btnSyncFields);
  const contentTextarea = el('textarea', { className: 'ttf-textarea', placeholder: '例如：SELECT * FROM users WHERE created_at > \'{{start_time}}\';' });
  const contentHint = el('div', { className: 'ttf-meta', text: '时间变量推荐使用 {{start_time}} 之类的命名，再在下方设为“当前时间”。' });
  contentField.append(contentRow, contentTextarea, contentHint);

  const fieldsHead = el('div', { className: 'ttf-row' },
    el('strong', { text: '变量配置' }),
    el('div', { className: 'ttf-meta' })
  );
  const fieldsCount = fieldsHead.lastChild;
  const fieldsWrap = el('div', { className: 'ttf-fields' });

  const managerActions = el('div', { className: 'ttf-modal-actions' });
  const btnSaveAll = el('button', { type: 'button', className: 'btn btn-primary btn-sm' });
  btnSaveAll.innerHTML = '<i class="fas fa-floppy-disk"></i> 保存模板';
  managerActions.append(btnSaveAll);

  editorPane.append(editorGrid, contentField, fieldsHead, fieldsWrap);
  managerBody.append(listPane, editorPane);
  managerPanel.append(managerHead, managerStatus, managerGuide, managerBody, managerActions);
  manager.appendChild(managerPanel);
  container.appendChild(manager);

  function setManagerStatus(type, message) {
    managerStatus.textContent = String(message || '');
    managerStatus.className = 'ttf-status';
    if (!message) return;
    managerStatus.classList.add('is-visible');
    if (type === 'error') managerStatus.classList.add('ttf-status--error');
    if (type === 'success') managerStatus.classList.add('ttf-status--success');
  }

  function getActiveTemplate() {
    return getTemplateById(state.store, state.store.activeTemplateId);
  }

  function getDraftTemplate() {
    return getTemplateById(state.draftStore, state.draftTemplateId);
  }

  function refreshValues(keepExisting) {
    const template = getActiveTemplate();
    state.values = template ? buildValuesFromTemplate(template, keepExisting ? state.values : {}) : {};
  }

  function closeGenerator() {
    state.generatorOpen = false;
    generator.classList.remove('is-open');
  }

  function closeManager() {
    state.managerOpen = false;
    manager.classList.remove('is-open');
    setManagerStatus('', '');
  }

  function setActiveTemplate(templateId, keepExistingValues) {
    state.store.activeTemplateId = templateId;
    refreshValues(Boolean(keepExistingValues));
    if (!keepExistingValues) state.result = '';
    renderMain();
  }

  function renderTemplateOptions() {
    const templates = state.store.templates || [];
    const active = getActiveTemplate();
    const stats = getTemplateStats(active);
    templateSelect.innerHTML = '';
    if (!templates.length) {
      templateSelect.appendChild(el('option', { value: '', text: '暂无模板' }));
      templateSelect.value = '';
      topMeta.textContent = '当前还没有模板，请先新建模板。';
      summaryText.value = '';
      summaryHint.textContent = '暂无模板内容。';
      typeBadge.textContent = '未选择';
      fieldBadge.textContent = '0 个变量';
      requiredBadge.textContent = '0 个必填';
      btnOpenGenerator.disabled = true;
      return;
    }
    templates.forEach((item) => {
      templateSelect.appendChild(el('option', { value: item.id, text: item.name }));
    });
    templateSelect.value = active?.id || templates[0].id;
    topMeta.textContent = active ? `${active.name} · ${getTypeLabel(active.type)} · ${stats.total} 个变量` : '';
    summaryText.value = active?.content || '';
    summaryHint.textContent = active?.content ? excerpt(active.content, 120) : '暂无模板内容。';
    typeBadge.textContent = getTypeLabel(active?.type);
    fieldBadge.textContent = `${stats.total} 个变量`;
    requiredBadge.textContent = `${stats.required} 个必填`;
    btnOpenGenerator.disabled = !active;
  }

  function renderResult() {
    const template = getActiveTemplate();
    const missing = getMissingRequiredFields(template, state.values);
    resultTextarea.value = state.result || '';
    btnCopy.disabled = !state.result;
    if (!template) {
      resultStatus.textContent = '请选择模板后再生成结果。';
      return;
    }
    if (!state.result) {
      resultStatus.textContent = missing.length ? `还有 ${missing.length} 个必填项将在生成前确认。` : '点击“生成文本”后填写变量。';
      return;
    }
    resultStatus.textContent = '结果已生成，可直接复制。';
  }

  function renderMain() {
    renderTemplateOptions();
    renderResult();
  }

  function openGenerator() {
    const template = getActiveTemplate();
    if (!template) {
      ctx?.showMessage?.('error', '请先选择模板');
      return;
    }
    refreshValues(true);
    state.generatorOpen = true;
    renderGenerator();
  }

  function renderGenerator() {
    generator.classList.toggle('is-open', state.generatorOpen);
    generatorFields.innerHTML = '';
    const template = getActiveTemplate();
    if (!template) {
      generatorStatus.textContent = '当前没有模板。';
      generatorFields.appendChild(el('div', { className: 'ttf-empty', text: '请先创建模板。' }));
      return;
    }
    const stats = getTemplateStats(template);
    generatorStatus.textContent = `${template.name} · ${stats.total} 个变量 · ${stats.required} 个必填`;
    if (!template.fields.length) {
      generatorFields.appendChild(el('div', { className: 'ttf-empty', text: '当前模板没有变量，点击下方“生成文本”即可直接输出固定内容。' }));
      return;
    }
    template.fields.forEach((field) => {
      const card = el('div', { className: 'ttf-field-card ttf-field-card--input ttf-field-card--compact' });
      const head = el('div', { className: 'ttf-row' });
      const title = el('div', { className: 'ttf-field-title', text: field.label || field.key });
      const badge = el('span', { className: `ttf-mini-badge${field.required ? ' is-required' : ''}`, text: field.required ? '必填' : '选填' });
      head.append(title, badge);
      const meta = el('div', { className: 'ttf-meta', text: `${field.key} · ${getInputTypeLabel(field.inputType)}` });
      card.append(head, meta);

      if (field.inputType === 'generated_time') {
        const preview = getAutoValue(field);
        card.append(
          el('div', { className: 'ttf-auto-preview', text: preview }),
          el('div', { className: 'ttf-meta', text: `格式：${field.format || DEFAULT_TIME_FORMAT}` })
        );
        generatorFields.appendChild(card);
        return;
      }

      let input = null;
      const currentValue = state.values[field.key] === undefined ? String(field.defaultValue || '') : String(state.values[field.key]);
      if (field.inputType === 'select') {
        input = el('select', { className: 'ttf-select' });
        input.appendChild(el('option', { value: '', text: '请选择' }));
        field.options.forEach((option) => input.appendChild(el('option', { value: option, text: option })));
        input.value = currentValue;
      } else if (field.inputType === 'textarea') {
        input = el('textarea', { className: 'ttf-textarea ttf-textarea--compact', placeholder: field.defaultValue || field.key, value: currentValue });
      } else {
        input = el('input', { className: 'ttf-input', type: 'text', placeholder: field.defaultValue || field.key, value: currentValue });
      }
      input.addEventListener('input', () => {
        state.values[field.key] = input.value;
      });
      card.append(input, el('div', { className: 'ttf-meta', text: field.defaultValue ? `默认值：${field.defaultValue}` : '未设置默认值' }));
      generatorFields.appendChild(card);
    });
  }

  function openManager(mode = 'current') {
    state.draftStore = clone(state.store);
    state.draftTemplateId = state.store.activeTemplateId || state.store.templates[0]?.id || '';
    if (mode === 'new') {
      const next = createTemplate(`新模板${(state.draftStore.templates || []).length + 1}`);
      state.draftStore.templates.push(next);
      state.draftTemplateId = next.id;
    }
    state.draftStore.activeTemplateId = state.draftTemplateId;
    state.managerOpen = true;
    setManagerStatus('', '');
    renderManager();
  }

  function renderFieldsEditor() {
    const template = getDraftTemplate();
    fieldsWrap.innerHTML = '';
    if (!template) {
      fieldsCount.textContent = '';
      fieldsWrap.appendChild(el('div', { className: 'ttf-empty', text: '请选择左侧模板开始编辑。' }));
      return;
    }
    fieldsCount.textContent = `${template.fields.length} 个变量`;
    if (!template.fields.length) {
      fieldsWrap.appendChild(el('div', { className: 'ttf-empty', text: '正文中暂未识别到变量。请先写模板正文，再点击“识别变量”。' }));
      return;
    }
    template.fields.forEach((field) => {
      const card = el('div', { className: 'ttf-field-card ttf-field-card--manager' });
      const header = el('div', { className: 'ttf-row' });
      header.append(
        el('div', { className: 'ttf-field-title', text: field.label || field.key }),
        el('span', { className: 'ttf-mini-badge', text: getInputTypeLabel(field.inputType) })
      );
      const fieldMeta = el('div', { className: 'ttf-meta', text: field.key });

      const rowA = el('div', { className: 'ttf-field-row' });
      const labelField = el('div', { className: 'ttf-field' });
      const labelInput = el('input', { className: 'ttf-input', type: 'text', value: field.label, placeholder: '显示名称' });
      labelInput.addEventListener('input', () => {
        field.label = labelInput.value;
      });
      labelField.append(el('div', { className: 'ttf-label', text: '显示名称' }), labelInput);

      const typeField = el('div', { className: 'ttf-field' });
      const inputTypeSelect = el('select', { className: 'ttf-select' });
      [
        ['text', '单行文本'],
        ['textarea', '多行文本'],
        ['select', '下拉框'],
        ['generated_time', '当前时间']
      ].forEach(([value, label]) => inputTypeSelect.appendChild(el('option', { value, text: label })));
      inputTypeSelect.value = field.inputType;
      inputTypeSelect.addEventListener('change', () => {
        field.inputType = inputTypeSelect.value;
        if (field.inputType === 'select' && !field.options.length) field.options = ['选项1'];
        if (field.inputType === 'generated_time') {
          field.defaultValue = '';
          field.format = field.format || DEFAULT_TIME_FORMAT;
        }
        renderFieldsEditor();
      });
      typeField.append(el('div', { className: 'ttf-label', text: '输入类型' }), inputTypeSelect);

      const requiredField = el('label', { className: 'ttf-check ttf-check--compact' });
      const requiredInput = el('input', { type: 'checkbox', checked: field.required });
      requiredInput.addEventListener('change', () => {
        field.required = requiredInput.checked;
      });
      requiredField.append(requiredInput, el('span', { text: '必填' }));
      rowA.append(labelField, typeField, requiredField);

      const rowB = el('div', { className: 'ttf-field-row' });
      if (field.inputType === 'generated_time') {
        const formatField = el('div', { className: 'ttf-field ttf-field--wide' });
        const previewMeta = el('div', { className: 'ttf-meta', text: `预览：${formatCurrentTime(field.format || DEFAULT_TIME_FORMAT)}` });
        const formatInput = el('input', { className: 'ttf-input', type: 'text', value: field.format || DEFAULT_TIME_FORMAT, placeholder: 'YYYY-MM-DDTHH:mm:ss.SSS' });
        formatInput.addEventListener('input', () => {
          field.format = formatInput.value;
          previewMeta.textContent = `预览：${formatCurrentTime(field.format || DEFAULT_TIME_FORMAT)}`;
        });
        formatField.append(el('div', { className: 'ttf-label', text: '时间格式' }), formatInput);
        rowB.append(formatField);
        card.append(header, fieldMeta, rowA, rowB, previewMeta);
      } else {
        const defaultField = el('div', { className: 'ttf-field' });
        const defaultInput = el('input', { className: 'ttf-input', type: 'text', value: field.defaultValue, placeholder: '默认值' });
        defaultInput.addEventListener('input', () => {
          field.defaultValue = defaultInput.value;
        });
        defaultField.append(el('div', { className: 'ttf-label', text: '默认值' }), defaultInput);
        rowB.append(defaultField);
        card.append(header, fieldMeta, rowA, rowB);
      }

      if (field.inputType === 'select') {
        const optionsField = el('div', { className: 'ttf-field ttf-field--wide' });
        const optionsInput = el('textarea', { className: 'ttf-textarea ttf-textarea--compact', placeholder: '每行一个选项', value: field.options.join('\n') });
        optionsInput.addEventListener('input', () => {
          field.options = normalizeOptions(optionsInput.value);
        });
        optionsField.append(el('div', { className: 'ttf-label', text: '下拉选项' }), optionsInput);
        card.appendChild(optionsField);
      }

      fieldsWrap.appendChild(card);
    });
  }

  function renderManager() {
    manager.classList.toggle('is-open', state.managerOpen);
    listItems.innerHTML = '';
    const templates = state.draftStore.templates || [];
    btnDeleteTemplate.disabled = !templates.length;
    btnSaveAll.disabled = state.saving;
    if (!templates.length) {
      listItems.appendChild(el('div', { className: 'ttf-empty', text: '还没有模板，点击“新增”创建。' }));
    } else {
      templates.forEach((item) => {
        const stats = getTemplateStats(item);
        const node = el('button', { type: 'button', className: `ttf-list-item${item.id === state.draftTemplateId ? ' is-active' : ''}` });
        node.append(
          el('div', { className: 'ttf-list-name', text: item.name }),
          el('div', { className: 'ttf-list-meta', text: `${getTypeLabel(item.type)} · ${stats.total} 个变量 · ${stats.required} 个必填` })
        );
        node.addEventListener('click', () => {
          state.draftTemplateId = item.id;
          state.draftStore.activeTemplateId = item.id;
          setManagerStatus('', '');
          renderManager();
        });
        listItems.appendChild(node);
      });
    }

    const current = getDraftTemplate();
    const disabled = !current;
    nameInput.disabled = disabled;
    typeSelect.disabled = disabled;
    contentTextarea.disabled = disabled;
    btnSyncFields.disabled = disabled;

    if (!current) {
      nameInput.value = '';
      typeSelect.value = 'text';
      contentTextarea.value = '';
      renderFieldsEditor();
      return;
    }

    nameInput.value = current.name;
    typeSelect.value = current.type;
    contentTextarea.value = current.content;
    renderFieldsEditor();
  }

  async function loadStore(showSuccess) {
    state.loading = true;
    btnReload.disabled = true;
    try {
      const payload = await apiGetStore();
      state.store = payload.store;
      state.configPath = payload.configPath;
      if (!state.store.activeTemplateId && state.store.templates[0]) state.store.activeTemplateId = state.store.templates[0].id;
      refreshValues(false);
      state.result = '';
      renderMain();
      if (showSuccess) ctx?.showMessage?.('success', '模板已刷新');
    } catch (err) {
      state.store = createEmptyStore();
      state.values = {};
      state.result = '';
      state.configPath = '';
      renderMain();
      ctx?.showMessage?.('error', `模板加载失败：${err?.message || String(err)}`);
    } finally {
      state.loading = false;
      btnReload.disabled = false;
    }
  }

  templateSelect.addEventListener('change', () => {
    setActiveTemplate(templateSelect.value, false);
  });

  btnOpenGenerator.addEventListener('click', openGenerator);
  btnManage.addEventListener('click', () => openManager('current'));
  btnNewFromMain.addEventListener('click', () => openManager('new'));
  btnReload.addEventListener('click', () => loadStore(true));

  btnGeneratorClose.addEventListener('click', closeGenerator);
  generator.addEventListener('click', (event) => {
    if (event.target === generator) closeGenerator();
  });
  btnGeneratorConfirm.addEventListener('click', () => {
    const template = getActiveTemplate();
    if (!template) {
      ctx?.showMessage?.('error', '请先选择模板');
      return;
    }
    const finalValues = buildSubmissionValues(template, state.values);
    const validation = validateValues(template, finalValues);
    if (!validation.ok) {
      ctx?.showMessage?.('error', validation.error);
      renderGenerator();
      return;
    }
    state.values = finalValues;
    state.result = renderTemplate(template.content, finalValues);
    renderMain();
    closeGenerator();
    ctx?.showMessage?.('success', '文本已生成');
  });

  btnManagerClose.addEventListener('click', closeManager);
  manager.addEventListener('click', (event) => {
    if (event.target === manager) closeManager();
  });

  btnAddTemplate.addEventListener('click', () => {
    const next = createTemplate(`新模板${(state.draftStore.templates || []).length + 1}`);
    state.draftStore.templates.push(next);
    state.draftTemplateId = next.id;
    state.draftStore.activeTemplateId = next.id;
    setManagerStatus('', '');
    renderManager();
  });

  btnDeleteTemplate.addEventListener('click', () => {
    const current = getDraftTemplate();
    if (!current) return;
    if (!window.confirm(`确定删除模板「${current.name}」吗？`)) return;
    state.draftStore.templates = (state.draftStore.templates || []).filter((item) => item.id !== current.id);
    state.draftTemplateId = state.draftStore.templates[0]?.id || '';
    if (state.draftStore.activeTemplateId === current.id) state.draftStore.activeTemplateId = state.draftTemplateId;
    setManagerStatus('', '');
    renderManager();
  });

  nameInput.addEventListener('input', () => {
    const current = getDraftTemplate();
    if (!current) return;
    current.name = nameInput.value;
  });

  typeSelect.addEventListener('change', () => {
    const current = getDraftTemplate();
    if (!current) return;
    current.type = typeSelect.value;
  });

  contentTextarea.addEventListener('input', () => {
    const current = getDraftTemplate();
    if (!current) return;
    current.content = contentTextarea.value;
  });

  btnSyncFields.addEventListener('click', () => {
    const current = getDraftTemplate();
    if (!current) return;
    current.fields = mergeFieldsFromContent(current.content, current.fields);
    renderFieldsEditor();
    setManagerStatus('success', `已识别 ${current.fields.length} 个变量`);
  });

  btnSaveAll.addEventListener('click', async () => {
    const draft = normalizeStore(state.draftStore);
    const validation = validateStore(draft);
    if (!validation.ok) {
      setManagerStatus('error', validation.error);
      return;
    }
    state.saving = true;
    btnSaveAll.disabled = true;
    try {
      if (!draft.activeTemplateId && draft.templates[0]) draft.activeTemplateId = draft.templates[0].id;
      await apiSaveStore(draft);
      state.store = draft;
      if (!state.store.activeTemplateId && state.store.templates[0]) state.store.activeTemplateId = state.store.templates[0].id;
      refreshValues(false);
      state.result = '';
      renderMain();
      setManagerStatus('success', '模板已保存');
      ctx?.showMessage?.('success', '共用模板已保存');
      window.setTimeout(() => {
        if (state.managerOpen) closeManager();
      }, 250);
    } catch (err) {
      setManagerStatus('error', err?.message || String(err));
    } finally {
      state.saving = false;
      btnSaveAll.disabled = false;
    }
  });

  btnCopy.addEventListener('click', async () => {
    if (!state.result) return;
    try {
      await copyText(state.result);
      ctx?.showMessage?.('success', '结果已复制');
    } catch (err) {
      ctx?.showMessage?.('error', `复制失败：${err?.message || String(err)}`);
    }
  });

  btnClear.addEventListener('click', () => {
    state.result = '';
    renderResult();
  });

  renderMain();
  await loadStore(false);

  return {
    unmount() {
      container.innerHTML = '';
    }
  };
}
