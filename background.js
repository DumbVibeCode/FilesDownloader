let downloadQueue = [];
let activeDownloads = 0;
let completedDownloads = 0;
let totalToDownload = 0;
let isDownloading = false;
let maxConcurrent = 3;

// downloadId -> fileIndex
const downloadMap = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD') {
    if (isDownloading) {
      sendResponse({ ok: false, reason: 'already_downloading' });
      return true;
    }
    isDownloading = true;
    downloadQueue = [...message.files];
    activeDownloads = 0;
    completedDownloads = 0;
    totalToDownload = message.files.length;
    maxConcurrent = message.maxConcurrent || 3;
    processQueue();
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    sendResponse({ isDownloading, completedDownloads, totalToDownload });
  }
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;

  const fileIndex = downloadMap[delta.id];
  if (fileIndex === undefined) return;

  if (delta.state.current === 'complete') {
    delete downloadMap[delta.id];
    handleDownloadComplete(fileIndex, true);
  } else if (delta.state.current === 'interrupted') {
    delete downloadMap[delta.id];
    handleDownloadComplete(fileIndex, false);
  }
});

function processQueue() {
  while (downloadQueue.length > 0 && activeDownloads < maxConcurrent) {
    const file = downloadQueue.shift();
    downloadFile(file);
  }
}

function downloadFile(file) {
  activeDownloads++;
  notifyPopup({ type: 'FILE_DOWNLOADING', fileIndex: file.index });

  chrome.downloads.download({ url: file.url, filename: file.filename, saveAs: false }, (downloadId) => {
    if (chrome.runtime.lastError || !downloadId) {
      handleDownloadComplete(file.index, false);
    } else {
      downloadMap[downloadId] = file.index;
    }
  });
}

function handleDownloadComplete(fileIndex, success) {
  activeDownloads--;
  completedDownloads++;

  notifyPopup({ type: 'FILE_COMPLETE', fileIndex, success, completedDownloads, totalToDownload });

  if (downloadQueue.length > 0) {
    processQueue();
  } else if (activeDownloads === 0) {
    isDownloading = false;
    notifyPopup({ type: 'ALL_COMPLETE', completedDownloads, totalToDownload });
  }
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // popup закрыт — игнорируем
  });
}
