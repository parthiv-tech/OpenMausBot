const $ = (id) => document.getElementById(id);
const dot = $("dot");
const status = $("status");
const errorBox = $("error");

function render(state) {
  const on = Boolean(state?.connected);
  dot.className = `dot ${on ? "on" : "off"}`;
  status.textContent = on ? "Connected to Astra" : "Not connected";
  errorBox.textContent = state?.lastError || "";
}

async function load() {
  const [{ state }, { serverUrl = "", token = "" }] = await Promise.all([
    chrome.runtime.sendMessage({ kind: "getState" }),
    chrome.storage.local.get(["serverUrl", "token"]),
  ]);
  $("serverUrl").value = serverUrl;
  $("token").value = token;
  render(state);
}

$("connect").addEventListener("click", async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token: $("token").value.trim(),
  });
  await chrome.runtime.sendMessage({ kind: "connect" });
  render(await chrome.runtime.sendMessage({ kind: "getState" }));
});

$("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ kind: "disconnect" });
  render(await chrome.runtime.sendMessage({ kind: "getState" }));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind === "state") render(message);
});

load();
