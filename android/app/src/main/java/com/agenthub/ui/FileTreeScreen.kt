package com.agenthub.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.FileTreeNode
import com.agenthub.FileTreeRoot
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
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
                        RootItem(root) { vm.enterFileTreeRoot(root) }
                    }
                } else {
                    items(vm.fileTreeNodes, key = { "node:${it.path}" }) { node ->
                        FileTreeItem(node, vm)
                    }
                }
            }
        }
    }
}

@Composable
private fun RootItem(root: FileTreeRoot, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
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
}

@Composable
private fun FileTreeItem(node: FileTreeNode, vm: ChatViewModel) {
    val icon = if (node.kind == "dir") "📁" else "🗎"

    Surface(
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                if (node.kind == "dir") {
                    vm.enterFileTreeDir(node)
                } else {
                    vm.openProjectFile(node.path)
                }
            }
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
}

private fun formatFileSize(size: Long): String = when {
    size >= 1_000_000 -> String.format("%.1f MB", size / 1_000_000.0)
    size >= 1_000 -> String.format("%.1f KB", size / 1_000.0)
    else -> "$size B"
}
