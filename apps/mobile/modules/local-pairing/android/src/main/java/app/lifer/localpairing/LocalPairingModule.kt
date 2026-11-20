package app.lifer.localpairing

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.security.SecureRandom

// Typed pairing: finds Lifer computers on this network (Network Service Discovery, no extra
// permission) and gives the key exchange secure random bytes, which Hermes doesn't provide.
class LocalPairingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LocalPairing")

    Function("randomBytes") { count: Int ->
      if (count <= 0 || count > 1024) throw CodedException("RANDOM", "Bad length", null)
      val bytes = ByteArray(count)
      SecureRandom().nextBytes(bytes)
      bytes.map { it.toInt() and 0xff }
    }

    AsyncFunction("browse") { type: String, timeoutMs: Double, promise: Promise ->
      val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "No context", null)
      Browse(context.getSystemService(Context.NSD_SERVICE) as NsdManager, type, timeoutMs.toLong(), promise).start()
    }
  }
}

// One browse: collects services for the timeout, then resolves them one at a time to an IPv4
// address and port (the listener binds IPv4 only). All state is touched on the main looper.
private class Browse(
  private val nsd: NsdManager,
  private val type: String,
  private val timeoutMs: Long,
  private val promise: Promise,
) {
  private val main = Handler(Looper.getMainLooper())
  private val services = mutableListOf<NsdServiceInfo>()
  private val found = mutableListOf<Map<String, Any>>()
  private var browsing = true

  private val listener = object : NsdManager.DiscoveryListener {
    override fun onServiceFound(info: NsdServiceInfo) {
      main.post { if (browsing && services.size < MAX_SERVICES) services.add(info) }
    }
    override fun onServiceLost(info: NsdServiceInfo) {}
    override fun onDiscoveryStarted(serviceType: String) {}
    override fun onDiscoveryStopped(serviceType: String) {}
    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
      main.post { finishBrowse(stop = false) }
    }
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
  }

  fun start() {
    nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
    main.postDelayed({ finishBrowse(stop = true) }, timeoutMs)
  }

  private fun finishBrowse(stop: Boolean) {
    if (!browsing) return
    browsing = false
    if (stop) runCatching { nsd.stopServiceDiscovery(listener) }
    resolveNext(services.toMutableList())
  }

  // resolveService is deprecated from API 34 but is the one call that works on every supported version.
  @Suppress("DEPRECATION")
  private fun resolveNext(pending: MutableList<NsdServiceInfo>) {
    val next = pending.removeFirstOrNull() ?: return promise.resolve(found)
    var done = false
    val finish = { info: NsdServiceInfo? ->
      if (!done) {
        done = true
        val host = info?.host
        val id = info?.attributes?.get("id")?.toString(Charsets.UTF_8)
        if (info != null && host is Inet4Address && !id.isNullOrEmpty()) {
          found.add(mapOf("host" to (host.hostAddress ?: ""), "port" to info.port, "id" to id))
        }
        resolveNext(pending)
      }
    }
    runCatching {
      nsd.resolveService(next, object : NsdManager.ResolveListener {
        override fun onServiceResolved(info: NsdServiceInfo) { main.post { finish(info) } }
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) { main.post { finish(null) } }
      })
    }.onFailure { main.post { finish(null) } }
    main.postDelayed({ finish(null) }, RESOLVE_TIMEOUT_MS)
  }

  companion object {
    const val MAX_SERVICES = 8
    const val RESOLVE_TIMEOUT_MS = 2000L
  }
}
