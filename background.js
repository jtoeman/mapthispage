/**
 * MapThisPage — Background Service Worker
 *
 * Watches every tab for page load completion, runs the address extractor,
 * and updates the extension icon badge with the count of addresses found.
 *
 * This gives the user an at-a-glance signal before they even open the popup.
 * The window.__mapThisPageElements refs are also populated as a side effect,
 * so scroll-to buttons work immediately when the popup opens.
 */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear badge immediately when navigation starts — feels responsive
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  if (changeInfo.status !== 'complete') return;

  // Skip pages where content scripts can't run
  const url = tab.url || '';
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url === ''
  ) return;

  // allFrames: true so archive.ph, reader modes, and iframe-heavy sites are counted
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/content.js']
  })
  .then(frameResults => {
    // Deduplicate across frames before counting (same address can appear in multiple frames)
    const seen = new Set();
    let count = 0;
    for (const frameResult of (frameResults ?? [])) {
      for (const item of (frameResult.result ?? [])) {
        const key = item.address.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        count++;
      }
    }
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count), tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  })
  .catch(() => {
    // Page blocked script injection (e.g. Chrome Web Store, PDFs) — clear badge
    chrome.action.setBadgeText({ text: '', tabId });
  });
});
