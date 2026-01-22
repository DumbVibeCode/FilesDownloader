let foundFiles = [];
let downloadQueue = [];
let activeDownloads = 0;
let completedDownloads = 0;
let totalToDownload = 0;
let isDownloading = false;

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_EXTENSIONS = 'mp3';

document.addEventListener('DOMContentLoaded', async () => {
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
  
  // Сохраняем количество параллельных загрузок при изменении
  maxConcurrentInput.addEventListener('change', () => {
    const value = Math.min(10, Math.max(1, parseInt(maxConcurrentInput.value) || DEFAULT_MAX_CONCURRENT));
    maxConcurrentInput.value = value;
    chrome.storage.local.set({ maxConcurrent: value });
  });
  
  // Обработка пресетов
  document.querySelectorAll('.ext-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const ext = btn.dataset.ext;
      extensionsInput.value = ext;
      updatePresetButtons(ext);
    });
  });
  
  // Обновление подсветки пресетов при вводе
  extensionsInput.addEventListener('input', () => {
    updatePresetButtons(extensionsInput.value);
  });
  
  // Сканирование по Enter
  extensionsInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      scanBtn.click();
    }
  });
  
  // Кнопка сканирования
  scanBtn.addEventListener('click', async () => {
    const extensions = parseExtensions(extensionsInput.value);
    
    if (extensions.length === 0) {
      statusEl.textContent = 'Введите хотя бы одно расширение';
      statusEl.className = 'status error';
      return;
    }
    
    // Сохраняем как формат по умолчанию, если выбрано
    if (saveAsDefaultCheckbox.checked) {
      chrome.storage.local.set({ defaultExtensions: extensionsInput.value });
      saveAsDefaultCheckbox.checked = false;
    }
    
    await scanPage(extensions);
  });
  
  // Обработчики выбора
  document.getElementById('selectAll').addEventListener('click', () => {
    document.querySelectorAll('.file-item input').forEach(cb => cb.checked = true);
  });
  
  document.getElementById('selectNone').addEventListener('click', () => {
    document.querySelectorAll('.file-item input').forEach(cb => cb.checked = false);
  });
  
  // Обработчики скачивания
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
  
  // Слушаем события завершения загрузки
  chrome.downloads.onChanged.addListener(handleDownloadChange);
  
  // Автоматическое сканирование при открытии, если есть расширения по умолчанию
  chrome.storage.local.get(['defaultExtensions'], async (result) => {
    if (result.defaultExtensions) {
      const extensions = parseExtensions(result.defaultExtensions);
      if (extensions.length > 0) {
        await scanPage(extensions);
      }
    }
  });
});

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
  
  statusEl.textContent = 'Сканирование...';
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
      statusEl.textContent = `Файлы не найдены (${extList})`;
      statusEl.className = 'status error';
      return;
    }
    
    statusEl.textContent = `Найдено: ${foundFiles.length} файл(ов)`;
    statusEl.className = 'status found';
    resultsEl.classList.add('visible');
    
    renderFileList(fileListEl);
    
  } catch (error) {
    statusEl.textContent = 'Ошибка: ' + error.message;
    statusEl.className = 'status error';
  }
}

// Функция поиска файлов (выполняется в контексте страницы)
function findFiles(extensions) {
  const fileSet = new Map(); // url -> { url, filename, ext }
  
  // Создаём регулярку для поиска расширений
  const extPattern = new RegExp(`\\.(${extensions.join('|')})(\\?.*)?$`, 'i');
  
  function addFile(url) {
    if (!url || fileSet.has(url)) return;
    if (!extPattern.test(url)) return;
    
    let filename, ext;
    try {
      const urlObj = new URL(url, location.href);
      const fullUrl = urlObj.href;
      const pathname = urlObj.pathname;
      filename = decodeURIComponent(pathname.split('/').pop());
      ext = filename.split('.').pop().toLowerCase();
      
      if (!fileSet.has(fullUrl)) {
        fileSet.set(fullUrl, { url: fullUrl, filename, ext });
      }
    } catch {
      // Игнорируем некорректные URL
    }
  }
  
  // Ищем во всех ссылках
  document.querySelectorAll('a[href]').forEach(a => {
    addFile(a.href);
  });
  
  // Ищем в аудио/видео элементах
  document.querySelectorAll('audio source, audio[src], video source, video[src]').forEach(el => {
    addFile(el.src || el.getAttribute('src'));
  });
  
  // Ищем в embed и object
  document.querySelectorAll('embed[src], object[data]').forEach(el => {
    addFile(el.src || el.getAttribute('data'));
  });
  
  // Ищем в iframe
  document.querySelectorAll('iframe[src]').forEach(el => {
    addFile(el.src);
  });
  
  // Ищем в атрибутах data-*
  const dataAttrs = ['data-src', 'data-url', 'data-href', 'data-file', 'data-download',
                     'data-mp3', 'data-mp4', 'data-audio', 'data-video', 'data-pdf'];
  
  dataAttrs.forEach(attr => {
    document.querySelectorAll(`[${attr}]`).forEach(el => {
      addFile(el.getAttribute(attr));
    });
  });
  
  // Ищем в onclick и других обработчиках (href в javascript)
  document.querySelectorAll('[onclick], [onmousedown]').forEach(el => {
    const handlers = [el.getAttribute('onclick'), el.getAttribute('onmousedown')];
    handlers.forEach(handler => {
      if (!handler) return;
      // Пытаемся найти URL в обработчике
      const urlMatches = handler.match(/['"]([^'"]+\.(${extensions.join('|')})(\?[^'"]*)?)['"]/gi);
      if (urlMatches) {
        urlMatches.forEach(match => {
          const url = match.slice(1, -1); // Убираем кавычки
          addFile(url);
        });
      }
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
    
    // Клик по названию переключает чекбокс
    item.querySelector('.file-info').addEventListener('click', () => {
      const cb = item.querySelector('input');
      cb.checked = !cb.checked;
    });
    
    // Кнопка скачивания одного файла
    item.querySelector('.download-single').addEventListener('click', (e) => {
      e.stopPropagation();
      startDownload([{ ...file, index }]);
    });
    
    container.appendChild(item);
  });
}

function startDownload(files) {
  if (isDownloading) return;
  
  isDownloading = true;
  downloadQueue = [...files];
  activeDownloads = 0;
  completedDownloads = 0;
  totalToDownload = files.length;
  
  // Показываем прогресс-бар
  const progressBar = document.getElementById('progressBar');
  progressBar.classList.add('active');
  updateProgress();
  
  // Блокируем кнопки
  document.getElementById('downloadSelected').disabled = true;
  document.getElementById('downloadAll').disabled = true;
  document.getElementById('scanBtn').disabled = true;
  
  // Запускаем загрузки
  processQueue();
}

function processQueue() {
  const maxConcurrent = parseInt(document.getElementById('maxConcurrent').value) || DEFAULT_MAX_CONCURRENT;
  
  while (downloadQueue.length > 0 && activeDownloads < maxConcurrent) {
    const file = downloadQueue.shift();
    downloadFile(file);
  }
}

function downloadFile(file) {
  activeDownloads++;
  
  // Обновляем статус в списке
  const statusEl = document.getElementById(`status-${file.index}`);
  const itemEl = document.getElementById(`file-item-${file.index}`);
  
  if (statusEl) {
    statusEl.textContent = 'загрузка...';
    statusEl.className = 'file-status downloading';
  }
  if (itemEl) {
    itemEl.classList.add('downloading');
    itemEl.classList.remove('completed');
  }
  
  chrome.downloads.download({
    url: file.url,
    filename: file.filename,
    saveAs: false
  }, (downloadId) => {
    if (downloadId) {
      // Сохраняем связь downloadId -> file.index
      chrome.storage.local.get(['downloadMap'], (result) => {
        const map = result.downloadMap || {};
        map[downloadId] = file.index;
        chrome.storage.local.set({ downloadMap: map });
      });
    } else {
      // Ошибка при запуске загрузки
      handleDownloadComplete(file.index, false);
    }
  });
}

function handleDownloadChange(delta) {
  if (delta.state && delta.state.current === 'complete') {
    chrome.storage.local.get(['downloadMap'], (result) => {
      const map = result.downloadMap || {};
      const fileIndex = map[delta.id];
      
      if (fileIndex !== undefined) {
        handleDownloadComplete(fileIndex, true);
        delete map[delta.id];
        chrome.storage.local.set({ downloadMap: map });
      }
    });
  } else if (delta.state && delta.state.current === 'interrupted') {
    chrome.storage.local.get(['downloadMap'], (result) => {
      const map = result.downloadMap || {};
      const fileIndex = map[delta.id];
      
      if (fileIndex !== undefined) {
        handleDownloadComplete(fileIndex, false);
        delete map[delta.id];
        chrome.storage.local.set({ downloadMap: map });
      }
    });
  }
}

function handleDownloadComplete(fileIndex, success) {
  activeDownloads--;
  completedDownloads++;
  
  // Обновляем статус в списке
  const statusEl = document.getElementById(`status-${fileIndex}`);
  const itemEl = document.getElementById(`file-item-${fileIndex}`);
  
  if (statusEl) {
    statusEl.textContent = success ? '✓' : '✗';
    statusEl.className = success ? 'file-status completed' : 'file-status error';
  }
  if (itemEl) {
    itemEl.classList.remove('downloading');
    if (success) itemEl.classList.add('completed');
  }
  
  updateProgress();
  
  // Запускаем следующие загрузки
  if (downloadQueue.length > 0) {
    processQueue();
  } else if (activeDownloads === 0) {
    // Все загрузки завершены
    finishDownload();
  }
}

function updateProgress() {
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  
  const percent = totalToDownload > 0 ? (completedDownloads / totalToDownload) * 100 : 0;
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${completedDownloads} / ${totalToDownload}`;
}

function finishDownload() {
  isDownloading = false;
  
  // Разблокируем кнопки
  document.getElementById('downloadSelected').disabled = false;
  document.getElementById('downloadAll').disabled = false;
  document.getElementById('scanBtn').disabled = false;
  
  // Обновляем текст прогресса
  document.getElementById('progressText').textContent = `Завершено: ${completedDownloads} / ${totalToDownload}`;
}
