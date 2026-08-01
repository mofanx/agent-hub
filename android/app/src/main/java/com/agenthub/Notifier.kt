package com.agenthub

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object Notifier {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_PERMISSION = "permissions"
    const val CHANNEL_SERVICE = "service"

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_MESSAGES,
                "Agent 回复",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Agent 任务完成或回复消息时提醒" },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_PERMISSION,
                "审批请求",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Agent 发起权限审批时提醒" },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SERVICE,
                "后台连接",
                NotificationManager.IMPORTANCE_MIN,
            ).apply { description = "保持与 Hub 的后台连接（常驻，可隐藏）" },
        )
    }

    fun notify(context: Context, channel: String, title: String, text: String, id: Int) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val intent = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(text.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(500)))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (_: SecurityException) {
        }
    }
}
