chrome.action.setBadgeBackgroundColor({ color: "#e0245e" });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.spoilerCount) return;
  const count = changes.spoilerCount.newValue || 0;
  const label = count > 999 ? "999+" : count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text: label });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const { onboarded } = await chrome.storage.local.get("onboarded");
  if (onboarded) return;
  chrome.storage.local.set({ onboarded: true });
  chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
});
