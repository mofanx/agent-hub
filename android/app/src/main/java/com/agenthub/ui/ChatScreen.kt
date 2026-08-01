package com.agenthub.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.PopupProperties
import com.agenthub.ChatItem
import com.agenthub.ChatViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel) {
    val S = LocalStrings.current
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val isRoom = vm.currentRoom != null
    val title = vm.currentRoom?.name ?: vm.currentSession?.name ?: S.chat

    LaunchedEffect(vm.chatItems.size, vm.chatItems.lastOrNull()?.let {
        when (it) {
            is ChatItem.Assistant -> it.text.length
            is ChatItem.Thought -> it.text.length
            else -> 0
        }
    }) {
        if (vm.chatItems.isNotEmpty()) listState.animateScrollToItem(vm.chatItems.lastIndex)
    }

    Scaffold(
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
                    IconButton(onClick = { vm.backToList() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
            ) {
                items(vm.chatItems.size) { i ->
                    ChatBubble(vm.chatItems[i], vm, showAuthor = isRoom)
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
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
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
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = {
                            Text(if (isRoom) S.inputRoom else S.inputSingle)
                        },
                        shape = RoundedCornerShape(24.dp),
                        maxLines = 4,
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedBorderColor = Color.Transparent,
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                            unfocusedContainerColor =
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            focusedContainerColor =
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        ),
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
                            matches.forEach { (_, name) ->
                                DropdownMenuItem(
                                    text = { Text("@$name") },
                                    onClick = {
                                        val at = input.lastIndexOf('@')
                                        input = input.substring(0, at) + "@$name "
                                    },
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.size(8.dp))
                FilledIconButton(
                    onClick = {
                        if (isRoom) vm.sendRoomMessage(input.trim()) else vm.sendPrompt(input.trim())
                        input = ""
                    },
                    enabled = input.isNotBlank() && !vm.generating,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = S.send)
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatBubble(item: ChatItem, vm: ChatViewModel, showAuthor: Boolean) {
    val S = LocalStrings.current
    when (item) {
        is ChatItem.System -> Box(
            Modifier.fillMaxWidth().padding(vertical = 6.dp),
            contentAlignment = Alignment.Center,
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
        is ChatItem.User -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Surface(
                modifier = Modifier.padding(vertical = 4.dp).widthIn(max = 300.dp),
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
                    Text(item.text, color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
        }
        is ChatItem.Assistant -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
            Surface(
                modifier = Modifier.widthIn(max = 320.dp).combinedClickable(
                    onClick = { },
                    onLongClick = { vm.quote = item.author to item.text },
                ),
                shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Text(
                    item.text,
                    Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        is ChatItem.Thought -> {
            var expanded by remember { mutableStateOf(false) }
            Column(Modifier.padding(vertical = 2.dp)) {
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
                    Text(
                        item.text,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
            }
        }
        is ChatItem.Tool -> Column(Modifier.padding(vertical = 3.dp)) {
            if (showAuthor) AuthorLabel(item.author)
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
        is ChatItem.Plan -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
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
        is ChatItem.Error -> Text(
            (if (item.author.isNotBlank()) "[${item.author}] " else "") +
                "${S.errorTag}: ${item.text}",
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        is ChatItem.Permission -> Column(Modifier.padding(vertical = 4.dp)) {
            if (showAuthor) AuthorLabel(item.author)
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
