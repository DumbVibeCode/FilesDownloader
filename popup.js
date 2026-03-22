let foundFiles = [];

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_EXTENSIONS = 'mp3';

function i18n(key, ...subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = i18n(el.dataset.i18n);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  const extensionsInput = document.getElementById('extensions');
  const maxConcurrentInput = document.getElementById('maxConcurrent');
  const saveAsDefaultCheckbox = document.getElementById('saveAsDefault');
  const scanBtn = document.getElementById('scanBtn');
  const statusEl = document.getElementById('status');

  // Загружаем сохранённые настройки
  chrome.storage.local.get(['maxConcurrent', 'defaultExtensions'], (result) => {
    maxConcurrentInput.value = result.maxConcurrent || DEFAULT_MAX_CONCURRENT;
    const defaultExt = result.defaultExtensions || DEFAULT_EXTENSIONS;
    extensionsInput.value = defaultExt;
    updatePresetButtons(defaultExt);
  });

  maxConcurrentInput.addEventListener('change', () => {
    const value = Math.min(10, Math.max(1, parseInt(maxConcurrentInput.value) || DEFAULT_MAX_CONCURRENT));
    maxConcurrentInput.value = value;
    chrome.storage.local.set({ maxConcurrent: value });
  });

  document.querySelectorAll('.ext-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const ext = btn.dataset.ext;
      extensionsInput.value = ext;
      updatePresetButtons(ext);
    });
  });

  extensionsInput.addEventListener('input', () => {
    updatePresetButtons(extensionsInput.value);
  });

  extensionsInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') scanBtn.click();
  });

  scanBtn.addEventListener('click', async () => {
    const extensions = parseExtensions(extensionsInput.value);
    if (extensions.length === 0) {
      statusEl.textContent = i18n('errNoExtension');
      statusEl.className = 'status error';
      return;
    }
    if (saveAsDefaultCheckbox.checked) {
      chrome.storage.local.set({ defaultExtensions: extensionsInput.value });
      saveAsDefaultCheckbox.checked = false;
    }
    await scanPage(extensions);
  });

  document.getElementById('selectAll').addEventListener('click', () => {
    document.querySelectorAll('.file-item input').forEach(cb => cb.checked = true);
  });

  document.getElementById('selectNone').addEventListener('click', () => {
    document.querySelectorAll('.file-item input').forEach(cb => cb.checked = false);
  });

  document.getElementById('downloadSelected').addEventListener('click', () => {
    const selected = [];
    document.querySelectorAll('.file-item input:checked').forEach((cb) => {
      const index = parseInt(cb.dataset.index);
      selected.push({ ...foundFiles[index], index });
    });
    startDownload(selected);
  });

  document.getElementById('downloadAll').addEventListener('click', () => {
    const allFiles = foundFiles.map((file, index) => ({ ...file, index }));
    startDownload(allFiles);
  });

  // Слушаем обновления от фонового скрипта
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Автоматическое сканирование при открытии
  chrome.storage.local.get(['defaultExtensions'], async (result) => {
    if (result.defaultExtensions) {
      const extensions = parseExtensions(result.defaultExtensions);
      if (extensions.length > 0) await scanPage(extensions);
    }
  });
});

function handleBackgroundMessage(message) {
  if (message.type === 'FILE_DOWNLOADING') {
    const statusEl = document.getElementById(`status-${message.fileIndex}`);
    const itemEl = document.getElementById(`file-item-${message.fileIndex}`);
    if (statusEl) { statusEl.textContent = i18n('fileStatusDownloading'); statusEl.className = 'file-status downloading'; }
    if (itemEl) { itemEl.classList.add('downloading'); itemEl.classList.remove('completed'); }

  } else if (message.type === 'FILE_COMPLETE') {
    const statusEl = document.getElementById(`status-${message.fileIndex}`);
    const itemEl = document.getElementById(`file-item-${message.fileIndex}`);
    if (statusEl) {
      statusEl.textContent = message.success ? '✓' : '✗';
      statusEl.className = message.success ? 'file-status completed' : 'file-status error';
    }
    if (itemEl) {
      itemEl.classList.remove('downloading');
      if (message.success) itemEl.classList.add('completed');
    }
    updateProgress(message.completedDownloads, message.totalToDownload);

  } else if (message.type === 'ALL_COMPLETE') {
    updateProgress(message.completedDownloads, message.totalToDownload);
    finishDownload(message.completedDownloads, message.totalToDownload);
  }
}

function parseExtensions(input) {
  return input
    .toLowerCase()
    .split(/[,\s]+/)
    .map(ext => ext.trim().replace(/^\./, ''))
    .filter(ext => ext.length > 0 && /^[a-z0-9]+$/i.test(ext));
}

function updatePresetButtons(currentValue) {
  const normalized = parseExtensions(currentValue).sort().join(',');
  document.querySelectorAll('.ext-preset').forEach(btn => {
    const presetNormalized = parseExtensions(btn.dataset.ext).sort().join(',');
    btn.classList.toggle('active', normalized === presetNormalized);
  });
}

async function scanPage(extensions) {
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const fileListEl = document.getElementById('fileList');

  statusEl.textContent = i18n('statusScanning');
  statusEl.className = 'status';
  resultsEl.classList.remove('visible');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: findFiles,
      args: [extensions]
    });

    foundFiles = results[0].result || [];

    if (foundFiles.length === 0) {
      const extList = extensions.join(', ').toUpperCase();
      statusEl.textContent = i18n('statusNotFound', extList);
      statusEl.className = 'status error';
      return;
    }

    statusEl.textContent = i18n('statusFound', String(foundFiles.length));
    statusEl.className = 'status found';
    resultsEl.classList.add('visible');
    renderFileList(fileListEl);

  } catch (error) {
    statusEl.textContent = i18n('statusError', error.message);
    statusEl.className = 'status error';
  }
}

// Функция поиска файлов (выполняется в контексте страницы)
function findFiles(extensions) {
  const fileSet = new Map();
  const extPattern = new RegExp(`\\.(${extensions.join('|')})(\\?.*)?$`, 'i');

  function addFile(url) {
    if (!url || fileSet.has(url)) return;
    if (!extPattern.test(url)) return;
    try {
      const urlObj = new URL(url, location.href);
      const fullUrl = urlObj.href;
      const pathname = urlObj.pathname;
      const filename = decodeURIComponent(pathname.split('/').pop());
      const ext = filename.split('.').pop().toLowerCase();
      if (!fileSet.has(fullUrl)) fileSet.set(fullUrl, { url: fullUrl, filename, ext });
    } catch { /* некорректный URL */ }
  }

  document.querySelectorAll('a[href]').forEach(a => addFile(a.href));
  document.querySelectorAll('audio source, audio[src], video source, video[src]').forEach(el => {
    addFile(el.src || el.getAttribute('src'));
  });
  document.querySelectorAll('embed[src], object[data]').forEach(el => {
    addFile(el.src || el.getAttribute('data'));
  });
  document.querySelectorAll('iframe[src]').forEach(el => addFile(el.src));

  const dataAttrs = ['data-src', 'data-url', 'data-href', 'data-file', 'data-download',
                     'data-mp3', 'data-mp4', 'data-audio', 'data-video', 'data-pdf'];
  dataAttrs.forEach(attr => {
    document.querySelectorAll(`[${attr}]`).forEach(el => addFile(el.getAttribute(attr)));
  });

  document.querySelectorAll('[onclick], [onmousedown]').forEach(el => {
    [el.getAttribute('onclick'), el.getAttribute('onmousedown')].forEach(handler => {
      if (!handler) return;
      const extList = extensions.join('|');
      const urlMatches = handler.match(new RegExp(`['"]([^'"]+\\.(${extList})(\\?[^'"]*)?)['"'`, 'gi'));
      if (urlMatches) urlMatches.forEach(match => addFile(match.slice(1, -1)));
    });
  });

  return Array.from(fileSet.values());
}

function renderFileList(container) {
  container.innerHTML = '';
  foundFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `file-item-${index}`;
    item.innerHTML = `
      <input type="checkbox" checked data-index="${index}">
      <div class="file-info">
        <div class="file-name" title="${file.filename}">${file.filename}</div>
        <div class="file-ext">${file.ext.toUpperCase()}</div>
      </div>
      <span class="file-status" id="status-${index}"></span>
      <button class="download-single" title="Скачать">⬇</button>
    `;

    item.querySelector('.file-info').addEventListener('click', () => {
      const cb = item.querySelector('input');
      cb.checked = !cb.checked;
    });

    item.querySelector('.download-single').addEventListener('click', (e) => {
      e.stopPropagation();
      startDownload([{ ...file, index }]);
    });

    container.appendChild(item);
  });
}

function startDownload(files) {
  const maxConcurrent = parseInt(document.getElementById('maxConcurrent').value) || DEFAULT_MAX_CONCURRENT;

  // Блокируем кнопки
  document.getElementById('downloadSelected').disabled = true;
  document.getElementById('downloadAll').disabled = true;
  document.getElementById('scanBtn').disabled = true;

  // Показываем прогресс-бар
  document.getElementById('progressBar').classList.add('active');
  updateProgress(0, files.length);

  // Передаём управление фоновому скрипту
  chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', files, maxConcurrent }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      // Уже идёт загрузка или ошибка — разблокируем кнопки
      document.getElementById('downloadSelected').disabled = false;
      document.getElementById('downloadAll').disabled = false;
      document.getElementById('scanBtn').disabled = false;
    }
  });
}

function updateProgress(completed, total) {
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const percent = total > 0 ? (completed / total) * 100 : 0;
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${completed} / ${total}`;
}

function finishDownload(completed, total) {
  document.getElementById('downloadSelected').disabled = false;
  document.getElementById('downloadAll').disabled = false;
  document.getElementById('scanBtn').disabled = false;
  document.getElementById('progressText').textContent = i18n('statusCompleted', String(completed), String(total));
}
