package com.agenthub

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.content.Intent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import com.agenthub.ui.AgentHubTheme
import com.agenthub.ui.ChatScreen
import com.agenthub.ui.ConnectScreen
import com.agenthub.ui.LocalStrings
import com.agenthub.ui.SessionListScreen
import com.agenthub.ui.SettingsScreen
import com.agenthub.ui.stringsFor

class MainActivity : ComponentActivity() {
    private val vm: ChatViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifier.ensureChannels(this)
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        setContent {
            AgentHubTheme(vm.themeMode) {
                CompositionLocalProvider(LocalStrings provides stringsFor(vm.lang)) {
                    Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = MaterialTheme.colorScheme.background,
                    ) {
                        AppRoot(vm)
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        ChatViewModel.appForeground = true
        try {
            startForegroundService(Intent(this, HubService::class.java))
        } catch (_: Exception) {
        }
    }

    override fun onPause() {
        super.onPause()
        ChatViewModel.appForeground = false
    }
}

@Composable
fun AppRoot(vm: ChatViewModel) {
    when (vm.screen) {
        Screen.Connect -> ConnectScreen(vm)
        Screen.Sessions -> SessionListScreen(vm)
        Screen.Chat, Screen.Room -> ChatScreen(vm)
        Screen.Settings -> SettingsScreen(vm)
    }
}
