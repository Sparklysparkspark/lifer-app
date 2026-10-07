// Local-network awareness for Automatic URL Switching: the LAN IP and WiFi SSID, used only on
// this device and never sent anywhere.

// UDP connect() only sets up routing (nothing is sent), and local_addr() then reveals the IP the
// OS would use. Works offline as long as a default route exists.
pub fn current_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

// Best effort: None for non-WiFi connections, a missing tool, or unparseable output. Read fresh
// each time since the network can change between launches.
pub fn current_wifi_ssid() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // Look up the WiFi hardware port rather than assuming "en0", which varies by model.
        let device = macos_wifi_device()?;
        let output = std::process::Command::new("networksetup")
            .args(["-getairportnetwork", &device])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // "Current Wi-Fi Network: HomeWiFi"; the not-connected message has no colon.
        text.split_once(": ")
            .map(|(_, name)| name.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "linux")]
    {
        // nmcli's terse "ACTIVE:SSID" output first, then `iwgetid` when nmcli isn't installed.
        if let Ok(output) = std::process::Command::new("nmcli")
            .args(["-t", "-f", "active,ssid", "dev", "wifi"])
            .output()
        {
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
        let output = std::process::Command::new("iwgetid")
            .args(["-r"])
            .output()
            .ok()?;
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
        let output = std::process::Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        // Match the "SSID : name" line by prefix so the "BSSID" line doesn't match.
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
    // The line after "Hardware Port: Wi-Fi" is "Device: enX".
    let output = std::process::Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "Hardware Port: Wi-Fi" {
            let device_line = lines.next()?;
            return device_line
                .strip_prefix("Device: ")
                .map(|s| s.trim().to_string());
        }
    }
    None
}
