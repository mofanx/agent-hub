package com.agenthub.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.ConnProfile

@Composable
fun HubProfileDialog(
    vm: ChatViewModel,
    profile: ConnProfile? = null,
    onDismiss: () -> Unit,
) {
    val S = LocalStrings.current
    var name by remember { mutableStateOf(profile?.name ?: "") }
    var host by remember { mutableStateOf(profile?.address ?: "") }
    var token by remember { mutableStateOf(profile?.token ?: "dev-token") }
    var publicToken by remember { mutableStateOf(profile?.publicToken ?: "") }

    var showScan by remember { mutableStateOf(false) }

    val isCurrent = profile != null && vm.currentProfile == profile
    val hostChanged = profile != null && profile.address != host.trim()

    if (showScan) {
        QrScanDialog(
            onResult = { raw ->
                showScan = false
                com.agenthub.parseConnectUri(raw)?.let { p ->
                    host = p.address
                    if (name.isBlank()) name = p.name
                    token = p.token.ifBlank { token }
                    publicToken = p.publicToken
                } ?: vm.importConnectUri(raw)
            },
            onDismiss = { showScan = false },
        )
    }

    val title = if (profile == null) S.addHub else S.editHub

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(S.nameExampleLabel) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = host,
                    onValueChange = { v ->
                        // 粘贴 agenthub://connect 链接自动拆分填充
                        if (v.trim().startsWith("agenthub://")) {
                            com.agenthub.parseConnectUri(v)?.let { p ->
                                host = p.address
                                if (name.isBlank()) name = p.name
                                token = p.token.ifBlank { token }
                                publicToken = p.publicToken
                                return@OutlinedTextField
                            }
                        }
                        host = v
                    },
                    label = { Text(S.hubAddress) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text(S.tokenLabel) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = publicToken,
                    onValueChange = { publicToken = it },
                    label = { Text(S.gatewayTokenLabel) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                TextButton(onClick = { showScan = true }) {
                    Text(S.scanQrCode)
                }
                vm.connectError?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val canSave = profile != null && !hostChanged
                if (canSave) {
                    TextButton(
                        onClick = {
                            vm.upsertProfile(
                                profile,
                                name.trim(),
                                host.trim(),
                                token.trim(),
                                publicToken.trim(),
                                connectNow = false,
                            )
                            onDismiss()
                        },
                    ) {
                        Text(S.save)
                    }
                    Spacer(Modifier.size(8.dp))
                }
                Button(
                    onClick = {
                        vm.upsertProfile(
                            profile,
                            name.trim(),
                            host.trim(),
                            token.trim(),
                            publicToken.trim(),
                            connectNow = true,
                        )
                        onDismiss()
                    },
                    enabled = !vm.connecting && host.isNotBlank(),
                ) {
                    val label = when {
                        isCurrent && hostChanged -> S.saveAndSwitch
                        isCurrent -> S.saveAndConnect
                        profile == null -> S.addAndConnect
                        else -> S.saveAndConnect
                    }
                    Text(label)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(S.cancel) }
        },
    )
}
