export {};
const statusEl = document.getElementById("status")!;
const disconnect = document.getElementById("disconnect") as HTMLButtonElement;

async function render() {
  const config = (await chrome.storage.local.get("config")).config as { server: string } | undefined;
  if (config) {
    statusEl.textContent = `Connected to ${config.server}. Use the Apply button in the portal.`;
    disconnect.hidden = false;
  } else {
    statusEl.textContent = "Not connected. Open the portal, go to Apply queue and click Connect extension.";
    disconnect.hidden = true;
  }
}

disconnect.onclick = async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  await render();
};
void render();
