console.log("[Unspoiled] content script loaded");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Selectors per platform
function getSelectors() {
  const host = location.hostname;
  if (host.includes("x.com") || host.includes("twitter.com")) {
    return {
      post: 'article[data-testid="tweet"]',
      text: '[data-testid="tweetText"]',
    };
  }
  if (host.includes("reddit.com")) {
    return {
      // Covers new Reddit, shreddit (redesign), and old Reddit
      post: 'shreddit-post, [data-testid="post-container"], .thing.link',
      text: '[data-testid="post-title-text"], [slot="title"], .title > a.may-blank',
    };
  }
  if (host.includes("youtube.com")) {
    return {
      post: "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer",
      text: "#video-title",
    };
  }
  return null;
}

let blocklist = [];
let geminiKey = "";
const processedIds = new Set(); // status IDs (or element refs on non-X platforms) already sent to Gemini
const processedTexts = new Map(); // key → postText so we can re-attach flag on scroll-back
const spoilerIds = new Map();   // key → postText for confirmed spoilers — re-blur on scroll
const activeFeedbackBars = new Map(); // postId → bar element for bars currently visible
let keywords = [];
let total = 0;
let passed = 0;

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

  // 5. Give up — keyword filter will reject this naturally, no Gemini call wasted
  return { text: "image post", source: "fallback" };
}

function passesKeywordFilter(text) {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

async function init() {
  const data = await chrome.storage.local.get(["blocklist", "geminiKey"]);
  blocklist = data.blocklist || [];
  geminiKey = data.geminiKey || "";
  console.log("[Unspoiled] blocklist:", blocklist, "geminiKey length:", geminiKey?.length);

  if (!geminiKey || blocklist.length === 0) return;

  keywords = buildKeywords(blocklist);
  const selectors = getSelectors();
  if (!selectors) return;

  injectStyles();
  scanPage(selectors);
  observePage(selectors);
}

function scanPage(selectors) {
  document.querySelectorAll(selectors.post).forEach((el) => enqueue(el, selectors));
}

function getFeedContainer() {
  const host = location.hostname;
  if (host.includes("x.com") || host.includes("twitter.com")) {
    return document.querySelector('div[data-testid="primaryColumn"]') || document.body;
  }
  if (host.includes("reddit.com")) {
    return document.querySelector("shreddit-feed, .ListingLayout-outerContainer, main") || document.body;
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
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

function enqueue(el, selectors) {
  const id = getStatusId(el);
  const key = id || el; // fall back to element ref on non-X platforms

  if (processedIds.has(key)) {
    if (spoilerIds.has(key)) {
      blurPost(el, spoilerIds.get(key)); // re-blur on scroll
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
  if (!passesKeywordFilter(text)) return;
  passed++;
  console.log("[Unspoiled] scanned:", total, "keyword-passed:", passed);
  classifyBatch([{ el, text, key }]);
}

async function classifyBatch(batch) {
  const shows = blocklist
    .map((s) => `${s.title}${s.year ? " (" + s.year + ")" : ""}`)
    .join(", ");

  const prompt = `Does this social media post reference, discuss, or relate to ${shows}? This includes fan art, memes, character mentions, plot references, or any content about the show. Reply with only YES or NO.\n\nPost: ${batch[0].text.slice(0, 400)}`;

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are a content filter. Respond with only YES or NO, nothing else." }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    const data = await res.json();
    console.log("[Unspoiled] Gemini response:", JSON.stringify(data));
    if (data.error) {
      console.error("Gemini classify error:", data.error.message || "Gemini API error");
      return;
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("[Unspoiled] Gemini raw text:", JSON.stringify(raw));
    const answers = raw.trim().split("\n").map((l) => l.trim().toUpperCase());
    batch.forEach(({ el, text, key }, i) => {
      if (answers[i]?.startsWith("YES")) {
        spoilerIds.set(key, text);
        if (typeof key === "string") el.dataset.statusId = key;
        blurPost(el, text);
        console.log("[Unspoiled] blurring post:", text.slice(0, 50));
      }
    });
  } catch (err) {
    console.error("Gemini classify error:", err);
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

function blurPost(el, postText) {
  if (el.dataset.unspoiled) return;
  el.dataset.unspoiled = "blurred";
  el.querySelector(".unspoiled-flag-btn")?.remove();

  el.style.filter = "blur(20px) brightness(0.3)";
  el.style.transition = "filter 0.3s";
  el.style.pointerEvents = "none";

  const container = el.parentNode;
  if (window.getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.className = "unspoiled-overlay";
  overlay.innerHTML = `
    <div class="unspoiled-overlay-inner">
      <div class="unspoiled-title">🚫 Spoiler Hidden</div>
      <div class="unspoiled-subtitle">Click to reveal</div>
    </div>
  `;
  container.appendChild(overlay);

  overlay.addEventListener("click", () => {
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
  el.appendChild(bar); // inside the article, not as a sibling

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

function reattachFeedbackBar(el) {
  const id = getStatusId(el);
  if (!id || !activeFeedbackBars.has(id)) return;
  const bar = activeFeedbackBars.get(id);
  if (!el.contains(bar)) el.appendChild(bar);
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
    .unspoiled-overlay {
      position: absolute;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.7);
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
    .unspoiled-feedback-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.06);
      border-radius: 8px;
      margin: 4px 12px 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .unspoiled-feedback-label {
      font-size: 12px;
      color: #555;
      flex: 1;
    }
    .unspoiled-fb-btn {
      padding: 4px 12px;
      border-radius: 999px;
      border: 1px solid #ccc;
      background: #fff;
      font-size: 12px;
      cursor: pointer;
      color: #333;
    }
    .unspoiled-fb-btn:hover {
      background: #f0f0f0;
    }
  `;
  document.head.appendChild(style);
}

init();
