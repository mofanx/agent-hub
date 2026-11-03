package com.agenthub

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.activity.compose.setContent
import android.content.Intent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.agenthub.ui.AgentHubTheme
import com.agenthub.ui.ChatScreen
import com.agenthub.ui.DeliveryManager
import com.agenthub.ui.AttentionManager
import com.agenthub.ui.FileTreeScreen
import com.agenthub.ui.HubDrawer
import com.agenthub.ui.HubProfileDialog
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
        handleConnectIntent(intent)
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleConnectIntent(intent)
    }

    private fun handleConnectIntent(intent: Intent?) {
        if (intent == null) return
        if (!intent.getStringExtra("navRoomId").isNullOrEmpty() || !intent.getStringExtra("navSessionId").isNullOrEmpty()) {
            val keys = listOf("navOrigin", "navHubId", "navRoomId", "navSessionId", "navFlowId", "navTaskId",
                "navDispatchedAt", "navDecisionId", "navRequestId", "navAt", "navHelpId", "navBatchKey")
            vm.openAttentionTarget(keys.mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap())
            return
        }
        val data = intent.data ?: return
        if (data.scheme == "agenthub") {
            // ntfy Click 深链：agenthub://attention?roomId=… → 走待办定位；connect 链接照旧导入
            if (data.host == "attention") {
                val rid = data.getQueryParameter("roomId")
                vm.openAttentionTarget(if (rid.isNullOrEmpty()) emptyMap() else mapOf("navRoomId" to rid))
            } else {
                vm.importConnectUri(data.toString())
            }
        }
    }

    override fun onResume() {
        super.onResume()
        ChatViewModel.appForeground = true
        vm.refreshBackgroundStatus()
        vm.startHubService()
    }

    override fun onPause() {
        super.onPause()
        ChatViewModel.appForeground = false
        if (HubService.running) vm.startHubService()
    }
}

@Composable
fun AppRoot(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val warning = vm.backgroundConnectionWarning()
    // 根级统一消费状态栏 inset：待办/发送记录/警告条不再侵入系统时间区，
    // 且与内部 TopAppBar 不再叠加出双间距（TopAppBar 的 windowInsets 置 0）
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        val S = stringsFor(vm.lang)
        val attentionCount = vm.attentionItems.count { vm.attentionCurrent(it) }
        if (attentionCount > 0) {
            TextButton(onClick = { vm.showAttentionManager = true }) { Text(S.attentionCountFmt.format(attentionCount)) }
        }
        vm.attentionNavError?.let { error ->
            Text(S.attentionLabels[error] ?: S.attentionNeeded, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error)
            TextButton(onClick = { vm.dismissAttentionNavigation() }) { Text(S.cancel) }
        }
        // banner 纯派生：存储级错误（corrupt/storage/full）恒显；本连接有在途记录才显——
        // 瞬态错误（context 等）挂在全局字段上无论哪条路径残留都不再撑横幅
        val deliveryActionable = vm.deliveryRecords.any {
            vm.currentDelivery(it) && it.status in setOf("pending", "sending", "uncertain", "failed")
        }
        if (vm.deliveryError in setOf("corrupt", "storage", "full") || deliveryActionable) {
            TextButton(onClick = { vm.showDeliveryManager = true }) {
                Text(stringsFor(vm.lang).deliveryLabels.getValue("title"))
            }
        }
        if (warning != null) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.errorContainer,
            ) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(warning, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    vm.currentProfile?.let { profile ->
                        TextButton(
                            enabled = vm.connectionState != HubConnectionState.Connecting,
                            onClick = { vm.connect(profile.address, profile.token, profile.publicToken, profile.name) },
                        ) { Text(stringsFor(vm.lang).connect) }
                    }
                }
            }
        }
        Box(Modifier.weight(1f).then(if (warning != null) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
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
    }
    DeliveryManager(vm)
    AttentionManager(vm)
    vm.pendingImport?.let { profile ->
        HubProfileDialog(vm, profile = profile, onDismiss = { vm.pendingImport = null })
    }
}
