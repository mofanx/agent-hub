package com.agenthub.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale
import java.text.DateFormat
import java.text.SimpleDateFormat

import android.content.ClipData
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.runtime.produceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.text.contextmenu.modifier.appendTextContextMenuComponents
import androidx.compose.foundation.text.contextmenu.builder.item
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
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
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
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
import com.agenthub.ChatListItem
import com.agenthub.ChatViewModel
import com.agenthub.DownloadRequest
import com.agenthub.FileTreeNode
import com.agenthub.FileTreeRoot
import com.agenthub.Screen
import com.agenthub.ContextUsage
import com.agenthub.ElicitationField
import com.agenthub.FlowTask
import com.agenthub.TokenUsage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

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

private val AUTHOR_PALETTE = listOf(
    Color(0xFF8B5CF6), Color(0xFFF59E0B), Color(0xFF10B981), Color(0xFF3B82F6),
    Color(0xFFEC4899), Color(0xFF14B8A6), Color(0xFFF97316), Color(0xFF6366F1),
)

internal fun authorColor(author: String): Color {
    var h = 0
    for (c in author) h = h * 31 + c.code
    return AUTHOR_PALETTE[Math.floorMod(h, AUTHOR_PALETTE.size)]
}

@Composable
private fun DateSeparator(at: Long) {
    val S = LocalStrings.current
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
    val now = LocalDate.now(zone)
    val label = when (date) {
        now -> S.dateToday
        now.minusDays(1) -> S.dateYesterday
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM, Locale.getDefault()).format(Date(at))
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(
            Modifier.weight(1f),
            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        )
        Text(
            label,
            modifier = Modifier.padding(horizontal = 12.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(
            Modifier.weight(1f),
            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        )
    }
}

private fun sameDay(a: Long, b: Long): Boolean {
    if (a <= 0 || b <= 0) return false
    val zone = ZoneId.systemDefault()
    return Instant.ofEpochMilli(a).atZone(zone).toLocalDate() ==
        Instant.ofEpochMilli(b).atZone(zone).toLocalDate()
}

private fun sameChatAuthor(a: String, b: String): Boolean {
    if (a == b) return true
    // 兼容三种作者形态：裸名、`name (conn)` 旧格式、`name·type·origin` 新格式
    val sep = { it: String, other: String -> it.startsWith("$other (") || it.startsWith("$other·") }
    return sep(a, b) || sep(b, a)
}

/** 作者显示：新格式 `name·type·local|remote` 的 origin 尾段本地化；旧格式原样。仅 ≥3 段才按 origin 处理，成员名内嵌 · 不受影响 */
@Composable
private fun fmtAuthor(author: String): String {
    val S = LocalStrings.current
    val parts = author.split("·")
    val last = parts.last()
    val localized = when {
        parts.size >= 3 && last == "local" -> S.originLocal
        parts.size >= 3 && last == "remote" -> S.originRemote
        else -> return author
    }
    return parts.dropLast(1).joinToString("·") + "·" + localized
}

private fun ChatListItem.groupableAuthor(): Boolean = when (this) {
    is ChatListItem.FlowCard -> false
    is ChatListItem.ProcessGroup -> author.isNotBlank()
    is ChatListItem.Message -> author.isNotBlank()
    is ChatListItem.Other -> when (item) {
        is ChatItem.System, is ChatItem.Error -> false
        else -> author.isNotBlank()
    }
}

private fun TokenUsage.format(S: Strings): String = buildString {
    append("${S.tokenInput} ${formatNumber(inputTokens)} · ${S.tokenOutput} ${formatNumber(outputTokens)}")
    if (cachedReadTokens != null && cachedReadTokens > 0) append(" · ${S.tokenCached} ${formatNumber(cachedReadTokens)}")
    if (cachedWriteTokens != null && cachedWriteTokens > 0) append(" · ${S.tokenCachedWrite} ${formatNumber(cachedWriteTokens)}")
    if (thoughtTokens != null && thoughtTokens > 0) append(" · ${S.tokenThought} ${formatNumber(thoughtTokens)}")
    append(" · ${S.tokenTotal} ${formatNumber(totalTokens)}")
}

private fun ContextUsage.format(S: Strings): String = buildString {
    val max = if (size > 0) " / ${S.contextMax} ${formatNumber(size)}" else ""
    append("${S.context} ${formatNumber(used)}$max")
    if (costAmount != null && costCurrency != null) {
        append(" · ${costCurrency} ${String.format("%.4f", costAmount)}")
    }
}

private fun ContextUsage.formatCompact(S: Strings): String {
    val max = if (size > 0) " / ${formatNumber(size)}" else ""
    return "${S.context} ${formatNumber(used)}$max"
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current
    val sessionKey = vm.currentRoom?.roomId ?: vm.currentSession?.sessionId ?: ""
    var input by remember(sessionKey) { mutableStateOf(vm.draftFor(sessionKey)) }
    val context = LocalContext.current
    val listState = remember(sessionKey) { LazyListState(0, 0) }
    val activeSessionId = vm.currentRoom?.activeSpeaker ?: vm.currentSession?.sessionId
    val contextUsage = activeSessionId?.let { vm.sessionUsage[it] }
    val isAtBottom by produceState(false, listState, vm.chatListItems.value.size) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                value = index == 0 && offset <= 20
            }
    }
    val scope = rememberCoroutineScope()
    val messages by remember { derivedStateOf { vm.chatListItems.value.asReversed() } }
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
    val matchPositions by remember {
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
    val flowAbsorbing = isRoom &&
        vm.flow?.phase in setOf("planning", "awaiting-input", "working", "reviewing", "summarizing")
    val title = vm.currentRoom?.name ?: vm.currentSession?.name ?: S.chat
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { vm.addAttachment(it) }
    }
    val attachErrorMsg = vm.attachError
    LaunchedEffect(attachErrorMsg) {
        if (attachErrorMsg != null) {
            Toast.makeText(context, attachErrorMsg, Toast.LENGTH_LONG).show()
            vm.clearAttachError()
        }
    }

    LaunchedEffect(matchPositions) {
        vm.chatSearchMatchCount = matchPositions.size
        if (vm.chatSearchMatchIndex == -1 && matchPositions.isNotEmpty()) {
            vm.chatSearchMatchIndex = 0
        }
    }

    LaunchedEffect(input, sessionKey) {
        vm.setDraft(sessionKey, input)
    }

    LaunchedEffect(vm.generating, sessionKey) {
        if (!vm.generating) vm.flushQueue(sessionKey)
    }

    LaunchedEffect(vm.flow, vm.helpReplyTo) {
        val target = vm.helpReplyTo ?: return@LaunchedEffect
        val waiting = vm.flow
        val alive = waiting?.tasks?.any { it.waitingFor == "user" && it.waitingHelpId == target } == true ||
            (waiting?.phase == "awaiting-input" && waiting.clarificationId == target)
        if (!alive) vm.cancelHelpReply()
    }

    LaunchedEffect(vm.jumpToHistoryId, matchPositions) {
        val targetId = vm.jumpToHistoryId ?: return@LaunchedEffect
        val targetIndex = messages.indexOfFirst { it.originalId == -targetId }
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

    var editingRoom by remember(sessionKey) { mutableStateOf(false) }
    var flashFlowId by remember(sessionKey) { mutableStateOf<String?>(null) }
    LaunchedEffect(flashFlowId) {
        if (flashFlowId != null) {
            delay(1200)
            flashFlowId = null
        }
    }

    BackHandler(enabled = !editingRoom) {
        if (vm.multiSelectMode) vm.exitMultiSelect()
        else vm.backToList()
    }

    ModelPickerDialog(vm)
    if (editingRoom) {
        vm.currentRoom?.let {
            RoomEditorDialog(it, vm, S) { editingRoom = false }
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom),
        topBar = {
            if (vm.multiSelectMode) {
                TopAppBar(
                    title = { Text(S.selectedCount.format(vm.selectedMessageIds.size)) },
                    navigationIcon = {
                        IconButton(onClick = { vm.exitMultiSelect() }) {
                            Icon(Icons.Filled.Close, contentDescription = S.cancel)
                        }
                    },
                    actions = {
                        IconButton(onClick = { vm.copySelectedMessages() }) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = S.copy)
                        }
                        IconButton(onClick = { vm.quoteSelectedMessages() }) {
                            Icon(Icons.AutoMirrored.Filled.Reply, contentDescription = S.quoting)
                        }
                    },
                )
            } else {
            TopAppBar(
                title = {
                    if (isRoom) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                title,
                                modifier = Modifier.weight(1f, fill = false),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(" (${vm.currentRoom?.members?.size ?: 0})")
                        }
                    } else {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onMenuClick) {
                        Icon(Icons.Filled.Menu, contentDescription = S.menu)
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
                            Text(S.fileLabel, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    if (isRoom) {
                        IconButton(onClick = { editingRoom = true }) {
                            Icon(Icons.Filled.MoreHoriz, contentDescription = S.editRoom)
                        }
                    } else {
                        IconButton(onClick = { vm.backToList() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                        }
                    }
                },
            )
            }
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
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                    val quota = vm.backendQuota
                    val hasDevinMember = if (isRoom) {
                        vm.currentRoom?.members?.any {
                            vm.roomMemberTypes[it.first] == "devin"
                        } == true
                    } else {
                        (vm.currentSession?.backendType ?: vm.currentSession?.agent) == "devin"
                    }
                    val effQuota = (vm.memberQuotas.values.firstOrNull { it.available }) ?: quota
                    val quotaText = if (effQuota?.available == true && hasDevinMember) {
                        listOfNotNull(
                            effQuota.daily?.let { S.quotaDaily.format(it.usedPercent) },
                            effQuota.weekly?.let { S.quotaWeekly.format(it.usedPercent) },
                        ).joinToString(" · ")
                    } else ""
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
                        val subModeLabel = room.subMode?.takeIf { it != room.mode }?.let { sub ->
                            when (sub) {
                                "mention" -> S.modeMention
                                "conductor" -> S.modeConductor
                                "roundrobin" -> S.modeRoundRobin
                                "parallel" -> S.modeParallel
                                "pipeline" -> S.modePipeline
                                "debate" -> S.modeDebate
                                "auto" -> S.modeAuto
                                "self" -> S.modeSelf
                                "deciding" -> S.modeDeciding
                                else -> sub
                            }
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(
                                modifier = Modifier.weight(1f),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    modeLabel,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                if (subModeLabel != null) {
                                    Text(
                                        S.modeCurrent.format(subModeLabel),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                room.members.forEach { (sid, name) ->
                                    val st = vm.memberStatus[sid] ?: "offline"
                                    val dotColor = when (st) {
                                        "generating" -> MaterialTheme.colorScheme.primary
                                        "online" -> MaterialTheme.colorScheme.tertiary
                                        else -> MaterialTheme.colorScheme.outline
                                    }
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            Modifier
                                                .size(6.dp)
                                                .clip(CircleShape)
                                                .background(dotColor),
                                        )
                                        Spacer(Modifier.width(3.dp))
                                        Text(
                                            name,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = if (st == "generating") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.widthIn(max = 64.dp),
                                        )
                                    }
                                }
                            }
                            if (quotaText.isNotEmpty()) {
                                Text(
                                    quotaText,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.outline,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                    if (!isRoom) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                if (vm.modelCurrent.isNotBlank()) {
                                    Text(
                                        vm.modelCurrent,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.outline,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                contextUsage?.let {
                                    Text(
                                        it.formatCompact(S),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.outline,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                            val sessQuota = vm.currentSession?.let { vm.memberQuotas[it.sessionId] } ?: quota
                            if (sessQuota?.available == true && (vm.currentSession?.backendType ?: vm.currentSession?.agent) == "devin") {
                                Column(horizontalAlignment = Alignment.End) {
                                    sessQuota.daily?.let {
                                        Text(
                                            S.quotaDaily.format(it.usedPercent),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.outline,
                                            maxLines = 1,
                                        )
                                    }
                                    sessQuota.weekly?.let {
                                        val costText = contextUsage?.costAmount?.let { cost ->
                                            "${contextUsage.costCurrency} ${String.format("%.4f", cost)} · "
                                        } ?: ""
                                        Text(
                                            "$costText${S.quotaWeekly.format(it.usedPercent)}",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.outline,
                                            maxLines = 1,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                if (isRoom || vm.currentSession != null) {
                    var expandedTop by remember(sessionKey) { mutableStateOf<String?>(null) }
                    ChatTopCapsules(vm, expandedTop, showRoomExtras = isRoom) { expandedTop = it }
                    FlowProgressStrip(vm, listState, messages) { flashFlowId = it }
                    when (expandedTop) {
                        "blackboard" -> if (isRoom) BlackboardPanel(vm)
                        "artifact" -> ArtifactPanel(vm.currentArtifacts, vm)
                        "event" -> EventPanel(vm.currentEvents, vm)
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    reverseLayout = true,
                    state = listState,
                    overscrollEffect = null,
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
                        // reverseLayout：index+1 是时间上更早的一条
                        val prev = messages.getOrNull(index + 1)
                        val grouped = prev != null &&
                            prev.groupableAuthor() && item.groupableAuthor() &&
                            sameChatAuthor(prev.author, item.author) &&
                            prev.at > 0 && item.at > 0 &&
                            kotlin.math.abs(item.at - prev.at) < 120_000L &&
                            sameDay(prev.at, item.at)
                        val currentMatchIndex = matchPositions.getOrNull(vm.chatSearchMatchIndex)
                        val isQuoted = vm.quote?.let { (author, text) ->
                            author == item.author && item.text.startsWith(text)
                        } ?: false
                        Column {
                            if (item.at > 0 && (prev == null || !sameDay(prev.at, item.at))) {
                                DateSeparator(item.at)
                            }
                            ChatBubble(
                                item,
                                vm,
                                showAuthor = isRoom && item.isFirst && !grouped,
                                grouped = grouped,
                                highlight = vm.inChatSearchQuery,
                                isCurrentMatch = currentMatchIndex == index,
                                isQuoted = isQuoted,
                                onMatchKeywordY = if (currentMatchIndex == index) onMatchKeywordY else null,
                                flash = flashFlowId != null &&
                                    (item as? ChatListItem.FlowCard)?.item?.flowId == flashFlowId,
                            )
                        }
                    }
                    if (vm.historyLoading) {
                        item {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    S.loadMoreHistory,
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
                            contentDescription = S.jumpToBottom,
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
            val helpTasks = if (isRoom) vm.flow?.tasks?.filter {
                it.waitingFor == "user" && !it.waitingHelpId.isNullOrBlank()
            }.orEmpty() else emptyList()
            val pendingClarification = if (isRoom &&
                vm.flow?.phase == "awaiting-input" &&
                !vm.flow?.clarificationId.isNullOrBlank() &&
                vm.flow?.clarificationQuestions?.isNotEmpty() == true
            ) vm.flow else null
            Column(
                Modifier
                    .heightIn(max = 160.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                helpTasks.forEach { helpTask ->
                    val isReplyTarget = vm.helpReplyTo != null && helpTask.waitingHelpId == vm.helpReplyTo
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    ) {
                        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.QuestionAnswer,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.size(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    if (isReplyTarget) "${S.helpReplying} @${helpTask.name}" else "@${helpTask.name}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                Text(
                                    helpTask.waitingQuestion.orEmpty().take(100),
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2,
                                )
                            }
                            TextButton(
                                onClick = {
                                    if (isReplyTarget) vm.cancelHelpReply()
                                    else helpTask.waitingHelpId?.let { vm.startHelpReply(it) }
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    if (isReplyTarget) S.exitHelpReply else S.helpReplyAction,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
                pendingClarification?.let { clarFlow ->
                    val clarId = clarFlow.clarificationId!!
                    val isReplyTarget = vm.helpReplyTo == clarId
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    ) {
                        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.QuestionAnswer,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.size(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    if (isReplyTarget) S.clarificationReplying
                                    else S.clarificationPending,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                clarFlow.clarificationQuestions.forEachIndexed { i, q ->
                                    Text(
                                        "${i + 1}. ${q.take(200)}",
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            TextButton(
                                onClick = {
                                    if (isReplyTarget) vm.cancelHelpReply()
                                    else vm.startHelpReply(clarId)
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    if (isReplyTarget) S.exitHelpReply else S.helpReplyAction,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
            }
            val queuedCount = vm.queuedCount(sessionKey)
            if (queuedCount > 0) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { vm.clearQueue(sessionKey) }
                        .padding(horizontal = 16.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        S.queueCountFmt.format(queuedCount),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        S.queueClearHint,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
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
                                        if (vm.helpReplyTo != null && vm.helpReplyTo == vm.flow?.clarificationId) S.clarificationReplying
                                        else if (vm.helpReplyTo != null) S.inputHelpReply
                                        else if (flowAbsorbing) S.inputFlowActive
                                        else if (isRoom) S.inputRoom else S.inputSingle,
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
                        // @all/@全员 保留字 + 房间自定义别名（hub 侧展开，发送原文不变）
                        val aliasMatches = (listOf("all", "全员") + vm.currentRoom!!.aliases).distinct()
                            .filter { it.startsWith(mentionQuery, ignoreCase = true) }
                        val artifactMatches = if (memberMatches.isNotEmpty()) emptyList() else vm.currentArtifacts.filter {
                            it.id.startsWith(mentionQuery, ignoreCase = true) ||
                                    (!it.alias.isNullOrBlank() && it.alias.startsWith(mentionQuery, ignoreCase = true)) ||
                                    (!it.path.isNullOrBlank() && it.path.contains(mentionQuery, ignoreCase = true)) ||
                                    it.summary.contains(mentionQuery, ignoreCase = true)
                        }
                        val matches = memberMatches.isNotEmpty()
                        DropdownMenu(
                            expanded = memberMatches.isNotEmpty() || aliasMatches.isNotEmpty() || artifactMatches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            aliasMatches.forEach { alias ->
                                DropdownMenuItem(
                                    text = { Text("@$alias · ${S.aliasGroupTag}") },
                                    onClick = {
                                        val at = input.lastIndexOf('@')
                                        input = input.substring(0, at) + "@$alias "
                                    },
                                )
                            }
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
                                        S.eventCommand,
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
                IconButton(onClick = { pickImage.launch("*/*") }) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = S.uploadImage,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (vm.generating) {
                    if (input.isNotBlank() || vm.pendingAttachments.isNotEmpty()) {
                        Spacer(Modifier.size(4.dp))
                        FilledIconButton(
                            onClick = {
                                if (flowAbsorbing) {
                                    vm.sendRoomMessage(input.trim())
                                } else {
                                    vm.enqueueMessage(sessionKey, input.trim())
                                }
                                input = ""
                            },
                            modifier = Modifier.size(40.dp),
                        ) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = S.send)
                        }
                    }
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
    val bitmap by produceState<Bitmap?>(null, attachment.localPath ?: attachment.base64) {
        value = withContext(Dispatchers.IO) {
            try {
                val bytes = Base64.decode(attachment.readBase64(), Base64.NO_WRAP)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (kotlin.math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1024) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            } catch (_: Exception) {
                null
            }
        }
    }
    val bmp = bitmap
    if (bmp != null) {
        Image(
            bitmap = bmp.asImageBitmap(),
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
    val S = LocalStrings.current
    LazyRow(modifier = modifier.fillMaxWidth().height(96.dp)) {
        items(attachments, key = { (it.localPath ?: it.base64).hashCode() }) { a ->
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
                        contentDescription = S.removeAttachment,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun AuthorLabel(author: String) {
    val S = LocalStrings.current
    val display = fmtAuthor(author)
    if (author.isNotBlank() && author != S.authorMe && author != "我") {
        Text(
            buildAnnotatedString {
                // 成员色向主题 onSurfaceVariant 靠拢降饱和，深浅色模式自适应
                withStyle(SpanStyle(color = lerp(authorColor(author), MaterialTheme.colorScheme.onSurfaceVariant, 0.38f), fontWeight = FontWeight.SemiBold)) {
                    append(display)
                }
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.outline)) {
                    append(" ·")
                }
            },
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun MessageBubbleBox(
    copyText: String,
    fullText: String = copyText,
    quote: Pair<String, String>?,
    vm: ChatViewModel,
    itemId: String,
    canSelect: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val S = LocalStrings.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val selected = vm.selectedMessageIds.contains(itemId)

    Box(modifier = modifier) {
        if (vm.multiSelectMode) {
            Box(
                Modifier.combinedClickable(
                    onClick = { vm.toggleMessageSelection(itemId) },
                    onLongClick = { vm.toggleMessageSelection(itemId) },
                ),
            ) { content() }
            if (selected) {
                Box(
                    Modifier
                        .matchParentSize()
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(12.dp)),
                )
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(18.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        } else {
            SelectionContainer(
                modifier = Modifier.appendTextContextMenuComponents {
                    if (canSelect) {
                        item(key = "multi_select", label = S.multiSelect) {
                            vm.enterMultiSelect(itemId)
                            close()
                        }
                    }
                    item(key = "copy_full", label = S.copyFull) {
                        scope.launch {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, fullText)))
                        }
                        Toast.makeText(context, S.copied, Toast.LENGTH_SHORT).show()
                        close()
                    }
                    quote?.let { (author, text) ->
                        item(key = "quote", label = S.quoting) {
                            vm.quote = author to text
                            close()
                        }
                    }
                },
            ) { content() }
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
    item: ChatListItem,
    vm: ChatViewModel,
    showAuthor: Boolean,
    grouped: Boolean = false,
    highlight: String = "",
    isCurrentMatch: Boolean = false,
    isQuoted: Boolean = false,
    onMatchKeywordY: ((Float) -> Unit)? = null,
    flash: Boolean = false,
) {
    ChatBubbleContent(item, vm, showAuthor, grouped, highlight, isCurrentMatch, isQuoted, onMatchKeywordY, flash)
}

@Composable
private fun ChatBubbleContent(
    item: ChatListItem,
    vm: ChatViewModel,
    showAuthor: Boolean,
    grouped: Boolean,
    highlight: String,
    isCurrentMatch: Boolean,
    isQuoted: Boolean,
    onMatchKeywordY: ((Float) -> Unit)?,
    flash: Boolean = false,
) {
    when (item) {
        is ChatListItem.Other -> RawChatBubble(
            item.item,
            vm,
            showAuthor = showAuthor,
            highlight = highlight,
            isCurrentMatch = isCurrentMatch,
            isQuoted = isQuoted,
            onMatchKeywordY = onMatchKeywordY,
            grouped = grouped,
        )
        is ChatListItem.Message -> MessageBlock(
            item,
            vm,
            showAuthor = showAuthor,
            grouped = grouped,
            highlight = highlight,
            isCurrentMatch = isCurrentMatch,
            isQuoted = isQuoted,
            onMatchKeywordY = onMatchKeywordY,
        )
        is ChatListItem.ProcessGroup -> ProcessGroupBlock(
            item,
            vm,
            showAuthor = showAuthor,
            grouped = grouped,
            highlight = highlight,
            isCurrentMatch = isCurrentMatch,
            onMatchKeywordY = onMatchKeywordY,
        )
        is ChatListItem.FlowCard -> FlowCardBlock(
            item.item,
            vm,
            isCurrentMatch = isCurrentMatch,
            flash = flash,
        )
    }
}

@Composable
private fun MessageBlock(
    item: ChatListItem.Message,
    vm: ChatViewModel,
    showAuthor: Boolean,
    grouped: Boolean = false,
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

    val (topStart, topEnd, bottomEnd, bottomStart) = when {
        item.isUser && item.isFirst && item.isLast -> listOf(18.dp, 18.dp, 4.dp, 18.dp)
        item.isUser && item.isFirst -> listOf(18.dp, 18.dp, 0.dp, 0.dp)
        item.isUser && item.isLast -> listOf(0.dp, 0.dp, 4.dp, 18.dp)
        item.isUser -> listOf(0.dp, 0.dp, 0.dp, 0.dp)
        item.isFirst && item.isLast -> listOf(18.dp, 18.dp, 18.dp, 4.dp)
        item.isFirst -> listOf(18.dp, 18.dp, 0.dp, 0.dp)
        item.isLast -> listOf(0.dp, 0.dp, 18.dp, 4.dp)
        else -> listOf(0.dp, 0.dp, 0.dp, 0.dp)
    }
    val shape = RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart)
    val blockTop = if (item.isFirst) (if (grouped) 1.dp else 4.dp) else 0.dp
    val blockBottom = if (item.isLast) 4.dp else 0.dp

    if (item.isUser) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimaryContainer
            val quoteColor = textColor.copy(alpha = 0.7f)
            MessageBubbleBox(
                copyText = item.content,
                fullText = item.text,
                quote = item.author to item.text,
                vm = vm,
                itemId = item.id,
                canSelect = true,
                modifier = bubbleModifier.padding(top = blockTop, bottom = blockBottom),
            ) {
                Surface(
                    shape = shape,
                    color = bgColor,
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        if (item.isFirst && item.quoteAuthor != null) {
                            Text(
                                "${S.quoting} @${item.quoteAuthor}: ${item.quoteText?.take(80).orEmpty()}",
                                style = MaterialTheme.typography.bodySmall,
                                color = quoteColor,
                                maxLines = 2,
                            )
                            Spacer(Modifier.height(4.dp))
                        }
                        if (item.content.isNotBlank()) {
                            MarkdownText(
                                text = item.content,
                                modifier = Modifier
                                    .heightIn(max = 600.dp)
                                    .verticalScroll(rememberScrollState()),
                                textColor = textColor,
                                fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                                highlight = highlight,
                                onMatchKeywordY = keywordCallback,
                                streaming = vm.isStreamingTail(item.originalId),
                            )
                        }
                        if (item.isFirst && item.attachments.isNotEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            LazyRow(Modifier.height(120.dp)) {
                                items(item.attachments, key = { (it.localPath ?: it.base64).hashCode() }) { a ->
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
    } else {
        Column(Modifier.padding(top = blockTop, bottom = blockBottom)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.85f) else MaterialTheme.colorScheme.surfaceVariant
            val textColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.content,
                fullText = item.text,
                quote = item.author to item.text,
                vm = vm,
                itemId = item.id,
                canSelect = true,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    color = bgColor,
                ) {
                    MarkdownText(
                        text = item.content,
                        modifier = Modifier
                            .heightIn(max = 600.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        textColor = textColor,
                        fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                        highlight = highlight,
                        onMatchKeywordY = keywordCallback,
                    )
                }
            }
            if (item.isLast && item.usage != null) {
                Text(
                    item.usage.format(S),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(start = 14.dp, top = 2.dp, bottom = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun ProcessGroupBlock(
    item: ChatListItem.ProcessGroup,
    vm: ChatViewModel,
    showAuthor: Boolean,
    grouped: Boolean = false,
    highlight: String = "",
    isCurrentMatch: Boolean = false,
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    val S = LocalStrings.current
    var expanded by remember { mutableStateOf(false) }
    val textColor = MaterialTheme.colorScheme.onSurfaceVariant
    val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
    val keywordCallback = if (isCurrentMatch) onMatchKeywordY else null
    Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (grouped) 1.dp else 4.dp)) {
        if (showAuthor) AuthorLabel(item.author)
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = bgColor),
        ) {
            Column(Modifier.padding(12.dp)) {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(
                        (if (expanded) "▾ " else "▸ ") + "${S.processSteps.format(item.items.size)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = textColor,
                    )
                }
                if (expanded) {
                    Spacer(Modifier.height(4.dp))
                    item.items.reversed().forEach { child ->
                        RawChatBubble(
                            child,
                            vm,
                            showAuthor = false,
                            highlight = highlight,
                            isCurrentMatch = false,
                            isQuoted = false,
                            onMatchKeywordY = keywordCallback,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProcessCardBlock(
    item: ChatItem.Process,
    vm: ChatViewModel,
    showAuthor: Boolean,
    grouped: Boolean = false,
    highlight: String = "",
    isCurrentMatch: Boolean = false,
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    val S = LocalStrings.current
    var expanded by remember { mutableStateOf(false) }
    val key = vm.processKey(item)
    val children = vm.processItems[key]
    val loading = vm.processLoading[key] == true
    val unavailable = vm.processUnavailable[key] == true
    val failed = vm.processErrors[key]
    val running = item.turnEndAt <= 0L || item.status == "running"
    val isDispatch = item.cardType == "dispatch" || item.dispatchTasks.isNotEmpty() || item.dispatchCount > 0
    val dispatchCount = item.dispatchTasks.size.takeIf { it > 0 } ?: item.dispatchCount
    val textColor = MaterialTheme.colorScheme.onSurfaceVariant
    val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
    val keywordCallback = if (isCurrentMatch) onMatchKeywordY else null
    Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (grouped) 1.dp else 4.dp)) {
        if (showAuthor) AuthorLabel(item.author)
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = bgColor),
        ) {
            Column(Modifier.padding(12.dp)) {
                TextButton(onClick = {
                    expanded = !expanded
                    if (expanded && !isDispatch) vm.loadProcessCard(item)
                }) {
                    Text(
                        (if (expanded) "▾ " else "▸ ") +
                            if (isDispatch) S.dispatchCollapsedFmt.format(dispatchCount)
                            else S.processCardFmt.format(item.author, item.steps.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = textColor,
                    )
                }
                if (expanded && isDispatch) {
                    Spacer(Modifier.height(4.dp))
                    if (item.dispatchTasks.isEmpty()) {
                        Text(
                            S.processEmpty,
                            style = MaterialTheme.typography.bodySmall,
                            color = textColor,
                        )
                    } else {
                        item.dispatchTasks.forEach { t ->
                            val label = listOfNotNull(
                                t.id,
                                t.to?.let { "@$it" },
                                t.task,
                            ).joinToString("  ")
                            if (label.isNotBlank()) {
                                HighlightText(
                                    text = label,
                                    highlight = highlight,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = textColor,
                                    onMatchKeywordY = keywordCallback,
                                    modifier = Modifier.padding(vertical = 1.dp),
                                )
                            }
                        }
                    }
                } else if (expanded) {
                    Spacer(Modifier.height(4.dp))
                    when {
                        !children.isNullOrEmpty() -> children.reversed().forEach { child ->
                            RawChatBubble(
                                child,
                                vm,
                                showAuthor = false,
                                highlight = highlight,
                                isCurrentMatch = false,
                                isQuoted = false,
                                onMatchKeywordY = keywordCallback,
                            )
                        }
                        unavailable -> {
                            if (item.steps.isNotEmpty()) {
                                ProcessStepList(item.steps, textColor, highlight, keywordCallback)
                            }
                            Text(
                                S.processUnavailable,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        children == null -> Text(
                            failed?.let { S.loadFailedFmt.format(it) }
                                ?: if (loading || !running) S.processLoading else S.processRunningHint,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (failed != null) MaterialTheme.colorScheme.error else textColor,
                        )
                        else -> {
                            if (item.steps.isNotEmpty()) {
                                ProcessStepList(item.steps, textColor, highlight, keywordCallback)
                            } else {
                                Text(
                                    if (running) S.processRunningHint else S.processEmpty,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = textColor,
                                )
                            }
                        }
                    }
                    if (failed != null && children != null) {
                        Text(
                            S.loadFailedFmt.format(failed),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProcessStepList(
    steps: List<ChatItem.ProcessStep>,
    color: Color,
    highlight: String,
    onMatchKeywordY: ((Float) -> Unit)?,
) {
    Column(
        Modifier
            .heightIn(max = 280.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        steps.forEach { s ->
            val label = when (s.kind) {
                "tool" -> "🔧 ${s.title ?: s.text.orEmpty()}"
                "plan" -> "📋 ${s.title ?: s.text.orEmpty()}"
                else -> s.text ?: s.title.orEmpty()
            }
            if (label.isNotBlank()) {
                HighlightText(
                    text = label.trim(),
                    highlight = highlight,
                    style = MaterialTheme.typography.bodySmall,
                    color = color,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    onMatchKeywordY = onMatchKeywordY,
                    modifier = Modifier.padding(vertical = 1.dp),
                )
            }
        }
    }
}



/** 过程区紧凑步骤行（与 desktop ProcessSteps 同构）：图标 + 一行标题/状态，不走气泡 chrome */
@Composable
private fun ProcessStepLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(modifier.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(12.dp), tint = color)
        Spacer(Modifier.width(6.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ProcessStepRow(item: ChatItem) {
    val S = LocalStrings.current
    when (item) {
        is ChatItem.Tool -> ProcessStepLine(
            Icons.Filled.Build,
            "${item.title} · ${toolStatusLabel(S, item.status)}",
        )
        is ChatItem.Plan -> ProcessStepLine(
            Icons.Filled.Menu,
            item.entries.joinToString("；") { planEntryLabel(S, it) },
        )
        is ChatItem.Thought -> {
            var expanded by remember(item.id) { mutableStateOf(false) }
            Column {
                ProcessStepLine(
                    Icons.Filled.Bolt,
                    item.text.replace("\n", " "),
                    Modifier.clickable { expanded = !expanded },
                )
                if (expanded) {
                    Text(
                        item.text,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 18.dp, top = 1.dp, bottom = 2.dp),
                    )
                }
            }
        }
        else -> {}
    }
}

@Composable
private fun TaskProcessSection(roomId: String, task: FlowTask, vm: ChatViewModel) {
    val S = LocalStrings.current
    val key = "task:$roomId:${task.id}"
    val items = vm.processItems[key]
    val unavailable = vm.processUnavailable[key] == true
    val failed = vm.processErrors[key]
    LaunchedEffect(task.sessionId, task.status) {
        if (task.status == "running") {
            while (true) {
                vm.loadTaskProcess(roomId, task)
                delay(2000)
                if (vm.processUnavailable[key] == true) break
            }
        } else {
            vm.loadTaskProcess(roomId, task)
        }
    }
    val procScroll = rememberScrollState()
    // 首次拿到条目滚底；之后仅视口本已贴底（canScrollForward==false）时跟随新条目，
    // 用户上翻不打断。canScrollForward 须在等帧前采样——等帧后新条目已布局，
    // maxValue 变大，贴底判定会永远为 false
    val initialScrolled = remember(key) { mutableStateOf(false) }
    LaunchedEffect(items) {
        if (items.isNullOrEmpty()) return@LaunchedEffect
        val follow = !initialScrolled.value || !procScroll.canScrollForward
        if (!follow) return@LaunchedEffect
        initialScrolled.value = true
        withFrameNanos { }
        procScroll.scrollTo(procScroll.maxValue)
    }
    Column(
        Modifier
            .padding(start = 20.dp, top = 2.dp)
            .heightIn(max = 280.dp)
            .verticalScroll(procScroll),
    ) {
        when {
            !items.isNullOrEmpty() -> items.forEach { child ->
                ProcessStepRow(child)
            }
            unavailable -> Text(
                S.processUnavailable,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            items == null -> Text(
                failed?.let { S.loadFailedFmt.format(it) } ?: S.processLoading,
                style = MaterialTheme.typography.bodySmall,
                color = if (failed != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> Text(
                if (task.status == "running") S.processRunningHint else S.processEmpty,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (failed != null && items != null) {
            Text(
                S.loadFailedFmt.format(failed),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (task.status == "running" && !items.isNullOrEmpty()) {
            Text(
                S.processRunningHint,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.tertiary,
            )
        }
    }
}

@Composable
private fun RawChatBubble(
    item: ChatItem,
    vm: ChatViewModel,
    showAuthor: Boolean,
    highlight: String = "",
    isCurrentMatch: Boolean = false,
    isQuoted: Boolean = false,
    onMatchKeywordY: ((Float) -> Unit)? = null,
    grouped: Boolean = false,
    compact: Boolean = false,
    /** 外层已有滚动容器（如过程钻取区）时置 false：子项不再自带限高内滚动，避免嵌套滚动裁切/空白 */
    innerScroll: Boolean = true,
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
        is ChatItem.System -> {
            Box(
                Modifier.fillMaxWidth().padding(vertical = if (compact) 1.dp else 6.dp),
                contentAlignment = Alignment.Center,
            ) {
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.65f) else MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f)
            val textColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
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
                        style = MaterialTheme.typography.labelSmall,
                        color = textColor,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 5.dp),
                    )
                }
            }
        }
        }

        is ChatItem.User -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.primaryContainer
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimaryContainer
            val quoteColor = textColor.copy(alpha = 0.7f)
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = true,
                modifier = bubbleModifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp),
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
                                modifier = Modifier
                                    .heightIn(max = 400.dp)
                                    .verticalScroll(rememberScrollState()),
                                textColor = textColor,
                                fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                                highlight = highlight,
                                onMatchKeywordY = keywordCallback,
                            )
                        }
                        if (item.attachments.isNotEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            LazyRow(Modifier.height(120.dp)) {
                                items(item.attachments, key = { (it.localPath ?: it.base64).hashCode() }) { a ->
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

        is ChatItem.Assistant -> Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.85f) else MaterialTheme.colorScheme.surfaceVariant
            val textColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = true,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
                    color = bgColor,
                ) {
                    MarkdownText(
                        text = item.text,
                        modifier = Modifier
                            .then(if (innerScroll) Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState()) else Modifier)
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        textColor = textColor,
                        fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                        highlight = highlight,
                        onMatchKeywordY = keywordCallback,
                        streaming = vm.generating && vm.chatItems.lastOrNull() === item,
                    )
                }
            }
            if (item.usage != null) {
                Text(
                    item.usage.format(S),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(start = 14.dp, top = 2.dp, bottom = 4.dp),
                )
            }
        }

        is ChatItem.Thought -> {
            var expanded by remember(isCurrentMatch) { mutableStateOf(isCurrentMatch) }
            val textColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = true,
                modifier = bubbleModifier.padding(top = if (grouped) 1.dp else 2.dp, bottom = if (compact) 1.dp else 2.dp),
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
                                    .then(if (innerScroll) Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()) else Modifier)
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

        is ChatItem.Tool -> Column(Modifier.padding(top = if (grouped) 1.dp else 3.dp, bottom = if (compact) 1.dp else 3.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.4f)
            val textColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = "[${item.title}] ${toolStatusLabel(S, item.status)}",
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
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
                            toolStatusLabel(S, item.status),
                            highlight,
                            onMatchKeywordY = keywordCallback,
                            style = MaterialTheme.typography.bodySmall,
                            color = textColor,
                        )
                    }
                }
            }
        }

        is ChatItem.Plan -> Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
            MessageBubbleBox(
                copyText = "${S.plan}\n${item.entries.joinToString("\n") { planEntryLabel(S, it) }}",
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
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
                                planEntryLabel(S, it),
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
            val text = (if (item.author.isNotBlank()) "[${fmtAuthor(item.author)}] " else "") +
                "${S.errorTag}: ${item.text}"
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error
            MessageBubbleBox(
                copyText = text,
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
                modifier = bubbleModifier.padding(vertical = if (compact) 1.dp else 4.dp),
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

        is ChatItem.Decision -> Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            DecisionCardBlock(item, vm, isCurrentMatch, highlight, onMatchKeywordY, bubbleModifier)
        }

        is ChatItem.Permission -> Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
            val answeredColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.title,
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
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
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item.options.forEach { (id, name) ->
                                    OutlinedButton(
                                        onClick = { vm.answerPermission(item.requestId, id, name) },
                                        shape = RoundedCornerShape(12.dp),
                                    ) { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                }
                            }
                        }
                    }
                }
            }
        }

        is ChatItem.Elicitation -> Column(Modifier.padding(top = if (grouped) 1.dp else 4.dp, bottom = if (compact) 1.dp else 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.6f) else MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)
            val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
            val answeredColor = MaterialTheme.colorScheme.onSurfaceVariant
            MessageBubbleBox(
                copyText = item.message,
                quote = null,
                vm = vm,
                itemId = item.id.toString(),
                canSelect = false,
                modifier = bubbleModifier.fillMaxWidth(),
            ) {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = bgColor),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            S.elicitationTitle,
                            style = MaterialTheme.typography.titleSmall,
                            color = textColor,
                        )
                        if (item.message.isNotBlank()) {
                            Spacer(Modifier.height(4.dp))
                            Text(item.message, style = MaterialTheme.typography.bodySmall, color = textColor)
                        }
                        Spacer(Modifier.height(8.dp))
                        if (item.answered != null) {
                            Text(
                                when (item.answered) {
                                    "accepted" -> S.outcomeAccepted
                                    "declined" -> S.outcomeDeclined
                                    else -> S.outcomeCancelled
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = answeredColor,
                            )
                        } else {
                            val values = remember(item.requestId) {
                                mutableStateMapOf<String, JsonElement>().apply {
                                    item.fields.forEach { f ->
                                        val d = f.defaultValue
                                        when {
                                            d != null -> put(f.name, d)
                                            f.type == "boolean" -> put(f.name, JsonPrimitive(false))
                                            f.type == "array" -> put(f.name, JsonArray(emptyList()))
                                            else -> put(f.name, JsonPrimitive(""))
                                        }
                                    }
                                }
                            }
                            fun fieldSatisfied(f: ElicitationField): Boolean {
                                val v = values[f.name] ?: return false
                                return when (f.type) {
                                    "boolean" -> true
                                    "array" -> (v as? JsonArray)?.isNotEmpty() == true
                                    "number" -> v.jsonPrimitive.content.toDoubleOrNull() != null
                                    "integer" -> v.jsonPrimitive.content.toLongOrNull() != null
                                    else -> v.jsonPrimitive.content.isNotBlank()
                                }
                            }
                            val canSubmit = item.fields.all { !it.required || fieldSatisfied(it) }
                            item.fields.forEach { f ->
                                Spacer(Modifier.height(8.dp))
                                if (f.type != "boolean") {
                                    Text(
                                        f.label + if (f.required) " *" else "",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = textColor,
                                    )
                                }
                                if (!f.description.isNullOrBlank()) {
                                    Text(
                                        f.description,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = answeredColor,
                                    )
                                }
                                when {
                                    f.type == "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
                                        Checkbox(
                                            checked = values[f.name]?.jsonPrimitive?.booleanOrNull == true,
                                            onCheckedChange = { values[f.name] = JsonPrimitive(it) },
                                        )
                                        Text(f.label, style = MaterialTheme.typography.bodySmall, color = textColor)
                                    }
                                    f.type == "array" && f.options.isNotEmpty() -> Column {
                                        val selected = (values[f.name] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
                                        f.options.forEach { o ->
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Checkbox(
                                                    checked = selected.contains(o.value),
                                                    onCheckedChange = { checked ->
                                                        values[f.name] = JsonArray(
                                                            if (checked) (selected + o.value).map { JsonPrimitive(it) }
                                                            else selected.filter { it != o.value }.map { JsonPrimitive(it) }
                                                        )
                                                    },
                                                )
                                                Text(o.label, style = MaterialTheme.typography.bodySmall, color = textColor)
                                            }
                                        }
                                    }
                                    f.type == "array" -> OutlinedTextField(
                                        value = (values[f.name] as? JsonArray)?.joinToString(",") { it.jsonPrimitive.content } ?: "",
                                        onValueChange = { s ->
                                            values[f.name] = JsonArray(s.split(",").map { it.trim() }.filter { it.isNotEmpty() }.map { JsonPrimitive(it) })
                                        },
                                        placeholder = { Text(S.commaSeparatedHint) },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    f.type == "number" || f.type == "integer" -> OutlinedTextField(
                                        value = values[f.name]?.jsonPrimitive?.content ?: "",
                                        onValueChange = { values[f.name] = JsonPrimitive(it) },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    f.options.isNotEmpty() -> Column(
                                        verticalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        f.options.forEach { o ->
                                            FilterChip(
                                                selected = values[f.name]?.jsonPrimitive?.contentOrNull == o.value,
                                                onClick = { values[f.name] = JsonPrimitive(o.value) },
                                                label = { Text(o.label) },
                                            )
                                        }
                                    }
                                    else -> OutlinedTextField(
                                        value = values[f.name]?.jsonPrimitive?.content ?: "",
                                        onValueChange = { values[f.name] = JsonPrimitive(it) },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    enabled = canSubmit,
                                    onClick = {
                                        val content = mutableMapOf<String, JsonElement>()
                                        item.fields.forEach { f ->
                                            val v = values[f.name] ?: return@forEach
                                            if (f.type == "integer") {
                                                v.jsonPrimitive.content.toLongOrNull()?.let { content[f.name] = JsonPrimitive(it) }
                                            } else if (f.type == "number") {
                                                v.jsonPrimitive.content.toDoubleOrNull()?.let { content[f.name] = JsonPrimitive(it) }
                                            } else if (f.type == "string" && f.options.isEmpty() && v.jsonPrimitive.content.isBlank() && !f.required) {
                                            } else {
                                                content[f.name] = v
                                            }
                                        }
                                        vm.answerElicitation(item.requestId, "accept", content)
                                    },
                                ) { Text(S.actionSubmit) }
                                OutlinedButton(
                                    onClick = { vm.answerElicitation(item.requestId, "decline") },
                                ) { Text(S.actionDecline) }
                            }
                        }
                    }
                }
            }
        }

        is ChatItem.Process -> ProcessCardBlock(
            item,
            vm,
            showAuthor = showAuthor,
            grouped = grouped,
            highlight = highlight,
            isCurrentMatch = isCurrentMatch,
            onMatchKeywordY = keywordCallback,
        )

        is ChatItem.Flow -> FlowCardBlock(
            item,
            vm,
            isCurrentMatch = isCurrentMatch,
        )

    }
}


private fun formatElapsed(start: Long, end: Long, S: Strings): String {
    val s = maxOf(0L, (end - start) / 1000)
    if (s < 60) return S.elapsedSecFmt.format(s)
    val m = s / 60
    if (m < 60) return S.elapsedMinFmt.format(m, s % 60)
    return S.elapsedHourFmt.format(m / 60, m % 60)
}

/** 编排消息卡：锚定在房史流中；vm.flow.flowId 匹配时走实时数据，否则渲染内嵌快照 */
@Composable
private fun FlowCardBlock(
    item: ChatItem.Flow,
    vm: ChatViewModel,
    isCurrentMatch: Boolean = false,
    flash: Boolean = false,
) {
    val S = LocalStrings.current
    val live = vm.flow
    val isLive = live != null && live.flowId.ifEmpty { "__live" } == item.flowId
    val flow = if (isLive) live else item.snapshot
    val terminal = flow.phase == "done" || flow.phase == "cancelled"
    // 折叠默认：进行中展开、终态折叠；用户手动选择后按 flowId 记忆（-1 未选/0 展开/1 折叠）
    var collapsedChoice by rememberSaveable(item.flowId) { mutableStateOf(-1) }
    val collapsed = if (collapsedChoice >= 0) collapsedChoice == 1 else terminal
    // 进行中卡片每秒刷新耗时
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(terminal, flow.finishedAt > 0) {
        while (!terminal && flow.finishedAt <= 0L) {
            delay(1000)
            nowTick = System.currentTimeMillis()
        }
    }
    val progress = flow.progress
    val title = if (flow.mode == "conductor") S.flowTitleConductor else S.flowTitleRoom
    val phaseLabel = when (flow.phase) {
        "planning" -> S.phasePlanning
        "awaiting-input" -> S.flowAwaitingInput
        "working" -> S.phaseWorking
        "reviewing" -> S.phaseReviewing
        "summarizing" -> S.phaseSummarizing
        "awaiting-retry" -> S.phaseAwaitingRetry
        "done" -> S.phaseDone
        "cancelled" -> S.phaseCancelled
        else -> ""
    }
    val phaseTagColor = when (flow.phase) {
        "done" -> MaterialTheme.colorScheme.primaryContainer
        "cancelled" -> MaterialTheme.colorScheme.errorContainer
        "awaiting-retry" -> MaterialTheme.colorScheme.tertiaryContainer
        else -> MaterialTheme.colorScheme.surface
    }
    val phaseTagTextColor = when (flow.phase) {
        "done" -> MaterialTheme.colorScheme.onPrimaryContainer
        "cancelled" -> MaterialTheme.colorScheme.onErrorContainer
        "awaiting-retry" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val showRetry = isLive && flow.phase == "awaiting-retry"
    val canCancel = isLive &&
        flow.phase !in setOf("done", "summarizing", "reviewing", "cancelled")
    val waitingOnUser = flow.tasks.any { it.waitingFor == "user" }
    val bgColor = when {
        flash -> MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
        isCurrentMatch -> MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f)
        else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = bgColor),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsedChoice = if (collapsed) 0 else 1 },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} $title",
                    style = MaterialTheme.typography.titleSmall,
                )
                if (phaseLabel.isNotEmpty()) {
                    Spacer(Modifier.width(6.dp))
                    Surface(
                        color = phaseTagColor,
                        shape = RoundedCornerShape(4.dp),
                    ) {
                        Text(
                            phaseLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = phaseTagTextColor,
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                        )
                    }
                }
                if (waitingOnUser) {
                    Spacer(Modifier.width(6.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(4.dp),
                    ) {
                        Text(
                            S.helpWanted,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                if (flow.tasks.isNotEmpty()) {
                    Text(
                        S.flowProgressFmt.format(progress.done, progress.total, progress.running, progress.pending) +
                            if (progress.failed > 0) S.flowProgressFailed.format(progress.failed) else "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (flow.startedAt > 0 || progress.total > 0) {
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (progress.total > 0) {
                        LinearProgressIndicator(
                            progress = {
                                if (progress.total > 0) progress.done.toFloat() / progress.total else 0f
                            },
                            modifier = Modifier
                                .weight(1f)
                                .height(4.dp)
                                .clip(RoundedCornerShape(2.dp)),
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    val endAt = if (flow.finishedAt > 0) flow.finishedAt
                        else if (terminal) 0L else nowTick
                    val elapsed = if (flow.startedAt > 0 && endAt > flow.startedAt)
                        formatElapsed(flow.startedAt, endAt, S) else ""
                    val meta = buildString {
                        if (flow.startedAt > 0) append(formatArtifactTime(flow.startedAt))
                        if (elapsed.isNotEmpty()) {
                            if (isNotEmpty()) append(" · ")
                            append(S.flowElapsedFmt.format(elapsed))
                        }
                    }
                    if (meta.isNotEmpty()) {
                        Text(
                            meta,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                            maxLines = 1,
                            softWrap = false,
                        )
                    }
                }
            }
            if (collapsed) {
                // 折叠态：终态一行摘要；进行中列出 running/失败任务（与桌面端同构）
                val collapsedLines = mutableListOf<Pair<String, Boolean>>()
                if (flow.phase == "done") {
                    collapsedLines.add(
                        ("✓ ${progress.done}/${progress.total}" +
                            (if (flow.finishedAt > 0 && flow.startedAt > 0)
                                " · " + S.flowElapsedFmt.format(formatElapsed(flow.startedAt, flow.finishedAt, S))
                            else "") +
                            if (progress.failed > 0) S.flowProgressFailed.format(progress.failed) else "") to false,
                    )
                } else if (flow.phase == "cancelled") {
                    collapsedLines.add(S.phaseCancelled to false)
                } else {
                    flow.tasks.filter { it.status == "running" }.take(2).forEach { t ->
                        collapsedLines.add("@${t.name} ${t.task}" to false)
                    }
                    if (flow.phase == "awaiting-retry") {
                        collapsedLines.add(S.flowInterruptedRetry to true)
                    }
                    flow.tasks.firstOrNull { it.status == "failed" }?.let { t ->
                        collapsedLines.add("✗ @${t.name} ${t.task}" to true)
                    }
                    if (collapsedLines.isEmpty() && progress.pending > 0) {
                        collapsedLines.add(S.flowCardPendingFmt.format(progress.pending) to false)
                    }
                }
                collapsedLines.forEach { (line, danger) ->
                    Spacer(Modifier.height(2.dp))
                    Text(
                        line,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (!collapsed) {
                flow.goal?.takeIf { it.isNotBlank() }?.let { goal ->
                    Spacer(Modifier.height(4.dp))
                    Text(
                        goal,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (flow.acceptanceCriteria.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        S.flowAcceptanceTitle,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        S.flowAcceptanceCaution,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    flow.acceptanceCriteria.forEachIndexed { i, c ->
                        Text(
                            "${i + 1}. $c",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                }
                if (flow.phase == "done") {
                    HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    Column(Modifier.fillMaxWidth()) {
                            Text(
                                S.finalSummary,
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(2.dp))
                            Text(
                                S.summaryCompleted.format(progress.done, progress.total),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (flow.supplements.isNotEmpty()) {
                                Text(
                                    S.summaryAdopted.format(flow.supplements.size),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            val verificationCount = flow.tasks.sumOf { it.verifications.size }
                            if (verificationCount > 0) {
                                Text(
                                    S.summaryVerified.format(verificationCount),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                }
                Spacer(Modifier.height(6.dp))
                flow.tasks.forEach { task ->
                    FlowTaskRow(task, showRetry, vm, flow.roomId) { vm.retryTask(task.id) }
                }
                if (flow.supplements.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        S.supplementCount.format(flow.supplements.size),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    flow.supplements.takeLast(5).forEach { s ->
                        Text(
                            "· ${s.take(200)}",
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (canCancel || showRetry) {
                    Spacer(Modifier.height(6.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        if (canCancel) {
                            OutlinedButton(
                                onClick = { vm.cancelFlow() },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(S.interruptFlow, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                            }
                        }
                        if (showRetry) {
                            if (canCancel) Spacer(Modifier.width(8.dp))
                            OutlinedButton(
                                onClick = { vm.retryFailedTasks() },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(S.retryAllFailed, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FlowTaskRow(task: FlowTask, showRetry: Boolean, vm: ChatViewModel, roomId: String, onRetry: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var processExpanded by remember { mutableStateOf(false) }
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
    val S = LocalStrings.current
    val hasDetail = task.status == "done" || task.output != null || task.failureMessage != null ||
        task.dependsOn.isNotEmpty() || task.retries > 0 || task.waitingFor != null ||
        task.verifications.isNotEmpty() || task.backendRuns.isNotEmpty()
    val showRetryBtn = showRetry && task.status == "failed"
    Column(Modifier.padding(vertical = 1.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = if (hasDetail) Modifier.clickable { expanded = !expanded } else Modifier,
        ) {
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
            if (task.retries > 0) {
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(4.dp),
                ) {
                    Text(S.retryBadge.format(task.retries), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                }
                Spacer(Modifier.width(4.dp))
            }
            if (hasDetail) {
                Text(if (expanded) "▾" else "▸", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
        }
        task.waitingFor?.let { target ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 20.dp, top = 2.dp),
            ) {
                Text(
                    "${S.waitingReply.format(if (target == "user") S.you else "@$target")}${task.waitingQuestion.orEmpty().take(160)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (target == "user") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (target == "user" && task.waitingHelpId != null) {
                    Spacer(Modifier.width(6.dp))
                    TextButton(
                        onClick = { vm.startHelpReply(task.waitingHelpId) },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                    ) {
                        Text(S.helpReplyAction, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .padding(start = 20.dp)
                .clickable { processExpanded = !processExpanded },
        ) {
            Text(
                if (processExpanded) "▾" else "▸",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.width(4.dp))
            Text(
                S.viewProcess,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        if (processExpanded) {
            TaskProcessSection(roomId, task, vm)
        }
        if (expanded && hasDetail) {
            Column(Modifier.padding(start = 20.dp, top = 4.dp)) {
                Text(
                    task.task,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 240.dp)
                        .verticalScroll(rememberScrollState()),
                )
                if (task.status == "done") {
                    val statusText = when (task.verificationStatus) {
                        "member_pass" -> S.verificationStatusMemberPass
                        "member_nonpass" -> S.verificationStatusMemberNonpass
                        "unverified" -> S.verificationStatusUnverified
                        else -> {
                            val vs = task.verifications.map { it.verdict.trim().lowercase() }
                            when {
                                vs.isEmpty() -> S.verificationStatusUnverified
                                vs.any { it != "pass" } -> S.verificationStatusMemberNonpass
                                else -> S.verificationStatusMemberPass
                            }
                        }
                    }
                    Text("${S.verificationStatusLabel}$statusText", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val acHasExtra = task.automaticCheckSnapshot != null || task.automaticCheckTruncated || task.automaticCheckSnapshotCurrent == false
                    val acText = if (task.automaticCheckStatus == "exited_zero" && !acHasExtra) null else when (task.automaticCheckStatus) {
                        "exited_zero" -> S.automaticCheckExitedZero
                        "exited_nonzero" -> task.automaticCheckExitCode
                            ?.let { S.automaticCheckExitedNonzero.format(it) }
                            ?: S.automaticCheckBlocked
                        "blocked" -> S.automaticCheckBlocked +
                            ((when (task.automaticCheckReason) {
                                "check_unapproved" -> S.checkUnapproved
                                "command_mismatch" -> S.checkCommandMismatch
                                else -> task.automaticCheckReason
                            })?.let { "（$it）" } ?: "")
                        "timed_out" -> S.automaticCheckTimedOut
                        else -> S.automaticCheckNotRun
                    }
                    if (acText != null) {
                        Text(
                            "${S.automaticCheckLabel}$acText",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val acExtra = listOfNotNull(
                        task.automaticCheckSnapshot?.take(12)?.let { S.automaticCheckSnapshot.format(it) },
                        if (task.automaticCheckSnapshotCurrent == true) S.snapshotCurrentTrue else null,
                        if (task.automaticCheckTruncated) S.automaticCheckTruncated else null,
                    ).joinToString(" · ")
                    if (acExtra.isNotEmpty()) {
                        Text(
                            acExtra,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (task.automaticCheckSnapshotCurrent == false) {
                        Text(
                            S.snapshotCurrentFalse,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                if (task.dependsOn.isNotEmpty()) {
                    Text("${S.dependsOnLabel}${task.dependsOn.joinToString(", ")}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                task.verifications.forEachIndexed { _, v ->
                    var expanded by remember(task.id, v.by, v.verdict) { mutableStateOf(false) }
                    Spacer(Modifier.height(2.dp))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { expanded = !expanded }
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "${S.verificationBy.format(v.by)}${v.verdict}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Icon(
                                imageVector = if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (v.evidence.isNotBlank()) {
                            Text(
                                v.evidence.take(400),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = if (expanded) Int.MAX_VALUE else 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (expanded) {
                            v.backendToolCallId?.let {
                                Text(S.backendVerificationCall.format(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                            }
                            v.evidenceDetail?.let { d ->
                                if (d.summary.isNotBlank()) {
                                    Text("${S.evidenceSummaryLabel}${d.summary}", style = MaterialTheme.typography.bodySmall)
                                }
                                if (d.command.isNotBlank() || d.exitCode != null || d.stdout.isNotBlank() || d.stderr.isNotBlank()) {
                                    Text(S.memberReportedLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                                }
                                if (d.command.isNotBlank()) {
                                    Text("${S.evidenceCommandLabel}${d.command}", style = MaterialTheme.typography.bodySmall)
                                }
                                d.exitCode?.let {
                                    Text("${S.evidenceExitCodeLabel}$it", style = MaterialTheme.typography.bodySmall)
                                }
                                if (d.stdout.isNotBlank()) {
                                    Text(
                                        "${S.evidenceStdoutLabel}\n${d.stdout}",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 10,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (d.stderr.isNotBlank()) {
                                    Text(
                                        "${S.evidenceStderrLabel}${d.stderr}",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 5,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (d.baseline.isNotBlank()) {
                                    Text(
                                        "${S.evidenceBaselineLabel}${d.baseline.take(500)}",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 5,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (d.diff.isNotBlank()) {
                                    Text(
                                        "${S.evidenceDiffLabel}${d.diff.take(1000)}",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 8,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (d.reproSteps.isNotEmpty()) {
                                    Text(S.evidenceReproStepsLabel, style = MaterialTheme.typography.bodySmall)
                                    Column {
                                        d.reproSteps.forEachIndexed { i, s ->
                                            Text("${i + 1}. $s", style = MaterialTheme.typography.bodySmall)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                val backendStatusText = when (task.backendClaimStatus) {
                    "matched" -> S.backendClaimMatchLabel
                    "missing_member_command" -> S.backendStatusMissingCommand
                    "missing_member_exit_code" -> S.backendStatusMissingExit
                    "no_completed_backend_run" -> S.backendStatusNoRun
                    "backend_exit_unknown" -> S.backendStatusUnknownExit
                    "backend_mismatch" -> S.backendStatusMismatch
                    else -> null
                }
                if (task.backendRuns.isNotEmpty() || (task.verifyCommand != null && backendStatusText != null)) {
                    Spacer(Modifier.height(2.dp))
                    Text(S.backendRunsLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                    task.backendRuns.forEach { r ->
                        if (r.status == "completed" && r.exitCode == null) return@forEach
                        val statusText = when (r.status) {
                            "completed" -> S.backendRunCompleted
                            "failed" -> S.backendRunFailed
                            else -> r.status
                        }
                        Text(
                            listOf(r.toolCallId, statusText, r.exitCode?.let { "${S.evidenceExitCodeLabel}$it" }).filter { it != null }.joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (backendStatusText != null) {
                        Text(
                            backendStatusText,
                            style = MaterialTheme.typography.labelSmall,
                            color = when (task.backendClaimStatus) {
                                "matched" -> MaterialTheme.colorScheme.primary
                                "backend_mismatch" -> MaterialTheme.colorScheme.error
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    } else if (task.backendClaimMatch) {
                        Text(S.backendClaimMatchLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
                if (task.baseline != null || task.diff != null || task.reproSteps.isNotEmpty() || task.verifyCommand != null || task.verifyCheckId != null) {
                    var deliverableExpanded by remember(task.id) { mutableStateOf(false) }
                    Spacer(Modifier.height(2.dp))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { deliverableExpanded = !deliverableExpanded }
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(S.deliverableEvidence, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                            Icon(
                                imageVector = if (deliverableExpanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (deliverableExpanded) {
                            task.baseline?.let { Text("${S.evidenceBaselineLabel}${it.take(500)}", style = MaterialTheme.typography.bodySmall, maxLines = 5, overflow = TextOverflow.Ellipsis) }
                            task.diff?.let { Text("${S.evidenceDiffLabel}${it.take(1000)}", style = MaterialTheme.typography.bodySmall, maxLines = 8, overflow = TextOverflow.Ellipsis) }
                            if (task.reproSteps.isNotEmpty()) {
                                Text(S.evidenceReproStepsLabel, style = MaterialTheme.typography.bodySmall)
                                Column {
                                    task.reproSteps.forEachIndexed { i, s ->
                                        Text("${i + 1}. $s", style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                            if (task.verifyCommand != null || task.verifyStdout != null || task.verifyStderr != null) {
                                Text(S.memberReportedLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                            }
                            task.verifyCommand?.let { cmd ->
                                Text(
                                    "${S.verificationCommandLabel}$cmd${task.verifyExitCode?.let { S.verificationExitCodeSuffix.format(it) } ?: ""}",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            task.verifyStdout?.let { Text("${S.evidenceStdoutLabel}\n$it", style = MaterialTheme.typography.bodySmall, maxLines = 10, overflow = TextOverflow.Ellipsis) }
                            task.verifyStderr?.let { Text("${S.evidenceStderrLabel}${it.take(500)}", style = MaterialTheme.typography.bodySmall, maxLines = 5, overflow = TextOverflow.Ellipsis) }
                            task.verifyCheckId?.let { Text(S.presetCheckRequested.format(it), style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
                task.output?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 240.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
                task.failureMessage?.let {
                    Spacer(Modifier.height(2.dp))
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
        if (showRetryBtn) {
            Spacer(Modifier.height(4.dp))
            OutlinedButton(
                onClick = onRetry,
                modifier = Modifier.padding(start = 20.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp),
            ) {
                Text("↻ ${S.retryAction}", style = MaterialTheme.typography.labelMedium)
            }
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
                            Toast.makeText(context, S.copied, Toast.LENGTH_SHORT).show()
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
    val S = LocalStrings.current
    val context = LocalContext.current
    var collapsed by remember { mutableStateOf(false) }
    var showClearConfirm by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<ArtifactInfo?>(null) }
    var managing by remember { mutableStateOf(false) }
    val selected = remember { mutableStateListOf<ArtifactInfo>() }
    var confirmRemoveSelected by remember { mutableStateOf(false) }
    var selectedArtifact by remember { mutableStateOf<ArtifactInfo?>(null) }
    val groups = mapOf("file" to artifacts)
    val kindLabel = { _: String -> S.fileLabel }
    val fileColor = MaterialTheme.colorScheme.primary
    val scroll = rememberScrollState()
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 280.dp)
            .padding(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
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
                    "${if (collapsed) "▸" else "▾"} ${S.artifactsTitle}",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (managing) {
                        Text(
                            S.deleteSelectedCount.format(selected.size),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (selected.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                            modifier = Modifier
                                .clickable(enabled = selected.isNotEmpty()) { confirmRemoveSelected = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            S.actionCancel,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = false; selected.clear() }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    } else {
                        Text(
                            S.actionClear,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { showClearConfirm = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            S.actionManage,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = true; selectedArtifact = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    Text(
                        S.itemCount.format(artifacts.size),
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
                                    Toast.makeText(context, S.quotedToast, Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.FormatQuote,
                                    contentDescription = S.actionQuote,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { vm.loadArtifactPreview(artifact) },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Visibility,
                                    contentDescription = S.actionPreview,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { vm.downloadArtifactFile(artifact) },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Download,
                                    contentDescription = S.actionDownload,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { confirmRemove = artifact; selectedArtifact = null },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = S.actionDelete,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(scroll),
                ) {
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
    }

    confirmRemove?.let { artifact ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(S.deleteArtifactTitle) },
            text = { Text(S.deleteArtifactMsg.format(artifact.summary)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeArtifact(artifact)
                        confirmRemove = null
                    },
                ) { Text(S.actionDelete) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = null }) { Text(S.actionCancel) }
            },
        )
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text(S.clearArtifactsTitle) },
            text = { Text(S.clearArtifactsMsg) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearArtifacts()
                        showClearConfirm = false
                    },
                ) { Text(S.actionClear) }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text(S.actionCancel) }
            },
        )
    }

    if (confirmRemoveSelected) {
        AlertDialog(
            onDismissRequest = { confirmRemoveSelected = false },
            title = { Text(S.deleteSelectedArtifactsTitle) },
            text = { Text(S.deleteSelectedArtifactsMsg.format(selected.size)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeArtifacts(selected.toList())
                        selected.clear()
                        managing = false
                        confirmRemoveSelected = false
                    },
                ) { Text(S.actionDelete) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemoveSelected = false }) { Text(S.actionCancel) }
            },
        )
    }
}

@Composable
private fun EventPanel(events: List<EventInfo>, vm: ChatViewModel) {
    if (events.isEmpty()) return
    val S = LocalStrings.current
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
            "add" -> S.eventAdd
            "modify" -> S.eventModify
            "delete" -> S.eventDelete
            "rename" -> S.eventRename
            "command" -> S.eventCommand
            "test" -> S.eventTest
            else -> S.eventOther
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
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { collapsed = !collapsed },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${if (collapsed) "▸" else "▾"} ${S.eventsTitle}",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (managing) {
                        Text(
                            S.deleteSelectedCount.format(selected.size),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (selected.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                            modifier = Modifier
                                .clickable(enabled = selected.isNotEmpty()) { confirmRemoveSelected = true }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        Text(
                            S.actionCancel,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = false; selected.clear(); selectedEvent = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    } else {
                        Box {
                            Text(
                                S.actionClear,
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
                                    text = { Text(S.clearAll) },
                                    onClick = {
                                        showClearMenu = false
                                        clearAction = null
                                        showClearConfirm = true
                                    },
                                )
                                actionOptions.forEach { action ->
                                    DropdownMenuItem(
                                        text = { Text(S.clearActionOnly.format(actionLabel(action))) },
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
                            S.actionManage,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .clickable { managing = true; selectedEvent = null }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    Text(
                        S.itemCount.format(events.size),
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
                                    Toast.makeText(context, S.quotedToast, Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.FormatQuote,
                                    contentDescription = S.actionQuote,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            IconButton(
                                onClick = { confirmRemove = event; selectedEvent = null },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Delete,
                                    contentDescription = S.actionDelete,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(scroll),
                ) {
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
                                            Toast.makeText(context, S.quotedToast, Toast.LENGTH_SHORT).show()
                                        },
                                        modifier = Modifier.size(28.dp),
                                    ) {
                                        Icon(
                                            imageVector = Icons.Filled.FormatQuote,
                                            contentDescription = S.actionQuote,
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
    }

    confirmRemove?.let { event ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(S.deleteEventTitle) },
            text = { Text(S.deleteEventMsg.format(event.summary)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeEvent(event)
                        confirmRemove = null
                        selectedEvent = null
                    },
                ) { Text(S.actionDelete) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = null }) { Text(S.actionCancel) }
            },
        )
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text(S.clearEventsTitle) },
            text = {
                Text(
                    if (clearAction == null) S.clearEventsMsg
                    else S.clearEventsActionMsg.format(actionLabel(clearAction))
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearEvents(clearAction)
                        showClearConfirm = false
                        clearAction = null
                    },
                ) { Text(S.actionClear) }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text(S.actionCancel) }
            },
        )
    }

    if (confirmRemoveSelected) {
        AlertDialog(
            onDismissRequest = { confirmRemoveSelected = false },
            title = { Text(S.deleteSelectedEventsTitle) },
            text = { Text(S.deleteSelectedEventsMsg.format(selected.size)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.removeEvents(selected.toList())
                        selected.clear()
                        managing = false
                        confirmRemoveSelected = false
                    },
                ) { Text(S.actionDelete) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemoveSelected = false }) { Text(S.actionCancel) }
            },
        )
    }
}

/** 常驻编排进度条：钉在胶囊区与消息列表之间；点按定位时间线中的编排卡，长按展开紧凑任务列表 */
@Composable
private fun FlowProgressStrip(
    vm: ChatViewModel,
    listState: LazyListState,
    messages: List<ChatListItem>,
    onFlash: (String) -> Unit,
) {
    val S = LocalStrings.current
    val flow = vm.flow ?: return
    if (flow.phase == "done" || flow.phase == "cancelled") return
    val scope = rememberCoroutineScope()
    var tasksExpanded by remember { mutableStateOf(false) }
    val progress = flow.progress
    val waitingOnUser = flow.tasks.any { it.waitingFor == "user" }
    val runningTask = flow.tasks.firstOrNull { it.status == "running" }
    val cardFlowId = flow.flowId.ifEmpty { "__live" }
    val phaseLabel = when (flow.phase) {
        "planning" -> S.phasePlanning
        "awaiting-input" -> S.flowAwaitingInput
        "working" -> S.phaseWorking
        "reviewing" -> S.phaseReviewing
        "summarizing" -> S.phaseSummarizing
        "awaiting-retry" -> S.phaseAwaitingRetry
        else -> ""
    }
    val phaseTagColor = when (flow.phase) {
        "awaiting-retry" -> MaterialTheme.colorScheme.tertiaryContainer
        else -> MaterialTheme.colorScheme.surface
    }
    val phaseTagTextColor = when (flow.phase) {
        "awaiting-retry" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val containerColor = if (waitingOnUser) {
        MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.45f)
    } else {
        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .padding(bottom = 2.dp),
    ) {
        Surface(
            color = containerColor,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = {
                        if (tasksExpanded) {
                            tasksExpanded = false
                        } else {
                            val idx = messages.indexOfFirst {
                                it is ChatListItem.FlowCard && it.item.flowId == cardFlowId
                            }
                            if (idx >= 0) {
                                scope.launch { listState.animateScrollToItem(idx) }
                                onFlash(cardFlowId)
                            } else {
                                tasksExpanded = true
                            }
                        }
                    },
                    onLongClick = { tasksExpanded = !tasksExpanded },
                ),
        ) {
            Column {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 32.dp)
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (phaseLabel.isNotEmpty()) {
                        Surface(color = phaseTagColor, shape = RoundedCornerShape(4.dp)) {
                            Text(
                                phaseLabel,
                                style = MaterialTheme.typography.labelSmall,
                                color = phaseTagTextColor,
                                modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                    }
                    if (progress.total > 0) {
                        Text(
                            "${progress.done}/${progress.total}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (waitingOnUser) {
                        Spacer(Modifier.width(6.dp))
                        Surface(
                            color = MaterialTheme.colorScheme.errorContainer,
                            shape = RoundedCornerShape(4.dp),
                        ) {
                            Text(
                                S.helpWanted,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                            )
                        }
                    }
                    if (runningTask != null) {
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "@${runningTask.name} ${runningTask.task}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                if (progress.total > 0) {
                    LinearProgressIndicator(
                        progress = { progress.done.toFloat() / progress.total },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(2.5.dp),
                    )
                }
            }
        }
        if (tasksExpanded) {
            Surface(
                color = containerColor,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 2.dp)
                    .clickable { tasksExpanded = false },
            ) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Text(
                        S.flowTasksTitle,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Column(
                        Modifier
                            .heightIn(max = 280.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        flow.tasks.forEach { FlowStripTaskRow(it) }
                    }
                }
            }
        }
    }
}

/** 统一决策卡：permission/elicitation 满宽卡，粒度选择 + 撤销入口 */
@Composable
private fun DecisionCardBlock(
    item: ChatItem.Decision,
    vm: ChatViewModel,
    isCurrentMatch: Boolean,
    highlight: String,
    onMatchKeywordY: ((Float) -> Unit)?,
    bubbleModifier: Modifier,
) {
    val S = LocalStrings.current
    val bgColor = if (isCurrentMatch) MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
    val textColor = if (isCurrentMatch) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
    MessageBubbleBox(
        copyText = item.title,
        quote = null,
        vm = vm,
        itemId = item.id.toString(),
        canSelect = false,
        modifier = bubbleModifier.fillMaxWidth(),
    ) {
        Card(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = bgColor),
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
                HighlightText(
                    (if (item.decisionType == "elicitation") S.elicitationTitle else S.permissionRequest) + ": ${item.title}",
                    highlight,
                    onMatchKeywordY = onMatchKeywordY,
                    style = MaterialTheme.typography.titleSmall,
                    color = textColor,
                )
                if (!item.contextSummary.isNullOrBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        item.contextSummary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(8.dp))
                when (item.status) {
                    "pending" -> {
                        if (item.decisionType == "permission") {
                            var scope by remember(item.id) { mutableStateOf("once") }
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                listOf(
                                    "once" to S.decisionScopeOnce,
                                    "task" to S.decisionScopeTask,
                                    "always" to S.decisionScopeAlways,
                                ).forEach { (key, label) ->
                                    FilterChip(
                                        selected = scope == key,
                                        onClick = { scope = key },
                                        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
                                    )
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item.options.forEach { (id, name) ->
                                    OutlinedButton(
                                        onClick = { vm.answerDecision(item, id, scope) },
                                        shape = RoundedCornerShape(12.dp),
                                    ) { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                }
                            }
                        } else {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item.options.forEach { (id, name) ->
                                    OutlinedButton(
                                        onClick = { vm.answerDecision(item, id, "once") },
                                        shape = RoundedCornerShape(12.dp),
                                    ) { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                }
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        TextButton(
                            onClick = { vm.revokeDecision(item) },
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                        ) {
                            Text(
                                S.decisionRevoke,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    "answered" -> {
                        val scopeLabel = when (item.scope) {
                            "task" -> S.decisionScopeTask
                            "always" -> S.decisionScopeAlways
                            else -> S.decisionScopeOnce
                        }
                        Text(
                            S.chose.format(item.answerLabel ?: "") +
                                (if (item.scope != "once") " · $scopeLabel" else "") +
                                (if (item.auto) " · ${S.decisionAuto}" else ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (item.scope != "once" && !item.auto) {
                            TextButton(
                                onClick = { vm.revokeDecision(item) },
                                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    S.decisionRevokeGrant,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                    else -> Text(
                        if (item.status == "revoked") S.decisionRevoked else S.decisionExpired,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun FlowStripTaskRow(task: FlowTask) {
    val S = LocalStrings.current
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
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(icon, color = iconColor, modifier = Modifier.width(16.dp), style = MaterialTheme.typography.labelSmall)
        Text("@${task.name}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(6.dp))
        Text(
            task.task,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (task.waitingFor == "user") {
            Spacer(Modifier.width(6.dp))
            Text(
                S.helpWanted,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun ChatTopCapsules(vm: ChatViewModel, expanded: String?, showRoomExtras: Boolean = true, onExpand: (String?) -> Unit) {
    val S = LocalStrings.current
    val blackboardCount = if (showRoomExtras) vm.blackboard.size else 0
    val artifactCount = vm.currentArtifacts.size
    val eventCount = vm.currentEvents.size
    if (blackboardCount == 0 && artifactCount == 0 && eventCount == 0) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp)
            .padding(top = 8.dp, bottom = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (blackboardCount > 0) {
            CapsuleWithBadge(
                label = S.capsuleBlackboard.format(blackboardCount),
                badgeCount = vm.newBlackboardCount,
                expanded = expanded == "blackboard",
                onClick = {
                    val next = if (expanded == "blackboard") null else "blackboard"
                    if (next == "blackboard") vm.clearNewCounts("blackboard")
                    onExpand(next)
                },
            )
        }
        if (artifactCount > 0) {
            CapsuleWithBadge(
                label = S.capsuleArtifact.format(artifactCount),
                badgeCount = vm.newArtifactCount,
                expanded = expanded == "artifact",
                onClick = {
                    val next = if (expanded == "artifact") null else "artifact"
                    if (next == "artifact") vm.clearNewCounts("artifact")
                    onExpand(next)
                },
            )
        }
        if (eventCount > 0) {
            CapsuleWithBadge(
                label = S.capsuleEvent.format(eventCount),
                badgeCount = vm.newEventCount,
                expanded = expanded == "event",
                onClick = {
                    val next = if (expanded == "event") null else "event"
                    if (next == "event") vm.clearNewCounts("event")
                    onExpand(next)
                },
            )
        }
    }
}

@Composable
private fun CapsuleWithBadge(label: String, badgeCount: Int, expanded: Boolean, onClick: () -> Unit) {
    BadgedBox(
        badge = {
            if (badgeCount > 0 && !expanded) {
                Badge { Text(if (badgeCount > 99) "99+" else "$badgeCount") }
            }
        },
    ) {
        AssistChip(
            onClick = onClick,
            label = { Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1, softWrap = false) },
            leadingIcon = {
                Text(
                    if (expanded) "▾" else "▸",
                    style = MaterialTheme.typography.labelMedium,
                )
            },
        )
    }
}

@Composable
private fun BlackboardPanel(vm: ChatViewModel) {
    val S = LocalStrings.current
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
                    "${if (collapsed) "▸" else "▾"} ${S.sharedBlackboard}",
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        S.actionClear,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .clickable { showClearConfirm = true }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                    Text(
                        S.itemCount.format(entries.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            // 未结话题：type==topic 且 open 置顶可点关闭，resolved 置灰折叠
            // open 在前，resolved 沉底置灰
            val topicEntries = entries.filter { it.type == "topic" }
                .sortedBy { it.status == "resolved" }
            if (!collapsed) {
                Spacer(Modifier.height(4.dp))
                if (topicEntries.isNotEmpty()) {
                    topicEntries.forEach { t ->
                        val resolved = t.status == "resolved"
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp),
                        ) {
                            Text(
                                "${if (resolved) "✓" else "◌"} ${t.text}",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (resolved) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                                        else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (!resolved) {
                                Text(
                                    S.topicResolve,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier
                                        .clickable { vm.resolveTopic(t.id) }
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(2.dp))
                }
                entries.reversed().filter { it.type != "topic" }.forEach { entry ->
                    Column(
                        Modifier
                            .padding(vertical = 3.dp)
                            .combinedClickable(
                                onClick = { detailEntry = entry },
                                onLongClick = { detailEntry = entry },
                            ),
                    ) {
                        Text(
                            "@${vm.sessionName(entry.from)} · ${formatArtifactTime(entry.at)}",
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
                            "@${vm.sessionName(entry.from)} · ${formatArtifactTime(entry.at)}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        IconButton(onClick = { detailEntry = null }) {
                            Icon(Icons.Default.Close, contentDescription = S.actionClose)
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
                        TextButton(onClick = { detailEntry = null }) { Text(S.actionClose) }
                        OutlinedButton(
                            onClick = {
                                vm.quoteBlackboard(entry)
                                detailEntry = null
                                Toast.makeText(context, S.quotedToast, Toast.LENGTH_SHORT).show()
                            },
                        ) { Text(S.actionQuote) }
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(null, entry.detail.ifBlank { entry.text })))
                                }
                                Toast.makeText(context, S.copiedToast, Toast.LENGTH_SHORT).show()
                            },
                        ) { Text(S.actionCopy) }
                        TextButton(
                            onClick = {
                                vm.removeBlackboardEntry(entry)
                                detailEntry = null
                            },
                        ) { Text(S.actionDelete) }
                    }
                }
            }
        }
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text(S.clearBlackboardTitle) },
            text = { Text(S.clearBlackboardMsg.format(entries.size)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.clearBlackboard()
                        showClearConfirm = false
                    },
                ) { Text(S.actionClear) }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) { Text(S.actionCancel) }
            },
        )
    }
}
