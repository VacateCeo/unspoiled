chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const { onboarded } = await chrome.storage.local.get("onboarded");
  if (onboarded) return;
  chrome.storage.local.set({ onboarded: true });
  chrome.tabs.create({ url: chrome.runtime.getURL("src/welcome.html") });
});
