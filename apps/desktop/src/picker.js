// Setup page logic. Kept out of picker.html so the CSP needs no inline scripts.
const localButton = document.getElementById("use-local");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const httpWarningEl = document.getElementById("http-warning");

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function setBusy(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  localButton.disabled = true;
  document.getElementById("show-server-form").disabled = true;
}
function clearBusy() {
  statusEl.hidden = true;
  localButton.disabled = false;
  document.getElementById("show-server-form").disabled = false;
}

localButton.addEventListener("click", async () => {
  // First setup can take 10-30+ seconds (database init, migrations, catalog restore).
  setBusy("Setting up your library… this can take a minute the first time.");
  const result = await window.liferSetup.choose({ mode: "local" });
  // Success navigates away, so reaching here means canceled or failed.
  clearBusy();
  if (result && result.error) showError(result.error);
});
document.getElementById("show-server-form").addEventListener("click", () => {
  document.getElementById("server-form").classList.add("open");
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
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
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
  errorEl.hidden = true;
  const rawServerUrl = serverUrlInput.value.trim();
  if (!rawServerUrl) {
    showError(ipSwitchingCheckbox.checked ? "Enter your local address." : "Enter a full URL, starting with http:// or https://");
    return;
  }

  let payload;
  if (ipSwitchingCheckbox.checked) {
    const rawExternalUrl = externalUrlInput.value.trim();
    if (!rawExternalUrl) {
      showError("Enter your external address too, or turn off IP switching.");
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
      showError("Enter a full URL, starting with http:// or https://");
      return;
    }
    payload = { mode: "remote", serverUrl: rawServerUrl };
  }

  const result = await window.liferSetup.choose(payload);
  if (result && result.error) showError(result.error);
});
