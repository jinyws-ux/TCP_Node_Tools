// core/messages.js
let toastStackEl = null;

function containerById(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.error('消息容器不存在:', id);
  }
  return el;
}

function ensureToastStack() {
  if (toastStackEl) return toastStackEl;
  toastStackEl = document.getElementById('global-toast-stack');
  if (!toastStackEl) {
    toastStackEl = document.createElement('div');
    toastStackEl.id = 'global-toast-stack';
    document.body.appendChild(toastStackEl);
  }
  return toastStackEl;
}

function incrementContainer(container) {
  const count = Number(container.dataset.activeCount || 0) + 1;
  container.dataset.activeCount = String(count);
  container.classList.add('message-container', 'has-message');
}

function decrementContainer(container) {
  const count = Math.max(0, Number(container.dataset.activeCount || 0) - 1);
  container.dataset.activeCount = String(count);
  if (count === 0) {
    container.classList.remove('has-message');
  }
}

export function showMessage(type, text, containerId) {
  const container = containerById(containerId);
  if (!container) return;

  const stack = ensureToastStack();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const label = container.dataset?.label || '提示';

  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = label;
  const body = document.createElement('div');
  body.className = 'toast-text';
  body.textContent = text;
  toast.appendChild(title);
  toast.appendChild(body);

  incrementContainer(container);
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const timeout = type === 'info' ? 3000 : 5000;
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => {
      toast.remove();
      decrementContainer(container);
    }, 250);
  }, timeout);
}

export function checkEmptyState(containerId) {
  const container = containerById(containerId);
  if (!container) return;
  const count = Number(container.dataset.activeCount || 0);
  if (count === 0) {
    container.classList.remove('has-message');
  }
}

export function initMessageContainers() {
  ['download-messages', 'analyze-messages', 'server-config-messages', 'parser-config-messages']
    .forEach((id) => {
      const container = containerById(id);
      if (container) {
        container.dataset.activeCount = '0';
        container.classList.remove('has-message');
      }
    });
}
