package com.agenthub.ui

import android.graphics.BitmapFactory
import android.util.Base64
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import java.text.SimpleDateFormat

import android.content.ClipData
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import com.agenthub.ui.MarkdownText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import com.agenthub.ArtifactInfo
import com.agenthub.BlackboardEntry
import com.agenthub.EventInfo
import com.agenthub.Attachment
import com.agenthub.ChatItem
import com.agenthub.ChatViewModel
import com.agenthub.DownloadRequest
import com.agenthub.FileTreeNode
import com.agenthub.FileTreeRoot
import com.agenthub.Screen
import com.agenthub.ContextUsage
import com.agenthub.FlowArtifact
import com.agenthub.FlowInfo
import com.agenthub.FlowTask
import com.agenthub.TokenUsage

private fun formatNumber(n: Long): String = when {
    n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format("%.1fk", n / 1_000.0)
    else -> n.toString()
}

private data class FileRefItem(val name: String, val path: String, val isDir: Boolean)

internal fun formatArtifactTime(at: Long): String {
    val instant = Instant.ofEpochMilli(at)
    val zone = ZoneId.systemDefault()
    val date = instant.atZone(zone).toLocalDate()
    val now = LocalDate.now(zone)
    val pattern = if (date == now) "HH:mm" else "M/d HH:mm"
    val formatter = SimpleDateFormat(pattern, Locale.getDefault())
    formatter.timeZone = java.util.TimeZone.getTimeZone(zone)
    return formatter.format(java.util.Date.from(instant))
}

private fun TokenUsage.format(): String = buildString {
    append("输入 ${formatNumber(inputTokens)} · 输出 ${formatNumber(outputTokens)}")
    if (cachedReadTokens != null && cachedReadTokens > 0) append(" · 缓存 ${formatNumber(cachedReadTokens)}")
    if (cachedWriteTokens != null && cachedWriteTokens > 0) append(" · 写缓存 ${formatNumber(cachedWriteTokens)}")
    if (thoughtTokens != null && thoughtTokens > 0) append(" · 思考 ${formatNumber(thoughtTokens)}")
    append(" · 总计 ${formatNumber(totalTokens)}")
}

private fun ContextUsage.format(): String = buildString {
    append("上下文 ${formatNumber(used)} / ${formatNumber(size)}")
    if (costAmount != null && costCurrency != null) {
        append(" · ${costCurrency} ${String.format("%.4f", costAmount)}")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current
    var input by remember { mutableStateOf("") }
    val sessionKey = vm.currentRoom?.roomId ?: vm.currentSession?.sessionId ?: ""
    val listState = remember(sessionKey) { LazyListState(0, 0) }
    val activeSessionId = vm.currentRoom?.activeSpeaker ?: vm.currentSession?.sessionId
    val contextUsage by remember { derivedStateOf { activeSessionId?.let { vm.sessionUsage[it] } } }
    val isAtBottom by produceState(false, listState, vm.chatItems.size) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                value = index == 0 && offset <= 20
            }
    }
    val scope = rememberCoroutineScope()
    val messages by remember { derivedStateOf { vm.chatItems.asReversed() } }
    val isAtTop by remember { derivedStateOf { messages.isNotEmpty() && listState.firstVisibleItemIndex >= messages.lastIndex - 2 } }

    var activeDownload by remember { mutableStateOf<DownloadRequest?>(null) }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val request = activeDownload
        if (uri != null && request != null) {
            vm.saveDownloadToUri(uri, request)
        }
        activeDownload = null
    }
    LaunchedEffect(vm.pendingDownload) {
        val request = vm.pendingDownload ?: return@LaunchedEffect
        vm.pendingDownload = null
        activeDownload = request
        saveLauncher.launch(request.name)
    }

    LaunchedEffect(vm.fileRefToInsert) {
        val ref = vm.fileRefToInsert ?: return@LaunchedEffect
        input = if (input.isBlank()) "#$ref" else "$input #$ref"
        vm.fileRefToInsert = null
    }

    LaunchedEffect(isAtTop, vm.historyHasMore, vm.historyLoading) {
        if (isAtTop && vm.historyHasMore && !vm.historyLoading) {
            vm.loadMoreHistory()
        }
    }
    val matchPositions by remember(vm.chatItems, vm.inChatSearchQuery) {
        derivedStateOf {
            val q = vm.inChatSearchQuery
            if (q.isBlank()) emptyList()
            else messages.mapIndexedNotNull { i, item ->
                if (item.text.contains(q, ignoreCase = true)) i else null
            }
        }
    }
    val keywordChannel = remember { Channel<Float>(Channel.CONFLATED) }
    val onMatchKeywordY = remember(keywordChannel) {
        { y: Float -> keywordChannel.trySend(y); Unit }
    }
    var listBounds by remember { mutableStateOf<Rect?>(null) }
    val isRoom = vm.currentRoom != null
    val title = vm.currentRoom?.name ?: vm.currentSession?.name ?: S.chat
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { vm.addAttachment(it) }
    }

    LaunchedEffect(matchPositions) {
        vm.chatSearchMatchCount = matchPositions.size
        if (vm.chatSearchMatchIndex == -1 && matchPositions.isNotEmpty()) {
            vm.chatSearchMatchIndex = 0
        }
    }

    LaunchedEffect(vm.jumpToHistoryId, matchPositions) {
        val targetId = vm.jumpToHistoryId ?: return@LaunchedEffect
        val targetIndex = messages.indexOfFirst { it.id == -targetId }
        if (targetIndex >= 0) {
            val pos = matchPositions.indexOf(targetIndex).takeIf { it >= 0 } ?: 0
            vm.chatSearchMatchIndex = if (matchPositions.isNotEmpty()) pos else -1
            vm.jumpToHistoryId = null
        }
    }

    LaunchedEffect(vm.chatSearchMatchIndex, matchPositions) {
        val idx = vm.chatSearchMatchIndex
        if (idx in matchPositions.indices) {
            // drain stale measurements from previous matches / scrolls
            while (keywordChannel.tryReceive().isSuccess) { }
            listState.animateScrollToItem(matchPositions[idx], 0)
            val bounds = listBounds ?: return@LaunchedEffect
            val topTarget = bounds.top + 160f
            val bottomTarget = bounds.bottom - 160f
            val maxStep = bounds.height
            var step = 0
            var settled = false
            keywordChannel
                .receiveAsFlow()
                .filterNotNull()
                .collect { y ->
                    if (settled) return@collect
                    val delta = when {
                        y < topTarget -> topTarget - y
                        y > bottomTarget -> bottomTarget - y
                        else -> 0f
                    }
                    if (kotlin.math.abs(delta) < 2f || step >= 30) {
                        settled = true
                        return@collect
                    }
                    val stepDelta = delta.coerceIn(-maxStep, maxStep)
                    var consumed = 0f
                    listState.scroll { consumed = scrollBy(stepDelta) }
                    if (kotlin.math.abs(consumed) < kotlin.math.abs(stepDelta) * 0.5f) {
                        settled = true
                    }
                    step++
                }
        }
    }

    LaunchedEffect(vm.currentRoom?.roomId, vm.currentSession?.sessionId) {
        vm.refreshBusy()
    }

    BackHandler {
        vm.backToList()
    }

    ModelPickerDialog(vm)

    Scaffold(
        contentWindowInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title)
                        if (isRoom) {
                            val room = vm.currentRoom!!
                            val modeLabel = when (room.mode) {
                                "mention" -> S.modeMention
                                "conductor" -> S.modeConductor
                                "roundrobin" -> S.modeRoundRobin
                                "parallel" -> S.modeParallel
                                "pipeline" -> S.modePipeline
                                "debate" -> S.modeDebate
                                "auto" -> S.modeAuto
                                else -> room.mode
                            }
                            Text(
                                "${modeLabel}${room.subMode?.let { " · $it" } ?: ""} | ${room.members.joinToString("  ") { "@${it.second}" }}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (contextUsage != null) {
                            Text(
                                contextUsage!!.format(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.outline,
                            )
                        }
                        if (vm.modelCurrent.isNotBlank()) {
                            val modelLabel = if (isRoom) {
                                val count = vm.currentRoom?.members?.size ?: 0
                                "成员模型 · ${count}人"
                            } else {
                                vm.modelCurrent
                            }
                            Text(
                                modelLabel,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.outline,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onMenuClick) {
                        Icon(Icons.Filled.Menu, contentDescription = "Menu")
                    }
                },
                actions = {
                    if (vm.inChatSearchQuery.isNotBlank()) {
                        Text(
                            if (vm.chatSearchMatchCount > 0) "${vm.chatSearchMatchIndex + 1} / ${vm.chatSearchMatchCount}" else "0",
                            modifier = Modifier.padding(horizontal = 8.dp),
                            style = MaterialTheme.typography.labelMedium,
                        )
                        IconButton(onClick = { vm.nextChatSearchMatch() }) {
                            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = S.previous)
                        }
                        IconButton(onClick = { vm.prevChatSearchMatch() }) {
                            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = S.next)
                        }
                        IconButton(onClick = {
                            vm.inChatSearchQuery = ""
                            vm.jumpToHistoryId = null
                            vm.chatSearchMatchIndex = -1
                            vm.chatSearchMatchCount = 0
                        }) {
                            Icon(Icons.Filled.Close, contentDescription = S.cancel)
                        }
                    }
                    if (isRoom || vm.currentSession != null) {
                        IconButton(onClick = { vm.screen = Screen.FileTree }) {
                            Text("文件", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    IconButton(onClick = { vm.backToList() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                },
            )
        },
    ) { padding ->
        Box(
            Modifier
                .padding(padding)
                .fillMaxSize(),
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(
                        WindowInsets.ime.exclude(WindowInsets.navigationBars),
                    ),
            ) {
                if (isRoom || vm.currentSession != null) {
                    var expandedTop by remember(sessionKey) { mutableStateOf<String?>(null) }
                    ChatTopCapsules(vm, expandedTop, showRoomExtras = isRoom) { expandedTop = it }
                    when (expandedTop) {
                        "flow" -> if (isRoom) FlowPanel(vm.flow, vm.currentRoom!!.mode)
                        "blackboard" -> if (isRoom) BlackboardPanel(vm)
                        "artifact" -> ArtifactPanel(vm.currentArtifacts, vm)
                        "event" -> EventPanel(vm.currentEvents, vm)
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    reverseLayout = true,
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 12.dp)
                        .onGloballyPositioned { coordinates ->
                            val top = coordinates.positionInWindow().y
                            listBounds = Rect(0f, top, 0f, top + coordinates.size.height)
                        },
                ) {
                    itemsIndexed(
                        messages,
                        key = { _, item -> item.id },
                    ) { index, item ->
                        val nextAuthor = messages.getOrNull(index + 1)?.author
                        val currentMatchIndex = matchPositions.getOrNull(vm.chatSearchMatchIndex)
                        val isQuoted = vm.quote?.let { (author, text) ->
                            author == item.author && item.text.startsWith(text)
                        } ?: false
                        ChatBubble(
                            item,
                            vm,
                            showAuthor = isRoom && nextAuthor != item.author,
                            highlight = vm.inChatSearchQuery,
                            isCurrentMatch = currentMatchIndex == index,
                            isQuoted = isQuoted,
                            onMatchKeywordY = if (currentMatchIndex == index) onMatchKeywordY else null,
                        )
                    }
                    if (vm.historyLoading) {
                        item {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    "加载更多历史…",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
                if (!isAtBottom && vm.chatItems.isNotEmpty()) {
                    FilledIconButton(
                        onClick = {
                            scope.launch { listState.scrollToLast() }
                        },
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 12.dp)
                            .size(40.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                            contentColor = MaterialTheme.colorScheme.onSurface,
                        ),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.KeyboardArrowDown,
                            contentDescription = "跳转到最下方",
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
            }
            vm.quote?.let { (author, text) ->
                Card(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                    ),
                ) {
                    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.FormatQuote,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.size(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                "${S.quoting} @$author",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                text.take(100),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                            )
                        }
                        IconButton(onClick = { vm.quote = null }) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }
            }
            val mentionQuery: String? = run {
                if (!isRoom) return@run null
                val at = input.lastIndexOf('@')
                if (at < 0) return@run null
                val q = input.substring(at + 1)
                if (q.contains(' ') || q.contains('\n')) null else q
            }
            val fileRefQuery: String? = run {
                if (vm.currentRoom == null && vm.currentSession == null) return@run null
                val hash = input.lastIndexOf('#')
                if (hash < 0) return@run null
                val q = input.substring(hash + 1)
                if (q.contains(' ') || q.contains('\n')) null else q
            }
            if (vm.pendingAttachments.isNotEmpty()) {
                AttachmentPreviews(
                    attachments = vm.pendingAttachments,
                    onRemove = { vm.removeAttachment(it) },
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
            Row(
                Modifier
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .fillMaxWidth()
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        RoundedCornerShape(24.dp),
                    )
                    .padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                var cmdMenu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { cmdMenu = true }) {
                        Icon(
                            Icons.Filled.Bolt,
                            contentDescription = S.quickCommands,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                    DropdownMenu(expanded = cmdMenu, onDismissRequest = { cmdMenu = false }) {
                        vm.defaultCommands.forEach { cmd ->
                            DropdownMenuItem(
                                text = { Text(cmd) },
                                onClick = { input = cmd; cmdMenu = false },
                            )
                        }
                        vm.customCommands.forEach { cmd ->
                            DropdownMenuItem(
                                text = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(cmd, Modifier.weight(1f), maxLines = 1)
                                        IconButton(onClick = { vm.removeCommand(cmd) }) {
                                            Icon(
                                                Icons.Filled.Delete,
                                                contentDescription = null,
                                                modifier = Modifier.size(16.dp),
                                            )
                                        }
                                    }
                                },
                                onClick = { input = cmd; cmdMenu = false },
                            )
                        }
                        DropdownMenuItem(
                            text = {
                                Text(
                                    "＋ ${S.saveCommand}",
                                    color = if (input.isBlank())
                                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                                    else MaterialTheme.colorScheme.primary,
                                )
                            },
                            onClick = {
                                if (input.isNotBlank()) {
                                    vm.addCommand(input.trim())
                                    cmdMenu = false
                                }
                            },
                        )
                    }
                }
                Box(Modifier.weight(1f)) {
                    LaunchedEffect(fileRefQuery) {
                        if (fileRefQuery == null || vm.fileTreeLoading) return@LaunchedEffect
                        if (fileRefQuery.endsWith("/")) {
                            val dir = fileRefQuery.removeSuffix("/")
                            if (dir.isNotBlank() && vm.fileTreePath != dir) {
                                vm.refreshFileTree(dir)
                            }
                        } else if (vm.fileTreeRoots.isEmpty() && vm.fileTreePath == null) {
                            vm.refreshFileTree(null)
                        }
                    }
                    BasicTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        maxLines = 4,
                        minLines = 1,
                        decorationBox = { innerTextField ->
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 8.dp, vertical = 12.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                if (input.isEmpty()) {
                                    Text(
                                        if (isRoom) S.inputRoom else S.inputSingle,
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                innerTextField()
                            }
                        },
                    )
                    if (mentionQuery != null) {
                        val memberMatches = vm.currentRoom!!.members.filter {
                            it.second.startsWith(mentionQuery, ignoreCase = true)
                        }
                        val artifactMatches = if (memberMatches.isNotEmpty()) emptyList() else vm.currentArtifacts.filter {
                            it.id.startsWith(mentionQuery, ignoreCase = true) ||
                                    (!it.alias.isNullOrBlank() && it.alias.startsWith(mentionQuery, ignoreCase = true)) ||
                                    (!it.path.isNullOrBlank() && it.path.contains(mentionQuery, ignoreCase = true)) ||
                                    it.summary.contains(mentionQuery, ignoreCase = true)
                        }
                        val matches = memberMatches.isNotEmpty()
                        DropdownMenu(
                            expanded = memberMatches.isNotEmpty() || artifactMatches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            if (matches) {
                                memberMatches.forEach { (sid, name) ->
                                    val display = vm.sessionName(sid)
                                    DropdownMenuItem(
                                        text = { Text("@$display") },
                                        onClick = {
                                            val at = input.lastIndexOf('@')
                                            input = input.substring(0, at) + "@$name "
                                        },
                                    )
                                }
                            } else {
                                artifactMatches.forEach { artifact ->
                                    val label = "${artifact.path?.let { "$it · " } ?: ""}${artifact.summary.take(60)} · @${vm.sessionName(artifact.author)}"
                                    DropdownMenuItem(
                                        text = { Text(label) },
                                        onClick = {
                                            val at = input.lastIndexOf('@')
                                            input = input.substring(0, at) + "@${artifact.alias ?: artifact.id} "
                                        },
                                    )
                                }
                            }
                        }
                    }
                    val slashQuery: String? = run {
                        if (!input.startsWith("/")) return@run null
                        if (input.contains(' ') || input.contains('\n')) return@run null
                        input.substring(1)
                    }
                    if (slashQuery != null) {
                        val allMatches = vm.slashCommands.filter {
                            it.name.startsWith(slashQuery, ignoreCase = true)
                        }
                        val skillNames = vm.skills.map { it.name }.toSet()
                        val localMatches = allMatches.filter { it.name !in skillNames }
                        val skillMatches = allMatches.filter { it.name in skillNames }
                        DropdownMenu(
                            expanded = allMatches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            Column(
                                modifier = Modifier
                                    .heightIn(max = 320.dp)
                                    .verticalScroll(rememberScrollState()),
                            ) {
                                if (localMatches.isNotEmpty()) {
                                    Text(
                                        "命令",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                                    )
                                    localMatches.forEach { cmd ->
                                        DropdownMenuItem(
                                            text = {
                                                Row(verticalAlignment = Alignment.CenterVertically) {
                                                    Text(
                                                        "/${cmd.name}",
                                                        style = MaterialTheme.typography.bodyMedium,
                                                        fontWeight = FontWeight.Bold,
                                                    )
                                                    Spacer(Modifier.width(6.dp))
                                                    Text(
                                                        cmd.description,
                                                        style = MaterialTheme.typography.bodySmall,
                                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                        maxLines = 1,
                                                        overflow = TextOverflow.Ellipsis,
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                }
                                            },
                                            onClick = { input = "/${cmd.name} " },
                                        )
                                    }
                                }
                                if (skillMatches.isNotEmpty()) {
                                    HorizontalDivider(modifier = Modifier.padding(vertical = 2.dp))
                                    Text(
                                        "Skill",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                                    )
                                    skillMatches.forEach { cmd ->
                                        DropdownMenuItem(
                                            text = {
                                                Row(verticalAlignment = Alignment.CenterVertically) {
                                                    Text(
                                                        "/${cmd.name}",
                                                        style = MaterialTheme.typography.bodyMedium,
                                                        fontWeight = FontWeight.Bold,
                                                    )
                                                    Spacer(Modifier.width(4.dp))
                                                    Text(
                                                        "skill",
                                                        style = MaterialTheme.typography.labelSmall,
                                                        color = MaterialTheme.colorScheme.primary,
                                                        modifier = Modifier
                                                            .background(
                                                                MaterialTheme.colorScheme.primaryContainer,
                                                                RoundedCornerShape(3.dp)
                                                            )
                                                            .padding(horizontal = 3.dp, vertical = 1.dp),
                                                    )
                                                    Spacer(Modifier.width(6.dp))
                                                    Text(
                                                        cmd.description,
                                                        style = MaterialTheme.typography.bodySmall,
                                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                        maxLines = 1,
                                                        overflow = TextOverflow.Ellipsis,
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                }
                                            },
                                            onClick = { input = "/${cmd.name} " },
                                        )
                                    }
                                }
                            }
                        }
                    }
                    if (fileRefQuery != null) {
                        val filter = fileRefQuery.substringAfterLast("/")
                        val candidates = if (vm.fileTreePath != null) {
                            vm.fileTreeNodes.map { FileRefItem(it.name, it.path, it.kind == "dir") }
                        } else {
                            vm.fileTreeRoots.map { FileRefItem(it.name, it.path, true) }
                        }
                        val matches = candidates.filter {
                            it.name.contains(filter, ignoreCase = true) ||
                                it.path.contains(fileRefQuery, ignoreCase = true)
                        }.take(20)
                        DropdownMenu(
                            expanded = matches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            matches.forEach { item ->
                                val icon = if (item.isDir) "📁" else "🗎"
                                DropdownMenuItem(
                                    text = { Text("$icon ${item.name}") },
                                    onClick = {
                                        val hash = input.lastIndexOf('#')
                                        val base = if (hash >= 0) input.substring(0, hash) else input
                                        input = "$base#${item.path}" + if (item.isDir) "/" else " "
                                        if (item.isDir) vm.refreshFileTree(item.path)
                                    },
                                )
                            }
                        }
                    }
                }
                IconButton(onClick = { pickImage.launch("image/*") }) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = "上传图片",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (vm.generating) {
                    Spacer(Modifier.size(4.dp))
                    FilledIconButton(
                        onClick = { vm.stopCurrent() },
                        modifier = Modifier.size(40.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) {
                        Icon(Icons.Filled.Stop, contentDescription = S.stop)
                    }
                } else if (input.isNotBlank() || vm.pendingAttachments.isNotEmpty()) {
                    Spacer(Modifier.size(4.dp))
                    FilledIconButton(
                        onClick = {
                            if (isRoom) vm.sendRoomMessage(input.trim()) else vm.sendPrompt(input.trim())
                            input = ""
                        },
                        modifier = Modifier.size(40.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = S.send)
                    }
                }
            }
        }
    }

    vm.filePreview?.let { FilePreviewDialog(it) { vm.dismissFilePreview() } }
}
}

private suspend fun LazyListState.scrollToLast() {
    if (layoutInfo.totalItemsCount > 0) {
        scrollToItem(0, 0)
    }
}

@Composable
fun AttachmentImage(attachment: Attachment, modifier: Modifier = Modifier) {
    val bitmap = remember(attachment.base64) {
        try {
            val bytes = Base64.decode(attachment.base64, Base64.NO_WRAP)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Exception) {
            null
        }
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = attachment.name,
            modifier = modifier,
            contentScale = ContentScale.Crop,
        )
    } else {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Icon(
                Icons.Filled.AttachFile,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun AttachmentPreviews(
    attachments: List<Attachment>,
    onRemove: (Attachment) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier = modifier.fillMaxWidth().height(96.dp)) {
        items(attachments, key = { it.base64.hashCode() }) { a ->
            Box(Modifier.padding(4.dp).size(88.dp)) {
                AttachmentImage(
                    a,
                    Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)),
                )
                IconButton(
                    onClick = { onRemove(a) },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(20.dp)
                        .background(
                            MaterialTheme.colorScheme.surface.copy(alpha = 0.8f),
                            shape = RoundedCornerShape(50),
                        ),
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "移除",
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun AuthorLabel(author: String) {
    if (author.isNotBlank() && author != "我") {
        Text(
            author,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

@Composable
private fun MessageBubbleBox(
    copyText: String,
    quote: Pair<String, String>?,
    vm: ChatViewModel,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val S = LocalStrings.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    var showSelectText by remember { mutableStateOf(false) }
    var menuOffset by remember { mutableStateOf(IntOffset.Zero) }
    Box(
        modifier = modifier
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val down = event.changes.firstOrNull {
                            it.pressed && !it.previousPressed && !it.isConsumed
                        } ?: continue

                        if (event.type == PointerEventType.Press && event.buttons.isSecondaryPressed) {
                            menuOffset = IntOffset(
                                down.position.x.toInt(),
                                down.position.y.toInt(),
                            )
                            expanded = true
                            event.changes.forEach { it.consume() }
                            continue
                        }

                        val longPress = withTimeoutOrNull(
                            viewConfiguration.longPressTimeoutMillis,
                        ) {
                            var canceled = false
                            while (!canceled) {
                                val ev = awaitPointerEvent(PointerEventPass.Initial)
                                val change = ev.changes.firstOrNull { it.id == down.id }
                                if (change == null || change.isConsumed) {
                                    canceled = true
                                } else if (!change.pressed && change.previousPressed) {
                                    canceled = true
                                } else if (change.pressed && change.previousPressed) {
                                    val dx = change.position.x - down.position.x
                                    val dy = change.position.y - down.position.y
                                    if (dx * dx + dy * dy > viewConfiguration.touchSlop * viewConfiguration.touchSlop) {
                                        canceled = true
                                    }
                                }
                            }
                            false
                        } == null

                        if (longPress) {
                            menuOffset = IntOffset(
                                down.position.x.toInt(),
                                down.position.y.toInt(),
                            )
                            expanded = true
                            down.consume()
                            while (true) {
                                val ev = awaitPointerEvent(PointerEventPass.Initial)
                                val change = ev.changes.firstOrNull { it.id == down.id }
                                if (change != null) {
                                    change.consume()
                                    if (!change.pressed) break
                                }
                            }
                        }
                    }
                }
            },
    ) {
        content()
        Box(
            Modifier
                .offset { menuOffset }
                .size(1.dp),
        ) {
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
            DropdownMenuItem(
                text = { Text(S.copy) },
                onClick = {
                    scope.launch {
                        clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, copyText)))
                    }
                    expanded = false
                    Toast.makeText(context, S.copied, Toast.LENGTH_SHORT).show()
                },
            )
            DropdownMenuItem(
                text = { Text(S.selectText) },
                onClick = {
                    expanded = false
                    showSelectText = true
                },
            )
            quote?.let { (author, text) ->
                DropdownMenuItem(
                    text = { Text(S.quoting) },
                    onClick = {
                        vm.quote = author to text
                        expanded = false
                    },
                )
            }
            }
        }
        if (showSelectText) {
            Dialog(
                onDismissRequest = { showSelectText = false },
                properties = DialogProperties(usePlatformDefaultWidth = false),
            ) {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                    modifier = Modifier
                        .fillMaxWidth(0.9f)
                        .widthIn(max = 520.dp)
                        .padding(24.dp),
                ) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Text(
                            S.selectText,
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                        SelectionContainer {
                            Text(
                                copyText,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 360.dp)
                                    .verticalScroll(rememberScrollState()),
                            )
                        }
                        Spacer(Modifier.height(12.dp))
                        TextButton(
                            onClick = { showSelectText = false },
                            modifier = Modifier.align(Alignment.End),
                        ) {
                            Text(S.ok)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun HighlightText(
    text: String,
    highlight: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    if (highlight.isBlank()) {
        Text(text, modifier = modifier, style = style, color = color, maxLines = maxLines, overflow = overflow)
    } else {
        val annotated = buildAnnotatedString {
            val q = highlight.lowercase()
            val t = text.lowercase()
            var start = 0
            val baseSpan = SpanStyle(color = color)
            val highlightSpan = SpanStyle(
                color = color,
                background = Color(0xFFFFEB3B).copy(alpha = 0.7f),
            )
            while (true) {
                val idx = t.indexOf(q, start)
                if (idx == -1) {
                    withStyle(baseSpan) { append(text.substring(start)) }
                    break
                }
                withStyle(baseSpan) { append(text.substring(start, idx)) }
                withStyle(highlightSpan) { append(text.substring(idx, idx + highlight.length)) }
                start = idx + highlight.length
            }
        }
        val q = highlight.lowercase()
        val idx = text.lowercase().indexOf(q)
        if (onMatchKeywordY == null) {
            Text(annotated, modifier = modifier, style = style, color = Color.Unspecified, maxLines = maxLines, overflow = overflow)
        } else {
            var textY by remember(onMatchKeywordY, text, highlight) { mutableStateOf<Float?>(null) }
            var lineTop by remember(onMatchKeywordY, text, highlight) { mutableStateOf<Float?>(null) }
            val measureModifier = Modifier.onGloballyPositioned { coordinates ->
                textY = coordinates.positionInWindow().y
            }
            Text(
                annotated,
                modifier = modifier.then(measureModifier),
                style = style,
                color = Color.Unspecified,
                maxLines = maxLines,
                overflow = overflow,
                onTextLayout = { result: TextLayoutResult ->
                    if (idx in 0..text.length - q.length) {
                        val line = result.getLineForOffset(idx)
                        lineTop = result.getLineTop(line)
                    }
                },
            )
            LaunchedEffect(textY, lineTop) {
                val y = textY
                val lt = lineTop
                if (y != null && lt != null) {
                    onMatchKeywordY(y + lt)
                }
            }
        }
    }
}

@Composable
fun ChatBubble(
    item: ChatItem,
    vm: ChatViewModel,
    showAuthor: Boolean,
    highlight: String = "",
    isCurrentMatch: Boolean = false,
    isQuoted: Boolean = false,
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    val S = LocalStrings.current
    val keywordCallback = if (isCurrentMatch) onMatchKeywordY else null
    val bubbleModifier = if (isCurrentMatch) Modifier.border(
        width = 2.dp,
        color = MaterialTheme.colorScheme.tertiary,
        shape = RoundedCornerShape(12.dp),
    ) else if (isQuoted) Modifier.border(
        width = 2.dp,
        color = MaterialTheme.colorScheme.primary,
        shape = RoundedCornerShape(12.dp),
    ) else Modifier
    when (item) {
        is ChatItem.System -> Box(
            Modifier.fillMaxWidth().padding(vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.65f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
                modifier = bubbleModifier,
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = bgColor,
                ) {
                    HighlightText(
                        text = item.text,
                        highlight = highlight,
                        onMatchKeywordY = keywordCallback,
                        style = MaterialTheme.typography.bodySmall,
                        color = textColor,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }
        }

        is ChatItem.User -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onPrimaryContainer
            val quoteColor = textColor.copy(alpha = 0.7f)
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                modifier = bubbleModifier.padding(vertical = 4.dp),
            ) {
                Surface(
                    shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
                    color = bgColor,
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        if (item.quoteAuthor != null) {
                            Text(
                                "${S.quoting} @${item.quoteAuthor}: ${item.quoteText?.take(80).orEmpty()}",
                                style = MaterialTheme.typography.bodySmall,
                                color = quoteColor,
                                maxLines = 2,
                            )
                            Spacer(Modifier.height(4.dp))
                        }
                        if (item.text.isNotBlank()) {
                            MarkdownText(
                                text = item.text,
                                textColor = textColor,
                                fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                                highlight = highlight,
                                onMatchKeywordY = keywordCallback,
                            )
                        }
                        if (item.attachments.isNotEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            LazyRow(Modifier.height(120.dp)) {
                                items(item.attachments, key = { it.base64.hashCode() }) { a ->
                                    AttachmentImage(
                                        a,
                                        Modifier
                                            .padding(end = 8.dp)
                                            .size(120.dp)
                                            .clip(RoundedCornerShape(12.dp)),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        is ChatItem.Assistant -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.85f) else MaterialTheme.colorScheme.surfaceVariant
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
                    color = bgColor,
                ) {
                    MarkdownText(
                        text = item.text,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        textColor = textColor,
                        fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                        highlight = highlight,
                        onMatchKeywordY = keywordCallback,
                    )
                }
            }
            if (item.usage != null) {
                Text(
                    item.usage.format(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(start = 14.dp, top = 2.dp, bottom = 4.dp),
                )
            }
        }

        is ChatItem.Thought -> {
            var expanded by remember(isCurrentMatch) { mutableStateOf(isCurrentMatch) }
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
                modifier = bubbleModifier.padding(vertical = 2.dp),
            ) {
                Column {
                    TextButton(onClick = { expanded = !expanded }) {
                        Text(
                            (if (expanded) "▾ " else "▸ ") +
                                (if (showAuthor) S.thoughtOf.format(item.author) else S.thought),
                            fontStyle = FontStyle.Italic,
                            style = MaterialTheme.typography.bodySmall,
                            color = textColor,
                        )
                    }
                    if (expanded) {
                        val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = bgColor,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 360.dp)
                                    .verticalScroll(rememberScrollState())
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                            ) {
                                HighlightText(
                                    item.text,
                                    highlight,
                                    onMatchKeywordY = keywordCallback,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = textColor,
                                )
                            }
                        }
                    }
                }
            }
        }

        is ChatItem.Tool -> Column(Modifier.padding(vertical = 3.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.4f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = "[${item.title}] ${item.status}",
                quote = null,
                vm = vm,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = bgColor,
                ) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Build,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = textColor,
                        )
                        Spacer(Modifier.size(8.dp))
                        HighlightText(
                            item.title,
                            highlight,
                            onMatchKeywordY = keywordCallback,
                            style = MaterialTheme.typography.bodyMedium,
                            color = textColor,
                            modifier = Modifier.weight(1f),
                        )
                        HighlightText(
                            item.status,
                            highlight,
                            onMatchKeywordY = keywordCallback,
                            style = MaterialTheme.typography.bodySmall,
                            color = textColor,
                        )
                    }
                }
            }
        }

        is ChatItem.Plan -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurface
            MessageBubbleBox(
                copyText = "${S.plan}\n${item.entries.joinToString("\n")}",
                quote = null,
                vm = vm,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = bgColor),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        HighlightText(
                            S.plan,
                            highlight,
                            onMatchKeywordY = keywordCallback,
                            style = MaterialTheme.typography.titleSmall,
                            color = textColor,
                        )
                        Spacer(Modifier.height(4.dp))
                        item.entries.forEach {
                            HighlightText(
                                it,
                                highlight,
                                onMatchKeywordY = keywordCallback,
                                style = MaterialTheme.typography.bodySmall,
                                color = textColor,
                            )
                        }
                    }
                }
            }
        }

        is ChatItem.Error -> {
            val text = (if (item.author.isNotBlank()) "[${item.author}] " else "") +
                "${S.errorTag}: ${item.text}"
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.error
            MessageBubbleBox(
                copyText = text,
                quote = null,
                vm = vm,
                modifier = bubbleModifier.padding(vertical = 4.dp),
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.65f) else Color.Transparent,
                    modifier = Modifier.padding(horizontal = 4.dp),
                ) {
                    HighlightText(
                        text,
                        highlight,
                        onMatchKeywordY = keywordCallback,
                        style = MaterialTheme.typography.bodySmall,
                        color = textColor,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
        }

        is ChatItem.Permission -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurface
            val answeredColor = if (isCurrentMatch) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.title,
                quote = null,
                vm = vm,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = bgColor),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        HighlightText(
                            "${S.permissionRequest}: ${item.title}",
                            highlight,
                            onMatchKeywordY = keywordCallback,
                            style = MaterialTheme.typography.titleSmall,
                            color = textColor,
                        )
                        Spacer(Modifier.height(8.dp))
                        if (item.answered != null) {
                            HighlightText(
                                S.chose.format(item.answered),
                                highlight,
                                onMatchKeywordY = keywordCallback,
                                style = MaterialTheme.typography.bodySmall,
                                color = answeredColor,
                            )
                        } else {
                            Row {
                                item.options.forEach { (id, name) ->
                                    OutlinedButton(
                                        onClick = { vm.answerPermission(item.requestId, id, name) },
                                        modifier = Modifier.padding(end = 8.dp),
                                        shape = RoundedCornerShape(12.dp),
                                    ) { Text(name) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FlowPanel(flow: FlowInfo?, roomMode: String) {
    if (flow == null || flow.tasks.isEmpty()) return
    var collapsed by remember { mutableStateOf(false) }
    val progress = flow.progress
    val title = if (roomMode == "conductor") "指挥编排" else "编排进度"
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsed = !collapsed },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} $title",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    "${progress.done}/${progress.total} 完成 · ${progress.running} 进行中 · ${progress.pending} 待执行" +
                        if (progress.failed > 0) " · ${progress.failed} 失败" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!collapsed) {
                Spacer(Modifier.height(6.dp))
                flow.tasks.forEach { task ->
                    FlowTaskRow(task)
                }
            }
        }
    }
}

@Composable
private fun FlowTaskRow(task: FlowTask) {
    val icon = when (task.status) {
        "done" -> "✓"
        "running" -> "▶"
        "failed" -> "✗"
        else -> "○"
    }
    val iconColor = when (task.status) {
        "done" -> MaterialTheme.colorScheme.primary
        "running" -> MaterialTheme.colorScheme.tertiary
        "failed" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    Column(Modifier.padding(vertical = 3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(icon, color = iconColor, modifier = Modifier.width(20.dp))
            Text("@${task.name}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(6.dp))
            Text(
                task.task,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (task.artifacts.isNotEmpty()) {
            Row(
                modifier = Modifier.padding(start = 20.dp, top = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                task.artifacts.forEach { artifact ->
                    val copyText = artifact.path ?: artifact.summary
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        shape = RoundedCornerShape(4.dp),
                        modifier = Modifier.clickable {
                            scope.launch {
                                clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, copyText)))
                            }
                            Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                        },
                    ) {
                        Text(
                            "[${artifact.type}] ${artifact.path ?: ""} ${artifact.summary.take(60)}",
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArtifactPanel(artifacts: List<ArtifactInfo>, vm: ChatViewModel) {
    if (artifacts.isEmpty()) return
    val context = LocalContext.current
    var collapsed by remember { mutableStateOf(false) }
    var showClearConfirm by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<ArtifactInfo?>(null) }
    var managing by remember { mutableStateOf(false) }
    val selected = remember { mutableStateListOf<ArtifactInfo>() }
    var confirmRemoveSelected by remember { mutableStateOf(false) }
    var selectedArtifact by remember { mutableStateOf<ArtifactInfo?>(null) }
    val groups = mapOf("file" to artifacts)
    val kindLabel = { _: String -> "文件" }
    val fileColor = MaterialTheme.colorScheme.primary
    val scroll = rememberScrollState()
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 280.dp)
            .padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
    ) {
        Column(
            Modifier
                .padding(horizontal = 10.dp, vertical = 6.dp)
                .verticalScroll(scroll),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsed = !collapsed },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} 产物",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (managing) {
                        Text(
                            "删除 ${selected.size}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (selected.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                            modifier = Modifier
                                .clickable(enabled = selected.isNotEmpty()) { confirmRemoveSelected = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            "取消",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = false; selected.clear() }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    } else {
                        Text(
                            "清空",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { showClearConfirm = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            "管理",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = true; selectedArtifact = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    Text(
                        "${artifacts.size} 条",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            if (!collapsed) {
                Spacer(Modifier.height(6.dp))
                selectedArtifact?.let { artifact ->
                    val activeContainer = MaterialTheme.colorScheme.primaryContainer
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(activeContainer, RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            artifact.path ?: artifact.alias ?: artifact.id,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).padding(end = 6.dp),
                        )
                        Row {
                            IconButton(
                                onClick = {
                                    vm.quoteArtifact(artifact)
                                    Toast.makeText(context, "已引用到输入框", Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.FormatQuote,
                                    contentDescription = "引用",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { vm.loadArtifactPreview(artifact) },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Visibility,
                                    contentDescription = "预览",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { vm.downloadArtifactFile(artifact) },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Download,
                                    contentDescription = "下载",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { confirmRemove = artifact; selectedArtifact = null },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = "删除",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                groups.forEach { (kind, list) ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(vertical = 2.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .background(fileColor, CircleShape)
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "${kindLabel(kind)} (${list.size})",
                                style = MaterialTheme.typography.labelSmall,
                                color = fileColor,
                            )
                        }
                        list.forEach { artifact ->
                            val isActive = selectedArtifact?.id == artifact.id
                            val bg = if (isActive) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
                            Surface(
                                color = bg,
                                shape = RoundedCornerShape(4.dp),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 2.dp)
                                    .clickable {
                                        if (managing) {
                                            if (selected.contains(artifact)) selected.remove(artifact)
                                            else selected.add(artifact)
                                        } else {
                                            selectedArtifact = if (isActive) null else artifact
                                        }
                                    },
                            ) {
                                if (managing) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                if (selected.contains(artifact)) selected.remove(artifact)
                                                else selected.add(artifact)
                                            }
                                            .padding(horizontal = 8.dp, vertical = 6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Checkbox(
                                            checked = selected.contains(artifact),
                                            onCheckedChange = {
                                                if (selected.contains(artifact)) selected.remove(artifact)
                                                else selected.add(artifact)
                                            },
                                        )
                                        Box(
                                            modifier = Modifier
                                                .width(4.dp)
                                                .height(20.dp)
                                                .background(fileColor)
                                        )
                                        Text(
                                            "@${vm.sessionName(artifact.author)} ${formatArtifactTime(artifact.at)} ${artifact.path?.let { "$it · " } ?: ""}${artifact.summary}",
                                            style = MaterialTheme.typography.bodySmall,
                                            modifier = Modifier.weight(1f).padding(start = 6.dp),
                                        )
                                    }
                                } else {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 8.dp, vertical = 6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .width(4.dp)
                                                .height(36.dp)
                                                .background(fileColor)
                                        )
                                        Column(
                                            modifier = Modifier
                                                .weight(1f)
                                                .padding(start = 6.dp)
                                                .fillMaxWidth(),
                                        ) {
                                            Text(
                                                "@${vm.sessionName(artifact.author)} · ${formatArtifactTime(artifact.at)}",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            Text(
                                                artifact.path ?: artifact.alias ?: artifact.id,
                                                style = MaterialTheme.typography.bodySmall.copy(
                                                    fontWeight = FontWeight.SemiBold,
                                                    color = MaterialTheme.colorScheme.primary,
                                                ),
                                                maxLines = 2,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
            }
        }
    }

    confirmRemove?.let { artifact ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("删除产物") },
            text = { Text("确定删除该产物？\n${artifact.summary}") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeArtifact(artifact)
                        confirmRemove = null
                    },
                ) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = null }) { Text("取消") }
            },
        )
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("清空产物") },
            text = { Text("确定清空全部产物？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearArtifacts()
                        showClearConfirm = false
                    },
                ) { Text("清空") }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text("取消") }
            },
        )
    }

    if (confirmRemoveSelected) {
        AlertDialog(
            onDismissRequest = { confirmRemoveSelected = false },
            title = { Text("删除选中产物") },
            text = { Text("确定删除 ${selected.size} 条产物？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeArtifacts(selected.toList())
                        selected.clear()
                        managing = false
                        confirmRemoveSelected = false
                    },
                ) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemoveSelected = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun EventPanel(events: List<EventInfo>, vm: ChatViewModel) {
    if (events.isEmpty()) return
    val context = LocalContext.current
    var collapsed by remember { mutableStateOf(false) }
    var showClearConfirm by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<EventInfo?>(null) }
    var confirmRemoveSelected by remember { mutableStateOf(false) }
    var managing by remember { mutableStateOf(false) }
    val selected = remember { mutableStateListOf<EventInfo>() }
    var selectedEvent by remember { mutableStateOf<EventInfo?>(null) }
    var clearAction by remember { mutableStateOf<String?>(null) }
    var showClearMenu by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    val actionLabel = { action: String? ->
        when (action) {
            "add" -> "新增"
            "modify" -> "修改"
            "delete" -> "删除"
            "rename" -> "重命名"
            "command" -> "命令"
            "test" -> "测试"
            else -> "事件"
        }
    }
    val colorScheme = MaterialTheme.colorScheme
    val actionColors = mapOf(
        "add" to colorScheme.primary,
        "modify" to colorScheme.tertiary,
        "delete" to colorScheme.error,
        "rename" to colorScheme.tertiary,
        "command" to colorScheme.primary,
        "test" to colorScheme.secondary,
    )
    val actionColor = { action: String? -> actionColors[action] ?: Color.Gray }
    val actionOptions = remember(events) { events.map { it.action }.distinct().sorted() }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 280.dp)
            .padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
    ) {
        Column(
            Modifier
                .padding(horizontal = 10.dp, vertical = 6.dp)
                .verticalScroll(scroll),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsed = !collapsed },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} 事件",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (managing) {
                        Text(
                            "删除 ${selected.size}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (selected.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                            modifier = Modifier
                                .clickable(enabled = selected.isNotEmpty()) { confirmRemoveSelected = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            "取消",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = false; selected.clear(); selectedEvent = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    } else {
                        Box {
                            Text(
                                "清空",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier
                                    .clickable { showClearMenu = true }
                                    .padding(horizontal = 8.dp, vertical = 4.dp),
                            )
                            DropdownMenu(
                                expanded = showClearMenu,
                                onDismissRequest = { showClearMenu = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text("清空全部") },
                                    onClick = {
                                        showClearMenu = false
                                        clearAction = null
                                        showClearConfirm = true
                                    },
                                )
                                actionOptions.forEach { action ->
                                    DropdownMenuItem(
                                        text = { Text("仅清空「${actionLabel(action)}」") },
                                        onClick = {
                                            showClearMenu = false
                                            clearAction = action
                                            showClearConfirm = true
                                        },
                                    )
                                }
                            }
                        }
                        Text(
                            "管理",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = true; selectedEvent = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    Text(
                        "${events.size} 条",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            if (!collapsed) {
                Spacer(Modifier.height(6.dp))
                selectedEvent?.let { event ->
                    val activeContainer = MaterialTheme.colorScheme.primaryContainer
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(activeContainer, RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            event.path ?: event.summary,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).padding(end = 6.dp),
                        )
                        Row {
                            IconButton(
                                onClick = {
                                    vm.quoteEvent(event)
                                    Toast.makeText(context, "已引用到输入框", Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.FormatQuote,
                                    contentDescription = "引用",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { confirmRemove = event; selectedEvent = null },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = "删除",
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                events.forEach { event ->
                    val isActive = selectedEvent?.id == event.id
                    val bg = if (isActive) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
                    Surface(
                        color = bg,
                        shape = RoundedCornerShape(4.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp)
                            .clickable {
                                if (managing) {
                                    if (selected.contains(event)) selected.remove(event)
                                    else selected.add(event)
                                } else {
                                    selectedEvent = if (isActive) null else event
                                }
                            },
                    ) {
                        if (managing) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 8.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(
                                    checked = selected.contains(event),
                                    onCheckedChange = {
                                        if (selected.contains(event)) selected.remove(event)
                                        else selected.add(event)
                                    },
                                )
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(actionColor(event.action), CircleShape)
                                )
                                Text(
                                    "${actionLabel(event.action)} · @${vm.sessionName(event.author)} · ${formatArtifactTime(event.at)} · ${event.summary}",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.weight(1f).padding(start = 6.dp),
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        } else {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 8.dp, vertical = 6.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(actionColor(event.action), CircleShape)
                                )
                                Spacer(Modifier.width(6.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "${actionLabel(event.action)} · @${vm.sessionName(event.author)} · ${formatArtifactTime(event.at)}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = actionColor(event.action),
                                    )
                                    Text(
                                        buildString {
                                            if (event.oldPath != null) append("${event.oldPath} → ")
                                            if (event.path != null) append(event.path)
                                            if (!event.summary.isNullOrEmpty() && (event.path == null || !event.summary.contains(event.path))) {
                                                append(" · ${event.summary}")
                                            }
                                        },
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (event.action == "command" || event.action == "test") {
                                    IconButton(
                                        onClick = {
                                            vm.quoteEvent(event)
                                            Toast.makeText(context, "已引用到输入框", Toast.LENGTH_SHORT).show()
                                        },
                                        modifier = Modifier.size(28.dp),
                                    ) {
                                        Icon(
                                            imageVector = Icons.Filled.FormatQuote,
                                            contentDescription = "引用",
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    confirmRemove?.let { event ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("删除事件") },
            text = { Text("确定删除该事件？\n${event.summary}") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeEvent(event)
                        confirmRemove = null
                        selectedEvent = null
                    },
                ) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = null }) { Text("取消") }
            },
        )
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("清空事件") },
            text = {
                Text(
                    if (clearAction == null) "确定清空全部事件？"
                    else "确定清空全部「${actionLabel(clearAction)}」事件？"
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearEvents(clearAction)
                        showClearConfirm = false
                        clearAction = null
                    },
                ) { Text("清空") }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text("取消") }
            },
        )
    }

    if (confirmRemoveSelected) {
        AlertDialog(
            onDismissRequest = { confirmRemoveSelected = false },
            title = { Text("删除选中事件") },
            text = { Text("确定删除 ${selected.size} 条事件？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeEvents(selected.toList())
                        selected.clear()
                        managing = false
                        confirmRemoveSelected = false
                    },
                ) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemoveSelected = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun ChatTopCapsules(vm: ChatViewModel, expanded: String?, showRoomExtras: Boolean = true, onExpand: (String?) -> Unit) {
    val flow = vm.flow
    val flowCount = if (showRoomExtras) flow?.tasks?.size ?: 0 else 0
    val blackboardCount = if (showRoomExtras) vm.blackboard.size else 0
    val artifactCount = vm.currentArtifacts.size
    val eventCount = vm.currentEvents.size
    if (flowCount == 0 && blackboardCount == 0 && artifactCount == 0 && eventCount == 0) return
    val flowProgress = flow?.progress
    val flowLabel = if (flowProgress != null) {
        "编排 ${flowProgress.done}/${flowProgress.total}"
    } else "编排"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (flowCount > 0) {
            AssistChip(
                onClick = { onExpand(if (expanded == "flow") null else "flow") },
                label = { Text(flowLabel, style = MaterialTheme.typography.labelMedium) },
                leadingIcon = {
                    Text(
                        if (expanded == "flow") "▾" else "▸",
                        style = MaterialTheme.typography.labelMedium,
                    )
                },
            )
        }
        if (blackboardCount > 0) {
            AssistChip(
                onClick = { onExpand(if (expanded == "blackboard") null else "blackboard") },
                label = { Text("黑板 $blackboardCount", style = MaterialTheme.typography.labelMedium) },
                leadingIcon = {
                    Text(
                        if (expanded == "blackboard") "▾" else "▸",
                        style = MaterialTheme.typography.labelMedium,
                    )
                },
            )
        }
        if (artifactCount > 0) {
            var unread by remember { mutableStateOf(0) }
            var previousCount by remember { mutableStateOf(artifactCount) }
            LaunchedEffect(artifactCount, expanded) {
                if (expanded == "artifact") {
                    unread = 0
                    previousCount = artifactCount
                } else {
                    if (artifactCount > previousCount) {
                        unread += artifactCount - previousCount
                    } else if (artifactCount < previousCount) {
                        unread = maxOf(0, unread - (previousCount - artifactCount))
                    }
                    previousCount = artifactCount
                }
            }
            Box {
                AssistChip(
                    onClick = { onExpand(if (expanded == "artifact") null else "artifact") },
                    label = { Text("产物 $artifactCount", style = MaterialTheme.typography.labelMedium) },
                    leadingIcon = {
                        Text(
                            if (expanded == "artifact") "▾" else "▸",
                            style = MaterialTheme.typography.labelMedium,
                        )
                    },
                )
                if (unread > 0) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .offset(x = (-2).dp, y = (-2).dp)
                            .size(if (unread > 9) 16.dp else 10.dp)
                            .background(
                                MaterialTheme.colorScheme.error,
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (unread > 9) {
                            Text(
                                unread.toString(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onError,
                                fontSize = 9.sp,
                            )
                        }
                    }
                }
            }
        }
        if (eventCount > 0) {
            AssistChip(
                onClick = { onExpand(if (expanded == "event") null else "event") },
                label = { Text("事件 $eventCount", style = MaterialTheme.typography.labelMedium) },
                leadingIcon = {
                    Text(
                        if (expanded == "event") "▾" else "▸",
                        style = MaterialTheme.typography.labelMedium,
                    )
                },
            )
        }
    }
}

@Composable
private fun BlackboardPanel(vm: ChatViewModel) {
    val entries = vm.blackboard
    if (entries.isEmpty()) return
    var collapsed by remember { mutableStateOf(false) }
    var detailEntry by remember { mutableStateOf<BlackboardEntry?>(null) }
    var showClearConfirm by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 8.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsed = !collapsed },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} 共享黑板",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "清空",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .clickable { showClearConfirm = true }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                    Text(
                        "${entries.size} 条",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            if (!collapsed) {
                Spacer(Modifier.height(4.dp))
                entries.reversed().forEach { entry ->
                    Column(
                        Modifier
                            .padding(vertical = 3.dp)
                            .combinedClickable(
                                onClick = { detailEntry = entry },
                                onLongClick = { detailEntry = entry },
                            ),
                    ) {
                        Text(
                            "@${entry.from} · ${formatArtifactTime(entry.at)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            entry.text,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }

    detailEntry?.let { entry ->
        Dialog(
            onDismissRequest = { detailEntry = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Card(
                modifier = Modifier
                    .fillMaxWidth(0.9f)
                    .widthIn(max = 520.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Column(Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "@${entry.from} · ${formatArtifactTime(entry.at)}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        IconButton(onClick = { detailEntry = null }) {
                            Icon(Icons.Default.Close, contentDescription = "关闭")
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    SelectionContainer(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = 320.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Text(
                            entry.detail.ifBlank { entry.text },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    ) {
                        TextButton(onClick = { detailEntry = null }) { Text("关闭") }
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, entry.detail.ifBlank { entry.text })))
                                }
                                Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                            },
                        ) { Text("复制") }
                        TextButton(
                            onClick = {
                                vm.removeBlackboardEntry(entry)
                                detailEntry = null
                            },
                        ) { Text("删除") }
                    }
                }
            }
        }
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("清空黑板") },
            text = { Text("确定清空全部 ${entries.size} 条黑板摘要？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearBlackboard()
                        showClearConfirm = false
                    },
                ) { Text("清空") }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text("取消") }
            },
        )
    }
}
