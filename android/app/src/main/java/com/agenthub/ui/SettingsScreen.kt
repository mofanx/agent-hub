package com.agenthub.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.Screen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: ChatViewModel) {
    val S = LocalStrings.current

    LaunchedEffect(Unit) {
        vm.refreshAll()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(S.settings) },
                navigationIcon = {
                    IconButton(onClick = { vm.screen = Screen.Sessions }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().padding(16.dp)) {
            Card(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                ),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(S.theme, style = MaterialTheme.typography.titleSmall)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        listOf(
                            "system" to S.themeSystem,
                            "light" to S.themeLight,
                            "dark" to S.themeDark,
                        ).forEachIndexed { i, (mode, label) ->
                            SegmentedButton(
                                selected = vm.themeMode == mode,
                                onClick = { vm.updateThemeMode(mode) },
                                shape = SegmentedButtonDefaults.itemShape(index = i, count = 3),
                            ) { Text(label) }
                        }
                    }
                }
            }
            Card(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                ),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(S.language, style = MaterialTheme.typography.titleSmall)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        listOf("zh" to "中文", "en" to "English").forEachIndexed { i, (l, label) ->
                            SegmentedButton(
                                selected = vm.lang == l,
                                onClick = { vm.updateLang(l) },
                                shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                            ) { Text(label) }
                        }
                    }
                }
            }
            Card(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                ),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(S.agentSources, style = MaterialTheme.typography.titleSmall)
                    var showAdd by remember { mutableStateOf(false) }
                    var newName by remember { mutableStateOf("") }
                    var newAgent by remember { mutableStateOf("devin") }
                    var newAddress by remember { mutableStateOf("") }
                    var newCwd by remember { mutableStateOf("") }
                    var newLocal by remember { mutableStateOf(false) }
                    var tokenAuto by remember { mutableStateOf(true) }
                    var newToken by remember { mutableStateOf("") }
                    var agentMenu by remember { mutableStateOf(false) }
                    val agentTypes = listOf(
                        "devin" to "Devin", "claude" to "Claude",
                        "codex" to "Codex", "opencode" to "OpenCode",
                    )
                    OutlinedButton(
                        onClick = { showAdd = true },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(8.dp))
                        Text(S.addConnection)
                    }
                    if (showAdd) {
                        AlertDialog(
                            onDismissRequest = { showAdd = false },
                            title = { Text(S.addConnection) },
                            text = {
                                Column {
                                    OutlinedTextField(
                                        value = newName,
                                        onValueChange = { newName = it },
                                        label = { Text(S.connectionNameLabel) },
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    Box {
                                        OutlinedButton(
                                            onClick = { agentMenu = true },
                                            modifier = Modifier.fillMaxWidth(),
                                        ) {
                                            Text(
                                                agentTypes.find { it.first == newAgent }?.second ?: newAgent,
                                                Modifier.weight(1f),
                                            )
                                            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                                        }
                                        DropdownMenu(expanded = agentMenu, onDismissRequest = { agentMenu = false }) {
                                            agentTypes.forEach { (key, label) ->
                                                DropdownMenuItem(
                                                    text = { Text(label) },
                                                    onClick = { newAgent = key; agentMenu = false },
                                                )
                                            }
                                        }
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = newAddress,
                                        onValueChange = { newAddress = it },
                                        label = { Text(S.connectionNoteLabel) },
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = newCwd,
                                        onValueChange = { newCwd = it },
                                        label = { Text(S.defaultCwdLabel) },
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Checkbox(
                                            checked = newLocal,
                                            onCheckedChange = { newLocal = it },
                                        )
                                        Text(S.localLaunch, style = MaterialTheme.typography.bodyMedium)
                                    }
                                    if (!newLocal) {
                                        Spacer(Modifier.height(8.dp))
                                        Text(S.tokenLabel, style = MaterialTheme.typography.labelLarge)
                                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                                            listOf(true to S.tokenAuto, false to S.tokenManual).forEachIndexed { i, (auto, label) ->
                                                SegmentedButton(
                                                    selected = tokenAuto == auto,
                                                    onClick = { tokenAuto = auto },
                                                    shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                                                ) { Text(label) }
                                            }
                                        }
                                        if (!tokenAuto) {
                                            Spacer(Modifier.height(8.dp))
                                            OutlinedTextField(
                                                value = newToken,
                                                onValueChange = { newToken = it },
                                                label = { Text(S.tokenLabel) },
                                                singleLine = true,
                                            )
                                        }
                                    }
                                }
                            },
                            confirmButton = {
                                TextButton(
                                    onClick = {
                                        showAdd = false
                                        vm.createConnection(newName.trim(), newAgent, newAddress.trim(), newCwd.trim(), if (tokenAuto) "" else newToken.trim(), newLocal)
                                    },
                                    enabled = newName.isNotBlank() && (newLocal || tokenAuto || newToken.isNotBlank()),
                                ) { Text(S.create) }
                            },
                            dismissButton = {
                                TextButton(onClick = { showAdd = false }) { Text(S.cancel) }
                            },
                        )
                    }
                    vm.connections.forEach { c ->
                        val context = androidx.compose.ui.platform.LocalContext.current
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        Row(
                            Modifier.fillMaxWidth().padding(top = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(c.name, style = MaterialTheme.typography.bodyMedium)
                                    Spacer(Modifier.size(6.dp))
                                    if (c.local) {
                                        Text(
                                            S.localConnection,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                    } else {
                                        Text(
                                            if (c.online) S.online else S.offline,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = if (c.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                                        )
                                    }
                                }
                                Text(
                                    buildString {
                                        append(c.agent)
                                        if (c.local) {
                                            append(" · ")
                                            append(S.localLaunch)
                                        } else {
                                            append(" · ")
                                            append(S.tokenLabel)
                                            append(": ")
                                            append(c.token)
                                        }
                                        if (c.address.isNotBlank()) {
                                            append(" · ")
                                            append(c.address)
                                        }
                                        if (c.cwd.isNotBlank()) {
                                            append(" · ")
                                            append(c.cwd)
                                        }
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (!c.local) {
                                IconButton(
                                    onClick = {
                                        clipboard.setPrimaryClip(ClipData.newPlainText("token", c.token))
                                        Toast.makeText(context, S.copied, Toast.LENGTH_SHORT).show()
                                    },
                                ) {
                                    Icon(Icons.Filled.ContentCopy, contentDescription = S.copy, modifier = Modifier.size(20.dp))
                                }
                            }
                            IconButton(onClick = { vm.deleteConnection(c.id) }) {
                                Icon(Icons.Filled.Delete, contentDescription = S.delete, tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
            val context = androidx.compose.ui.platform.LocalContext.current
            Card(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                ),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text(S.keepAlive, style = MaterialTheme.typography.titleSmall)
                    Text(
                        S.keepAliveDesc,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    androidx.compose.material3.OutlinedButton(
                        onClick = {
                            try {
                                context.startActivity(
                                    android.content.Intent(
                                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                        android.net.Uri.parse("package:${context.packageName}"),
                                    ),
                                )
                            } catch (_: Exception) {
                            }
                        },
                        modifier = Modifier.padding(top = 8.dp),
                    ) { Text(S.batteryOptimization) }
                    androidx.compose.material3.TextButton(
                        onClick = {
                            try {
                                context.startActivity(
                                    android.content.Intent(
                                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                        android.net.Uri.parse("package:${context.packageName}"),
                                    ),
                                )
                            } catch (_: Exception) {
                            }
                        },
                        modifier = Modifier.padding(top = 4.dp),
                    ) { Text("应用详情设置") }
                }
            }
            Row(Modifier.padding(top = 16.dp)) {
                Text(
                    "Agent Hub · ACP multi-agent gateway",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
