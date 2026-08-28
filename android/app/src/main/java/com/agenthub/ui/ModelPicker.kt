package com.agenthub.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.agenthub.ChatViewModel
import com.agenthub.ModelInfo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerDialog(vm: ChatViewModel, onDismiss: () -> Unit = { vm.showModelPicker = false }) {
    val S = LocalStrings.current
    if (!vm.showModelPicker) return

    val isRoom = vm.currentRoom != null
    val memberModels = vm.roomMemberModels
    val selectedMember = vm.selectedMemberSession

    val all = vm.modelList
    val selectedBackends = remember { mutableStateListOf<String>() }
    val selectedTiers = remember { mutableStateListOf<String>() }
    val selectedVendors = remember { mutableStateListOf<String>() }

    val filter = vm.modelFilter
    val filtered by remember(all, filter, selectedBackends, selectedTiers, selectedVendors, isRoom) {
        derivedStateOf {
            all.filter { m ->
                val textOk = filter.isBlank() ||
                    m.uid.contains(filter, ignoreCase = true) ||
                    m.label.contains(filter, ignoreCase = true) ||
                    m.family.contains(filter, ignoreCase = true) ||
                    m.vendor.contains(filter, ignoreCase = true) ||
                    m.aliases.any { it.contains(filter, ignoreCase = true) }
                val backendOk = isRoom || selectedBackends.isEmpty() || selectedBackends.contains(m.backend)
                val tierOk = isRoom || selectedTiers.isEmpty() || selectedTiers.contains(m.costTier)
                val vendorOk = isRoom || selectedVendors.isEmpty() || selectedVendors.contains(m.vendor)
                textOk && backendOk && tierOk && vendorOk
            }
        }
    }

    val grouped by remember(filtered, isRoom) {
        derivedStateOf {
            if (isRoom) {
                // 群聊模式：不分组，直接列表
                listOf("" to filtered)
            } else {
                val order = listOf("devin", "claude", "codex", "opencode", "openclaw", "custom")
                filtered.groupBy { it.backend }
                    .toList()
                    .sortedBy { (backend, _) -> order.indexOf(backend).takeIf { it >= 0 } ?: Int.MAX_VALUE }
            }
        }
    }

    val costOrder = listOf("Free", "Low cost", "Med cost", "High cost")
    val availableBackends = remember(all) { all.map { it.backend }.toSet().sorted() }
    val availableTiers = remember(all) { all.map { it.costTier }.toSet().sortedBy { costOrder.indexOf(it) } }
    val availableVendors = remember(all) { all.map { it.vendor }.toSet().sorted() }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.fillMaxSize().padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = S.back)
                    }
                    Text(
                        S.modelListTitle,
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { vm.refreshModelList() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                }

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = vm.modelFilter,
                    onValueChange = { vm.modelFilter = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text(S.modelFilterHint) },
                    leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                    singleLine = true,
                    shape = RoundedCornerShape(24.dp),
                )

                if (isRoom) {
                    // 群聊模式：成员标签栏
                    Spacer(Modifier.height(8.dp))
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 2.dp),
                    ) {
                        items(memberModels.entries.toList(), key = { it.key }) { entry ->
                            FilterChip(
                                selected = selectedMember == entry.key,
                                onClick = { vm.selectMemberForModel(entry.key) },
                                label = { Text("@${entry.value.first}") },
                                modifier = Modifier.padding(end = 8.dp),
                            )
                        }
                    }
                } else {
                    // 单聊模式：后端/tier/vendor 筛选
                    if (selectedBackends.isNotEmpty() || selectedTiers.isNotEmpty() || selectedVendors.isNotEmpty() || filter.isNotBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Spacer(Modifier.weight(1f))
                            TextButton(
                                onClick = {
                                    vm.modelFilter = ""
                                    selectedBackends.clear()
                                    selectedTiers.clear()
                                    selectedVendors.clear()
                                },
                            ) { Text(S.modelClearFilters) }
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 2.dp),
                    ) {
                        items(availableBackends, key = { "backend:$it" }) { backend ->
                            FilterChip(
                                selected = selectedBackends.contains(backend),
                                onClick = {
                                    if (selectedBackends.contains(backend)) selectedBackends.remove(backend)
                                    else selectedBackends.add(backend)
                                },
                                label = { Text(backendDisplayName(backend)) },
                                modifier = Modifier.padding(end = 8.dp),
                            )
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 2.dp),
                    ) {
                        items(availableTiers, key = { "tier:$it" }) { tier ->
                            FilterChip(
                                selected = selectedTiers.contains(tier),
                                onClick = {
                                    if (selectedTiers.contains(tier)) selectedTiers.remove(tier)
                                    else selectedTiers.add(tier)
                                },
                                label = { Text(tierName(S, tier)) },
                                modifier = Modifier.padding(end = 8.dp),
                            )
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 2.dp),
                    ) {
                        items(availableVendors, key = { "vendor:$it" }) { vendor ->
                            FilterChip(
                                selected = selectedVendors.contains(vendor),
                                onClick = {
                                    if (selectedVendors.contains(vendor)) selectedVendors.remove(vendor)
                                    else selectedVendors.add(vendor)
                                },
                                label = { Text(vendor) },
                                modifier = Modifier.padding(end = 8.dp),
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = PaddingValues(bottom = 16.dp),
                ) {
                    grouped.forEach { (backend, models) ->
                        if (!isRoom) {
                            item(key = "header:$backend") {
                                Text(
                                    backendDisplayName(backend),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.padding(vertical = 8.dp),
                                )
                            }
                        }
                        items(models, key = { it.uid }) { m ->
                            ModelItem(S, m, vm.modelCurrent) {
                                vm.switchModel(m)
                            }
                        }
                    }
                    if (grouped.isEmpty() || filtered.isEmpty()) {
                        item {
                            Text(
                                S.modelNoResults,
                                modifier = Modifier.padding(16.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelItem(S: Strings, m: ModelInfo, current: String, onClick: () -> Unit) {
    val isCurrent = m.uid == current
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isCurrent) {
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)
            } else {
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
            },
        ),
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    m.label,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                if (isCurrent) {
                    Text(
                        S.modelCurrentLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
            Text(
                m.uid,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    tierName(S, m.costTier),
                    style = MaterialTheme.typography.labelSmall,
                    color = costColor(m.costTier),
                )
                if (!m.costSummary.isNullOrBlank()) {
                    Text(
                        " · ${m.costSummary}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (m.aliases.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    m.aliases.joinToString(", ") { "@$it" },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun tierName(S: Strings, tier: String): String = when (tier) {
    "Free" -> S.costTierFree
    "Low cost" -> S.costTierLow
    "Med cost" -> S.costTierMed
    "High cost" -> S.costTierHigh
    else -> tier
}

private fun backendDisplayName(backend: String): String = when (backend) {
    "devin" -> "Devin"
    "claude" -> "Claude Code"
    "codex" -> "Codex"
    "opencode" -> "OpenCode"
    "openclaw" -> "OpenClaw"
    "custom" -> "自定义"
    else -> backend
}

@Composable
private fun costColor(tier: String): Color = when (tier) {
    "Free" -> Color(0xFF2E7D32)
    "Low cost" -> Color(0xFF1565C0)
    "Med cost" -> Color(0xFFF57C00)
    "High cost" -> Color(0xFFC62828)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
