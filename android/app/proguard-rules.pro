-keepattributes SourceFile,LineNumberTable
# QR 扫码（ML Kit / CameraX）：R8 会裁剪 mlkit 内部反射加载的 zz* 类，release 下 getValue 崩 NPE
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_** { *; }
-keep class com.google.android.gms.internal.mlkit_common.** { *; }
