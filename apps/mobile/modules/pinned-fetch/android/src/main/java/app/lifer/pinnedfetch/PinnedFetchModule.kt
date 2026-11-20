package app.lifer.pinnedfetch

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import android.content.Context
import android.net.ConnectivityManager
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class PinnedRequest : Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
  @Field var certSha256: String? = null
  // Accept any certificate and report its SHA-256. Only for a typed pairing's first request, which
  // carries no secret; the key exchange then proves the certificate and later requests pin it.
  @Field var captureCert: Boolean = false
  @Field var timeoutMs: Double = 5000.0
}

class PinnedDownload : Record {
  @Field var url: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var certSha256: String = ""
  @Field var path: String = ""
  @Field var timeoutMs: Double = 60000.0
}

class CertMismatchException : CertificateException("pin mismatch")

// The one request allowed to skip the pin: a typed pairing's hello, which carries no secret.
private const val CAPTURE_CERT_PATH = "/api/companion/v1/pair/start"

// The leaf certificate must hash to the pinned value (or, capturing, any leaf is accepted and its
// hash recorded); the platform trust store is not consulted.
private class PinTrustManager(private val pin: String, private val capture: Boolean) : X509TrustManager {
  @Volatile var seen: String? = null
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException()
  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    val hex = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded).joinToString("") { "%02x".format(it) }
    seen = hex
    if (!capture && hex != pin) throw CertMismatchException()
  }
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class PinnedFetchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PinnedFetch")

    // Streams a pinned download straight to a file, so a photo never sits in memory as text.
    AsyncFunction("download") { opts: PinnedDownload ->
      if (opts.certSha256.isEmpty() || !opts.url.startsWith("https://")) {
        throw CodedException("BAD_REQUEST", "Pin a certificate, over HTTPS", null)
      }
      val trust = PinTrustManager(opts.certSha256.lowercase(), false)
      val ctx = SSLContext.getInstance("TLS")
      ctx.init(null, arrayOf<TrustManager>(trust), null)
      val conn = URL(opts.url).openConnection() as HttpsURLConnection
      try {
        conn.sslSocketFactory = ctx.socketFactory
        conn.instanceFollowRedirects = false
        conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        conn.instanceFollowRedirects = false
        conn.connectTimeout = opts.timeoutMs.toInt()
        conn.readTimeout = opts.timeoutMs.toInt()
        opts.headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        val status = conn.responseCode
        var bytes = 0L
        if (status == 200 || status == 206) {
          val target = File(opts.path)
          val part = File(opts.path + ".part")
          conn.inputStream.use { input -> part.outputStream().use { out -> bytes = input.copyTo(out) } }
          target.delete()
          part.renameTo(target)
        }
        mapOf("status" to status, "bytes" to bytes)
      } catch (e: Exception) {
        var cause: Throwable? = e
        while (cause != null) {
          if (cause is CertMismatchException) throw CodedException("CERT_MISMATCH", "Certificate does not match", e)
          cause = cause.cause
        }
        throw CodedException("NETWORK", e.message ?: "Network error", e)
      } finally {
        conn.disconnect()
      }
    }

    // Android's cloud backup is set in the app manifest, not per file.
    Function("excludeFromBackup") { _: String -> true }

    // Whether the connection in use is cellular or otherwise costs money.
    AsyncFunction("isMetered") {
      val cm = appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      cm?.isActiveNetworkMetered ?: false
    }

    AsyncFunction("request") { opts: PinnedRequest ->
      if (opts.captureCert != (opts.certSha256 == null) || !opts.url.startsWith("https://")) {
        throw CodedException("BAD_REQUEST", "Pin a certificate or capture one, over HTTPS", null)
      }
      val target = URL(opts.url)
      val keyed = opts.headers.keys.any { it.equals("x-api-key", ignoreCase = true) }
      if (opts.captureCert && (opts.method != "POST" || target.path != CAPTURE_CERT_PATH || target.query != null || keyed)) {
        throw CodedException("BAD_REQUEST", "Only a typed pairing's first request may skip the pin", null)
      }
      val trust = PinTrustManager((opts.certSha256 ?: "").lowercase(), opts.captureCert)
      val ctx = SSLContext.getInstance("TLS")
      ctx.init(null, arrayOf<TrustManager>(trust), null)
      val conn = target.openConnection() as HttpsURLConnection
      try {
        conn.sslSocketFactory = ctx.socketFactory
        // A redirect could leave the pinned host or, capturing, swap the certificate seen.
        conn.instanceFollowRedirects = false
        // The pin identifies the server, so the host name (a LAN address) is not checked.
        conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        conn.requestMethod = opts.method
        conn.connectTimeout = opts.timeoutMs.toInt()
        conn.readTimeout = opts.timeoutMs.toInt()
        opts.headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        opts.body?.let {
          conn.doOutput = true
          conn.outputStream.use { out -> out.write(it.toByteArray()) }
        }
        val status = conn.responseCode
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
        val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
        mapOf("status" to status, "body" to body, "certSha256" to (trust.seen ?: ""))
      } catch (e: Exception) {
        var cause: Throwable? = e
        while (cause != null) {
          if (cause is CertMismatchException) throw CodedException("CERT_MISMATCH", "Certificate does not match", e)
          cause = cause.cause
        }
        throw CodedException("NETWORK", e.message ?: "Network error", e)
      } finally {
        conn.disconnect()
      }
    }
  }
}
