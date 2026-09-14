// Local-network awareness for Automatic URL Switching (see store.rs's own comment on the data
// model, and lib.rs's apply_config for how these get used at switch-decision time). Both
// "current LAN IP" and "current WiFi SSID" are read here, purely to power the Settings UI's
// "use current connection" convenience button and the network-name comparison used when
// deciding whether to prefer the local address — never anything more sensitive, and never sent
// anywhere outside this device.

// Reads the machine's own LAN-facing IP address without needing a real network round-trip: a
// UDP "connect" only sets up local kernel routing (no packet is ever actually sent for UDP
// connect), and asking the resulting socket for its own local_addr() reveals which interface/IP
// the OS would use to reach that destination — the standard no-dependency trick for this,
// working even fully offline as long as a default route exists. 8.8.8.8:80 is just a stand-in
// destination outside any private range; nothing is actually sent to it.
pub fn current_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

// Best-effort, platform-specific — returns None (never panics) if the current connection isn't
// WiFi at all (ethernet, no connection), the relevant tool isn't installed, or its output
// doesn't parse as expected. This is read fresh every time it's needed (setup, and every launch/
// reconnect decision in lib.rs's apply_config) rather than cached, since which network a laptop
// is on can obviously change between app launches.
pub fn current_wifi_ssid() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // networksetup's own documented way to read the currently-associated network name for
        // a given WiFi interface. Hardware port name is looked up first rather than assuming
        // "en0" — Apple Silicon Macs and some Intel models have shipped with WiFi on a different
        // port name before.
        let device = macos_wifi_device()?;
        let output = std::process::Command::new("networksetup").args(["-getairportnetwork", &device]).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // Real output looks like "Current Wi-Fi Network: HomeWiFi"; the not-connected case
        // ("You are not associated with an AirPort network.") has no colon at all.
        text.split_once(": ").map(|(_, name)| name.trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "linux")]
    {
        // `nmcli` (NetworkManager) is the common case on desktop Linux distros; -t (terse) +
        // -f (fields) gives a stable, script-parseable "ACTIVE:SSID" line per network instead of
        // nmcli's normal human-formatted table. Falls back to `iwgetid` (present on some
        // networking setups NetworkManager isn't managing) if nmcli itself isn't installed.
        if let Ok(output) = std::process::Command::new("nmcli").args(["-t", "-f", "active,ssid", "dev", "wifi"]).output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if let Some(ssid) = line.strip_prefix("yes:") {
                        if !ssid.is_empty() {
                            return Some(ssid.to_string());
                        }
                    }
                }
            }
        }
        let output = std::process::Command::new("iwgetid").args(["-r"]).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("netsh").args(["wlan", "show", "interfaces"]).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // One line reads "    SSID                   : HomeWiFi" — matched by prefix on the
        // trimmed line so it isn't confused with the separate "BSSID" line just below it.
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("SSID") {
                if let Some((_, name)) = rest.split_once(':') {
                    let name = name.trim().to_string();
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_wifi_device() -> Option<String> {
    // `networksetup -listallhardwareports` lists every interface; the WiFi one is whichever
    // "Hardware Port: Wi-Fi" block's very next line gives as "Device: enX".
    let output = std::process::Command::new("networksetup").arg("-listallhardwareports").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "Hardware Port: Wi-Fi" {
            let device_line = lines.next()?;
            return device_line.strip_prefix("Device: ").map(|s| s.trim().to_string());
        }
    }
    None
}
