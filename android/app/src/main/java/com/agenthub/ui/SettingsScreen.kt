package com.agenthub.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.Screen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: ChatViewModel) {
    val S = LocalStrings.current

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
