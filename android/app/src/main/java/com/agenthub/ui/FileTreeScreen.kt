package com.agenthub.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agenthub.ChatViewModel
import com.agenthub.DownloadRequest
import com.agenthub.FileTreeNode
import com.agenthub.FileTreeRoot
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileTreeScreen(vm: ChatViewModel, onBack: () -> Unit) {
    LaunchedEffect(Unit) {
        vm.refreshFileTree(null)
    }

    val onUpOrBack = {
        if (vm.fileTreePath != null) vm.upFileTree() else onBack()
    }
    BackHandler { onUpOrBack() }

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

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        vm.fileTreeRootName ?: "项目文件",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onUpOrBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(
                        onClick = {
                            vm.refreshFileTree(
                                if (vm.fileTreePath.isNullOrBlank()) null else vm.fileTreePath,
                            )
                        },
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 12.dp),
        ) {
            if (vm.fileTreeLoading) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(16.dp)
                        .align(Alignment.CenterHorizontally),
                )
            }

            vm.fileTreePath?.let { currentPath ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { vm.upFileTree() }
                        .padding(12.dp),
                ) {
                    Text(
                        "↑ 返回上级",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (vm.fileTreePath == null) {
                    items(vm.fileTreeRoots, key = { "root:${it.path}" }) { root ->
                        RootItem(root, vm, onBack) { vm.enterFileTreeRoot(root) }
                    }
                } else {
                    items(vm.fileTreeNodes, key = { "node:${it.path}" }) { node ->
                        FileTreeItem(node, vm, onBack)
                    }
                }
            }
        }
    }

    vm.filePreview?.let { preview ->
        FilePreviewDialog(preview) { vm.dismissFilePreview() }
    }
}

@Composable
private fun RootItem(root: FileTreeRoot, vm: ChatViewModel, onBack: () -> Unit, onClick: () -> Unit) {
    val canQuote = vm.currentRoom != null || vm.currentSession != null
    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "📁",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(root.name, style = MaterialTheme.typography.bodyMedium)
                Text(
                    root.path,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            FileTreeMenu(
                icon = "📁",
                name = root.name,
                isFile = false,
                canQuote = canQuote,
                onOpen = onClick,
                onQuote = if (canQuote) {
                    {
                        vm.fileRefToInsert = root.path
                        onBack()
                    }
                } else null,
            )
        }
    }
    HorizontalDivider()
}

@Composable
private fun FileTreeItem(node: FileTreeNode, vm: ChatViewModel, onBack: () -> Unit) {
    var showRename by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    val canQuote = vm.currentRoom != null || vm.currentSession != null
    val isFile = node.kind == "file"
    val icon = if (node.kind == "dir") "📁" else "🗎"
    val onOpen = {
        if (node.kind == "dir") {
            vm.enterFileTreeDir(node)
        } else {
            vm.openProjectFile(node.path)
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                icon,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.size(24.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(node.name, style = MaterialTheme.typography.bodyMedium)
                if (node.size != null) {
                    Text(
                        "${formatFileSize(node.size)} · ${formatArtifactTime(node.at)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            FileTreeMenu(
                icon = icon,
                name = node.name,
                isFile = isFile,
                canQuote = canQuote,
                onOpen = onOpen,
                onPreview = if (isFile) {
                    { vm.loadFilePreview(node.path) }
                } else null,
                onDownload = if (isFile) {
                    { vm.downloadProjectFile(node.path) }
                } else null,
                onQuote = if (canQuote) {
                    {
                        vm.fileRefToInsert = node.path
                        onBack()
                    }
                } else null,
                onRename = if (isFile) {
                    { showRename = true }
                } else null,
                onDelete = if (isFile) {
                    { showDeleteConfirm = true }
                } else null,
            )
        }
    }
    HorizontalDivider()
    if (showRename) {
        FileRenameDialog(
            currentName = node.name,
            onConfirm = { newName ->
                val parent = File(node.path).parentFile?.absolutePath
                val to = if (parent.isNullOrBlank()) newName else File(parent, newName).absolutePath
                vm.renameProjectFile(node.path, to)
            },
            onDismiss = { showRename = false },
        )
    }
    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("删除文件") },
            text = { Text("确认删除 ${node.name}？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.deleteProjectFile(node.path)
                        showDeleteConfirm = false
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun FileTreeMenu(
    icon: String,
    name: String,
    isFile: Boolean,
    canQuote: Boolean,
    onOpen: () -> Unit,
    onPreview: (() -> Unit)? = null,
    onDownload: (() -> Unit)? = null,
    onQuote: (() -> Unit)? = null,
    onRename: (() -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }) {
            Icon(Icons.Filled.MoreVert, contentDescription = "更多")
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(icon, style = MaterialTheme.typography.titleMedium, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(if (isFile) "打开" else "进入") },
                onClick = { expanded = false; onOpen() },
            )
            if (onPreview != null) {
                DropdownMenuItem(
                    text = { Text("预览") },
                    onClick = { expanded = false; onPreview() },
                )
            }
            if (onDownload != null) {
                DropdownMenuItem(
                    text = { Text("下载") },
                    onClick = { expanded = false; onDownload() },
                )
            }
            if (canQuote && onQuote != null) {
                DropdownMenuItem(
                    text = { Text("引用到输入框", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = { expanded = false; onQuote() },
                )
            }
            if (onRename != null) {
                DropdownMenuItem(
                    text = { Text("重命名") },
                    onClick = { expanded = false; onRename() },
                )
            }
            if (onDelete != null) {
                DropdownMenuItem(
                    text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                    onClick = { expanded = false; onDelete() },
                )
            }
        }
    }
}

@Composable
private fun FileRenameDialog(
    currentName: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(currentName) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("重命名") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("新名称") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val trimmed = name.trim()
                    if (trimmed.isNotBlank() && trimmed != currentName) onConfirm(trimmed)
                    onDismiss()
                },
            ) { Text("确认") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

@Composable
internal fun FilePreviewDialog(
    preview: com.agenthub.FilePreview,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth(0.9f)
                .widthIn(max = 520.dp)
                .padding(16.dp),
            shape = MaterialTheme.shapes.extraLarge,
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        preview.name,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismiss) {
                        Text("✕")
                    }
                }
                Spacer(Modifier.height(8.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp, max = 360.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    when {
                        preview.text != null -> TextContent(preview.text)
                        preview.data != null && preview.mime.startsWith("image/") -> ImageContent(preview.data)
                        preview.data != null -> Text("二进制文件，无法直接预览", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else -> CircularProgressIndicator()
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onDismiss) { Text("关闭") }
                }
            }
        }
    }
}

@Composable
private fun TextContent(text: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 360.dp)
            .verticalScroll(rememberScrollState())
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
            .padding(12.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ImageContent(data: ByteArray) {
    val bitmap = remember(data) {
        BitmapFactory.decodeByteArray(data, 0, data.size)?.asImageBitmap()
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 360.dp),
            contentScale = ContentScale.Fit,
        )
    } else {
        Text("无法解析图片", color = MaterialTheme.colorScheme.error)
    }
}

private fun formatFileSize(size: Long): String = when {
    size >= 1_000_000 -> String.format("%.1f MB", size / 1_000_000.0)
    size >= 1_000 -> String.format("%.1f KB", size / 1_000.0)
    else -> "$size B"
}
