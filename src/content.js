console.log("[Unspoiled] content script loaded");

const API_URL = "https://unspoiled-api-sable.vercel.app/api/classify";

// Selectors per platform
function getSelectors() {
  const host = location.hostname;
  if (host.includes("x.com") || host.includes("twitter.com")) {
    return {
      post: 'article[data-testid="tweet"]',
      text: '[data-testid="tweetText"]',
    };
  }
  if (host.includes("youtube.com")) {
    return {
      post: "ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model, ytd-grid-video-renderer, ytd-comment-thread-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-video-renderer",
      text: "#video-title, #content-text",
    };
  }
  return null;
}

let blocklist = [];
const processedIds = new Set(); // status IDs (or element refs on non-X platforms) already classified
const processedTexts = new Map(); // key → postText so we can re-attach flag on scroll-back
const spoilerIds = new Map();   // key → postText for confirmed spoilers — re-blur on scroll
const spoilerShowIds = new Map(); // key → showId that triggered the blur
const activeFeedbackBars = new Map(); // postId → bar element for bars currently visible
let keywords = [];
let total = 0;
let passed = 0;
let currentSelectors = null;
let stylesInjected = false;

function buildKeywords(list) {
  const articles = new Set(["the", "a", "an"]);
  const kws = new Set();
  for (const show of list) {
    const title = show.title.toLowerCase();
    kws.add(title);
    const words = title.split(/\s+/);
    if (words.length > 1) {
      // Title with articles stripped (e.g. "Last of Us" from "The Last of Us")
      const stripped = words.filter((w) => !articles.has(w)).join(" ");
      if (stripped !== title) kws.add(stripped);
      // Individual words except articles
      words.forEach((w) => { if (!articles.has(w)) kws.add(w); });
    }
  }
  return [...kws];
}

function getStatusId(el) {
  const link = el.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

const UI_CHROME = new Set([
  "Retweet", "Retweets", "Like", "Likes", "Reply", "Replies",
  "Quote", "Bookmark", "Share", "View", "Views", "More",
]);

function extractPostText(el, selectors) {
  if (el.tagName?.toLowerCase() === "ytd-reel-video-renderer") {
    const titleEl = el.querySelector("ytd-reel-player-overlay-renderer #title") ||
      el.querySelector("#title") || el.querySelector("h2");
    const title = titleEl?.textContent?.trim() || "";
    console.log("[Unspoiled] Shorts player title extracted:", title.slice(0, 80));
    if (!title) {
      setTimeout(() => {
        if (!el.dataset.unspoiled && !el.dataset.unspoiledPreblur) {
          processedIds.delete(el);
          enqueue(el, currentSelectors);
        }
      }, 800);
    }
    return { text: title || "short", source: "shorts-player" };
  }
  if (el.tagName?.toLowerCase() === "ytm-shorts-lockup-view-model" || el.tagName?.toLowerCase() === "ytm-shorts-lockup-view-model-v2") {
    const titleEl = el.querySelector("h3 a span[role='text']") || el.querySelector("h3 a") || el.querySelector("h3");
    const title = titleEl?.textContent?.trim() || "";
    console.log("[Unspoiled] Shorts title extracted:", title.slice(0, 80));
    if (!title) {
      setTimeout(() => {
        if (!el.dataset.unspoiled && !el.dataset.unspoiledPreblur) {
          processedIds.delete(el);
          enqueue(el, currentSelectors);
        }
      }, 1000);
    }
    return { text: title || "short", source: "shorts" };
  }

  // YouTube sidebar lockup: innerText is "title\nchannel\nviews…" — first line is the title
  if (el.tagName?.toLowerCase() === "yt-lockup-view-model") {
    const titleEl =
      el.querySelector("#video-title") ||
      el.querySelector("h3") ||
      el.querySelector("[title]");
    const title = titleEl?.textContent?.trim() || titleEl?.getAttribute("title") || "";
    console.log("[Unspoiled] yt-lockup title extracted:", title.slice(0, 80));
    return { text: title || "video", source: "yt-lockup" };
  }

  // 1. tweetText span
  const bodyText = el.querySelector(selectors.text)?.innerText?.trim();
  if (bodyText) return { text: bodyText, source: "tweetText" };

  // 2. aria-label on article (X encodes full tweet content here)
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return { text: ariaLabel, source: "aria-label" };

  // 3. img alt text (user-provided captions on media)
  const imgAlts = [...el.querySelectorAll("img[alt]")]
    .map((img) => img.alt.trim())
    .filter(Boolean)
    .join(" ");
  if (imgAlts) return { text: imgAlts, source: "img-alt" };

  // 4. Leaf spans, excluding UI chrome labels and bare numbers
  const spanText = [...el.querySelectorAll("span")]
    .filter((s) => !s.querySelector("span")) // leaf nodes only — avoid duplicating parent text
    .map((s) => s.innerText?.trim())
    .filter((t) => t && t.length > 1 && !UI_CHROME.has(t) && !/^\d+$/.test(t))
    .join(" ");
  if (spanText) return { text: spanText, source: "spans" };

  // 5. Give up — keyword filter will reject this naturally, no API call wasted
  return { text: "image post", source: "fallback" };
}

function preBlur(el) {
  if (el.dataset.unspoiledPreblur || el.dataset.unspoiled) return;
  el.dataset.unspoiledPreblur = "pending";
  el.style.visibility = "hidden"; // hide content instantly while Gemini responds
}

function removePreBlur(el) {
  if (!el.dataset.unspoiledPreblur) return;
  delete el.dataset.unspoiledPreblur;
  el.style.visibility = "";
}

function passesKeywordFilter(text) {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

async function init() {
  const data = await chrome.storage.local.get(["blocklist"]);
  blocklist = data.blocklist || [];
  console.log("[Unspoiled] blocklist:", blocklist);

  currentSelectors = getSelectors();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.blocklist) {
      const newBlocklist = changes.blocklist.newValue || [];
      const oldBlocklist = blocklist;
      const removedShows = oldBlocklist.filter(
        (show) => !newBlocklist.some((s) => (s.id && show.id) ? s.id === show.id : s.title === show.title)
      );
      const addedShows = newBlocklist.filter(
        (show) => !oldBlocklist.some((s) => (s.id && show.id) ? s.id === show.id : s.title === show.title)
      );
      blocklist = newBlocklist;
      keywords = buildKeywords(blocklist);
      if (removedShows.length > 0) {
        unblurRemovedShows(removedShows);
        scanAllVisiblePosts(); // re-evaluate visible posts whose blur was removed
      }
      if (addedShows.length > 0) {
        processedIds.clear(); // force re-evaluation of all visible posts against new show
        scanAllVisiblePosts();
      }
    }
  });

  if (blocklist.length === 0 || !currentSelectors) return;

  keywords = buildKeywords(blocklist);
  injectStyles();
  stylesInjected = true;
  scanPage(currentSelectors);
  observePage(currentSelectors);
  if (location.hostname.includes("youtube.com")) {
    observeYouTubeSidebar(currentSelectors);
    observeYouTubeShorts(currentSelectors);
  }
}

function unblurRemovedShows(removedShows) {
  for (const show of removedShows) {
    const showId = String(show.id || show.title);
    document.querySelectorAll(`.unspoiled-overlay[data-unspoiled-show="${CSS.escape(showId)}"]`).forEach((overlay) => {
      const container = overlay.parentNode;
      if (!container) { overlay.remove(); return; }
      // YouTube overlays live inside the blurred element itself; X overlays are siblings of it
      const el = container.dataset.unspoiled === "blurred"
        ? container
        : [...container.children].find((child) => child.dataset.unspoiled === "blurred");
      if (!el) { overlay.remove(); return; }

      const key = el.dataset.statusId || el;
      const postText = spoilerIds.get(key) || processedTexts.get(key) || "";

      // Keep blurred if post still matches a remaining show
      if (postText && keywords.some((kw) => postText.toLowerCase().includes(kw))) return;

      el.style.filter = "";
      el.style.pointerEvents = "";
      el.style.visibility = "";
      delete el.dataset.unspoiled;
      overlay.remove();
      spoilerIds.delete(key);
      spoilerShowIds.delete(key);
      processedIds.delete(key); // allow re-evaluation if show is re-added
      addFlagButton(el, key, postText);
    });
  }
}

function scanAllVisiblePosts() {
  if (!currentSelectors || blocklist.length === 0) return;
  if (!stylesInjected) {
    injectStyles();
    stylesInjected = true;
    observePage(currentSelectors);
  }
  const count = document.querySelectorAll(currentSelectors.post).length;
  console.log(`[Unspoiled] rescanning ${count} visible posts after blocklist change`);
  scanPage(currentSelectors);
}

function findMatchingShowId(text) {
  const lower = text.toLowerCase();
  for (const show of blocklist) {
    const showKws = buildKeywords([show]);
    if (showKws.some((kw) => lower.includes(kw))) return String(show.id || show.title);
  }
  return null;
}

function scanPage(selectors) {
  document.querySelectorAll(selectors.post).forEach((el) => enqueue(el, selectors));

  // Explicit pass for YouTube sidebar lockup cards — confirms they're actually present/found
  if (location.hostname.includes("youtube.com")) {
    const lockups = document.querySelectorAll("yt-lockup-view-model");
    console.log("[Unspoiled] found yt-lockup-view-model:", lockups.length);
    lockups.forEach((el) => enqueue(el, selectors));
  }
}

function getFeedContainer() {
  const host = location.hostname;
  if (host.includes("x.com") || host.includes("twitter.com")) {
    // primaryColumn covers most views; main[role="main"] covers x.com/home and some SPAs
    return document.querySelector('div[data-testid="primaryColumn"]')
      || document.querySelector('main[role="main"]')
      || document.body;
  }
  if (host.includes("youtube.com")) {
    return document.querySelector("ytd-page-manager") || document.body;
  }
  return document.body;
}

function observePage(selectors) {
  const container = getFeedContainer();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(selectors.post)) {
          enqueue(node, selectors);
          reattachFeedbackBar(node);
        }
        node.querySelectorAll(selectors.post).forEach((el) => {
          enqueue(el, selectors);
          reattachFeedbackBar(el);
        });
        // Explicit catch for YouTube sidebar lockup cards added dynamically
        if (node.matches?.("yt-lockup-view-model")) enqueue(node, selectors);
        node.querySelectorAll?.("yt-lockup-view-model").forEach((el) => enqueue(el, selectors));
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

// YouTube's "up next" sidebar (yt-lockup-view-model cards inside
// ytd-watch-next-secondary-results-renderer) sits outside the scope the main feed observer
// reliably covers, so it gets its own watcher: an initial scan (its items are usually already
// in the DOM by the time we run) plus a dedicated MutationObserver — both feeding the same
// keyword filter → classify → blur pipeline as the feed.
function observeYouTubeSidebar(selectors) {
  const scan = (container) => {
    [...container.querySelectorAll("yt-lockup-view-model")].forEach((el, i) => {
      if (i === 0 && el.innerText?.includes("Sponsored")) return;
      const title = (el.innerText || "").split("\n")[0].trim();
      if (!title) {
        setTimeout(() => enqueue(el, selectors), 500);
      } else {
        enqueue(el, selectors);
      }
    });
  };

  const attach = (container) => {
    setTimeout(() => scan(container), 1000);
    const observer = new MutationObserver(() => scan(container));
    observer.observe(container, { childList: true, subtree: true });
  };

  const container = document.querySelector("ytd-watch-next-secondary-results-renderer");
  if (container) {
    attach(container);
    return;
  }

  // Container isn't rendered yet (e.g. landed on a non-watch page first) — wait for it
  const watcher = new MutationObserver(() => {
    const el = document.querySelector("ytd-watch-next-secondary-results-renderer");
    if (!el) return;
    watcher.disconnect();
    attach(el);
  });
  watcher.observe(document.body, { childList: true, subtree: true });
}

function observeYouTubeShorts(selectors) {
  if (!location.pathname.startsWith("/shorts")) return;
  const scan = () => {
    document.querySelectorAll("ytd-reel-video-renderer").forEach((el) => enqueue(el, selectors));
  };
  setTimeout(scan, 800);
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
}

function enqueue(el, selectors) {
  const id = getStatusId(el);
  const key = id || el; // fall back to element ref on non-X platforms

  if (processedIds.has(key)) {
    if (spoilerIds.has(key)) {
      blurPost(el, spoilerIds.get(key), spoilerShowIds.get(key)); // re-blur on scroll
    } else {
      addFlagButton(el, key, processedTexts.get(key)); // re-attach flag to recreated element
    }
    return;
  }

  const { text, source } = extractPostText(el, selectors);
  console.log(`[Unspoiled] post text extracted: ${text.length} chars from: ${source}`);
  processedIds.add(key);
  processedTexts.set(key, text);
  total++;
  addFlagButton(el, key, text);
  if (!passesKeywordFilter(text)) {
    if (location.hostname.includes("youtube.com")) {
      console.log("[Unspoiled] keyword MISS:", text.slice(0, 80), "| keywords:", keywords.slice(0, 5));
    }
    return;
  }
  passed++;
  console.log("[Unspoiled] scanned:", total, "keyword-passed:", passed);
  preBlur(el);
  classifyBatch([{ el, text, key }]);
}

async function classifyBatch(batch) {
  const posts = batch.map(({ text, key }, i) => ({
    id: typeof key === "string" ? key : `p${i}`,
    text,
  }));

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts, blocklist }),
    });

    if (!res.ok) {
      batch.forEach(({ el }) => removePreBlur(el));
      console.error("[Unspoiled] API error:", res.status);
      return;
    }

    const data = await res.json();
    console.log("[Unspoiled] classify response:", data);
    const resultMap = new Map(data.results.map((r) => [String(r.id), r.spoiler]));

    batch.forEach(({ el, text, key }, i) => {
      const postId = typeof key === "string" ? key : `p${i}`;
      if (resultMap.get(postId) === true) {
        const showId = findMatchingShowId(text);
        spoilerIds.set(key, text);
        spoilerShowIds.set(key, showId);
        if (typeof key === "string") el.dataset.statusId = key;
        blurPost(el, text, showId);
        console.log("[Unspoiled] blurring post:", text.slice(0, 50));
        chrome.storage.local.get(["spoilerCount"], (data) => {
          chrome.storage.local.set({ spoilerCount: (data.spoilerCount || 0) + 1 });
        });
      } else {
        removePreBlur(el);
      }
    });
  } catch (err) {
    batch.forEach(({ el }) => removePreBlur(el));
    console.error("[Unspoiled] classify error:", err);
  }
}

function addFlagButton(el, key, postText) {
  if (el.querySelector(".unspoiled-flag-btn")) return; // already present
  if (window.getComputedStyle(el).position === "static") el.style.position = "relative";

  const btn = document.createElement("button");
  btn.className = "unspoiled-flag-btn";
  btn.title = "Report as missed spoiler";
  btn.innerHTML = `<span class="unspoiled-flag-icon">🚩</span><span class="unspoiled-flag-label">Spoiler?</span>`;
  el.appendChild(btn);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.storage.local.get(["feedback"], (data) => {
      const fb = data.feedback || [];
      fb.push({ postId: typeof key === "string" ? key : null, postText: postText?.slice(0, 200), action: "missed_spoiler", ts: Date.now() });
      chrome.storage.local.set({ feedback: fb });
    });
    showToast("Thanks — we'll improve detection");
    btn.remove();
    if (typeof key === "string") {
      spoilerIds.set(key, postText);
      el.dataset.statusId = key;
    }
    blurPost(el, postText);
  });
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "unspoiled-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function blurYouTubePost(el, postText, showId = null) {
  // YouTube post cards share a parent container — never blur it, only the matched card itself
  if (!currentSelectors || !el.matches(currentSelectors.post)) return;

  el.dataset.unspoiled = "blurred";
  el.querySelector(".unspoiled-flag-btn")?.remove();

  if (window.getComputedStyle(el).position === "static") {
    el.style.position = "relative";
  }
  delete el.dataset.unspoiledPreblur;
  el.style.visibility = "hidden"; // hides el's content; overlay opts back into visible below
  el.querySelector("video")?.pause();

  const overlay = document.createElement("div");
  overlay.className = "unspoiled-overlay unspoiled-yt-overlay";
  if (showId) overlay.dataset.unspoiledShow = showId;
  overlay.innerHTML = `
    <div class="unspoiled-overlay-inner">
      <div class="unspoiled-dots"><span class="ud ud1"></span><span class="ud ud2"></span><span class="ud ud3"></span></div>
      <div class="unspoiled-wordmark">Unspoiled</div>
      <button class="unspoiled-reveal-btn unspoiled-reveal-solid" type="button">Click to reveal</button>
    </div>
  `;
  el.appendChild(overlay);

  overlay.querySelector(".unspoiled-reveal-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    el.style.visibility = "";
    el.dataset.unspoiled = "revealed";
    overlay.remove();
    showFeedbackBar(el, el.dataset.statusId || null, postText);
  });
}

function blurPost(el, postText, showId = null) {
  if (el.dataset.unspoiled) return;

  if (location.hostname.includes("youtube.com")) {
    blurYouTubePost(el, postText, showId);
    return;
  }

  el.dataset.unspoiled = "blurred";
  el.querySelector(".unspoiled-flag-btn")?.remove();

  // Apply filter before restoring visibility — no intermediate flash
  el.style.filter = "blur(20px) brightness(0.3)";
  el.style.transition = "filter 0.3s";
  el.style.pointerEvents = "none";
  delete el.dataset.unspoiledPreblur;
  el.style.visibility = "";

  const container = el.parentNode;
  if (window.getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.className = "unspoiled-overlay";
  if (showId) overlay.dataset.unspoiledShow = showId;
  overlay.innerHTML = `
    <div class="unspoiled-overlay-inner">
      <div class="unspoiled-dots"><span class="ud ud1"></span><span class="ud ud2"></span><span class="ud ud3"></span></div>
      <div class="unspoiled-wordmark">Unspoiled</div>
      <button class="unspoiled-reveal-btn unspoiled-reveal-solid" type="button">Click to reveal</button>
    </div>
  `;
  container.appendChild(overlay);

  overlay.querySelector(".unspoiled-reveal-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    el.style.filter = "none";
    el.style.pointerEvents = "";
    el.dataset.unspoiled = "revealed";
    overlay.remove();
    showFeedbackBar(el, el.dataset.statusId || null, postText);
  });
}

function showFeedbackBar(el, postId, postText) {
  const bar = document.createElement("div");
  bar.className = "unspoiled-feedback-bar";
  bar.dataset.unspoiledFeedback = "true";
  bar.innerHTML = `
    <span class="unspoiled-feedback-label">Was this a spoiler?</span>
    <button class="unspoiled-fb-btn" data-action="spoiler">✓ Was a spoiler</button>
    <button class="unspoiled-fb-btn" data-action="false_positive">✗ Not a spoiler</button>
  `;
  document.body.appendChild(bar); // fixed to viewport — never inside article DOM

  if (postId) activeFeedbackBars.set(postId, bar);

  const dismiss = () => {
    bar.remove();
    if (postId) activeFeedbackBars.delete(postId);
  };

  const logFeedback = (action) => {
    chrome.storage.local.get(["feedback"], (data) => {
      const fb = data.feedback || [];
      fb.push({ postId, postText: postText?.slice(0, 200), action, ts: Date.now() });
      chrome.storage.local.set({ feedback: fb });
    });
  };

  bar.querySelectorAll(".unspoiled-fb-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      logFeedback(btn.dataset.action);
      dismiss();
    });
  });

  setTimeout(dismiss, 5000);
}

function reattachFeedbackBar(_el) {
  // no-op: feedback bar lives in document.body (position:fixed), not in article DOM
}

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .unspoiled-flag-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      z-index: 100;
    }
    .unspoiled-flag-icon {
      font-size: 16px;
      line-height: 1;
    }
    .unspoiled-flag-label {
      background: #e0245e;
      color: #fff;
      font-size: 11px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .unspoiled-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.82);
      color: #fff;
      padding: 8px 18px;
      border-radius: 999px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      z-index: 99999;
      pointer-events: none;
      transition: opacity 0.3s;
    }
    .unspoiled-dots {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 10px;
    }
    .unspoiled-dots .ud {
      display: block;
      border-radius: 50%;
      background: #fb6f47;
    }
    .unspoiled-dots .ud1 { width: 13px; height: 13px; opacity: 1; }
    .unspoiled-dots .ud2 { width: 10px; height: 10px; opacity: 0.58; }
    .unspoiled-dots .ud3 { width: 7px; height: 7px; opacity: 0.25; }
    .unspoiled-wordmark {
      color: #fffdf9;
      font-size: 20px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: -0.3px;
      margin-bottom: 12px;
    }
    .unspoiled-reveal-solid {
      background: #fb6f47 !important;
      border: none !important;
      color: #fffdf9 !important;
      font-weight: 700 !important;
    }
    .unspoiled-reveal-solid:hover {
      background: #e8512a !important;
    }
    .unspoiled-overlay {
      position: absolute;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(20, 17, 14, 0.92);
      cursor: pointer;
    }
    .unspoiled-overlay-inner {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      text-align: center;
      pointer-events: none;
    }
    .unspoiled-title {
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.01em;
    }
    .unspoiled-subtitle {
      color: rgba(255, 255, 255, 0.7);
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .unspoiled-yt-overlay {
      visibility: visible; /* opt out of the blurred element's visibility: hidden */
      cursor: default;
    }
    .unspoiled-reveal-btn {
      pointer-events: auto;
      padding: 6px 16px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .unspoiled-reveal-btn:hover {
      background: rgba(255, 255, 255, 0.28);
    }
    .unspoiled-feedback-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 10px 16px;
      background: rgba(15, 15, 15, 0.92);
      backdrop-filter: blur(8px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      z-index: 99999;
    }
    .unspoiled-feedback-label {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.85);
    }
    .unspoiled-fb-btn {
      padding: 5px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      background: rgba(255, 255, 255, 0.12);
      font-size: 12px;
      cursor: pointer;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .unspoiled-fb-btn:hover {
      background: rgba(255, 255, 255, 0.22);
    }
  `;
  document.head.appendChild(style);
}

init();
