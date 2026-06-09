const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function sendAction(action) {
  setStatus("Working...");
  chrome.runtime.sendMessage({ action }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message);
      return;
    }
    setStatus(response?.message || "Done");
  });
}

document.getElementById("downloadPage").addEventListener("click", () => {
  sendAction("download-page");
});

document.getElementById("downloadSite").addEventListener("click", () => {
  sendAction("download-site");
});
