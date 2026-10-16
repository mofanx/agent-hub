package com.agenthub.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** QR 扫码弹层：命中 agenthub://connect 交给 onResult，拒绝权限时降级提示手动粘贴 */
@Composable
fun QrScanDialog(onResult: (String) -> Unit, onDismiss: () -> Unit) {
    val S = LocalStrings.current
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var denied by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { ok ->
        granted = ok
        denied = !ok
    }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }
    var decoding by remember { mutableStateOf(false) }
    var decodeFailed by remember { mutableStateOf(false) }
    val decodeScope = rememberCoroutineScope()
    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        decoding = true
        decodeScope.launch(Dispatchers.Default) {
            val value = decodeQrFromUri(context, uri)
            withContext(Dispatchers.Main) {
                decoding = false
                if (value != null) onResult(value) else decodeFailed = true
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            when {
                granted -> CameraPreview(onResult)
                denied -> Column(
                    Modifier
                        .align(Alignment.Center)
                        .padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        S.cameraPermissionHint,
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            Column(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(8.dp)) {
                Text(
                    S.scanQrTitle,
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                )
                TextButton(onClick = { decodeFailed = false; galleryLauncher.launch("image/*") }) {
                    Text(S.scanFromGallery, color = Color.White)
                }
                if (decodeFailed) {
                    Text(
                        S.qrDecodeFailed,
                        color = Color(0xFFFFB4AB),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            if (decoding) {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(24.dp),
            ) {
                Text(S.cancel, color = Color.White)
            }
        }
    }
}

@Composable
private fun CameraPreview(onResult: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val controller = remember { LifecycleCameraController(context) }
    val done = remember { mutableStateOf(false) }
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    val executor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(controller) {
        onDispose {
            controller.unbind()
            scanner.close()
            executor.shutdown()
        }
    }

    LaunchedEffect(controller) {
        controller.setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
        controller.setImageAnalysisAnalyzer(
            executor,
            @Suppress("DEPRECATION")
            MlKitAnalyzer(
                listOf(scanner),
                CameraController.COORDINATE_SYSTEM_VIEW_REFERENCED,
                executor,
            ) { result ->
                if (done.value) return@MlKitAnalyzer
                val value = result.getValue(scanner)?.firstOrNull()?.rawValue
                if (!value.isNullOrBlank()) {
                    done.value = true
                    onResult(value)
                }
            },
        )
        controller.cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
        controller.bindToLifecycle(lifecycleOwner)
    }

    AndroidView(
        factory = { ctx -> PreviewView(ctx).apply { this.controller = controller } },
        modifier = Modifier.fillMaxSize(),
    )
    // 取景框提示线
    Box(
        Modifier
            .fillMaxWidth(0.6f)
            .height(240.dp),
    )
}

/** 相册图片解码 QR：inSampleSize 降采样 + EXIF 旋转，ML Kit 离线解码 */
private fun decodeQrFromUri(context: android.content.Context, uri: Uri): String? {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 800 && bounds.outHeight / (sample * 2) >= 800) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    var bmp = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
    resolver.openInputStream(uri)?.use {
        val exif = ExifInterface(it)
        val deg = when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (deg != 0f) {
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(deg) }, true)
        }
    }
    val image = InputImage.fromBitmap(bmp, 0)
    val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
    )
    return try {
        val result = com.google.android.gms.tasks.Tasks.await(scanner.process(image))
        result.firstOrNull()?.rawValue?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    } finally {
        scanner.close()
    }
}
