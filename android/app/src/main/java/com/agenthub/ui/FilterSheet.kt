package com.agenthub.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.RoomGroupBy
import com.agenthub.RoomListFilter
import com.agenthub.SessionGroupBy
import com.agenthub.SessionListFilter
import com.agenthub.SessionStatus

fun truncatePath(path: String, maxLen: Int = 40): String {
    if (path.length <= maxLen) return path
    val tail = path.takeLast(maxLen - 3)
    val idx = tail.indexOf("/")
    return if (idx > 0) "...${tail.drop(idx)}" else "...$tail"
}

private fun sessionStatusLabel(status: SessionStatus, S: Strings): String = when (status) {
    SessionStatus.Online -> S.statusOnline
    SessionStatus.Offline -> S.statusOffline
    SessionStatus.Busy -> S.statusBusy
    SessionStatus.Pinned -> S.statusPinned
    SessionStatus.Archived -> S.statusArchived
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilterBottomSheet(vm: ChatViewModel, selectedTab: Int, onDismiss: () -> Unit) {
    val S = LocalStrings.current
    val sheetState = rememberModalBottomSheetState()
    ModalBottomSheet(
        sheetState = sheetState,
        onDismissRequest = onDismiss,
    ) {
        FilterSheetContent(vm, selectedTab, onDismiss)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterSheetContent(vm: ChatViewModel, selectedTab: Int, onDismiss: () -> Unit) {
    val S = LocalStrings.current
    val filter = if (selectedTab == 0) vm.sessionListFilter else null
    val roomFilter = if (selectedTab == 1) vm.roomListFilter else null

    val agents = remember(vm.sessions) { vm.sessions.map { it.agent }.distinct().sorted() }
    val cwds = remember(vm.sessions) { vm.sessions.map { it.cwd }.filter { it.isNotBlank() }.distinct().sorted() }
    val modes = remember(vm.rooms) { vm.rooms.map { it.mode }.distinct().sorted() }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(S.filterBy, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = S.cancel) }
        }
        Spacer(Modifier.height(8.dp))

        val listHeight = 360.dp
        LazyColumn(Modifier.heightIn(max = listHeight).fillMaxWidth()) {
            if (selectedTab == 0 && filter != null) {
                item { SectionTitle(S.groupBy) }
                item {
                    GroupChips(
                        items = listOf(
                            SessionGroupBy.None to S.noGroup,
                            SessionGroupBy.Agent to S.byAgent,
                            SessionGroupBy.Cwd to S.byCwd,
                        ),
                        selected = filter.groupBy,
                        onSelect = { vm.sessionListFilter = filter.copy(groupBy = it) },
                    )
                }

                if (agents.isNotEmpty()) {
                    item { SectionTitle("Agent") }
                    item {
                        MultiSelectChips(
                            items = agents,
                            selected = filter.agents,
                            onToggle = { a ->
                                vm.sessionListFilter = filter.copy(
                                    agents = if (filter.agents.contains(a)) filter.agents - a else filter.agents + a,
                                )
                            },
                        )
                    }
                }

                if (cwds.isNotEmpty()) {
                    item { SectionTitle(S.byCwd) }
                    items(cwds.size) { i ->
                        val p = cwds[i]
                        val selected = filter.cwds.contains(p)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Checkbox(
                                checked = selected,
                                onCheckedChange = {
                                    vm.sessionListFilter = filter.copy(
                                        cwds = if (selected) filter.cwds - p else filter.cwds + p,
                                    )
                                },
                            )
                            Text(
                                truncatePath(p),
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }

                item {
                    SectionTitle("状态")
                    Text(
                        "未选择时显示全部",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                item {
                    MultiSelectChips(
                        items = SessionStatus.entries,
                        selected = filter.statuses,
                        onToggle = { st ->
                            vm.sessionListFilter = filter.copy(
                                statuses = if (filter.statuses.contains(st)) filter.statuses - st else filter.statuses + st,
                            )
                        },
                        label = { sessionStatusLabel(it, S) },
                    )
                }
            }

            if (selectedTab == 1 && roomFilter != null) {
                item { SectionTitle(S.groupBy) }
                item {
                    GroupChips(
                        items = listOf(
                            RoomGroupBy.None to S.noGroup,
                            RoomGroupBy.Mode to S.byMode,
                        ),
                        selected = roomFilter.groupBy,
                        onSelect = { vm.roomListFilter = roomFilter.copy(groupBy = it) },
                    )
                }

                if (modes.isNotEmpty()) {
                    item { SectionTitle(S.modeLabel) }
                    item {
                        MultiSelectChips(
                            items = modes,
                            selected = roomFilter.modes,
                            onToggle = { m ->
                                vm.roomListFilter = roomFilter.copy(
                                    modes = if (roomFilter.modes.contains(m)) roomFilter.modes - m else roomFilter.modes + m,
                                )
                            },
                            label = { modeName(it, S) },
                        )
                    }
                }
            }

            item {
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = {
                        if (selectedTab == 0) vm.sessionListFilter = com.agenthub.SessionListFilter()
                        else vm.roomListFilter = com.agenthub.RoomListFilter()
                    }) { Text("重置") }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

@Composable
private fun <T> GroupChips(
    items: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(items.size) { i ->
            val (value, label) = items[i]
            FilterChip(
                selected = selected == value,
                onClick = { onSelect(value) },
                label = { Text(label) },
            )
        }
    }
    Spacer(Modifier.height(8.dp))
}

@Composable
private fun <T> MultiSelectChips(
    items: List<T>,
    selected: Set<T>,
    onToggle: (T) -> Unit,
    label: (T) -> String = { it.toString() },
) {
    LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(end = 16.dp),
    ) {
        items(items.size) { i ->
            val v = items[i]
            FilterChip(
                selected = selected.contains(v),
                onClick = { onToggle(v) },
                label = { Text(label(v)) },
            )
        }
    }
    Spacer(Modifier.height(8.dp))
}

fun modeName(mode: String, S: Strings): String = when (mode) {
    "mention" -> S.modeMention
    "conductor" -> S.modeConductor
    "roundrobin" -> S.modeRoundRobin
    "parallel" -> S.modeParallel
    "pipeline" -> S.modePipeline
    "debate" -> S.modeDebate
    "auto" -> S.modeAuto
    else -> mode
}
