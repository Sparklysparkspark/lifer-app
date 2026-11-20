import ExpoModulesCore
import Foundation
import Network
import Security

// Typed pairing: finds Lifer computers on this network (Bonjour, the NSBonjourServices entry in
// app.json) and gives the key exchange secure random bytes, which Hermes doesn't provide.
public class LocalPairingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalPairing")

    Function("randomBytes") { (count: Int) throws -> [Int] in
      var bytes = [UInt8](repeating: 0, count: max(count, 0))
      guard count > 0, count <= 1024, SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
        throw Exception(name: "RANDOM", description: "No secure random bytes")
      }
      return bytes.map { Int($0) }
    }

    AsyncFunction("browse") { (type: String, timeoutMs: Double, promise: Promise) in
      Browse(type: type, timeout: timeoutMs / 1000, promise: promise).start()
    }
  }
}

// One browse: collects services for the timeout, then resolves each to an IPv4 address and port
// (the listener binds IPv4 only). Everything runs on one serial queue.
final class Browse {
  private static let maxServices = 8
  private let queue = DispatchQueue(label: "app.lifer.localpairing")
  private let browser: NWBrowser
  private let timeout: Double
  private let promise: Promise
  private var results: [NWBrowser.Result] = []
  private var found: [[String: Any]] = []
  private var browsing = true
  private var keepAlive: Browse?

  init(type: String, timeout: Double, promise: Promise) {
    browser = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: "local."), using: NWParameters())
    self.timeout = timeout
    self.promise = promise
  }

  func start() {
    keepAlive = self
    browser.browseResultsChangedHandler = { [weak self] results, _ in self?.results = Array(results) }
    // Local network access refused or no network: answer with what was found, usually nothing.
    browser.stateUpdateHandler = { [weak self] state in
      if case .failed = state { self?.finishBrowse() }
    }
    browser.start(queue: queue)
    queue.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finishBrowse() }
  }

  private func finishBrowse() {
    guard browsing else { return }
    browsing = false
    browser.cancel()
    resolve(Array(results.prefix(Browse.maxServices)))
  }

  private func resolve(_ pending: [NWBrowser.Result]) {
    guard let next = pending.first else {
      promise.resolve(found)
      keepAlive = nil
      return
    }
    let rest = Array(pending.dropFirst())
    var id = ""
    if case let .bonjour(txt) = next.metadata { id = txt["id"] ?? "" }
    let params = NWParameters.tcp
    if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
    let conn = NWConnection(to: next.endpoint, using: params)
    var done = false
    let finish: (String?, Int?) -> Void = { [weak self] host, port in
      guard let self = self, !done else { return }
      done = true
      conn.cancel()
      if let host = host, let port = port, !id.isEmpty {
        self.found.append(["host": host, "port": port, "id": id])
      }
      self.resolve(rest)
    }
    conn.stateUpdateHandler = { state in
      switch state {
      case .ready:
        if case let .hostPort(host, port)? = conn.currentPath?.remoteEndpoint, case let .ipv4(addr) = host {
          // Drop any "%en0" interface suffix.
          finish(String("\(addr)".split(separator: "%").first ?? ""), Int(port.rawValue))
        } else {
          finish(nil, nil)
        }
      case .failed, .cancelled:
        finish(nil, nil)
      default:
        break
      }
    }
    conn.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 2) { finish(nil, nil) }
  }
}
