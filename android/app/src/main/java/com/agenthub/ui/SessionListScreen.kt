package com.agenthub.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.GroupAdd
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.widget.Toast
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import com.agenthub.ChatViewModel
import com.agenthub.SearchGroup
import com.agenthub.SearchHit
import com.agenthub.Screen
import com.agenthub.RoomGroupBy
import com.agenthub.RoomInfo
import com.agenthub.SessionGroupBy
import com.agenthub.SessionInfo
import com.agenthub.SessionStatus

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun SessionListScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current
    var showCreate by remember { mutableStateOf(false) }
    var showCreateRoom by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<SessionInfo?>(null) }
    var renameTarget by remember { mutableStateOf<SessionInfo?>(null) }
    var roomRenameTarget by remember { mutableStateOf<RoomInfo?>(null) }
    var roomCloneTarget by remember { mutableStateOf<RoomInfo?>(null) }
    var roomEditTarget by remember { mutableStateOf<RoomInfo?>(null) }
    var roomDeleteTarget by remember { mutableStateOf<RoomInfo?>(null) }
    var confirmBatchDelete by remember { mutableStateOf(false) }
    var inBatchMode by remember { mutableStateOf(false) }
    var selectedTab by remember { vm.listTab }
    val selectedSessionIds = remember { mutableStateListOf<String>() }
    val selectedRoomIds = remember { mutableStateListOf<String>() }
    var showFilter by remember { mutableStateOf(false) }
    var showSearchBox by remember { mutableStateOf(vm.searchQuery.isNotBlank()) }
    val searchFocusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        vm.refreshAll()
    }

    LaunchedEffect(vm.searchQuery) {
        if (vm.searchQuery.isNotBlank()) showSearchBox = true
    }

    val context = LocalContext.current

    LaunchedEffect(vm.connectError) {
        val msg = vm.connectError ?: return@LaunchedEffect
        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
        vm.connectError = null
    }

    LaunchedEffect(showSearchBox) {
        if (showSearchBox) searchFocusRequester.requestFocus()
    }

    BackHandler(enabled = inBatchMode || vm.selectedSearchGroup != null || showSearchBox) {
        if (inBatchMode) {
            inBatchMode = false
            selectedSessionIds.clear()
            selectedRoomIds.clear()
        } else if (vm.selectedSearchGroup != null) {
            vm.clearSearchScope()
        } else {
            showSearchBox = false
            vm.scheduleSearch("")
        }
    }

    val selectedCount = selectedSessionIds.size + selectedRoomIds.size
    val searchScopeName by remember(vm.selectedSearchGroup, vm.sessions.size, vm.rooms.size) {
        derivedStateOf {
            val group = vm.selectedSearchGroup
            if (group == null) ""
            else if (group.scope == "room") {
                vm.rooms.find { it.roomId == group.scopeId }?.name ?: group.scopeId
            } else {
                vm.sessions.find { it.sessionId == group.scopeId }?.name ?: group.scopeId
            }
        }
    }

    renameTarget?.let { s ->
        var name by remember(s) { mutableStateOf(s.name) }
        val nameTaken = name.isNotBlank() &&
            name.trim() != s.name &&
            vm.sessions.any { it.sessionId != s.sessionId && it.name == name.trim() }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("新名称") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(16.dp),
                    isError = nameTaken,
                    supportingText = {
                        if (nameTaken) Text(S.nameExists, color = MaterialTheme.colorScheme.error)
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.renameSession(s, name.trim())
                        renameTarget = null
                    },
                    enabled = name.isNotBlank() && !nameTaken,
                ) { Text(S.ok) }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text(S.cancel) }
            },
        )
    }

    val selectAll = {
        if (selectedSessionIds.size == vm.sessions.size && selectedRoomIds.size == vm.rooms.size) {
            selectedSessionIds.clear()
            selectedRoomIds.clear()
        } else {
            selectedSessionIds.clear()
            selectedRoomIds.clear()
            selectedSessionIds.addAll(vm.sessions.map { it.sessionId })
            selectedRoomIds.addAll(vm.rooms.map { it.roomId })
        }
        Unit
    }

    val invertSelection = {
        val allSessionIds = vm.sessions.map { it.sessionId }
        val allRoomIds = vm.rooms.map { it.roomId }
        val oldSession = selectedSessionIds.toSet()
        val oldRoom = selectedRoomIds.toSet()
        selectedSessionIds.clear()
        selectedRoomIds.clear()
        selectedSessionIds.addAll(allSessionIds.filterNot { oldSession.contains(it) })
        selectedRoomIds.addAll(allRoomIds.filterNot { oldRoom.contains(it) })
        Unit
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        when {
                            inBatchMode -> S.selectedCount.format(selectedCount)
                            vm.selectedSearchGroup != null -> searchScopeName
                            else -> S.appName
                        }
                    )
                },
                navigationIcon = {
                    if (inBatchMode) {
                        IconButton(onClick = {
                            inBatchMode = false
                            selectedSessionIds.clear()
                            selectedRoomIds.clear()
                        }) {
                            Icon(Icons.Filled.Close, contentDescription = S.cancel)
                        }
                    } else if (vm.selectedSearchGroup != null) {
                        IconButton(onClick = { vm.clearSearchScope() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                        }
                    } else {
                        IconButton(onClick = onMenuClick) {
                            Icon(Icons.Filled.Menu, contentDescription = "Menu")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = {
                        if (showSearchBox) {
                            vm.scheduleSearch("")
                        }
                        showSearchBox = !showSearchBox
                    }) {
                        Icon(
                            if (showSearchBox) Icons.Filled.Close else Icons.Filled.Search,
                            contentDescription = if (showSearchBox) S.cancel else S.searchHistory,
                        )
                    }
                    IconButton(onClick = { showFilter = true }) { Icon(Icons.Filled.FilterList, contentDescription = S.filter) }
                },
            )
        },
        bottomBar = {
            if (inBatchMode) {
                BottomAppBar(
                    actions = {
                        TextButton(onClick = selectAll) { Text(S.selectAll) }
                        TextButton(onClick = invertSelection) { Text(S.invertSelection) }
                    },
                    floatingActionButton = {
                        FloatingActionButton(
                            onClick = { if (selectedCount > 0) confirmBatchDelete = true },
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                            contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        ) {
                            Icon(Icons.Filled.Delete, contentDescription = S.delete)
                        }
                    },
                )
            } else {
                NavigationBar {
                    NavigationBarItem(
                        icon = { Icon(Icons.Filled.Chat, contentDescription = S.sessions) },
                        label = { Text(S.sessions) },
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                    )
                    NavigationBarItem(
                        icon = { Icon(Icons.Filled.Groups, contentDescription = S.rooms) },
                        label = { Text(S.rooms) },
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                    )
                    NavigationBarItem(
                        icon = { Icon(Icons.Filled.Settings, contentDescription = S.settings) },
                        label = { Text(S.settings) },
                        selected = false,
                        onClick = { vm.screen = Screen.Settings },
                    )
                }
            }
        },
        floatingActionButton = {
            if (!inBatchMode) {
                FloatingActionButton(
                    onClick = {
                        if (selectedTab == 0) showCreate = true else showCreateRoom = true
                    },
                ) {
                    Icon(Icons.Filled.Add, contentDescription = S.newSession)
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (showSearchBox) {
                OutlinedTextField(
                    value = vm.searchQuery,
                    onValueChange = { q -> vm.scheduleSearch(q) },
                    placeholder = { Text(S.searchHistory) },
                    leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                    trailingIcon = {
                        if (vm.searchQuery.isNotBlank()) {
                            IconButton(onClick = { vm.scheduleSearch("") }) {
                                Icon(Icons.Filled.Close, contentDescription = S.cancel)
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                        .focusRequester(searchFocusRequester),
                    shape = RoundedCornerShape(24.dp),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = {
                        if (vm.searchQuery.isNotBlank()) scope.launch { vm.search(vm.searchQuery) }
                    }),
                )
            }

            if (vm.searchQuery.isBlank()) {
                ActiveFilterChips(vm = vm, selectedTab = selectedTab)
            }

            val sessionGroups by remember(vm.sessions, vm.sessionListFilter, vm.pinnedIds, vm.busyIds) {
                derivedStateOf { vm.filteredSessionGroups() }
            }
            val roomGroups by remember(vm.rooms, vm.roomListFilter) {
                derivedStateOf { vm.filteredRoomGroups() }
            }
            val flatSessions by remember(sessionGroups) { derivedStateOf { sessionGroups.flatMap { it.sessions } } }
            val flatRooms by remember(roomGroups) { derivedStateOf { roomGroups.flatMap { it.rooms } } }

            if (vm.searchQuery.isNotBlank()) {
                LazyColumn(
                    Modifier.weight(1f).padding(horizontal = 12.dp),
                    contentPadding = PaddingValues(bottom = 88.dp),
                ) {
                    item {
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (vm.selectedSearchGroup != null) S.searchHistory else S.searchConversations,
                                Modifier.weight(1f),
                                style = MaterialTheme.typography.titleSmall,
                            )
                            IconButton(onClick = { vm.scheduleSearch("") }) {
                                Icon(Icons.Filled.Close, contentDescription = S.cancel)
                            }
                        }
                    }
                    if (vm.selectedSearchGroup == null) {
                        items(vm.searchGroups.size) { i ->
                            val group = vm.searchGroups[i]
                            SearchGroupCard(group, vm)
                        }
                        if (vm.searchGroups.isEmpty()) {
                            item {
                                Text(
                                    S.noResults,
                                    Modifier.padding(16.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    } else {
                        items(vm.searchResults.size) { i ->
                            val hit = vm.searchResults[i]
                            SearchHitCard(hit, vm.searchQuery, onClick = { vm.openSearchHit(hit) })
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
                }
            } else {
                LazyColumn(
                    Modifier.weight(1f).padding(horizontal = 12.dp),
                    contentPadding = PaddingValues(bottom = 88.dp),
                ) {
                if (inBatchMode && vm.currentProfile == null) {
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                            shape = RoundedCornerShape(16.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            ),
                        ) {
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                if (vm.connecting) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(32.dp),
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text("正在连接 Hub…", style = MaterialTheme.typography.bodyMedium)
                                } else {
                                    Text(
                                        "当前未连接到 Hub",
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        if (vm.profiles.isEmpty()) "还没有保存的 Hub，点击下方按钮添加"
                                        else "点击下方按钮选择或添加 Hub",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Button(onClick = onMenuClick) {
                                        Text("添加 / 选择 Hub")
                                    }
                                }
                            }
                        }
                    }
                }

                if (inBatchMode) {
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
                }
                if (selectedTab == 0 || inBatchMode) {
                    if (inBatchMode) {
                        items(flatSessions.size) { i ->
                            val s = flatSessions[i]
                            SessionCard(
                                s = s,
                                vm = vm,
                                S = S,
                                inBatchMode = inBatchMode,
                                selected = selectedSessionIds.contains(s.sessionId),
                                onClick = {
                                    if (inBatchMode) {
                                        if (selectedSessionIds.contains(s.sessionId)) selectedSessionIds.remove(s.sessionId)
                                        else selectedSessionIds.add(s.sessionId)
                                    } else {
                                        vm.openChat(s)
                                    }
                                },
                                onLongClick = {
                                    if (!inBatchMode) {
                                        inBatchMode = true
                                        selectedSessionIds.clear()
                                        selectedRoomIds.clear()
                                    }
                                    selectedSessionIds.add(s.sessionId)
                                },
                                onEdit = { renameTarget = s },
                                onClone = { vm.cloneSession(s) { renameTarget = it } },
                                onDelete = { confirmDelete = s },
                            )
                        }
                    } else {
                        for (group in sessionGroups) {
                            if (group.title.isNotBlank()) {
                                item {
                                    GroupHeader(
                                        title = if (vm.sessionListFilter.groupBy == SessionGroupBy.Cwd) {
                                            truncatePath(group.title)
                                        } else {
                                            group.title
                                        },
                                        count = group.sessions.size,
                                    )
                                }
                            }
                            items(group.sessions.size) { i ->
                                val s = group.sessions[i]
                                SessionCard(
                                    s = s,
                                    vm = vm,
                                    S = S,
                                    inBatchMode = inBatchMode,
                                    selected = selectedSessionIds.contains(s.sessionId),
                                    onClick = {
                                        if (inBatchMode) {
                                            if (selectedSessionIds.contains(s.sessionId)) selectedSessionIds.remove(s.sessionId)
                                            else selectedSessionIds.add(s.sessionId)
                                        } else {
                                            vm.openChat(s)
                                        }
                                    },
                                    onLongClick = {
                                        if (!inBatchMode) {
                                            inBatchMode = true
                                            selectedSessionIds.clear()
                                            selectedRoomIds.clear()
                                        }
                                        selectedSessionIds.add(s.sessionId)
                                    },
                                    onEdit = { renameTarget = s },
                                    onClone = { vm.cloneSession(s) { renameTarget = it } },
                                    onDelete = { confirmDelete = s },
                                )
                            }
                        }
                    }
                }
                if (inBatchMode) {
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
                }
                if (selectedTab == 1 || inBatchMode) {
                    if (inBatchMode) {
                        items(flatRooms.size) { i ->
                            val r = flatRooms[i]
                            RoomCard(
                                r = r,
                                vm = vm,
                                S = S,
                                inBatchMode = inBatchMode,
                                selected = selectedRoomIds.contains(r.roomId),
                                onClick = {
                                    if (inBatchMode) {
                                        if (selectedRoomIds.contains(r.roomId)) selectedRoomIds.remove(r.roomId)
                                        else selectedRoomIds.add(r.roomId)
                                    } else {
                                        vm.openRoom(r)
                                    }
                                },
                                onLongClick = {
                                    if (!inBatchMode) {
                                        inBatchMode = true
                                        selectedSessionIds.clear()
                                        selectedRoomIds.clear()
                                    }
                                    selectedRoomIds.add(r.roomId)
                                },
                                onRename = { roomRenameTarget = r },
                                onEdit = { roomEditTarget = r },
                                onClone = { roomCloneTarget = r },
                                onDelete = { roomDeleteTarget = r },
                            )
                        }
                    } else {
                        for (group in roomGroups) {
                            if (group.title.isNotBlank()) {
                                item {
                                    GroupHeader(
                                        title = modeName(group.title, S),
                                        count = group.rooms.size,
                                    )
                                }
                            }
                            items(group.rooms.size) { i ->
                                val r = group.rooms[i]
                                RoomCard(
                                    r = r,
                                    vm = vm,
                                    S = S,
                                    inBatchMode = inBatchMode,
                                    selected = selectedRoomIds.contains(r.roomId),
                                    onClick = {
                                        if (inBatchMode) {
                                            if (selectedRoomIds.contains(r.roomId)) selectedRoomIds.remove(r.roomId)
                                            else selectedRoomIds.add(r.roomId)
                                        } else {
                                            vm.openRoom(r)
                                        }
                                    },
                                    onLongClick = {
                                        if (!inBatchMode) {
                                            inBatchMode = true
                                            selectedSessionIds.clear()
                                            selectedRoomIds.clear()
                                        }
                                        selectedRoomIds.add(r.roomId)
                                    },
                                    onRename = { roomRenameTarget = r },
                                    onEdit = { roomEditTarget = r },
                                    onClone = { roomCloneTarget = r },
                                    onDelete = { roomDeleteTarget = r },
                                )
                            }
                        }
                    }
                }
            }
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
            val nameTaken = name.isNotBlank() &&
                vm.sessions.any { it.name == name.trim() }
            var selectedConnectionId by remember { mutableStateOf<String?>(null) }
            var selectedRoleId by remember { mutableStateOf<String?>(null) }
            var showAddRole by remember { mutableStateOf(false) }
            var deleteRoleTarget by remember { mutableStateOf<String?>(null) }
            var connectionMenu by remember { mutableStateOf(false) }
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
                                            role.connectionId?.let { selectedConnectionId = it }
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
                        Text(S.selectConnection, style = MaterialTheme.typography.labelLarge)
                        Box {
                            val selected = vm.connections.find { it.id == selectedConnectionId }
                            OutlinedButton(
                                onClick = { connectionMenu = true },
                                modifier = Modifier.fillMaxWidth(),
                                enabled = vm.connections.isNotEmpty(),
                            ) {
                                Text(
                                    selected?.let {
                                        val status = when {
                                            it.local -> S.localConnection
                                            it.online -> S.online
                                            else -> S.offline
                                        }
                                        "${it.name} · ${it.agent} · $status"
                                    } ?: S.noConnections,
                                    Modifier.weight(1f),
                                )
                                Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                            }
                            DropdownMenu(expanded = connectionMenu, onDismissRequest = { connectionMenu = false }) {
                                vm.connections.forEach { c ->
                                    val local = c.local
                                    val status = when {
                                        local -> S.localConnection
                                        c.online -> S.online
                                        else -> S.offline
                                    }
                                    val color = when {
                                        local -> MaterialTheme.colorScheme.tertiary
                                        c.online -> MaterialTheme.colorScheme.primary
                                        else -> MaterialTheme.colorScheme.error
                                    }
                                    DropdownMenuItem(
                                        text = {
                                            Text("${c.name} · ${c.agent} · $status", color = color)
                                        },
                                        onClick = { selectedConnectionId = c.id; connectionMenu = false },
                                        enabled = c.online || local,
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(S.addConnection, color = MaterialTheme.colorScheme.primary) },
                                    onClick = { showAddRole = false; vm.screen = Screen.Settings; showCreate = false; connectionMenu = false },
                                )
                            }
                        }
                        OutlinedTextField(
                            value = name,
                            onValueChange = { name = it },
                            label = { Text(S.nameLabel) },
                            singleLine = true,
                            isError = nameTaken,
                            supportingText = {
                                if (nameTaken) Text(S.nameExists, color = MaterialTheme.colorScheme.error)
                            },
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
                    val selectedConnection = vm.connections.find { it.id == selectedConnectionId }
                    TextButton(
                        onClick = {
                            showCreate = false
                            selectedConnectionId?.let {
                                vm.createSession(cwd.trim(), name.trim(), it, selectedRoleId)
                            }
                        },
                        enabled = !nameTaken && name.isNotBlank() && cwd.isNotBlank() && selectedConnectionId != null && (selectedConnection?.online == true || selectedConnection?.local == true),
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
                var roleConnectionId by remember { mutableStateOf<String?>(null) }
                var connectionMenu by remember { mutableStateOf(false) }
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
                            Spacer(Modifier.height(8.dp))
                            Text(S.selectConnection, style = MaterialTheme.typography.labelLarge)
                            Box {
                                val selected = vm.connections.find { it.id == roleConnectionId }
                                OutlinedButton(
                                    onClick = { connectionMenu = true },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = vm.connections.isNotEmpty(),
                                ) {
                                    Text(
                                        selected?.let {
                                            val origin = it.address.ifBlank { S.localConnection }
                                            "${it.name} · ${it.agent} · $origin"
                                        } ?: S.selectConnection,
                                        Modifier.weight(1f),
                                    )
                                    Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                                }
                                DropdownMenu(expanded = connectionMenu, onDismissRequest = { connectionMenu = false }) {
                                    vm.connections.forEach { c ->
                                        DropdownMenuItem(
                                            text = {
                                                val origin = c.address.ifBlank { S.localConnection }
                                                Text("${c.name} · ${c.agent} · $origin")
                                            },
                                            onClick = { roleConnectionId = c.id; connectionMenu = false },
                                        )
                                    }
                                }
                            }
                        }
                    },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                showAddRole = false
                                vm.createRole(roleName.trim(), persona.trim(), roleCwd.trim(), roleConnectionId)
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

        if (showCreateRoom || roomEditTarget != null) {
            RoomEditorDialog(
                room = roomEditTarget,
                vm = vm,
                S = S,
                onDismiss = { showCreateRoom = false; roomEditTarget = null },
            )
        }

        roomRenameTarget?.let { room ->
            var name by remember(room) { mutableStateOf(room.name) }
            val nameTaken = name.isNotBlank() &&
                name.trim() != room.name &&
                vm.rooms.any { it.roomId != room.roomId && it.name == name.trim() }
            AlertDialog(
                onDismissRequest = { roomRenameTarget = null },
                title = { Text(S.rename) },
                text = {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(S.roomName) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        isError = nameTaken,
                        supportingText = {
                            if (nameTaken) Text(S.nameExists, color = MaterialTheme.colorScheme.error)
                        },
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            vm.renameRoom(room, name.trim())
                            roomRenameTarget = null
                        },
                        enabled = name.isNotBlank() && !nameTaken,
                    ) { Text(S.ok) }
                },
                dismissButton = {
                    TextButton(onClick = { roomRenameTarget = null }) { Text(S.cancel) }
                },
            )
        }

        roomCloneTarget?.let { room ->
            var name by remember(room) { mutableStateOf(room.name + " " + S.clone) }
            val nameTaken = name.isNotBlank() &&
                vm.rooms.any { it.name == name.trim() }
            AlertDialog(
                onDismissRequest = { roomCloneTarget = null },
                title = { Text(S.clone) },
                text = {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(S.roomName) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        isError = nameTaken,
                        supportingText = {
                            if (nameTaken) Text(S.nameExists, color = MaterialTheme.colorScheme.error)
                        },
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            vm.cloneRoom(room, name.trim())
                            roomCloneTarget = null
                        },
                        enabled = name.isNotBlank() && !nameTaken,
                    ) { Text(S.ok) }
                },
                dismissButton = {
                    TextButton(onClick = { roomCloneTarget = null }) { Text(S.cancel) }
                },
            )
        }

        roomDeleteTarget?.let { room ->
            AlertDialog(
                onDismissRequest = { roomDeleteTarget = null },
                title = { Text(S.deleteRoomConfirmTitle.format(room.name)) },
                text = { Text(S.deleteRoomConfirmText) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            vm.deleteRoom(room)
                            roomDeleteTarget = null
                        },
                    ) { Text(S.delete, color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = {
                    TextButton(onClick = { roomDeleteTarget = null }) { Text(S.cancel) }
                },
            )
        }

        if (confirmBatchDelete) {
            AlertDialog(
                onDismissRequest = { confirmBatchDelete = false },
                title = { Text(S.batchDeleteTitle) },
                text = { Text(S.batchDeleteConfirm.format(selectedCount)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            vm.batchDelete(
                                selectedSessionIds.toList(),
                                selectedRoomIds.toList(),
                            )
                            selectedSessionIds.clear()
                            selectedRoomIds.clear()
                            confirmBatchDelete = false
                            inBatchMode = false
                        },
                    ) {
                        Text(S.delete, color = MaterialTheme.colorScheme.error)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { confirmBatchDelete = false }) { Text(S.cancel) }
                },
            )
        }

        if (showFilter) {
            FilterBottomSheet(vm, selectedTab) { showFilter = false }
        }
    }
}
}

private data class FilterChipData(val label: String, val onRemove: () -> Unit)

@Composable
private fun ActiveFilterChips(vm: ChatViewModel, selectedTab: Int) {
    val S = LocalStrings.current
    val filter = if (selectedTab == 0) vm.sessionListFilter else null
    val roomFilter = if (selectedTab == 1) vm.roomListFilter else null
    val chips = buildList {
        if (filter != null) {
            for (a in filter.agents) add(FilterChipData(a) { vm.sessionListFilter = filter.copy(agents = filter.agents - a) })
            for (c in filter.cwds) add(FilterChipData(truncatePath(c)) { vm.sessionListFilter = filter.copy(cwds = filter.cwds - c) })
            for (st in filter.statuses) add(FilterChipData(sessionStatusName(st, S)) { vm.sessionListFilter = filter.copy(statuses = filter.statuses - st) })
            if (filter.groupBy != SessionGroupBy.None) add(FilterChipData(groupName(filter.groupBy, S)) { vm.sessionListFilter = filter.copy(groupBy = SessionGroupBy.None) })
        } else if (roomFilter != null) {
            for (m in roomFilter.modes) add(FilterChipData(modeName(m, S)) { vm.roomListFilter = roomFilter.copy(modes = roomFilter.modes - m) })
            if (roomFilter.groupBy != RoomGroupBy.None) add(FilterChipData(roomGroupName(roomFilter.groupBy, S)) { vm.roomListFilter = roomFilter.copy(groupBy = RoomGroupBy.None) })
        }
    }
    if (chips.isEmpty()) return
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(chips.size) { i ->
            val c = chips[i]
            InputChip(
                selected = true,
                onClick = c.onRemove,
                label = { Text(c.label) },
                trailingIcon = { Icon(Icons.Filled.Close, contentDescription = S.cancel, modifier = Modifier.size(18.dp)) },
            )
        }
    }
}

@Composable
private fun GroupHeader(title: String, count: Int) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                Modifier.weight(1f),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "($count)",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    }
}

private fun sessionStatusName(status: SessionStatus, S: Strings): String = when (status) {
    SessionStatus.Online -> S.statusOnline
    SessionStatus.Offline -> S.statusOffline
    SessionStatus.Busy -> S.statusBusy
    SessionStatus.Pinned -> S.statusPinned
    SessionStatus.Archived -> S.statusArchived
}

private fun groupName(groupBy: SessionGroupBy, S: Strings): String = when (groupBy) {
    SessionGroupBy.None -> S.noGroup
    SessionGroupBy.Agent -> S.byAgent
    SessionGroupBy.Cwd -> S.byCwd
}

private fun roomGroupName(groupBy: RoomGroupBy, S: Strings): String = when (groupBy) {
    RoomGroupBy.None -> S.noGroup
    RoomGroupBy.Mode -> S.byMode
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomEditorDialog(
    room: RoomInfo?,
    vm: ChatViewModel,
    S: Strings,
    onDismiss: () -> Unit,
) {
    val editing = room
    val isCreate = editing == null
    var roomName by remember(room) { mutableStateOf(editing?.name ?: "") }
    val roomNameTaken = roomName.isNotBlank() &&
        vm.rooms.any { it.roomId != editing?.roomId && it.name == roomName.trim() }
    var mode by remember(room) { mutableStateOf(editing?.mode ?: "mention") }
    var modeManuallyChanged by remember(room) { mutableStateOf(false) }

    fun recommendMode(name: String): String? {
        val n = name.lowercase()
        return when {
            Regex("bug|fix|测试|test|review|审查|重构|refactor|实现|implement|添加功能|feature|任务|分工|拆解").containsMatchIn(n) -> "conductor"
            Regex("brainstorm|头脑风暴|想法|方案|收集|调研|优缺点|分析|集思广益|多观点").containsMatchIn(n) -> "parallel"
            Regex("辩论|debate|正反|利弊|争论|对比|vs|观点碰撞").containsMatchIn(n) -> "debate"
            Regex("流程|流水线|pipeline|步骤|step|顺序|sequence|链路|串联|串行").containsMatchIn(n) -> "pipeline"
            Regex("轮流|轮询|round|依次|每人|顺序发言").containsMatchIn(n) -> "roundrobin"
            Regex("闲聊|讨论|提问|@|广播|通知").containsMatchIn(n) -> "mention"
            else -> null
        }
    }

    val selected = remember(room) {
        mutableStateListOf<String>().apply {
            addAll(editing?.members?.map { it.first } ?: emptyList())
        }
    }

    fun initialPipelineOrder(): List<String> {
        val base = editing?.pipelineOrder ?: editing?.members?.map { it.first } ?: emptyList()
        return base.filter { selected.contains(it) }
    }

    var specialId by remember(room) { mutableStateOf<String?>(editing?.conductorId) }
    var parallelSummarizerId by remember(room) { mutableStateOf<String?>(editing?.parallelSummarizerId) }
    var debateJudge by remember(room) { mutableStateOf<String?>(editing?.debateJudge) }
    var debateSideA by remember(room) { mutableStateOf<String?>(editing?.debateSides?.first) }
    var debateSideB by remember(room) { mutableStateOf<String?>(editing?.debateSides?.second) }
    var debateRounds by remember(room) { mutableIntStateOf(editing?.debateRounds ?: 2) }
    var pipelineOrder by remember(room) { mutableStateOf(initialPipelineOrder()) }

    fun onModeChanged(newMode: String) {
        modeManuallyChanged = true
        mode = newMode
        specialId = null
        parallelSummarizerId = null
        debateJudge = null
        debateSideA = null
        debateSideB = null
        debateRounds = 2
        pipelineOrder = selected.toList()
    }

    fun onToggleSelected(id: String, checked: Boolean) {
        if (checked) {
            selected.add(id)
            if (!pipelineOrder.contains(id)) pipelineOrder = pipelineOrder + id
        } else {
            selected.remove(id)
            if (specialId == id) specialId = null
            if (parallelSummarizerId == id) parallelSummarizerId = null
            if (debateJudge == id) debateJudge = null
            if (debateSideA == id) debateSideA = null
            if (debateSideB == id) debateSideB = null
            pipelineOrder = pipelineOrder.filter { it != id }
        }
    }

    fun movePipeline(id: String, dir: Int) {
        val idx = pipelineOrder.indexOf(id)
        if (idx < 0) return
        val target = idx + dir
        if (target < 0 || target >= pipelineOrder.size) return
        val list = pipelineOrder.toMutableList()
        list[idx] = list[target]
        list[target] = id
        pipelineOrder = list
    }

    fun isValid(): Boolean {
        if (roomName.isBlank() || roomNameTaken || selected.size < (if (isCreate) 2 else 1)) return false
        return when (mode) {
            "conductor", "auto", "roundrobin" -> specialId != null
            "parallel" -> parallelSummarizerId != null
            "pipeline" -> pipelineOrder.isNotEmpty()
            "debate" -> debateSideA != null && debateSideB != null && debateJudge != null
            else -> true
        }
    }

    fun buildConfig(): ChatViewModel.RoomModeConfig = when (mode) {
        "conductor", "auto", "roundrobin" -> ChatViewModel.RoomModeConfig(conductorId = specialId)
        "parallel" -> ChatViewModel.RoomModeConfig(parallelSummarizerId = parallelSummarizerId)
        "pipeline" -> ChatViewModel.RoomModeConfig(pipelineOrder = pipelineOrder)
        "debate" -> ChatViewModel.RoomModeConfig(
            debateSides = if (debateSideA != null && debateSideB != null) debateSideA!! to debateSideB!! else null,
            debateJudge = debateJudge,
            debateRounds = debateRounds.coerceIn(1, 5),
        )
        else -> ChatViewModel.RoomModeConfig()
    }

    val modes = remember { listOf("mention", "conductor", "roundrobin", "parallel", "pipeline", "debate", "auto") }
    fun modeLabel(m: String) = when (m) {
        "mention" -> S.modeMention
        "conductor" -> S.modeConductor
        "roundrobin" -> S.modeRoundRobin
        "parallel" -> S.modeParallel
        "pipeline" -> S.modePipeline
        "debate" -> S.modeDebate
        "auto" -> S.modeAuto
        else -> m
    }
    fun modeDescription(m: String) = when (m) {
        "mention" -> "成员自由发言，@某个成员时该成员单独回答。适合闲聊、快速提问。"
        "conductor" -> "指挥家自动拆解任务，派发给不同成员并行执行，最后汇总结果。适合复杂任务。"
        "roundrobin" -> "每个问题按顺序由一个成员回答，可设置起始发言人。适合多角色依次表态。"
        "parallel" -> "所有成员同时回答同一个问题，最后由汇总者综合出一致结论。适合头脑风暴。"
        "pipeline" -> "成员按指定顺序串行处理，后一个成员基于前一个的结果继续。适合多步骤流程。"
        "debate" -> "正方与反方交替辩论若干轮，最后由裁判给出公正总结。适合观点碰撞。"
        "auto" -> "主持人根据任务内容自动选择最合适的协作模式。不确定选哪个时可用。"
        else -> ""
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isCreate) S.createRoom else S.editRoom) },
        text = {
            Column {
                OutlinedTextField(
                    value = roomName,
                    onValueChange = {
                        roomName = it
                        if (!modeManuallyChanged) {
                            recommendMode(it)?.let { recommended ->
                                if (recommended != mode) onModeChanged(recommended)
                            }
                        }
                    },
                    label = { Text(S.roomName) },
                    singleLine = true,
                    isError = roomNameTaken,
                    supportingText = {
                        if (roomNameTaken) Text(S.nameExists, color = MaterialTheme.colorScheme.error)
                    },
                )
                Spacer(Modifier.height(8.dp))

                var expanded by remember { mutableStateOf(false) }
                Box {
                    TextButton(onClick = { expanded = true }) {
                        Text("${S.modeLabel} ${modeLabel(mode)}")
                    }
                    DropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                    ) {
                        modes.forEach { m ->
                            DropdownMenuItem(
                                text = { Column {
                                    Text(modeLabel(m))
                                    Text(
                                        modeDescription(m),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                } },
                                onClick = {
                                    onModeChanged(m)
                                    expanded = false
                                },
                            )
                        }
                    }
                }

                Text(
                    modeDescription(mode),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )

                val sessions = remember(vm.sessions) { vm.sessions.filter { !it.archived } }
                LazyColumn(
                    Modifier
                        .heightIn(max = 320.dp)
                        .fillMaxWidth(),
                ) {
                    items(sessions.size) { i ->
                        val s = sessions[i]
                        val isSelected = selected.contains(s.sessionId)
                        val inPipeline = pipelineOrder.indexOf(s.sessionId).takeIf { it >= 0 }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Checkbox(
                                checked = isSelected,
                                onCheckedChange = { onToggleSelected(s.sessionId, it) },
                            )
                            Text(vm.displayName(s), modifier = Modifier.weight(1f))

                            if (isSelected) {
                                when (mode) {
                                    "conductor", "auto", "roundrobin" -> {
                                        TextButton(onClick = { specialId = s.sessionId }) {
                                            Text(
                                                if (specialId == s.sessionId) "◉ ${S.conductorTag}"
                                                else "○ ${S.conductorTag}"
                                            )
                                        }
                                    }
                                    "parallel" -> {
                                        TextButton(onClick = { parallelSummarizerId = s.sessionId }) {
                                            Text(
                                                if (parallelSummarizerId == s.sessionId) "◉ ${S.summarizerTag}"
                                                else "○ ${S.summarizerTag}"
                                            )
                                        }
                                    }
                                    "debate" -> {
                                        TextButton(onClick = { debateJudge = s.sessionId }) {
                                            Text(
                                                if (debateJudge == s.sessionId) "◉ ${S.judgeTag}"
                                                else "○ ${S.judgeTag}"
                                            )
                                        }
                                        TextButton(onClick = { debateSideA = s.sessionId }) {
                                            Text(
                                                if (debateSideA == s.sessionId) "◉ ${S.sideProTag}"
                                                else "○ ${S.sideProTag}"
                                            )
                                        }
                                        TextButton(onClick = { debateSideB = s.sessionId }) {
                                            Text(
                                                if (debateSideB == s.sessionId) "◉ ${S.sideConTag}"
                                                else "○ ${S.sideConTag}"
                                            )
                                        }
                                    }
                                    "pipeline" -> {
                                        if (inPipeline != null) {
                                            Text("${inPipeline + 1}", modifier = Modifier.padding(horizontal = 8.dp))
                                            IconButton(
                                                onClick = { movePipeline(s.sessionId, -1) },
                                                enabled = inPipeline > 0,
                                            ) {
                                                Text("↑")
                                            }
                                            IconButton(
                                                onClick = { movePipeline(s.sessionId, 1) },
                                                enabled = inPipeline < pipelineOrder.size - 1,
                                            ) {
                                                Text("↓")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if (mode == "debate") {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${S.modeDebate} 轮数：")
                        IconButton(onClick = { if (debateRounds > 1) debateRounds-- }) {
                            Text("−")
                        }
                        Text(debateRounds.toString(), modifier = Modifier.padding(horizontal = 8.dp))
                        IconButton(onClick = { if (debateRounds < 5) debateRounds++ }) {
                            Text("+")
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    if (isCreate) {
                        vm.createRoom(
                            roomName.trim().ifBlank { S.rooms },
                            selected.toList(),
                            mode,
                            buildConfig(),
                        )
                    } else {
                        vm.updateRoom(
                            editing,
                            roomName.trim().ifBlank { editing.name },
                            selected.toList(),
                            mode,
                            buildConfig(),
                        )
                    }
                },
                enabled = isValid(),
            ) { Text(if (isCreate) S.create else S.ok) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(S.cancel) }
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionCard(
    s: SessionInfo,
    vm: ChatViewModel,
    S: Strings,
    inBatchMode: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onEdit: () -> Unit,
    onClone: () -> Unit,
    onDelete: () -> Unit,
) {
    val pinned = vm.pinnedIds.contains(s.sessionId)
    var showMenu by remember { mutableStateOf(false) }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
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
            if (inBatchMode) {
                Checkbox(checked = selected, onCheckedChange = null)
                Spacer(Modifier.size(12.dp))
            } else {
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
            }
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
                    if (!inBatchMode && s.offline) {
                        Text(
                            "  ${S.offline}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else if (!inBatchMode && (s.busy || vm.busyIds.contains(s.sessionId))) {
                        Text(
                            "  ${S.busyTag}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.tertiary,
                        )
                    }
                }
                Text(
                    buildString {
                        append(s.cwd)
                        append(" · ")
                        append(s.agent)
                        val origin = vm.sessionOrigin(s)
                        if (origin.isNotBlank()) {
                            append(" · ")
                            append(origin)
                        }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!inBatchMode) {
                if (s.offline) {
                    TextButton(onClick = { vm.resumeSession(s) }) { Text(S.resume) }
                }
                Box {
                    IconButton(onClick = { showMenu = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = S.chooseAction)
                    }
                    DropdownMenu(
                        expanded = showMenu,
                        onDismissRequest = { showMenu = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text(if (pinned) S.unpin else S.pin) },
                            onClick = {
                                vm.togglePin(s.sessionId)
                                showMenu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(if (s.archived) S.unarchive else S.archive) },
                            onClick = {
                                vm.archiveSession(s, !s.archived)
                                showMenu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(S.rename) },
                            onClick = {
                                onEdit()
                                showMenu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(S.clone) },
                            onClick = {
                                onClone()
                                showMenu = false
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(S.delete) },
                            onClick = {
                                onDelete()
                                showMenu = false
                            },
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RoomCard(
    r: RoomInfo,
    vm: ChatViewModel,
    S: Strings,
    inBatchMode: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onRename: () -> Unit,
    onEdit: () -> Unit,
    onClone: () -> Unit,
    onDelete: () -> Unit,
) {
    val showMenu = remember { mutableStateOf(false) }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            ),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (inBatchMode) {
                Checkbox(checked = selected, onCheckedChange = null)
                Spacer(Modifier.size(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(r.name, style = MaterialTheme.typography.titleSmall)
                    val modeLabel = when (r.mode) {
                        "mention" -> S.modeMention
                        "conductor" -> S.modeConductor
                        "roundrobin" -> S.modeRoundRobin
                        "parallel" -> S.modeParallel
                        "pipeline" -> S.modePipeline
                        "debate" -> S.modeDebate
                        "auto" -> S.modeAuto
                        else -> r.mode
                    }
                    Text(
                        "  · $modeLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                Text(
                    r.members.joinToString("、") { it.second },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!inBatchMode) {
                Box {
                    IconButton(onClick = { showMenu.value = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = S.chooseAction)
                    }
                    DropdownMenu(
                        expanded = showMenu.value,
                        onDismissRequest = { showMenu.value = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text(S.rename) },
                            onClick = { onRename(); showMenu.value = false },
                        )
                        DropdownMenuItem(
                            text = { Text(S.edit) },
                            onClick = { onEdit(); showMenu.value = false },
                        )
                        DropdownMenuItem(
                            text = { Text(S.clone) },
                            onClick = { onClone(); showMenu.value = false },
                        )
                        DropdownMenuItem(
                            text = { Text(S.delete) },
                            onClick = { onDelete(); showMenu.value = false },
                        )
                    }
                }
            }
        }
    }
}

private fun formatAt(at: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(at))

private fun searchExcerpt(
    text: String,
    query: String,
    before: Int = 12,
    after: Int = 24,
): String {
    val singleLine = text.replace(Regex("\\s+"), " ").trim()
    if (query.isBlank() || singleLine.isBlank()) {
        return singleLine.take(before + query.length + after)
    }
    val q = query.trim().lowercase()
    val t = singleLine.lowercase()
    val idx = t.indexOf(q)
    if (idx == -1) return singleLine.take(before + query.length + after)
    val start = (idx - before).coerceAtLeast(0)
    val end = (idx + q.length + after).coerceAtMost(singleLine.length)
    val prefix = if (start > 0) "…" else ""
    val suffix = if (end < singleLine.length) "…" else ""
    return "$prefix${singleLine.substring(start, end)}$suffix"
}

@Composable
private fun SearchGroupCard(group: SearchGroup, vm: ChatViewModel) {
    val name by remember(group, vm.sessions.size, vm.rooms.size) {
        derivedStateOf {
            if (group.scope == "room") {
                vm.rooms.find { it.roomId == group.scopeId }?.name ?: group.scopeId
            } else {
                vm.sessions.find { it.sessionId == group.scopeId }?.name ?: group.scopeId
            }
        }
    }
    val preview = group.previews.firstOrNull()
    Card(
        onClick = { vm.openSearchGroup(group) },
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        ),
    ) {
        Row(
            Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (preview != null) {
                    Spacer(Modifier.height(2.dp))
                    val q = vm.searchQuery.trim()
                    val excerpt = remember(preview, q) {
                        searchExcerpt(preview.text, q)
                    }
                    HighlightText(
                        text = excerpt,
                        highlight = q,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                "共 ${group.count} 条",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun SearchHitCard(hit: SearchHit, query: String, onClick: () -> Unit) {
    val q = query.trim()
    val excerpt = remember(hit, q) { searchExcerpt(hit.text, q) }
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        ),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                formatAt(hit.at),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(2.dp))
            HighlightText(
                text = excerpt,
                highlight = q,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
