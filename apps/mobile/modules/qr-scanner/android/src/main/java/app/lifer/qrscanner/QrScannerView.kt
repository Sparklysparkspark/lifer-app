package app.lifer.qrscanner

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors

// Live camera preview that decodes QR codes on the phone with ZXing. No network, no Google services.
class QrScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onScan by EventDispatcher()
  private val preview = PreviewView(context)
  private val executor = Executors.newSingleThreadExecutor()
  private val reader = QRCodeReader()
  private var provider: ProcessCameraProvider? = null

  override val shouldUseAndroidLayout = true

  init {
    addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      val cameraProvider = future.get()
      val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
      val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
      analysis.setAnalyzer(executor) { image -> analyze(image) }
      cameraProvider.unbindAll()
      cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
      provider = cameraProvider
    }, ContextCompat.getMainExecutor(context))
  }

  override fun onDetachedFromWindow() {
    provider?.unbindAll()
    provider = null
    super.onDetachedFromWindow()
  }

  // The Y plane is the greyscale image, all a QR code needs. ZXing finds the code in any rotation.
  private fun analyze(image: ImageProxy) {
    try {
      val plane = image.planes[0]
      val bytes = ByteArray(plane.buffer.remaining())
      plane.buffer.get(bytes)
      val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
      val result = reader.decode(BinaryBitmap(HybridBinarizer(source)))
      onScan(mapOf("data" to result.text))
    } catch (_: ReaderException) {
      // No code in this frame.
    } finally {
      reader.reset()
      image.close()
    }
  }
}
