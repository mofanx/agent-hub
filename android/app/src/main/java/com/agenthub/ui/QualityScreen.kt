package com.agenthub.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.QualityCheck
import com.agenthub.QualityFinding
import com.agenthub.QualityIncident
import com.agenthub.ReviewConfigV2
import com.agenthub.QualityRule
import com.agenthub.QualityProject
import com.agenthub.QualityRun
import com.agenthub.RequirementVerification
import com.agenthub.RequirementSpec
import com.agenthub.AcceptanceCriterion
import com.agenthub.Screen
import java.text.DateFormat
import java.util.Date

private val OUTCOME_LABELS = mapOf(
    "verified" to "已验证",
    "failed" to "未通过",
    "inconclusive" to "无法判定",
    "waived" to "已豁免",
)

private fun fmtTime(ts: Long?): String =
    if (ts == null || ts <= 0) "—" else DateFormat.getDateTimeInstance().format(Date(ts))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QualityScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current
    var runFilter by remember { mutableStateOf("all") }

    LaunchedEffect(Unit) {
        vm.loadQualityProjects()
        vm.loadQualityRuns()
        vm.loadQualityIncidents()
        vm.loadQualityRules()
    }

    // 从聊天跳转时自动加载 run 详情
    LaunchedEffect(vm.qualityRunId) {
        if (vm.qualityRunId != null) {
            vm.loadQualityRun(vm.qualityRunId!!)
        }
    }

    BackHandler { vm.screen = vm.qualityReturnScreen }

    val selectedRun = vm.qualityRuns.find { it.id == vm.qualityRunId }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("质量") },
                navigationIcon = {
                    IconButton(onClick = { vm.screen = vm.qualityReturnScreen }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                },
                actions = {
                    IconButton(onClick = {
                        vm.loadQualityProjects()
                        vm.loadQualityRuns()
                        vm.loadQualityIncidents()
                        vm.loadQualityRules()
                    }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            vm.qualityError?.let { err ->
                item {
                    Card(
                        Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                        ),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().padding(12.dp),
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                "⚠",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                            Text(
                                err,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { vm.clearQualityError() }) {
                                Text("清除")
                            }
                        }
                    }
                }
            }
            // 上下文感知区
            val ctxSession = vm.currentSession
            val ctxRoom = vm.currentRoom
            val ctxSq = vm.sessionQuality
            val verifyingTasks = vm.flow?.tasks?.filter { it.status == "verifying" } ?: emptyList()
            if (ctxSession != null || ctxRoom != null) {
                item {
                    Card(
                        Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                        ),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("🛡", style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    if (ctxSession != null) "当前会话：${ctxSession.name.ifBlank { ctxSession.sessionId }}" else "当前群聊：${ctxRoom?.name ?: ctxRoom?.roomId ?: ""}",
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = { vm.screen = if (ctxSession != null) Screen.Chat else Screen.Room }) {
                                    Text("返回")
                                }
                            }
                            if (ctxSession != null && ctxSq != null) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    "最新质量运行：${ChatViewModel.stageLabel(ctxSq.stage)} · L1 ${ctxSq.passedChecks}/${ctxSq.passedChecks + ctxSq.failedChecks}${ctxSq.failureCode?.let { " · $it" } ?: ""}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                TextButton(onClick = { vm.loadQualityRun(ctxSq.runId) }, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
                                    Text("查看完整证据", style = MaterialTheme.typography.labelSmall)
                                }
                            }
                            if (ctxRoom != null && verifyingTasks.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    "正在验证：${verifyingTasks.joinToString(", ") { it.name }}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text("项目", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(8.dp))
                        if (vm.qualityProjects.isEmpty()) {
                            Text(
                                "暂无已注册的质量项目",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            var delProject by remember { mutableStateOf<QualityProject?>(null) }
                            Column(
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                                modifier = Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
                            ) {
                                vm.qualityProjects.forEach { p ->
                                    Column {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            FilterChip(
                                                selected = vm.qualityProjectId == p.id,
                                                onClick = { vm.selectQualityProject(p.id) },
                                                label = { Text(p.displayName.ifBlank { p.root }) },
                                            )
                                            IconButton(
                                                onClick = { delProject = p },
                                                modifier = Modifier.size(24.dp),
                                            ) {
                                                Icon(Icons.Filled.Close, contentDescription = "删除项目", modifier = Modifier.size(16.dp))
                                            }
                                        }
                                        Text(
                                            p.root,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 2,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.padding(start = 4.dp, top = 2.dp),
                                        )
                                    }
                                }
                            }
                            delProject?.let { p ->
                                AlertDialog(
                                    onDismissRequest = { delProject = null },
                                    title = { Text("删除项目") },
                                    text = { Text("确认删除项目「${p.displayName.ifBlank { p.root }}」及其所有运行记录？此操作不可撤销。") },
                                    confirmButton = {
                                        TextButton(onClick = { vm.deleteQualityProject(p.id); delProject = null }) { Text("删除") }
                                    },
                                    dismissButton = {
                                        TextButton(onClick = { delProject = null }) { Text("取消") }
                                    },
                                )
                            }
                        }
                        vm.qualityPolicy?.let { pol ->
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "策略：${if (pol.source == "file") ".devin/quality.json" else "默认（未配置）"} · autonomy=${pol.autonomy} · checks=${pol.checkCount}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (pol.source == "default" && vm.qualityProjectId != null) {
                                Spacer(Modifier.height(6.dp))
                                OutlinedButton(onClick = { vm.ensureQualityPolicy(vm.qualityProjectId!!) }) {
                                    Text("初始化质量策略（v2）")
                                }
                            } else if (pol.version == 1 && vm.qualityProjectId != null) {
                                Spacer(Modifier.height(6.dp))
                                OutlinedButton(onClick = { vm.migrateQualityPolicy(vm.qualityProjectId!!) }) {
                                    Text("升级到 v2 策略以编辑 Review 配置")
                                }
                            }
                            pol.errors.forEach { e ->
                                Text(
                                    "⚠ $e",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                            if (pol.version == 2) {
                                pol.reviewConfig?.let { rc ->
                                    Spacer(Modifier.height(8.dp))
                                    ReviewTierConfigForm(
                                        reviewConfig = rc,
                                        projectId = vm.qualityProjectId,
                                        modelList = vm.modelList,
                                        onLoadModels = { vm.loadModelList() },
                                        onSave = { vm.saveQualityPolicy(it.first, it.second) },
                                    )
                                }
                                Spacer(Modifier.height(8.dp))
                                RequirementVerificationConfigForm(
                                    requirementsMode = pol.requirementsMode,
                                    requirementsMaxQuestions = pol.requirementsMaxQuestions,
                                    verificationMode = pol.verificationMode,
                                    projectId = vm.qualityProjectId,
                                    onSave = { pid, reqMode, maxQ, verMode ->
                                        vm.saveRequirementVerificationPolicy(pid, reqMode, maxQ, verMode)
                                    },
                                )
                            }
                        }
                    }
                }
            }

            // 主从导航：选中 run 时只显示详情，否则显示列表
            if (selectedRun != null) {
                val run = selectedRun
                item {
                    val firstSpecId = remember(run.id, vm.qualityVerifications.size) {
                        vm.qualityVerifications.firstOrNull { it.specId.isNotBlank() }?.specId ?: ""
                    }
                    LaunchedEffect(firstSpecId) {
                        if (firstSpecId.isNotBlank()) vm.loadRequirementSpec(firstSpecId)
                    }
                    Card(
                        Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                        ),
                    ) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                IconButton(onClick = { vm.qualityRunId = null }) {
                                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回列表")
                                }
                                Text(run.id, style = MaterialTheme.typography.titleSmall, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                                Text(ChatViewModel.STAGE_LABELS[run.stage] ?: run.stage, style = MaterialTheme.typography.bodySmall, color = stageColor(run.stage))
                            }
                            Spacer(Modifier.height(8.dp))
                            Text("风险：${run.risk} · 触发：${run.trigger} · 修复轮次：${run.fixRound}/${run.maxFixRounds}\n判定：${run.verdict ?: "—"}${run.failureCode?.let { " · $it" } ?: ""}${run.outcome?.let { " · 结果：${OUTCOME_LABELS[it] ?: it}" } ?: ""}\n创建：${fmtTime(run.createdAt)} · 更新：${fmtTime(run.updatedAt)}${run.completedAt?.let { " · 完成：${fmtTime(it)}" } ?: ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            run.workItemId?.let { wid -> Text("WorkItem：$wid${run.generation?.let { " · 第 $it 代" } ?: ""}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            run.patchHash?.let { Text("patchHash：$it", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (run.stage == "reviewed") {
                                    Button(onClick = { vm.advanceQualityRun(run.id, "full-verifying") }) { Text("继续验证") }
                                    Button(onClick = { vm.advanceQualityRun(run.id, "fixing") }) { Text("开始修复") }
                                }
                                if (run.stage == "awaiting-approval") {
                                    Button(onClick = { vm.qualityRunAction(run.id, "approve") }) { Text("批准") }
                                    OutlinedButton(onClick = { vm.qualityRunAction(run.id, "reject") }) { Text("拒绝") }
                                }
                                if (run.stage !in ChatViewModel.TERMINAL_STAGES) { OutlinedButton(onClick = { vm.qualityRunAction(run.id, "cancel") }) { Text("取消") } }
                                if (run.stage in ChatViewModel.TERMINAL_STAGES && run.stage != "accepted") { OutlinedButton(onClick = { vm.qualityRunAction(run.id, "retry") }) { Text("重跑检查") } }
                            }
                            Spacer(Modifier.height(12.dp))
                            Text("检查（${vm.qualityChecks.size}）", style = MaterialTheme.typography.titleSmall)
                            if (vm.qualityChecks.isEmpty()) { Text("暂无检查记录", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            else {
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
                                    vm.qualityChecks.forEach { c -> CheckCard(c) }
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                            Text("审查发现（${vm.qualityFindings.size}）", style = MaterialTheme.typography.titleSmall)
                            if (vm.qualityFindings.isEmpty()) { Text("暂无审查发现", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            else {
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
                                    vm.qualityFindings.forEach { f -> FindingCard(f, vm) }
                                }
                            }
                            if (vm.qualityVerifications.isNotEmpty()) {
                                Spacer(Modifier.height(12.dp))
                                Text("L3 需求验证（${vm.qualityVerifications.size}）", style = MaterialTheme.typography.titleSmall)
                                vm.qualityVerifications.forEach { v -> VerificationRow(v) }
                            }
                            vm.currentRequirementSpec?.let { spec ->
                                Spacer(Modifier.height(12.dp))
                                AcceptanceCriteriaCard(spec)
                            }
                        }
                    }
                }
            } else {
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Text("运行记录", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            if (vm.qualityProjectId != null) {
                                IconButton(onClick = { vm.startQualityRun() }) {
                                    Icon(Icons.Filled.PlayArrow, contentDescription = "发起质量运行")
                                }
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                            listOf("all" to "全部", "active" to "进行中", "approval" to "待审批", "reviewed" to "待确认", "accepted" to "已通过", "failed" to "未通过").forEach { (key, label) ->
                                FilterChip(selected = runFilter == key, onClick = { runFilter = key }, label = { Text(label, style = MaterialTheme.typography.labelSmall) })
                            }
                        }
                    }
                }
            }
            // run 列表懒加载
            val filtered = vm.qualityRuns.filter { r ->
                when (runFilter) {
                    "all" -> true
                    "active" -> r.stage !in ChatViewModel.TERMINAL_STAGES
                    "approval" -> r.stage == "awaiting-approval"
                    "reviewed" -> r.stage == "reviewed"
                    "accepted" -> r.stage == "accepted"
                    "failed" -> r.stage == "failed" || r.stage == "inconclusive"
                    else -> true
                }
            }
            if (filtered.isEmpty()) {
                item {
                    Text("无匹配的运行记录", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
                }
            } else {
                items(filtered, key = { it.id }) { r ->
                    RunRow(run = r, selected = false, onClick = { vm.loadQualityRun(r.id) }, onDelete = { vm.deleteQualityRun(r.id) })
                }
            }
            } // end else

            item {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text("Incident 列表", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(8.dp))
                        if (vm.qualityIncidents.isEmpty()) {
                            Text(
                                "暂无 incident",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            Column(
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                                modifier = Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()),
                            ) {
                                vm.qualityIncidents.forEach { i -> IncidentCard(i, vm) }
                            }
                        }
                    }
                }
            }

            item {
                Card(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text("规则候选", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(8.dp))
                        if (vm.qualityRules.isEmpty()) {
                            Text(
                                "暂无规则候选",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            Column(
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                                modifier = Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()),
                            ) {
                                vm.qualityRules.forEach { r -> RuleCard(r, vm) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun stageColor(stage: String): Color = when (stage) {
    "accepted" -> Color(0xFF2ECC71)
    "failed", "quarantined" -> MaterialTheme.colorScheme.error
    "cancelled", "stale" -> MaterialTheme.colorScheme.onSurfaceVariant
    "inconclusive", "waived", "awaiting-approval", "reviewed" -> Color(0xFFF1C40F)
    else -> MaterialTheme.colorScheme.primary
}

@Composable
private fun checkColor(status: String): Color = when (status) {
    "passed" -> Color(0xFF2ECC71)
    "failed", "timeout", "infra-failed" -> MaterialTheme.colorScheme.error
    "cancelled" -> MaterialTheme.colorScheme.onSurfaceVariant
    else -> Color(0xFFF1C40F)
}

@Composable
private fun severityColor(sev: String): Color = when (sev) {
    "critical" -> MaterialTheme.colorScheme.error
    "major" -> Color(0xFFF1C40F)
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun RunRow(run: QualityRun, selected: Boolean, onClick: () -> Unit, onDelete: () -> Unit) {
    var confirmDel by remember { mutableStateOf(false) }
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) {
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(
                ChatViewModel.STAGE_LABELS[run.stage] ?: run.stage,
                style = MaterialTheme.typography.labelMedium,
                color = stageColor(run.stage),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                run.id,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Text(
                run.risk,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            IconButton(onClick = { confirmDel = true }, modifier = Modifier.size(20.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "删除", modifier = Modifier.size(14.dp))
            }
        }
    }
    if (confirmDel) {
        AlertDialog(
            onDismissRequest = { confirmDel = false },
            title = { Text("删除运行") },
            text = { Text("确认删除运行 ${run.id}？此操作不可撤销。") },
            confirmButton = { TextButton(onClick = { onDelete(); confirmDel = false }) { Text("删除") } },
            dismissButton = { TextButton(onClick = { confirmDel = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun CheckCard(c: QualityCheck) {
    var expanded by remember { mutableStateOf(false) }
    val hasDetail = c.summary != null || c.stdoutArtifact != null || c.stderrArtifact != null
    Card(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                modifier = if (hasDetail) Modifier.clickable { expanded = !expanded } else Modifier,
            ) {
                Text(
                    c.status,
                    style = MaterialTheme.typography.labelMedium,
                    color = checkColor(c.status),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    c.checkId,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    buildString {
                        append("第${c.attempt}次")
                        c.exitCode?.let { append(" exit=$it") }
                        c.durationMs?.let { append(" ${it / 1000.0}s") }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (hasDetail) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (expanded && hasDetail) {
                Column(Modifier.padding(top = 6.dp)) {
                    c.summary?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    c.stdoutArtifact?.let {
                        Text(
                            "stdout：$it",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    c.stderrArtifact?.let {
                        Text(
                            "stderr：$it",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun VerificationRow(v: RequirementVerification) {
    val icon = when (v.status) { "passed" -> "✓"; "failed" -> "✗"; else -> "⚠" }
    val color = when (v.status) { "passed" -> MaterialTheme.colorScheme.primary; "failed" -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.tertiary }
    Row(
        Modifier.padding(top = 4.dp).fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(icon, color = color, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
        Text(v.criterionId, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
        Text(v.method, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        v.confidence?.let { Text("置信度 ${(it * 100).toInt()}%", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun FindingCard(f: QualityFinding, vm: ChatViewModel) {
    var expanded by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val hasDetail = f.evidence.isNotBlank() || f.reproduction != null || f.suggestion != null
    Card(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                modifier = if (hasDetail) Modifier.clickable { expanded = !expanded } else Modifier,
            ) {
                Text(
                    f.severity,
                    style = MaterialTheme.typography.labelMedium,
                    color = severityColor(f.severity),
                )
                Spacer(Modifier.width(8.dp))
                Text(f.claim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                if (f.blocking) {
                    Text("阻断", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
                Text(
                    f.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (hasDetail) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            f.file?.let {
                Text(
                    "$it${f.line?.let { l -> ":$l" } ?: ""} · 置信度 ${(f.confidence * 100).toInt()}%",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            if (expanded && hasDetail) {
                if (f.evidence.isNotBlank()) {
                    Text(
                        "证据：${f.evidence}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                f.reproduction?.let {
                    Text(
                        "复现：$it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                f.suggestion?.let {
                    Text(
                        "建议：$it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                Row(
                    modifier = Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(onClick = {
                        note = "标记已修复…"
                        vm.resolveQualityFinding(f.id, "fixed", "by user: 标记已修复")
                    }) {
                        Text("标记已修复", style = MaterialTheme.typography.labelSmall)
                    }
                    TextButton(onClick = {
                        note = "忽略…"
                        vm.resolveQualityFinding(f.id, "dismissed", "by user: 忽略")
                    }) {
                        Text("忽略", style = MaterialTheme.typography.labelSmall)
                    }
                    TextButton(onClick = {
                        note = "接受风险…"
                        vm.resolveQualityFinding(f.id, "accepted-risk", "by user: 接受风险")
                    }) {
                        Text("接受风险", style = MaterialTheme.typography.labelSmall)
                    }
                }
                note?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFF1C40F),
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun IncidentCard(i: QualityIncident, vm: ChatViewModel) {
    var expanded by remember { mutableStateOf(false) }
    Card(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                modifier = if (i.reproduction.isNullOrBlank()) Modifier else Modifier.clickable { expanded = !expanded },
            ) {
                Text(
                    i.severity,
                    style = MaterialTheme.typography.labelMedium,
                    color = severityColor(i.severity),
                )
                Spacer(Modifier.width(8.dp))
                Text(i.description, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                Text(
                    i.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (i.reproduction.isNullOrBlank().not()) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (expanded && !i.reproduction.isNullOrBlank()) {
                i.reproduction.let {
                    Text(
                        "复现：$it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                i.regressionTest?.let {
                    Text(
                        "回归测试：$it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                Row(
                    modifier = Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (i.status != "covered") {
                        TextButton(onClick = { vm.resolveQualityIncident(i.id, "covered") }) {
                            Text("标记为已覆盖", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (i.status != "accepted-risk") {
                        TextButton(onClick = { vm.resolveQualityIncident(i.id, "accepted-risk") }) {
                            Text("接受风险", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RuleCard(r: QualityRule, vm: ChatViewModel) {
    var expanded by remember { mutableStateOf(false) }
    Card(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                modifier = Modifier.clickable { expanded = !expanded },
            ) {
                Text(r.rule, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                Text(
                    r.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "复发${r.recurrence}次",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp),
                )
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                Text(
                    "证据 incidents：${r.evidenceIncidentIds.joinToString(", ")}",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                r.measuredImpact?.let {
                    Text(
                        "影响：$it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                Row(
                    modifier = Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (r.status != "approved") {
                        TextButton(onClick = { vm.resolveQualityRule(r.id, "approved") }) {
                            Text("批准", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (r.status != "active") {
                        TextButton(onClick = { vm.resolveQualityRule(r.id, "active") }) {
                            Text("激活", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (r.status != "rejected") {
                        TextButton(onClick = { vm.resolveQualityRule(r.id, "rejected") }) {
                            Text("拒绝", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ReviewTierConfigForm(
    reviewConfig: ReviewConfigV2,
    projectId: String?,
    modelList: List<com.agenthub.ModelInfo>,
    onLoadModels: () -> Unit,
    onSave: (Pair<String, ReviewConfigV2>) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var draft by remember(reviewConfig) { mutableStateOf(reviewConfig) }

    LaunchedEffect(expanded) {
        if (expanded && modelList.isEmpty()) onLoadModels()
    }

    val riskOptions = listOf("low" to "低", "medium" to "中", "high" to "高", "critical" to "关键")
    val tierOptions = listOf("light" to "轻量", "standard" to "标准", "deep" to "深度")
    val modeOptions = listOf("off" to "关闭", "advisory" to "建议", "blocking" to "阻塞")
    val severityOptions = listOf("major" to "major", "critical" to "critical")

    Column {
        OutlinedButton(onClick = { expanded = !expanded }) {
            Text(if (expanded) "▼ Review 配置" else "▶ Review 配置")
        }
        if (expanded && projectId != null) {
            Spacer(Modifier.height(8.dp))
            Text("Review 模式", style = MaterialTheme.typography.labelSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                modeOptions.forEach { (v, label) ->
                    FilterChip(
                        selected = draft.mode == v,
                        onClick = { draft = draft.copy(mode = v) },
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("阻塞严重度", style = MaterialTheme.typography.labelSmall)
                    ReviewSelectField(
                        value = draft.blockSeverity,
                        options = severityOptions,
                        onChange = { draft = draft.copy(blockSeverity = it) },
                    )
                }
                Column(Modifier.weight(1f)) {
                    Text("最小阻塞置信度", style = MaterialTheme.typography.labelSmall)
                    OutlinedTextField(
                        value = draft.minBlockingConfidence.toString(),
                        onValueChange = { v ->
                            v.toDoubleOrNull()?.let { draft = draft.copy(minBlockingConfidence = it) }
                        },
                        singleLine = true,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("触发条件", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("最小 diff 行数", style = MaterialTheme.typography.labelSmall)
                    OutlinedTextField(
                        value = draft.trigger.minDiffLines.toString(),
                        onValueChange = { v ->
                            v.toIntOrNull()?.let { draft = draft.copy(trigger = draft.trigger.copy(minDiffLines = it)) }
                        },
                        singleLine = true,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Column {
                Text("跳过模式（逗号分隔 glob）", style = MaterialTheme.typography.labelSmall)
                OutlinedTextField(
                    value = draft.trigger.skipPatterns.joinToString(", "),
                    onValueChange = { v ->
                        draft = draft.copy(trigger = draft.trigger.copy(skipPatterns = v.split(",").map { it.trim() }.filter { it.isNotEmpty() }))
                    },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(8.dp))
            Text("风险 → Tier 映射", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("默认", style = MaterialTheme.typography.labelSmall)
                    ReviewSelectField(
                        value = draft.tierMapping.default,
                        options = tierOptions,
                        onChange = { draft = draft.copy(tierMapping = draft.tierMapping.copy(default = it)) },
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Column {
                riskOptions.forEach { (risk, label) ->
                    val tier = draft.tierMapping.byRisk[risk] ?: ""
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("$label：", style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(48.dp))
                        ReviewSelectField(
                            value = tier,
                            options = listOf("" to "（继承默认）") + tierOptions,
                            onChange = { v ->
                                val newByRisk = draft.tierMapping.byRisk.toMutableMap()
                                if (v.isEmpty()) newByRisk.remove(risk) else newByRisk[risk] = v
                                draft = draft.copy(tierMapping = draft.tierMapping.copy(byRisk = newByRisk))
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("Reviewer 模型", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            val modelOptions = listOf("" to "（使用 agent 默认）") + modelList.map { it.uid to "${it.label}（${it.backend}）" }
            ReviewSelectField(
                value = draft.model,
                options = modelOptions,
                onChange = { draft = draft.copy(model = it) },
            )
            if (draft.model.isNotEmpty()) {
                val selected = modelList.find { it.uid == draft.model }
                Text(selected?.let { "后端：${it.backend} · 标识：${it.uid}" } ?: "未知模型：${draft.model}", style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { onSave(projectId to draft) },
                enabled = draft != reviewConfig,
            ) {
                Text("保存 Review 配置")
            }
        }
    }
}

@Composable
private fun ReviewSelectField(
    value: String,
    options: List<Pair<String, String>>,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        OutlinedButton(
            onClick = { open = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(options.find { it.first == value }?.second ?: value.ifBlank { "（未选择）" })
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
        ) {
            options.forEach { (v, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = { onChange(v); open = false },
                )
            }
        }
    }
}

@Composable
fun RequirementVerificationConfigForm(
    requirementsMode: String,
    requirementsMaxQuestions: Int,
    verificationMode: String,
    projectId: String?,
    onSave: (projectId: String, requirementsMode: String, maxQuestions: Int, verificationMode: String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var draftRequirements by remember { mutableStateOf(requirementsMode) }
    var draftMaxQuestions by remember { mutableStateOf(requirementsMaxQuestions.toString()) }
    var draftVerification by remember { mutableStateOf(verificationMode) }

    LaunchedEffect(requirementsMode, requirementsMaxQuestions, verificationMode) {
        draftRequirements = requirementsMode
        draftMaxQuestions = requirementsMaxQuestions.toString()
        draftVerification = verificationMode
    }

    val requirementOptions = listOf("off" to "关闭", "suggest" to "建议", "require" to "要求")
    val verificationOptions = listOf("off" to "关闭", "suggest" to "建议", "require-evidence" to "要求证据")

    Column {
        OutlinedButton(onClick = { expanded = !expanded }) {
            Text(if (expanded) "▼ 需求/验证配置" else "▶ 需求/验证配置")
        }
        if (expanded && projectId != null) {
            Spacer(Modifier.height(8.dp))
            Text("需求澄清模式", style = MaterialTheme.typography.labelSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                requirementOptions.forEach { (v, label) ->
                    FilterChip(
                        selected = draftRequirements == v,
                        onClick = { draftRequirements = v },
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("最多问题数", style = MaterialTheme.typography.labelSmall, modifier = Modifier.width(80.dp))
                OutlinedTextField(
                    value = draftMaxQuestions,
                    onValueChange = { v ->
                        when {
                            v.isBlank() -> draftMaxQuestions = ""
                            v.toIntOrNull() != null -> {
                                val n = v.toIntOrNull()!!
                                if (n >= 0) draftMaxQuestions = n.toString()
                            }
                        }
                    },
                    singleLine = true,
                    modifier = Modifier.width(80.dp),
                )
            }
            Spacer(Modifier.height(8.dp))
            Text("L3 验证模式", style = MaterialTheme.typography.labelSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                verificationOptions.forEach { (v, label) ->
                    FilterChip(
                        selected = draftVerification == v,
                        onClick = { draftVerification = v },
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            val maxQ = draftMaxQuestions.toIntOrNull() ?: requirementsMaxQuestions
            Button(
                onClick = { onSave(projectId, draftRequirements, maxQ, draftVerification) },
                enabled = draftRequirements != requirementsMode || maxQ != requirementsMaxQuestions || draftVerification != verificationMode,
            ) { Text("保存需求/验证配置") }
        }
    }
}

@Composable
private fun AcceptanceCriteriaCard(spec: RequirementSpec) {
    Card(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.3f)),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("需求目标", style = MaterialTheme.typography.titleSmall)
            Text(spec.goal, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (spec.acceptanceCriteria.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("验收标准（${spec.acceptanceCriteria.size}）", style = MaterialTheme.typography.titleSmall)
                spec.acceptanceCriteria.forEach { c ->
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.Top) {
                        Text(if (c.required) "●" else "○", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(6.dp))
                        Column {
                            Text(c.description, style = MaterialTheme.typography.bodySmall)
                            if (c.expectations.isNotEmpty()) {
                                Text(
                                    "证据：${c.expectations.joinToString("；")}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            if (spec.constraints.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("约束", style = MaterialTheme.typography.titleSmall)
                spec.constraints.forEach { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            if (spec.risks.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("风险", style = MaterialTheme.typography.titleSmall)
                spec.risks.forEach { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}
