// Setup page logic. Kept out of picker.html so the CSP needs no inline scripts.
const localButton = document.getElementById("use-local");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const serverErrorEl = document.getElementById("server-error");
const STEPS = ["welcome", "choose", "server"];
// "On this Mac" only on a Mac (lib.rs sets the platform before any page script runs).
if (window.__LIFER_PLATFORM__ !== "darwin") document.getElementById("local-title").textContent = "On this computer";

// One step on screen at a time; Back always returns to the step before.
function showStep(name) {
  for (const step of STEPS) document.getElementById(`step-${step}`).hidden = step !== name;
  errorEl.hidden = true;
  serverErrorEl.hidden = true;
  const heading = document.querySelector(`#step-${name} h1`);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}
document.getElementById("welcome-continue").addEventListener("click", () => showStep("choose"));
// Back from onboarding lands on the choice, not the welcome (commands.rs return_to_setup).
if (location.hash === "#choose") showStep("choose");
for (const back of document.querySelectorAll("[data-back]")) {
  back.addEventListener("click", () => showStep(back.dataset.back));
}
const httpWarningEl = document.getElementById("http-warning");

function showError(message, el = errorEl) {
  el.textContent = message;
  el.hidden = false;
}

function setBusy(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  localButton.disabled = true;
  document.getElementById("show-server-form").disabled = true;
}
function clearBusy() {
  statusEl.hidden = true;
  document.getElementById("setup-progress").hidden = true;
  localButton.disabled = false;
  document.getElementById("show-server-form").disabled = false;
}

// First setup's progress, sent by the app (pg_upgrade.rs report_setup) while it creates
// and migrates the database. The API loads the species catalog afterwards, in the background.
window.__liferSetupProgress = (step, fraction) => {
  statusEl.textContent = step;
  statusEl.hidden = false;
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  document.getElementById("setup-fill").style.width = `${percent}%`;
  document.getElementById("setup-bar").setAttribute("aria-valuenow", String(percent));
  document.getElementById("setup-progress").hidden = false;
};

localButton.addEventListener("click", async () => {
  setBusy("Setting up your library…");
  const result = await window.liferSetup.choose({ mode: "local" });
  // Success navigates away, so reaching here means canceled or failed.
  clearBusy();
  if (result && result.error) showError(result.error);
});
document.getElementById("show-server-form").addEventListener("click", () => {
  showStep("server");
  serverUrlInput.focus();
});

const ipSwitchingCheckbox = document.getElementById("ip-switching");
const externalField = document.getElementById("external-field");
const serverUrlLabel = document.getElementById("server-url-label");
const serverUrlInput = document.getElementById("server-url");
const externalUrlInput = document.getElementById("external-url");
ipSwitchingCheckbox.addEventListener("change", () => {
  const on = ipSwitchingCheckbox.checked;
  externalField.classList.toggle("open", on);
  serverUrlLabel.textContent = on ? "Local address (home network)" : "Server address";
  serverUrlInput.placeholder = on ? "192.168.1.50:4000" : "https://lifer.example.com";
  updateHttpWarning();
});

function normalizeUrl(raw) {
  // A LAN address is often typed as a bare host:port, so default it to http.
  if (!raw) return null;
  return /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
}

// Loopback, RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA/link-local, and LAN-only names.
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || (!host.includes(".") && !host.includes(":"))) return true;
  if (/\.(local|lan|home\.arpa|internal|localhost)$/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

// Plain http to a public address sends your password and photos unencrypted.
function insecureAddresses() {
  const raws = [serverUrlInput.value.trim()];
  if (ipSwitchingCheckbox.checked) raws.push(externalUrlInput.value.trim());
  return raws.filter((raw) => {
    if (!raw) return false;
    try {
      const url = new URL(ipSwitchingCheckbox.checked ? normalizeUrl(raw) : raw);
      return url.protocol === "http:" && !isPrivateHost(url.hostname);
    } catch {
      return false;
    }
  });
}

function updateHttpWarning() {
  const insecure = insecureAddresses();
  httpWarningEl.hidden = insecure.length === 0;
  httpWarningEl.textContent = insecure.length
    ? `${insecure.join(", ")} uses plain http on a public network, so your password and photos travel unencrypted. Use https:// if your server supports it.`
    : "";
}
serverUrlInput.addEventListener("input", updateHttpWarning);
externalUrlInput.addEventListener("input", updateHttpWarning);

document.getElementById("connect").addEventListener("click", async () => {
  serverErrorEl.hidden = true;
  const rawServerUrl = serverUrlInput.value.trim();
  if (!rawServerUrl) {
    showError(
      ipSwitchingCheckbox.checked ? "Enter your local address." : "Enter a full URL, starting with http:// or https://",
      serverErrorEl,
    );
    return;
  }

  let payload;
  if (ipSwitchingCheckbox.checked) {
    const rawExternalUrl = externalUrlInput.value.trim();
    if (!rawExternalUrl) {
      showError("Enter your external address too, or turn off Automatic URL Switching.", serverErrorEl);
      return;
    }
    const networkName = document.getElementById("local-network-name").value.trim();
    payload = {
      mode: "remote",
      localUrl: normalizeUrl(rawServerUrl),
      localNetworkName: networkName || undefined,
      externalUrls: [normalizeUrl(rawExternalUrl)],
    };
  } else {
    if (!/^https?:\/\//.test(rawServerUrl)) {
      showError("Enter a full URL, starting with http:// or https://", serverErrorEl);
      return;
    }
    payload = { mode: "remote", serverUrl: rawServerUrl };
  }

  const result = await window.liferSetup.choose(payload);
  if (result && result.error) showError(result.error, serverErrorEl);
});
