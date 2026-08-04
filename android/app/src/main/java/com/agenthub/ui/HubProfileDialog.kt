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
    var port by remember { mutableStateOf(profile?.port ?: "8787") }
    var token by remember { mutableStateOf(profile?.token ?: "dev-token") }

    val isCurrent = profile != null && vm.currentProfile == profile
    val hostPortChanged = profile != null &&
        (profile.address != host.trim() || profile.port != port.trim())

    val title = if (profile == null) "添加 Hub" else "编辑 Hub"

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
                    label = { Text("名称（如 本机 / 公网 VPS）") },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = host,
                    onValueChange = { host = it },
                    label = { Text(S.hubAddress) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true,
                )
                Spacer(Modifier.height(10.dp))
                Row {
                    OutlinedTextField(
                        value = port,
                        onValueChange = { port = it },
                        label = { Text(S.portLabel) },
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(16.dp),
                        singleLine = true,
                    )
                    Spacer(Modifier.size(10.dp))
                    OutlinedTextField(
                        value = token,
                        onValueChange = { token = it },
                        label = { Text(S.tokenLabel) },
                        modifier = Modifier.weight(2f),
                        shape = RoundedCornerShape(16.dp),
                        singleLine = true,
                    )
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
                val canSave = profile != null && !hostPortChanged
                if (canSave) {
                    TextButton(
                        onClick = {
                            vm.upsertProfile(
                                profile,
                                name.trim(),
                                host.trim(),
                                port.trim(),
                                token.trim(),
                                connectNow = false,
                            )
                            onDismiss()
                        },
                    ) {
                        Text("保存")
                    }
                    Spacer(Modifier.size(8.dp))
                }
                Button(
                    onClick = {
                        vm.upsertProfile(
                            profile,
                            name.trim(),
                            host.trim(),
                            port.trim(),
                            token.trim(),
                            connectNow = true,
                        )
                        onDismiss()
                    },
                    enabled = !vm.connecting && host.isNotBlank(),
                ) {
                    val label = when {
                        isCurrent && hostPortChanged -> "保存并切换"
                        isCurrent -> "保存并连接"
                        profile == null -> "添加并连接"
                        else -> "保存并连接"
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
