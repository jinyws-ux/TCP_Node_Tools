// core/messages.js
function containerById(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.error('消息容器不存在:', id);
  }
  return el;
}

export function showMessage(type, text, containerId) {
  const container = containerById(containerId);
  if (!container) return;

  container.classList.add('message-container', 'has-message');

  // 清除多余旧消息（保留最新 3 条）
  const old = container.querySelectorAll('.message');
  if (old.length >= 3) {
    for (let i = 0; i < old.length - 2; i++) {
      old[i].remove();
    }
  }

  const message = document.createElement('div');
  message.className = `message message-${type}`;
  const ts = new Date().toLocaleTimeString();

  message.innerHTML = `
    <div class="message-content">
      <strong>${ts}</strong> - ${text}
    </div>
    <button class="message-close" onclick="this.parentElement.remove(); window.checkEmptyState && window.checkEmptyState('${containerId}')">
      <i class="fas fa-times"></i>
    </button>
  `;

  container.insertBefore(message, container.firstChild);

  const timeout = type === 'info' ? 3000 : 5000;
  setTimeout(() => {
    if (message.parentNode) {
      message.remove();
      checkEmptyState(containerId);
    }
  }, timeout);
}

export function checkEmptyState(containerId) {
  const container = containerById(containerId);
  if (!container) return;
  const messages = container.querySelectorAll('.message');
  if (messages.length === 0) {
    container.classList.remove('has-message');
  }
}

export function initMessageContainers() {
  ['download-messages', 'analyze-messages', 'server-config-messages', 'parser-config-messages']
    .forEach(checkEmptyState);
}
