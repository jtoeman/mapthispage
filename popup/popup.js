/**
 * MapThisPage — Popup Script
 *
 * Orchestrates:
 *  1. Injecting content.js into the active tab
 *  2. Receiving the extracted { place, address }[] array
 *  3. Rendering the Gmail-style results table
 *  4. Managing checkbox state (select-all + per-row)
 *  5. Opening addresses in Google Maps (by name when available, address as fallback)
 *
 * SLOT: save-to-list — search for "SLOT" comments below to find all
 *   integration points for a future "Save to My Lists" feature.
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnScan         = document.getElementById('btn-scan');
const btnOpenSelected = document.getElementById('btn-open-selected');
const selectedLabel   = document.getElementById('selected-label');
const bulkBar         = document.getElementById('bulk-bar');
const chkSelectAll    = document.getElementById('chk-select-all');
const resultsBody     = document.getElementById('results-body');
const resultCount     = document.getElementById('result-count');

const stateIdle     = document.getElementById('state-idle');
const stateLoading  = document.getElementById('state-loading');
const stateEmpty    = document.getElementById('state-empty');
const stateResults  = document.getElementById('state-results');

// ── State ─────────────────────────────────────────────────────────────────────
let addresses = []; // [{ place, address, frameId, frameIndex }]
let activeTabId = null; // stored after scan so scroll injections know which tab

// ── Utilities ─────────────────────────────────────────────────────────────────
function showState(name) {
  stateIdle.classList.add('hidden');
  stateLoading.classList.add('hidden');
  stateEmpty.classList.add('hidden');
  stateResults.classList.add('hidden');
  if (name === 'idle')    stateIdle.classList.remove('hidden');
  if (name === 'loading') stateLoading.classList.remove('hidden');
  if (name === 'empty')   stateEmpty.classList.remove('hidden');
  if (name === 'results') stateResults.classList.remove('hidden');
}

/**
 * Build a Google Maps search URL.
 * When a place name is available, include it in the query so Maps surfaces
 * the business listing (with reviews, hours, etc.) rather than a pin on an address.
 * Falls back to address-only when no place name was detected.
 */
function mapsUrl(place, address) {
  const query = place ? `${place} ${address}` : address;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
}

function openInMaps(place, address) {
  chrome.tabs.create({ url: mapsUrl(place, address) });
}

/**
 * Scroll the tab to the element at the given index.
 * Uses window.__mapThisPageElements stored by content.js during the last scan.
 * Targets the correct frame (handles iframes on archive.ph and similar sites).
 * Briefly highlights the element so the user knows where to look.
 */
async function scrollToEntry(index) {
  if (!activeTabId) return;
  const entry = addresses[index];
  if (!entry) return;

  const { frameId, frameIndex } = entry;

  try {
    await chrome.scripting.executeScript({
      // Target the specific frame the element lives in
      target: { tabId: activeTabId, frameIds: [frameId ?? 0] },
      func: (idx) => {
        const els = window.__mapThisPageElements;
        if (!els || !els[idx]) return;
        const el = els[idx];
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background-color 0.2s ease';
        el.style.backgroundColor = '#fef08a';
        setTimeout(() => {
          el.style.backgroundColor = '';
          setTimeout(() => { el.style.transition = ''; }, 300);
        }, 1200);
      },
      args: [frameIndex ?? index]
    });
  } catch (e) {
    // Tab may have navigated away, or frame was unloaded — fail silently
  }
}

// ── Checkbox / selection logic ────────────────────────────────────────────────
function getRowCheckboxes() {
  return Array.from(resultsBody.querySelectorAll('input[type="checkbox"]'));
}

function updateSelectionUI() {
  const all = getRowCheckboxes();
  const checked = all.filter(c => c.checked);
  const count = checked.length;

  // Bulk bar
  if (count > 0) {
    selectedLabel.textContent = `${count} selected`;
    bulkBar.classList.remove('hidden');
  } else {
    bulkBar.classList.add('hidden');
  }

  // Select-all checkbox state
  chkSelectAll.indeterminate = count > 0 && count < all.length;
  chkSelectAll.checked = all.length > 0 && count === all.length;

  // Row highlight
  all.forEach(chk => {
    chk.closest('tr').classList.toggle('selected', chk.checked);
  });
}

chkSelectAll.addEventListener('change', () => {
  getRowCheckboxes().forEach(chk => { chk.checked = chkSelectAll.checked; });
  updateSelectionUI();
});

// ── Table rendering ───────────────────────────────────────────────────────────
function renderResults(items) {
  addresses = items;
  resultsBody.innerHTML = '';

  items.forEach(({ place, address }, index) => {
    const tr = document.createElement('tr');
    tr.dataset.index = index;

    // — Checkbox cell —
    const tdCheck = document.createElement('td');
    tdCheck.className = 'td-check col-check';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.dataset.index = index;
    chk.addEventListener('change', updateSelectionUI);
    tdCheck.appendChild(chk);
    tr.appendChild(tdCheck);

    // — Place cell (name + scroll-to button) —
    const tdPlace = document.createElement('td');
    tdPlace.className = 'col-place';

    const placeSpan = document.createElement('span');
    placeSpan.className = place ? 'place-text' : 'place-unknown';
    placeSpan.textContent = place || '—';
    tdPlace.appendChild(placeSpan);

    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'btn-scroll';
    scrollBtn.textContent = '⬇';
    scrollBtn.title = 'Scroll to this entry on the page';
    scrollBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      scrollToEntry(index);
    });
    tdPlace.appendChild(scrollBtn);

    tr.appendChild(tdPlace);

    // — Address cell —
    const tdAddress = document.createElement('td');
    tdAddress.className = 'col-address';
    const addrSpan = document.createElement('span');
    addrSpan.className = 'address-text';
    addrSpan.textContent = address;
    tdAddress.appendChild(addrSpan);
    tr.appendChild(tdAddress);

    // — Action cell —
    const tdAction = document.createElement('td');
    tdAction.className = 'td-action col-action';

    const mapsBtn = document.createElement('button');
    mapsBtn.className = 'btn-maps';
    mapsBtn.textContent = '🗺';
    // Tooltip shows what query will be sent to Maps
    mapsBtn.title = place
      ? `Search Maps: "${place} ${address}"`
      : `Search Maps: "${address}"`;
    mapsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInMaps(place, address);
      // SLOT: save-to-list — add a second icon button here for saving
    });
    tdAction.appendChild(mapsBtn);

    // SLOT: save-to-list — uncomment and implement when ready:
    // const saveBtn = document.createElement('button');
    // saveBtn.className = 'btn-save';
    // saveBtn.textContent = '🔖';
    // saveBtn.title = 'Save to list';
    // saveBtn.addEventListener('click', () => saveToList({ place, address }));
    // tdAction.appendChild(saveBtn);

    tr.appendChild(tdAction);

    // Clicking anywhere on the row (except checkbox/button) toggles checkbox
    tr.addEventListener('click', (e) => {
      if (e.target === chk || e.target === mapsBtn) return;
      chk.checked = !chk.checked;
      updateSelectionUI();
    });

    resultsBody.appendChild(tr);
  });

  resultCount.textContent = `${items.length} address${items.length !== 1 ? 'es' : ''} found`;

  chkSelectAll.checked = false;
  chkSelectAll.indeterminate = false;
  bulkBar.classList.add('hidden');

  showState('results');
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scanPage() {
  showState('loading');
  resultsBody.innerHTML = '';
  chkSelectAll.checked = false;
  chkSelectAll.indeterminate = false;
  bulkBar.classList.add('hidden');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      showState('empty');
      return;
    }

    activeTabId = tab.id; // store so scroll buttons can target the right tab

    // allFrames: true catches content inside iframes (archive.ph, reader modes, etc.)
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content/content.js']
    });

    // Flatten results across all frames, deduplicating by address.
    // Track frameId + frameIndex so scroll-to can target the right frame later.
    const seen = new Set();
    const extracted = [];
    for (const frameResult of (frameResults ?? [])) {
      const frameId = frameResult.frameId;
      (frameResult.result ?? []).forEach((item, frameIndex) => {
        const key = item.address.toLowerCase().trim();
        if (seen.has(key)) return;
        seen.add(key);
        extracted.push({ ...item, frameId, frameIndex });
      });
    }

    if (extracted.length === 0) {
      chrome.action.setBadgeText({ text: '', tabId: tab.id });
      showState('empty');
      return;
    }

    renderResults(extracted);

    // Keep badge in sync with manual scan (e.g. after dynamic content loads)
    chrome.action.setBadgeText({ text: String(extracted.length), tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId: tab.id });

  } catch (err) {
    console.error('[MapThisPage] Scan failed:', err);
    stateEmpty.querySelector('p').textContent =
      'Could not scan this page. Chrome restricts extensions on some pages (e.g. chrome://, new tab).';
    showState('empty');
  }
}

// ── Bulk open ─────────────────────────────────────────────────────────────────
btnOpenSelected.addEventListener('click', () => {
  const checked = getRowCheckboxes().filter(c => c.checked);
  checked.forEach(chk => {
    const { place, address } = addresses[parseInt(chk.dataset.index, 10)];
    openInMaps(place, address);
    // SLOT: save-to-list — call saveToList({ place, address }) here for bulk save
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
btnScan.addEventListener('click', scanPage);
scanPage(); // auto-scan on open
