package com.agenthub.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.QualityCheck
import com.agenthub.QualityFinding
import com.agenthub.QualityIncident
import com.agenthub.QualityRule
import com.agenthub.QualityRun
import com.agenthub.Screen
import java.text.DateFormat
import java.util.Date

private val STAGE_LABELS = mapOf(
    "queued" to "排队中",
    "preflight" to "预检",
    "implementing" to "实现中",
    "collecting" to "收集变更",
    "quick-verifying" to "快速验证",
    "reviewing" to "审查中",
    "fixing" to "修复中",
    "full-verifying" to "完整验证",
    "awaiting-approval" to "等待审批",
    "accepted" to "已通过",
    "failed" to "失败",
    "cancelled" to "已取消",
    "quarantined" to "已隔离",
)

private val TERMINAL_STAGES = setOf("accepted", "failed", "cancelled", "quarantined")

private fun fmtTime(ts: Long?): String =
    if (ts == null || ts <= 0) "—" else DateFormat.getDateTimeInstance().format(Date(ts))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QualityScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current

    LaunchedEffect(Unit) {
        vm.loadQualityProjects()
        vm.loadQualityRuns()
        vm.loadQualityIncidents()
        vm.loadQualityRules()
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
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(vm.qualityProjects, key = { it.id }) { p ->
                                    FilterChip(
                                        selected = vm.qualityProjectId == p.id,
                                        onClick = { vm.selectQualityProject(p.id) },
                                        label = { Text(p.displayName.ifBlank { p.root }) },
                                    )
                                }
                            }
                        }
                        vm.qualityPolicy?.let { pol ->
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "策略：${if (pol.source == "file") ".devin/quality.json" else "默认 observe"} · autonomy=${pol.autonomy} · checks=${pol.checkCount}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            pol.errors.forEach { e ->
                                Text(
                                    "⚠ $e",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error,
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
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Text("运行记录", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            if (vm.qualityProjectId != null) {
                                IconButton(onClick = { vm.startQualityRun() }) {
                                    Icon(Icons.Filled.PlayArrow, contentDescription = "发起质量运行")
                                }
                            }
                        }
                        if (vm.qualityRuns.isEmpty()) {
                            Text(
                                "暂无质量运行",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            vm.qualityRuns.forEach { r ->
                                RunRow(
                                    run = r,
                                    selected = r.id == vm.qualityRunId,
                                    onClick = { vm.loadQualityRun(r.id) },
                                )
                                Spacer(Modifier.height(6.dp))
                            }
                        }
                    }
                }
            }

            selectedRun?.let { run ->
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
                                Text(
                                    run.id,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontFamily = FontFamily.Monospace,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    STAGE_LABELS[run.stage] ?: run.stage,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = stageColor(run.stage),
                                )
                            }
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "风险：${run.risk} · 触发：${run.trigger} · 修复轮次：${run.fixRound}/${run.maxFixRounds}\n" +
                                    "判定：${run.verdict ?: "—"}${run.failureCode?.let { " · $it" } ?: ""}\n" +
                                    "创建：${fmtTime(run.createdAt)} · 更新：${fmtTime(run.updatedAt)}" +
                                    (run.completedAt?.let { " · 完成：${fmtTime(it)}" } ?: ""),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            run.patchHash?.let {
                                Text(
                                    "patchHash：$it",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }

                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (run.stage == "awaiting-approval") {
                                    Button(onClick = { vm.qualityRunAction(run.id, "approve") }) {
                                        Text("批准")
                                    }
                                    OutlinedButton(onClick = { vm.qualityRunAction(run.id, "reject") }) {
                                        Text("拒绝")
                                    }
                                }
                                if (run.stage !in TERMINAL_STAGES) {
                                    OutlinedButton(onClick = { vm.qualityRunAction(run.id, "cancel") }) {
                                        Text("取消")
                                    }
                                }
                                if (run.stage in TERMINAL_STAGES && run.stage != "accepted") {
                                    OutlinedButton(onClick = { vm.qualityRunAction(run.id, "retry") }) {
                                        Text("重试")
                                    }
                                }
                            }

                            Spacer(Modifier.height(12.dp))
                            Text("检查（${vm.qualityChecks.size}）", style = MaterialTheme.typography.titleSmall)
                            if (vm.qualityChecks.isEmpty()) {
                                Text(
                                    "暂无检查记录",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            } else {
                                vm.qualityChecks.forEach { c -> CheckCard(c) }
                            }

                            Spacer(Modifier.height(12.dp))
                            Text("审查发现（${vm.qualityFindings.size}）", style = MaterialTheme.typography.titleSmall)
                            if (vm.qualityFindings.isEmpty()) {
                                Text(
                                    "暂无审查发现",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            } else {
                                vm.qualityFindings.forEach { f -> FindingCard(f, vm) }
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
                        Text("Incident 列表", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(8.dp))
                        if (vm.qualityIncidents.isEmpty()) {
                            Text(
                                "暂无 incident",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            vm.qualityIncidents.forEach { i ->
                                IncidentCard(i, vm)
                                Spacer(Modifier.height(6.dp))
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
                            vm.qualityRules.forEach { r ->
                                RuleCard(r, vm)
                                Spacer(Modifier.height(6.dp))
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
    "cancelled" -> MaterialTheme.colorScheme.onSurfaceVariant
    "awaiting-approval" -> Color(0xFFF1C40F)
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
private fun RunRow(run: QualityRun, selected: Boolean, onClick: () -> Unit) {
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
                STAGE_LABELS[run.stage] ?: run.stage,
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
        }
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
