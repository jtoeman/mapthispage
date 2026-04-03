/**
 * Address Extractor — Content Script
 *
 * Scans the page for street addresses using regex, then walks the DOM
 * to find a nearby place name (business name, heading, label, etc.).
 *
 * Returns: Array of { place: string|null, address: string }
 *
 * SLOT A — AI extraction: replace extractAddresses() body with a call to
 *   chrome.runtime.sendMessage({ type: 'AI_EXTRACT', text: document.body.innerText })
 *   and await the same { place, address }[] response shape.
 */

(function () {
  // ─── Address Regexes ───────────────────────────────────────────────────────
  //
  // Two patterns run in sequence; deduplication ensures no address appears twice.
  //
  // PATTERN A — Full address with ZIP (high confidence)
  // Anchors on street number + street type at start, 5-digit ZIP at end.
  // Handles both abbreviated (NY) and full state names (New York).
  //
  //   776 8th Avenue, New York, New York 10036
  //   123 Main Street, Springfield, IL 62701
  //   456 Oak Ave Suite 3, Boston, MA 02101-1234
  //
  const ADDRESS_REGEX =
    /\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){0,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Terrace|Ter|Trail|Trl|Loop|Run|Broadway|Square|Sq)\.?(?:[^<\n\r]{0,80}?)\d{5}(?:-\d{4})?\b/gi;

  // PATTERN B — Editorial/short address without ZIP (moderate confidence)
  // How newspapers and food publications write addresses: street number + name,
  // optional parenthetical cross-street, no ZIP required.
  //
  //   961 Lexington Avenue (70th Street)
  //   432 Lafayette Street
  //   75 9th Avenue
  //   1 World Trade Center
  //
  const SHORT_ADDRESS_REGEX =
    /\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Terrace|Ter|Trail|Trl|Loop|Run|Broadway|Square|Sq)\.?(?:\s*\([^)]{2,40}\))?\b/gi;

  // Tags/classes that suggest a place name element
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const NAME_TAGS = new Set(['STRONG', 'B', 'EM']);
  const NAME_CLASS_PATTERNS = /name|title|label|place|business|venue|location|heading/i;

  // ─── Place Name Detection ───────────────────────────────────────────────────

  /**
   * Score an element as a candidate place-name label.
   * Higher = better. Returns 0 if not a candidate.
   */
  function scoreAsLabel(el) {
    if (!el || el.nodeType !== 1) return 0;
    const tag = el.tagName;
    const text = el.innerText?.trim() || '';
    if (!text || text.length > 120) return 0; // too long = not a name

    if (HEADING_TAGS.has(tag)) return 10;
    if (NAME_TAGS.has(tag)) return 8;
    if (el.className && NAME_CLASS_PATTERNS.test(el.className)) return 6;
    if (el.getAttribute('aria-label')) return 5;
    return 0;
  }

  /**
   * Given the element that contains an address string, walk up and around
   * the DOM to find the most likely place name.
   */
  function findPlaceName(addressEl) {
    let el = addressEl;

    for (let depth = 0; depth < 5; depth++) {
      if (!el) break;

      // 1. Check preceding siblings of current element
      let sibling = el.previousElementSibling;
      let siblingDepth = 0;
      while (sibling && siblingDepth < 4) {
        const score = scoreAsLabel(sibling);
        if (score > 0) return sibling.innerText.trim();

        // Also check children of sibling (e.g. a <div> wrapping a <strong>)
        const child = sibling.querySelector('h1,h2,h3,h4,h5,h6,strong,b,[class*="name"],[class*="title"]');
        if (child && scoreAsLabel(child) > 0) return child.innerText.trim();

        sibling = sibling.previousElementSibling;
        siblingDepth++;
      }

      // 2. Check aria-label on current element or its parent
      const ariaLabel = el.getAttribute?.('aria-label') || el.parentElement?.getAttribute?.('aria-label');
      if (ariaLabel && ariaLabel.length < 100) return ariaLabel.trim();

      // 3. Check if current element has a name-like class/tag and a first child that's a heading
      const firstHeading = el.querySelector?.('h1,h2,h3,h4,h5,h6');
      if (firstHeading) {
        const text = firstHeading.innerText?.trim();
        if (text && text.length < 100) return text;
      }

      el = el.parentElement;
    }

    return null;
  }

  // ─── JSON-LD / Schema.org Extractor ─────────────────────────────────────────
  // Many sites (Eater, Yelp, Google, etc.) embed structured address data in
  // <script type="application/ld+json"> for SEO. This is the most reliable
  // source when available — parse it first.

  function extractFromJsonLd() {
    const results = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    scripts.forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];

        function walkJsonLd(obj) {
          if (!obj || typeof obj !== 'object') return;

          // schema.org PostalAddress
          if (obj['@type'] === 'PostalAddress' || obj.streetAddress) {
            const parts = [
              obj.streetAddress,
              obj.addressLocality,
              obj.addressRegion,
              obj.postalCode
            ].filter(Boolean);

            if (parts.length >= 2 && obj.streetAddress) {
              const address = parts.join(', ');
              // Try to find a name from the parent object
              results.push({ place: null, address, _jsonLd: true });
            }
          }

          // Walk into arrays and nested objects
          Object.values(obj).forEach(val => {
            if (typeof val === 'object') walkJsonLd(val);
          });
        }

        items.forEach(walkJsonLd);
      } catch (e) {
        // Malformed JSON-LD — skip silently
      }
    });

    return results;
  }

  // ─── Main Extractor ─────────────────────────────────────────────────────────

  function extractAddresses() {
    const results = [];
    const seen = new Set();

    // _el is kept internally for scroll support; not sent back to popup
    function addResult({ place, address, _el = null }) {
      const key = address.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ place, address: address.replace(/\s+/g, ' ').trim(), _el });
    }

    // ── Pass 1: Walk individual text nodes ───────────────────────────────────
    // Run before JSON-LD so DOM element refs win deduplication (needed for scroll)
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
            return NodeFilter.FILTER_REJECT;
          }
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text) continue;

      ADDRESS_REGEX.lastIndex = 0;
      let match;
      while ((match = ADDRESS_REGEX.exec(text)) !== null) {
        const containingEl = node.parentElement;
        const place = findPlaceName(containingEl);
        addResult({ place, address: match[0], _el: containingEl });
      }
    }

    // ── Pass 2: JSON-LD structured data ──────────────────────────────────────
    // Catches addresses only in metadata (not visible text); no DOM element available
    extractFromJsonLd().forEach(item => addResult(item));

    // ── Pass 3: document.body.innerText flat scan (ZIP-required regex) ────────
    // Catches addresses split across adjacent DOM nodes; deduplication handles repeats
    try {
      const fullText = document.body.innerText;
      ADDRESS_REGEX.lastIndex = 0;
      let match;
      while ((match = ADDRESS_REGEX.exec(fullText)) !== null) {
        addResult({ place: null, address: match[0], _el: null });
      }
    } catch (e) {
      // innerText unavailable — skip
    }

    // ── Pass 4: Short-address regex (no ZIP required) ─────────────────────────
    // Catches editorial-style addresses: "961 Lexington Avenue (70th Street)"
    // as written by NYT, Eater, archive.ph articles, travel blogs, etc.
    // Runs on both individual text nodes (for DOM element refs) and innerText.
    const walker2 = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
            return NodeFilter.FILTER_REJECT;
          }
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node2;
    while ((node2 = walker2.nextNode())) {
      const text = node2.textContent;
      if (!text) continue;
      SHORT_ADDRESS_REGEX.lastIndex = 0;
      let match;
      while ((match = SHORT_ADDRESS_REGEX.exec(text)) !== null) {
        const containingEl = node2.parentElement;
        const place = findPlaceName(containingEl);
        addResult({ place, address: match[0], _el: containingEl });
      }
    }

    // Also run SHORT_ADDRESS_REGEX on innerText to catch split-node cases
    try {
      const fullText = document.body.innerText;
      SHORT_ADDRESS_REGEX.lastIndex = 0;
      let match;
      while ((match = SHORT_ADDRESS_REGEX.exec(fullText)) !== null) {
        addResult({ place: null, address: match[0], _el: null });
      }
    } catch (e) {
      // innerText unavailable — skip
    }

    // Store element refs on window so popup can scroll to them by index later
    window.__mapThisPageElements = results.map(r => r._el);

    // Return only the data the popup needs (no internal _el)
    return results.map(({ place, address }) => ({ place, address }));
  }

  // Expose to popup via scripting.executeScript return value
  window.__extractAddresses = extractAddresses;

  // Return immediately so scripting.executeScript can capture the result
  return extractAddresses();
})();
