package com.agenthub.ui

import android.graphics.BitmapFactory
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
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
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.launch
import com.agenthub.Attachment
import com.agenthub.ChatItem
import com.agenthub.ChatViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current
    var input by remember { mutableStateOf("") }
    val sessionKey = vm.currentRoom?.roomId ?: vm.currentSession?.sessionId ?: ""
    val listState = remember(sessionKey) { LazyListState(0, 0) }
    val isAtBottom by produceState(false, listState, vm.chatItems.size) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                value = index == 0 && offset <= 20
            }
    }
    val scope = rememberCoroutineScope()
    val messages by remember { derivedStateOf { vm.chatItems.asReversed() } }
    val isRoom = vm.currentRoom != null
    val title = vm.currentRoom?.name ?: vm.currentSession?.name ?: S.chat
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { vm.addAttachment(it) }
    }

    LaunchedEffect(vm.chatItems.size) {
        val latest = vm.chatItems.lastOrNull() ?: return@LaunchedEffect
        if (latest is ChatItem.User || isAtBottom) {
            val alreadyAtBottom =
                listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= 20
            if (!alreadyAtBottom) {
                listState.scrollToItem(0, 0)
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
                            Text(
                                vm.currentRoom!!.members.joinToString("  ") { "@${it.second}" },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                    IconButton(onClick = { vm.backToList() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                    if (vm.generating) {
                        IconButton(onClick = { vm.stopCurrent() }) {
                            Icon(
                                imageVector = Icons.Filled.Stop,
                                contentDescription = S.stop,
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
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
                Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    reverseLayout = true,
                    state = listState,
                    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                ) {
                    itemsIndexed(
                        messages,
                        key = { _, item -> item.id },
                    ) { index, item ->
                        val nextAuthor = messages.getOrNull(index + 1)?.author
                        ChatBubble(
                            item,
                            vm,
                            showAuthor = isRoom && nextAuthor != item.author,
                        )
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
            if (vm.generating) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.size(8.dp))
                        Text(
                            S.generating,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { vm.stopCurrent() }) {
                            Text(S.stop, color = MaterialTheme.colorScheme.error)
                        }
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
            if (vm.pendingAttachments.isNotEmpty()) {
                AttachmentPreviews(
                    attachments = vm.pendingAttachments,
                    onRemove = { vm.removeAttachment(it) },
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
            Row(
                Modifier
                    .padding(horizontal = 12.dp, vertical = 3.dp)
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
                        val matches = vm.currentRoom!!.members.filter {
                            it.second.startsWith(mentionQuery, ignoreCase = true)
                        }
                        DropdownMenu(
                            expanded = matches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            matches.forEach { (sid, name) ->
                                val display = vm.sessionName(sid)
                                DropdownMenuItem(
                                    text = { Text("@$display") },
                                    onClick = {
                                        val at = input.lastIndexOf('@')
                                        input = input.substring(0, at) + "@$name "
                                    },
                                )
                            }
                        }
                    }
                    val slashQuery: String? = run {
                        if (!input.startsWith("/")) return@run null
                        if (input.contains(' ') || input.contains('\n')) return@run null
                        input.substring(1)
                    }
                    if (slashQuery != null) {
                        val matches = vm.slashCommands.filter {
                            it.name.startsWith(slashQuery, ignoreCase = true)
                        }
                        DropdownMenu(
                            expanded = matches.isNotEmpty(),
                            onDismissRequest = { },
                            properties = PopupProperties(focusable = false),
                        ) {
                            matches.forEach { cmd ->
                                DropdownMenuItem(
                                    text = { Text("/${cmd.name} — ${cmd.description}") },
                                    onClick = { input = "/${cmd.name} " },
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
                if (input.isNotBlank() || vm.pendingAttachments.isNotEmpty()) {
                    Spacer(Modifier.size(4.dp))
                    FilledIconButton(
                        onClick = {
                            if (isRoom) vm.sendRoomMessage(input.trim()) else vm.sendPrompt(input.trim())
                            input = ""
                        },
                        enabled = !vm.generating,
                        modifier = Modifier.size(40.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = S.send)
                    }
                }
            }
        }
    }
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
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    var showSelectText by remember { mutableStateOf(false) }
    var menuOffset by remember { mutableStateOf(IntOffset.Zero) }
    Box(
        modifier = modifier
            .rightClickable {
                menuOffset = IntOffset(it.x.toInt(), it.y.toInt())
                expanded = true
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onLongPress = { offset ->
                        menuOffset = IntOffset(offset.x.toInt(), offset.y.toInt())
                        expanded = true
                    },
                )
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
                    clipboard.setText(AnnotatedString(copyText))
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
            Dialog(onDismissRequest = { showSelectText = false }) {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
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

fun Modifier.rightClickable(onRightClick: (Offset) -> Unit): Modifier = composed {
    val updated by rememberUpdatedState(onRightClick)
    pointerInput(Unit) {
        awaitPointerEventScope {
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.type == PointerEventType.Press && event.buttons.isSecondaryPressed) {
                    val pos = event.changes.firstOrNull()?.position ?: Offset.Zero
                    event.changes.forEach { it.consume() }
                    updated(pos)
                }
            }
        }
    }
}

@Composable
fun ChatBubble(item: ChatItem, vm: ChatViewModel, showAuthor: Boolean) {
    val S = LocalStrings.current
    when (item) {
        is ChatItem.System -> Box(
            Modifier.fillMaxWidth().padding(vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                ) {
                    Text(
                        item.text,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }
        }

        is ChatItem.User -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                Surface(
                    shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        if (item.quoteAuthor != null) {
                            Text(
                                "${S.quoting} @${item.quoteAuthor}: ${item.quoteText?.take(80).orEmpty()}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                                maxLines = 2,
                            )
                            Spacer(Modifier.height(4.dp))
                        }
                        if (item.text.isNotBlank()) {
                            Text(item.text, color = MaterialTheme.colorScheme.onPrimaryContainer)
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
            MessageBubbleBox(
                copyText = item.text,
                quote = item.author to item.text,
                vm = vm,
                modifier = Modifier.fillMaxWidth(),
            ) {
                val assistantColor = MaterialTheme.colorScheme.onSurfaceVariant
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Markdown(
                        item.text,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        colors = markdownColor(text = assistantColor),
                        typography = markdownTypography(text = MaterialTheme.typography.bodyLarge),
                    )
                }
            }
        }

        is ChatItem.Thought -> {
            var expanded by remember { mutableStateOf(false) }
            MessageBubbleBox(
                copyText = item.text,
                quote = null,
                vm = vm,
                modifier = Modifier.padding(vertical = 2.dp),
            ) {
                Column {
                    TextButton(onClick = { expanded = !expanded }) {
                        Text(
                            (if (expanded) "▾ " else "▸ ") +
                                (if (showAuthor) S.thoughtOf.format(item.author) else S.thought),
                            fontStyle = FontStyle.Italic,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (expanded) {
                        val thoughtColor = MaterialTheme.colorScheme.onSurfaceVariant
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text(
                                item.text,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = thoughtColor,
                            )
                        }
                    }
                }
            }
        }

        is ChatItem.Tool -> Column(Modifier.padding(vertical = 3.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            MessageBubbleBox(
                copyText = "[${item.title}] ${item.status}",
                quote = null,
                vm = vm,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.4f),
                ) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Build,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.size(8.dp))
                        Text(item.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            item.status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        is ChatItem.Plan -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            MessageBubbleBox(
                copyText = "${S.plan}\n${item.entries.joinToString("\n")}",
                quote = null,
                vm = vm,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(S.plan, style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(4.dp))
                        item.entries.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }

        is ChatItem.Error -> {
            val text = (if (item.author.isNotBlank()) "[${item.author}] " else "") +
                "${S.errorTag}: ${item.text}"
            MessageBubbleBox(
                copyText = text,
                quote = null,
                vm = vm,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                Text(
                    text,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        is ChatItem.Permission -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            MessageBubbleBox(
                copyText = item.title,
                quote = null,
                vm = vm,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f),
                    ),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            "${S.permissionRequest}: ${item.title}",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Spacer(Modifier.height(8.dp))
                        if (item.answered != null) {
                            Text(
                                S.chose.format(item.answered),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
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
