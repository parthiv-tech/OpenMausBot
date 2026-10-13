const $ = (id) => document.getElementById(id);
const saved = $("saved");

async function load() {
  const { serverUrl = "", token = "", allowlist = "" } = await chrome.storage.local.get(["serverUrl", "token", "allowlist"]);
  $("serverUrl").value = serverUrl;
  $("token").value = token;
  $("allowlist").value = allowlist;
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token: $("token").value.trim(),
    allowlist: $("allowlist").value.trim(),
  });
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
  // Reconnect in the background so a token change takes effect immediately.
  chrome.runtime.sendMessage({ kind: "disconnect" }).then(() => chrome.runtime.sendMessage({ kind: "connect" }));
});

load();
