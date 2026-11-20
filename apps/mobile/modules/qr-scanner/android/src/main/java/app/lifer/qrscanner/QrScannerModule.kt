package app.lifer.qrscanner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class QrScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("QrScanner")

    View(QrScannerView::class) {
      Events("onScan")
    }
  }
}
