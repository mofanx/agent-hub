package com.agenthub.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.GroupAdd
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.Screen
import com.agenthub.SessionInfo

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun SessionListScreen(vm: ChatViewModel) {
    val S = LocalStrings.current
    var showCreate by remember { mutableStateOf(false) }
    var showCreateRoom by remember { mutableStateOf(false) }
    var showArchived by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<SessionInfo?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionInfo?>(null) }
    var searchQuery by remember { mutableStateOf("") }

    LaunchedEffect(searchQuery) {
        if (searchQuery.isNotBlank()) vm.search(searchQuery)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(S.appName) },
                actions = {
                    IconButton(onClick = { vm.screen = Screen.Settings }) {
                        Icon(Icons.Filled.Settings, contentDescription = S.settings)
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text(S.searchHistory) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                shape = RoundedCornerShape(24.dp),
                singleLine = true,
            )
            if (searchQuery.isNotBlank()) {
                LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    items(vm.searchResults.size) { i ->
                        val hit = vm.searchResults[i]
                        Card(
                            onClick = {
                                searchQuery = ""
                                vm.openSearchHit(hit)
                            },
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            shape = RoundedCornerShape(16.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                            ),
                        ) {
                            Column(Modifier.padding(12.dp)) {
                                Text(
                                    "${hit.author.ifBlank { S.systemTag }} · " +
                                        if (hit.scope == "room") S.roomTag else S.singleChat,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                Text(
                                    hit.text.take(120),
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2,
                                )
                            }
                        }
                    }
                    if (vm.searchResults.isEmpty()) {
                        item {
                            Text(
                                S.noResults,
                                Modifier.padding(16.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                return@Column
            }

            LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            S.sessions,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        IconButton(onClick = { showCreate = true }) {
                            Icon(Icons.Filled.Add, contentDescription = S.newSession)
                        }
                    }
                }
                val visible = vm.sessions.filter { !it.archived }
                    .sortedByDescending { vm.pinnedIds.contains(it.sessionId) }
                items(visible.size) { i ->
                    SessionCard(visible[i], vm, S, onLongClick = { actionTarget = it })
                }
                val archived = vm.sessions.filter { it.archived }
                if (archived.isNotEmpty()) {
                    item {
                        TextButton(onClick = { showArchived = !showArchived }) {
                            Text("${S.archived} (${archived.size}) ${if (showArchived) "▲" else "▼"}")
                        }
                    }
                    if (showArchived) {
                        items(archived.size) { i ->
                            SessionCard(archived[i], vm, S, onLongClick = { actionTarget = it })
                        }
                    }
                }
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            S.rooms,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        IconButton(
                            onClick = { showCreateRoom = true },
                            enabled = vm.sessions.count { !it.archived } >= 2,
                        ) {
                            Icon(Icons.Filled.GroupAdd, contentDescription = S.createRoom)
                        }
                    }
                }
                items(vm.rooms.size) { i ->
                    val r = vm.rooms[i]
                    Card(
                        onClick = { vm.openRoom(r) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                        ),
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(r.name, style = MaterialTheme.typography.titleSmall)
                                if (r.mode == "conductor") {
                                    Text(
                                        "  · ${S.modeConductor}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                            Text(
                                r.members.joinToString("、") { it.second },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        actionTarget?.let { s ->
            AlertDialog(
                onDismissRequest = { actionTarget = null },
                title = { Text(s.name) },
                text = { Text(S.chooseAction) },
                confirmButton = {
                    Row {
                        TextButton(onClick = {
                            vm.togglePin(s.sessionId)
                            actionTarget = null
                        }) { Text(if (vm.pinnedIds.contains(s.sessionId)) S.unpin else S.pin) }
                        TextButton(onClick = {
                            vm.archiveSession(s, !s.archived)
                            actionTarget = null
                        }) { Text(if (s.archived) S.unarchive else S.archive) }
                    }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = {
                            confirmDelete = s
                            actionTarget = null
                        }) { Text(S.delete, color = MaterialTheme.colorScheme.error) }
                        TextButton(onClick = { actionTarget = null }) { Text(S.cancel) }
                    }
                },
            )
        }

        confirmDelete?.let { s ->
            AlertDialog(
                onDismissRequest = { confirmDelete = null },
                title = { Text(S.deleteConfirmTitle.format(s.name)) },
                text = { Text(S.deleteConfirmText) },
                confirmButton = {
                    TextButton(onClick = {
                        vm.deleteSession(s)
                        confirmDelete = null
                    }) { Text(S.delete, color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = {
                    TextButton(onClick = { confirmDelete = null }) { Text(S.cancel) }
                },
            )
        }

        if (showCreate) {
            var cwd by remember { mutableStateOf("") }
            var name by remember { mutableStateOf("") }
            var agentType by remember { mutableStateOf("devin") }
            var selectedRoleId by remember { mutableStateOf<String?>(null) }
            var showAddRole by remember { mutableStateOf(false) }
            var deleteRoleTarget by remember { mutableStateOf<String?>(null) }
            val agentTypes = listOf(
                "devin" to "Devin", "claude" to "Claude",
                "codex" to "Codex", "opencode" to "OpenCode",
            )
            AlertDialog(
                onDismissRequest = { showCreate = false },
                title = { Text(S.newSession) },
                text = {
                    Column {
                        Text(S.roleLabel, style = MaterialTheme.typography.labelLarge)
                        var roleMenu by remember { mutableStateOf(false) }
                        Box {
                            OutlinedButton(
                                onClick = { roleMenu = true },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    vm.roles.find { it.id == selectedRoleId }?.name ?: S.noneRole,
                                    Modifier.weight(1f),
                                )
                                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                            }
                            DropdownMenu(expanded = roleMenu, onDismissRequest = { roleMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text(S.noneRole) },
                                    onClick = { selectedRoleId = null; roleMenu = false },
                                )
                                vm.roles.forEach { role ->
                                    DropdownMenuItem(
                                        text = {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(role.name, Modifier.weight(1f))
                                                if (!role.builtin) {
                                                    IconButton(onClick = {
                                                        deleteRoleTarget = role.id
                                                        roleMenu = false
                                                    }) {
                                                        Icon(
                                                            Icons.Filled.Delete,
                                                            contentDescription = S.delete,
                                                            modifier = Modifier.size(18.dp),
                                                            tint = MaterialTheme.colorScheme.error,
                                                        )
                                                    }
                                                }
                                            }
                                        },
                                        onClick = {
                                            selectedRoleId = role.id
                                            name = role.name
                                            role.cwd?.let { cwd = it }
                                            role.agent?.let { agentType = it }
                                            roleMenu = false
                                        },
                                    )
                                }
                                DropdownMenuItem(
                                    text = {
                                        Text(S.addRole, color = MaterialTheme.colorScheme.primary)
                                    },
                                    onClick = { showAddRole = true; roleMenu = false },
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(S.agentLabel, style = MaterialTheme.typography.labelLarge)
                        var agentMenu by remember { mutableStateOf(false) }
                        Box {
                            OutlinedButton(
                                onClick = { agentMenu = true },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    agentTypes.find { it.first == agentType }?.second ?: agentType,
                                    Modifier.weight(1f),
                                )
                                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                            }
                            DropdownMenu(expanded = agentMenu, onDismissRequest = { agentMenu = false }) {
                                agentTypes.forEach { (key, label) ->
                                    DropdownMenuItem(
                                        text = { Text(label) },
                                        onClick = { agentType = key; agentMenu = false },
                                    )
                                }
                            }
                        }
                        OutlinedTextField(
                            value = name,
                            onValueChange = { name = it },
                            label = { Text(S.nameLabel) },
                            singleLine = true,
                        )
                        Spacer(Modifier.height(8.dp))
                        Box {
                            var cwdMenu by remember { mutableStateOf(false) }
                            OutlinedTextField(
                                value = cwd,
                                onValueChange = { cwd = it },
                                label = { Text(S.cwdLabel) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                                trailingIcon = {
                                    if (vm.recentCwds.isNotEmpty()) {
                                        IconButton(onClick = { cwdMenu = true }) {
                                            Icon(Icons.Filled.FolderOpen, contentDescription = null)
                                        }
                                    }
                                },
                            )
                            DropdownMenu(
                                expanded = cwdMenu,
                                onDismissRequest = { cwdMenu = false },
                            ) {
                                vm.recentCwds.forEach { dir ->
                                    DropdownMenuItem(
                                        text = {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(
                                                    dir,
                                                    Modifier.weight(1f),
                                                    style = MaterialTheme.typography.bodySmall,
                                                )
                                                IconButton(onClick = { vm.removeCwd(dir) }) {
                                                    Icon(
                                                        Icons.Filled.Delete,
                                                        contentDescription = S.delete,
                                                        modifier = Modifier.size(16.dp),
                                                    )
                                                }
                                            }
                                        },
                                        onClick = { cwd = dir; cwdMenu = false },
                                    )
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            showCreate = false
                            vm.createSession(cwd.trim(), name.trim(), agentType, selectedRoleId)
                        },
                        enabled = cwd.isNotBlank(),
                    ) { Text(S.create) }
                },
                dismissButton = {
                    TextButton(onClick = { showCreate = false }) { Text(S.cancel) }
                },
            )

            if (showAddRole) {
                var roleName by remember { mutableStateOf("") }
                var persona by remember { mutableStateOf("") }
                var roleCwd by remember { mutableStateOf("") }
                AlertDialog(
                    onDismissRequest = { showAddRole = false },
                    title = { Text(S.addRole) },
                    text = {
                        Column {
                            OutlinedTextField(
                                value = roleName,
                                onValueChange = { roleName = it },
                                label = { Text(S.roleNameLabel) },
                                singleLine = true,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = persona,
                                onValueChange = { persona = it },
                                label = { Text(S.personaLabel) },
                                minLines = 3,
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = roleCwd,
                                onValueChange = { roleCwd = it },
                                label = { Text(S.defaultCwdLabel) },
                                singleLine = true,
                            )
                        }
                    },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                showAddRole = false
                                vm.createRole(roleName.trim(), persona.trim(), roleCwd.trim())
                            },
                            enabled = roleName.isNotBlank() && persona.isNotBlank(),
                        ) { Text(S.create) }
                    },
                    dismissButton = {
                        TextButton(onClick = { showAddRole = false }) { Text(S.cancel) }
                    },
                )
            }

            deleteRoleTarget?.let { roleId ->
                val role = vm.roles.find { it.id == roleId }
                AlertDialog(
                    onDismissRequest = { deleteRoleTarget = null },
                    title = { Text(S.deleteRoleTitle.format(role?.name ?: roleId)) },
                    confirmButton = {
                        TextButton(onClick = {
                            vm.deleteRole(roleId)
                            deleteRoleTarget = null
                        }) { Text(S.delete, color = MaterialTheme.colorScheme.error) }
                    },
                    dismissButton = {
                        TextButton(onClick = { deleteRoleTarget = null }) { Text(S.cancel) }
                    },
                )
            }
        }

        if (showCreateRoom) {
            var roomName by remember { mutableStateOf("") }
            var mode by remember { mutableStateOf("mention") }
            var conductorId by remember { mutableStateOf<String?>(null) }
            val selected = remember { mutableStateListOf<String>() }
            AlertDialog(
                onDismissRequest = { showCreateRoom = false },
                title = { Text(S.createRoom) },
                text = {
                    Column {
                        OutlinedTextField(
                            value = roomName,
                            onValueChange = { roomName = it },
                            label = { Text(S.roomName) },
                            singleLine = true,
                        )
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(S.modeLabel)
                            TextButton(onClick = { mode = "mention" }) {
                                Text(if (mode == "mention") "◉ ${S.modeMention}" else "○ ${S.modeMention}")
                            }
                            TextButton(onClick = { mode = "conductor" }) {
                                Text(if (mode == "conductor") "◉ ${S.modeConductor}" else "○ ${S.modeConductor}")
                            }
                        }
                        vm.sessions.filter { !it.archived }.forEach { s ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(
                                    checked = selected.contains(s.sessionId),
                                    onCheckedChange = {
                                        if (it) {
                                            selected.add(s.sessionId)
                                        } else {
                                            selected.remove(s.sessionId)
                                            if (conductorId == s.sessionId) conductorId = null
                                        }
                                    },
                                )
                                Text(s.name)
                                if (mode == "conductor" && selected.contains(s.sessionId)) {
                                    TextButton(onClick = { conductorId = s.sessionId }) {
                                        Text(
                                            if (conductorId == s.sessionId) "◉ ${S.conductorTag}"
                                            else "○ ${S.conductorTag}"
                                        )
                                    }
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            showCreateRoom = false
                            vm.createRoom(
                                roomName.trim().ifBlank { S.rooms },
                                selected.toList(),
                                mode,
                                conductorId,
                            )
                        },
                        enabled = selected.size >= 2 &&
                            (mode != "conductor" || conductorId != null),
                    ) { Text(S.create) }
                },
                dismissButton = {
                    TextButton(onClick = { showCreateRoom = false }) { Text(S.cancel) }
                },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionCard(
    s: SessionInfo,
    vm: ChatViewModel,
    S: Strings,
    onLongClick: (SessionInfo) -> Unit,
) {
    val pinned = vm.pinnedIds.contains(s.sessionId)
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .combinedClickable(
                onClick = { vm.openChat(s) },
                onLongClick = { onLongClick(s) },
            ),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (s.archived || s.offline)
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
            else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Circle,
                contentDescription = null,
                modifier = Modifier.size(10.dp),
                tint = when {
                    s.offline -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                    s.busy || vm.busyIds.contains(s.sessionId) -> MaterialTheme.colorScheme.tertiary
                    else -> MaterialTheme.colorScheme.primary
                },
            )
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (pinned) {
                        Icon(
                            Icons.Filled.PushPin,
                            contentDescription = null,
                            modifier = Modifier.size(12.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.size(4.dp))
                    }
                    Text(s.name, style = MaterialTheme.typography.titleSmall)
                    if (s.offline) {
                        Text(
                            "  ${S.offline}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else if (s.busy || vm.busyIds.contains(s.sessionId)) {
                        Text(
                            "  ${S.busyTag}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                }
                Text(
                    "${s.cwd} · ${s.agent}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (s.offline) {
                TextButton(onClick = { vm.resumeSession(s) }) { Text(S.resume) }
            }
        }
    }
}
