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
        let ports = run("networksetup", &["-listallhardwareports"])?;
        let device = parse_wifi_device(&ports)?;
        parse_airport(&run("networksetup", &["-getairportnetwork", &device])?)
    }
    #[cfg(target_os = "linux")]
    {
        // nmcli first, then `iwgetid` when nmcli isn't installed.
        run("nmcli", &["-t", "-f", "active,ssid", "dev", "wifi"])
            .and_then(|text| parse_nmcli(&text))
            .or_else(|| non_empty(run("iwgetid", &["-r"])?.trim()))
    }
    #[cfg(target_os = "windows")]
    {
        parse_netsh(&run("netsh", &["wlan", "show", "interfaces"])?)
    }
}

/// A tool's stdout when it ran and succeeded. No console window flashes up on Windows.
fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = crate::pg_upgrade::command(std::path::Path::new(program))
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

// The parsers build on every OS so each one's tests run on every CI runner.

/// macOS: "Current Wi-Fi Network: HomeWiFi"; the not-connected message has no ": ".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_airport(text: &str) -> Option<String> {
    text.split_once(": ")
        .and_then(|(_, name)| non_empty(name.trim()))
}

/// macOS: the line after "Hardware Port: Wi-Fi" is "Device: enX".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_wifi_device(text: &str) -> Option<String> {
    let mut lines = text.lines();
    lines.find(|l| l.trim() == "Hardware Port: Wi-Fi")?;
    lines
        .next()?
        .trim()
        .strip_prefix("Device: ")
        .and_then(|d| non_empty(d.trim()))
}

/// Linux: nmcli's terse "yes:SSID" line, where a colon or backslash in the name is escaped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_nmcli(text: &str) -> Option<String> {
    let escaped = text.lines().find_map(|l| l.strip_prefix("yes:"))?;
    non_empty(&escaped.replace("\\:", ":").replace("\\\\", "\\"))
}

/// Windows: the "SSID : name" line; matched by prefix after trimming so "BSSID" doesn't match.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_netsh(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (_, name) = line.trim().strip_prefix("SSID")?.split_once(':')?;
        non_empty(name.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_macos_network_and_wifi_device() {
        assert_eq!(
            parse_airport("Current Wi-Fi Network: Home: Upstairs\n").as_deref(),
            Some("Home: Upstairs")
        );
        assert_eq!(
            parse_airport("You are not associated with an AirPort network.\n"),
            None
        );
        let ports = "Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: aa\n";
        assert_eq!(parse_wifi_device(ports).as_deref(), Some("en1"));
        assert_eq!(
            parse_wifi_device("Hardware Port: Ethernet\nDevice: en0\n"),
            None
        );
    }

    #[test]
    fn reads_the_active_nmcli_network_and_unescapes_it() {
        assert_eq!(
            parse_nmcli("no:Neighbour\nyes:Cabin\\:5G\nno:\n").as_deref(),
            Some("Cabin:5G")
        );
        assert_eq!(
            parse_nmcli("yes:back\\\\slash").as_deref(),
            Some("back\\slash")
        );
        assert_eq!(parse_nmcli("no:Neighbour\n"), None);
        assert_eq!(parse_nmcli("yes:\n"), None);
    }

    #[test]
    fn reads_the_netsh_ssid_and_skips_bssid() {
        let text = "    Name                   : Wi-Fi\r\n    BSSID                  : aa:bb\r\n    SSID                   : Home Net\r\n";
        assert_eq!(parse_netsh(text).as_deref(), Some("Home Net"));
        assert_eq!(
            parse_netsh("    State                  : disconnected\r\n"),
            None
        );
    }
}
