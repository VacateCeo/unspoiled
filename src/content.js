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
const spoilerIds = new Set();   // status IDs confirmed as spoilers — re-blur on scroll
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
        if (node.matches?.(selectors.post)) enqueue(node, selectors);
        node.querySelectorAll(selectors.post).forEach((el) => enqueue(el, selectors));
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

function enqueue(el, selectors) {
  const id = getStatusId(el);
  const key = id || el; // fall back to element ref on non-X platforms

  if (processedIds.has(key)) {
    if (spoilerIds.has(key)) blurPost(el); // re-blur on scroll
    return;
  }

  const textEl = el.querySelector(selectors.text);
  const bodyText = textEl?.innerText?.trim() || "";
  const imgAlts = [...el.querySelectorAll("img[alt]")]
    .map((img) => img.alt.trim())
    .filter(Boolean)
    .join(" ");
  const ariaLabel = el.getAttribute("aria-label")?.trim() || "";
  const text = [bodyText, imgAlts, ariaLabel].filter(Boolean).join(" ");

  if (text.length < 5) return;
  processedIds.add(key);
  total++;
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
        spoilerIds.add(key);
        blurPost(el);
        console.log("[Unspoiled] blurring post:", text.slice(0, 50));
      }
    });
  } catch (err) {
    console.error("Gemini classify error:", err);
  }
}

function blurPost(el) {
  if (el.dataset.unspoiled) return;
  el.dataset.unspoiled = "blurred";
  el.style.filter = "blur(6px)";
  el.style.transition = "filter 0.3s";
  el.style.cursor = "pointer";
  el.title = "Spoiler hidden — click to reveal";
  el.addEventListener("click", function reveal() {
    el.style.filter = "none";
    el.dataset.unspoiled = "revealed";
    el.removeEventListener("click", reveal);
  }, { once: true });
}

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .unspoiled-btn {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #1a1a2e;
      color: #fff;
      border: none;
      border-radius: 20px;
      padding: 8px 18px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
      z-index: 9999;
    }
    .unspoiled-btn:hover {
      background: #2d2d6e;
    }
  `;
  document.head.appendChild(style);
}

init();
