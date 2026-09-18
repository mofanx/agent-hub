package com.agenthub

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.activity.compose.setContent
import android.content.Intent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import com.agenthub.ui.AgentHubTheme
import com.agenthub.ui.ChatScreen
import com.agenthub.ui.FileTreeScreen
import com.agenthub.ui.HubDrawer
import com.agenthub.ui.LocalStrings
import com.agenthub.ui.SessionListScreen
import com.agenthub.ui.SettingsScreen
import com.agenthub.ui.ScheduleScreen
import com.agenthub.ui.stringsFor
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: ChatViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
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
                        val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
                        val scope = rememberCoroutineScope()
                        ModalNavigationDrawer(
                            drawerState = drawerState,
                            drawerContent = { HubDrawer(vm, drawerState) },
                        ) {
                            AppRoot(vm, onMenuClick = { scope.launch { drawerState.open() } })
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        ChatViewModel.appForeground = true
        if (vm.screen != Screen.Connect) {
            try {
                startForegroundService(Intent(this, HubService::class.java))
            } catch (_: Exception) {
            }
        }
    }

    override fun onPause() {
        super.onPause()
        ChatViewModel.appForeground = false
    }
}

@Composable
fun AppRoot(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    when (vm.screen) {
        Screen.Connect -> SessionListScreen(vm, onMenuClick)
        Screen.Sessions -> SessionListScreen(vm, onMenuClick)
        Screen.Chat, Screen.Room -> ChatScreen(vm, onMenuClick)
        Screen.FileTree -> FileTreeScreen(vm) {
            vm.screen = when {
                vm.currentRoom != null -> Screen.Room
                vm.currentSession != null -> Screen.Chat
                else -> Screen.Sessions
            }
        }
        Screen.Settings -> SettingsScreen(vm, onMenuClick)
        Screen.Schedule -> ScheduleScreen(vm, onMenuClick)
    }
}
