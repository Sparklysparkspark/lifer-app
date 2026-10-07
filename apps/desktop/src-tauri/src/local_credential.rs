// Per-launch values for the local API sidecar (api.rs passes both to it):
//   - launch_token: the desktop credential (LIFER_LAUNCH_TOKEN). Secret. Only the API process and
//     this app know it; the local library's window gets it through local_api_credential (lib.rs)
//     and trades it for an HttpOnly cookie (apps/api/src/auth/localCredential.ts).
//   - launch_id: not secret (LIFER_LAUNCH_ID). The API's GET /health echoes it, so the app can
//     tell its own API apart from a previous launch's still on the port.
use std::sync::OnceLock;

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // The OS random number generator failing means nothing on this computer can make a secret;
    // there's no safe fallback.
    getrandom::fill(&mut buf).expect("the OS random number generator failed");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn launch_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| random_hex(32))
}

// Passed to the API as LIFER_LAUNCH_ID; api.rs checks /health's launchId against it to confirm it reached its own API.
pub fn launch_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| random_hex(16))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_random_hex_and_stable_for_the_launch() {
        assert_eq!(launch_token().len(), 64);
        assert_eq!(launch_id().len(), 32);
        assert!(launch_token().chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(launch_token(), launch_token());
        assert!(!launch_token().starts_with(launch_id()));
        assert_ne!(random_hex(32), random_hex(32));
    }
}
