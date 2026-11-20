import ExpoModulesCore
import CryptoKit
import Foundation
import Network

struct PinnedRequest: Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String? = nil
  @Field var certSha256: String? = nil
  /// Accept any certificate and report its SHA-256. Only for a typed pairing's first request, which
  /// carries no secret; the key exchange then proves the certificate and later requests pin it.
  @Field var captureCert: Bool = false
  @Field var timeoutMs: Double = 5000
}

final class CertMismatch: Exception {
  override var code: String { "CERT_MISMATCH" }
  override var reason: String { "The server certificate does not match the paired one" }
}

// Replaces trust evaluation: the leaf certificate must hash to the pinned value, nothing else counts
// (or, capturing, any leaf is accepted and its hash recorded).
final class PinDelegate: NSObject, URLSessionTaskDelegate {
  let pin: String
  let capture: Bool
  var mismatched = false
  var seen: String? = nil
  init(pin: String, capture: Bool) {
    self.pin = pin
    self.capture = capture
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let hex = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
    seen = hex
    if capture || hex == pin {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      mismatched = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  // Never follow a redirect: it could leave the pinned host or, capturing, swap the certificate seen.
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

// The one request allowed to skip the pin: a typed pairing's hello, which carries no secret.
let captureCertPath = "/api/companion/v1/pair/start"

struct PinnedDownload: Record {
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  @Field var certSha256: String = ""
  @Field var path: String = ""
  @Field var timeoutMs: Double = 60000
}

public class PinnedFetchModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PinnedFetch")

    // Streams a pinned download straight to a file, so a photo never sits in memory as text.
    AsyncFunction("download") { (opts: PinnedDownload, promise: Promise) in
      guard let url = URL(string: opts.url), url.scheme == "https", !opts.certSha256.isEmpty else {
        promise.reject(Exception(name: "BAD_REQUEST", description: "Pin a certificate, over HTTPS"))
        return
      }
      var req = URLRequest(url: url, timeoutInterval: opts.timeoutMs / 1000)
      for (k, v) in opts.headers { req.setValue(v, forHTTPHeaderField: k) }
      let delegate = PinDelegate(pin: opts.certSha256.lowercased(), capture: false)
      let config = URLSessionConfiguration.ephemeral
      config.tlsMinimumSupportedProtocolVersion = .TLSv13
      let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
      session.downloadTask(with: req) { temp, response, error in
        defer { session.finishTasksAndInvalidate() }
        if delegate.mismatched { promise.reject(CertMismatch()); return }
        if let error = error { promise.reject(Exception(name: "NETWORK", description: error.localizedDescription)); return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        var bytes = 0
        if status == 200 || status == 206, let temp = temp {
          let dest = URL(fileURLWithPath: opts.path)
          try? FileManager.default.removeItem(at: dest)
          do {
            try FileManager.default.moveItem(at: temp, to: dest)
            bytes = (try? FileManager.default.attributesOfItem(atPath: opts.path)[.size] as? Int) ?? 0
          } catch {
            promise.reject(Exception(name: "DISK", description: error.localizedDescription))
            return
          }
        }
        promise.resolve(["status": status, "bytes": bytes])
      }.resume()
    }

    // The showcase is the person's own photos, rebuilt from the hub, so it stays out of iCloud backups.
    Function("excludeFromBackup") { (path: String) -> Bool in
      var url = URL(fileURLWithPath: path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      return (try? url.setResourceValues(values)) != nil
    }

    // Whether the connection in use is cellular or otherwise costs money (Low Data Mode counts).
    AsyncFunction("isMetered") { (promise: Promise) in
      let monitor = NWPathMonitor()
      let queue = DispatchQueue(label: "lifer.pathmonitor")
      var done = false
      monitor.pathUpdateHandler = { path in
        if done { return }
        done = true
        monitor.cancel()
        promise.resolve(path.isExpensive || path.isConstrained || path.usesInterfaceType(.cellular))
      }
      monitor.start(queue: queue)
    }

    AsyncFunction("request") { (opts: PinnedRequest, promise: Promise) in
      guard let url = URL(string: opts.url) else {
        promise.reject(Exception(name: "BAD_URL", description: "Bad URL"))
        return
      }
      guard opts.captureCert == (opts.certSha256 == nil), url.scheme == "https" else {
        promise.reject(Exception(name: "BAD_REQUEST", description: "Pin a certificate or capture one, over HTTPS"))
        return
      }
      let keyed = opts.headers.keys.contains { $0.lowercased() == "x-api-key" }
      guard !opts.captureCert || (opts.method == "POST" && url.path == captureCertPath && url.query == nil && !keyed) else {
        promise.reject(Exception(name: "BAD_REQUEST", description: "Only a typed pairing's first request may skip the pin"))
        return
      }
      var req = URLRequest(url: url, timeoutInterval: opts.timeoutMs / 1000)
      req.httpMethod = opts.method
      for (k, v) in opts.headers { req.setValue(v, forHTTPHeaderField: k) }
      req.httpBody = opts.body?.data(using: .utf8)

      let delegate = PinDelegate(pin: (opts.certSha256 ?? "").lowercased(), capture: opts.captureCert)
      let config = URLSessionConfiguration.ephemeral
      config.tlsMinimumSupportedProtocolVersion = .TLSv13
      let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
      session.dataTask(with: req) { data, response, error in
        defer { session.finishTasksAndInvalidate() }
        if delegate.mismatched { promise.reject(CertMismatch()); return }
        if let error = error { promise.reject(Exception(name: "NETWORK", description: error.localizedDescription)); return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        promise.resolve([
          "status": status,
          "body": String(data: data ?? Data(), encoding: .utf8) ?? "",
          "certSha256": delegate.seen ?? "",
        ])
      }.resume()
    }
  }
}
