package com.agenthub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        val allowed = action == Intent.ACTION_BOOT_COMPLETED ||
                action == Intent.ACTION_MY_PACKAGE_REPLACED ||
                action == Intent.ACTION_POWER_CONNECTED ||
                action == Intent.ACTION_USER_PRESENT
        if (!allowed) return
        val prefs = context.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)
        if (savedHubConnection(context) == null) return
        if (Build.VERSION.SDK_INT >= 35 && action == Intent.ACTION_BOOT_COMPLETED) {
            prefs.edit().putString("background_stop_reason", "start_restricted").apply()
            return
        }
        try {
            context.startForegroundService(Intent(context, HubService::class.java))
        } catch (_: Exception) {
            prefs.edit().putString("background_stop_reason", "start_restricted").apply()
        }
    }
}
