package com.agenthub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        val allowed = action == Intent.ACTION_BOOT_COMPLETED ||
                action == Intent.ACTION_MY_PACKAGE_REPLACED ||
                action == Intent.ACTION_POWER_CONNECTED ||
                action == Intent.ACTION_USER_PRESENT
        if (!allowed) return
        val prefs = context.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)
        if (prefs.getString("last", null) == null) return
        try {
            context.startForegroundService(Intent(context, HubService::class.java))
        } catch (_: Exception) {
        }
    }
}
