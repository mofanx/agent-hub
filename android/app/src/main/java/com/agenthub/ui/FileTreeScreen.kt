package com.agenthub.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.FileTreeNode
import com.agenthub.FileTreeRoot
import java.io.File

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun FileTreeScreen(vm: ChatViewModel, onBack: () -> Unit) {
    LaunchedEffect(Unit) {
        vm.refreshFileTree(null)
    }

    BackHandler { onBack() }

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
                    IconButton(onClick = onBack) {
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
}

@Composable
private fun RootItem(root: FileTreeRoot, vm: ChatViewModel, onBack: () -> Unit, onClick: () -> Unit) {
    var showDialog by remember { mutableStateOf(false) }
    val canQuote = vm.currentRoom != null || vm.currentSession != null
    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = { showDialog = true },
            )
            .padding(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "📁",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(root.name, style = MaterialTheme.typography.bodyMedium)
                Text(
                    root.path,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
    HorizontalDivider()
    if (showDialog) {
        FileTreeItemDialog(
            name = root.name,
            path = root.path,
            isDir = true,
            canQuote = canQuote,
            onOpen = {
                showDialog = false
                onClick()
            },
            onQuote = {
                vm.fileRefToInsert = root.path
                showDialog = false
                onBack()
            },
            onDismiss = { showDialog = false },
        )
    }
}

@Composable
private fun FileTreeItem(node: FileTreeNode, vm: ChatViewModel, onBack: () -> Unit) {
    var showDialog by remember { mutableStateOf(false) }
    val canQuote = vm.currentRoom != null || vm.currentSession != null
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
            .combinedClickable(
                onClick = onOpen,
                onLongClick = { showDialog = true },
            )
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
        }
    }
    HorizontalDivider()
    if (showDialog) {
        FileTreeItemDialog(
            name = node.name,
            path = node.path,
            isDir = node.kind == "dir",
            canQuote = canQuote,
            onOpen = {
                showDialog = false
                onOpen()
            },
            onQuote = {
                vm.fileRefToInsert = node.path
                showDialog = false
                onBack()
            },
            onDismiss = { showDialog = false },
        )
    }
}

@Composable
private fun FileTreeItemDialog(
    name: String,
    path: String,
    isDir: Boolean,
    canQuote: Boolean,
    onOpen: () -> Unit,
    onQuote: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(name) },
        text = {
            Text(
                path,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onOpen) {
                    Text(if (isDir) "进入" else "打开")
                }
                if (canQuote) {
                    TextButton(onClick = onQuote) {
                        Text("引用到输入框")
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("取消")
                }
            }
        },
    )
}

private fun formatFileSize(size: Long): String = when {
    size >= 1_000_000 -> String.format("%.1f MB", size / 1_000_000.0)
    size >= 1_000 -> String.format("%.1f KB", size / 1_000.0)
    else -> "$size B"
}
