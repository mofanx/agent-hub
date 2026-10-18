package com.agenthub.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.Mission
import com.agenthub.MissionReview
import com.agenthub.RoomInfo
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

private fun ownerName(room: RoomInfo?, sessionId: String): String =
    room?.members?.firstOrNull { it.first == sessionId }?.second ?: sessionId

@Composable
private fun missionColor(status: String): androidx.compose.ui.graphics.Color = when (status) {
    "running" -> MaterialTheme.colorScheme.primary
    "failed" -> MaterialTheme.colorScheme.error
    "waiting-user", "awaiting-acceptance" -> MaterialTheme.colorScheme.tertiary
    "accepted" -> MaterialTheme.colorScheme.secondary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun DecisionBlock(vm: ChatViewModel, S: Strings) {
    if (vm.pendingDecisions.isEmpty()) return
    var busyId by remember { mutableStateOf<String?>(null) }
    Text("${S.decisionSection} (${vm.pendingDecisions.size})", style = MaterialTheme.typography.titleSmall)
    vm.pendingDecisions.forEach { d ->
        androidx.compose.runtime.key(d.decisionId) {
        Card(
            Modifier.fillMaxWidth().padding(vertical = 4.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
        ) {
            Column(Modifier.padding(10.dp)) {
                Text(d.title, style = MaterialTheme.typography.titleSmall)
                Text(
                    "${S.decisionFrom} ${d.requestedBy}${d.roomId?.let { " · $it" } ?: " · ${d.sessionId.take(8)}"} · " +
                        S.decisionWaitingFmt.format(((System.currentTimeMillis() - d.at) / 60000).coerceAtLeast(0)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (d.contextSummary.isNotEmpty()) {
                    Text(
                        if (d.contextSummary == "redacted") S.decisionRedacted else d.contextSummary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (d.type == "permission") {
                    androidx.compose.foundation.layout.FlowRow {
                        d.options.forEach { (oid, label) ->
                            TextButton(
                                onClick = {
                                    if (busyId == null) {
                                        busyId = d.requestId + oid
                                        vm.respondToDecision(d, oid) { busyId = null }
                                    }
                                },
                                enabled = busyId == null,
                            ) { Text(label) }
                        }
                    }
                } else {
                    TextButton(onClick = {
                        d.roomId?.let { rid -> vm.rooms.find { it.roomId == rid } }?.let { vm.openRoom(it) }
                            ?: vm.sessions.find { it.sessionId == d.sessionId }?.let { vm.openChat(it) }
                    }) { Text(S.decisionLocate) }
                }
            }
        }
        }
    }
}

@Composable
private fun ReviewBlock(m: Mission, vm: ChatViewModel, S: Strings) {
    if (m.status != "awaiting-acceptance") return
    var editIdx by remember { mutableStateOf<Int?>(null) }
    var reviewBusy by remember { mutableStateOf(false) }
    var verdict by remember { mutableStateOf("unverified") }
    var note by rememberSaveable { mutableStateOf("") }
    var picked by remember { mutableStateOf(setOf<String>()) }
    val tasks = (m.flow?.get("tasks") as? kotlinx.serialization.json.JsonArray)
        ?.mapNotNull { it as? kotlinx.serialization.json.JsonObject } ?: emptyList()
    m.acceptanceCriteria.forEachIndexed { i, c ->
        val rv = m.reviews.find { it.index == i }
        Column(Modifier.padding(vertical = 4.dp)) {
            Text(
                "${i + 1}. $c  [${
                    when (rv?.verdict) {
                        "pass" -> S.missionReviewPass
                        "fail" -> S.missionReviewFail
                        else -> S.missionReviewUnverified
                    }
                }]",
                style = MaterialTheme.typography.bodySmall,
            )
            rv?.let {
                if (it.note.isNotEmpty() || it.taskIds.isNotEmpty()) {
                    Text(
                        "${it.note}${if (it.taskIds.isNotEmpty()) " · ${S.missionReviewTasks}: ${it.taskIds.joinToString(",")}" else ""}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (editIdx == i) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    listOf("unverified" to S.missionReviewUnverified, "pass" to S.missionReviewPass, "fail" to S.missionReviewFail).forEach { (v, l) ->
                        TextButton(onClick = { verdict = v }) {
                            Text(if (verdict == v) "● $l" else l)
                        }
                    }
                }
                OutlinedTextField(value = note, onValueChange = { note = it }, label = { Text(S.missionReviewNote) }, modifier = Modifier.fillMaxWidth())
                if (tasks.isNotEmpty()) {
                    Text(S.missionReviewTasks, style = MaterialTheme.typography.bodySmall)
                    tasks.forEach { t ->
                        val id = t["id"]?.jsonPrimitive?.contentOrNull ?: ""
                        if (id.isNotEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                androidx.compose.material3.Checkbox(
                                    checked = picked.contains(id),
                                    onCheckedChange = { picked = if (picked.contains(id)) picked - id else picked + id },
                                )
                                Text("$id ${t["status"]?.jsonPrimitive?.contentOrNull ?: ""}", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                TextButton(
                    onClick = {
                        reviewBusy = true
                        vm.reviewMission(m.id, i, verdict, picked.toList(), note) { ok ->
                            reviewBusy = false
                            if (ok) editIdx = null
                        }
                    },
                    enabled = !reviewBusy && (verdict != "pass" || note.isNotBlank()),
                ) { Text(S.missionReview) }
            } else {
                TextButton(onClick = {
                    editIdx = i
                    verdict = rv?.verdict ?: "unverified"
                    note = rv?.note ?: ""
                    picked = (rv?.taskIds ?: emptyList()).toSet()
                }) { Text(S.missionReview) }
            }
        }
    }
}


private val FILTERS = listOf("all", "active", "waiting", "risk", "acceptance", "closed")

private fun filterLabel(S: Strings, k: String) = when (k) {
    "active" -> S.missionFilterActive
    "waiting" -> S.missionFilterWaiting
    "risk" -> S.missionFilterRisk
    "acceptance" -> S.missionFilterAcceptance
    "closed" -> S.missionFilterClosed
    else -> S.missionFilterAll
}

private fun filterMatch(m: Mission, k: String) = when (k) {
    "active" -> m.status == "running"
    "waiting" -> m.status == "waiting-user"
    "risk" -> m.status == "failed" || m.error != null
    "acceptance" -> m.status == "awaiting-acceptance"
    "closed" -> m.status in listOf("accepted", "stopped", "failed")
    else -> true
}

@Composable
fun MissionSection(vm: ChatViewModel, S: Strings, onCreateRoom: () -> Unit) {
    if (!vm.missionSupported) return
    val rooms = vm.rooms.filter { !it.archived }
    var filter by rememberSaveable { mutableStateOf("all") }
    var showForm by rememberSaveable { mutableStateOf(false) }
    var roomId by rememberSaveable { mutableStateOf("") }
    val room = rooms.firstOrNull { it.roomId == roomId } ?: rooms.firstOrNull()
    var ownerId by rememberSaveable { mutableStateOf("") }
    var goal by rememberSaveable { mutableStateOf("") }
    var criteria by rememberSaveable { mutableStateOf("") }
    var scopeText by rememberSaveable { mutableStateOf("") }
    var constraints by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var confirmStart by remember { mutableStateOf<Mission?>(null) }
    var confirmStop by remember { mutableStateOf<Mission?>(null) }
    var suppId by remember { mutableStateOf<String?>(null) }
    var suppText by rememberSaveable { mutableStateOf("") }
    var reworkId by remember { mutableStateOf<String?>(null) }
    var reworkNote by rememberSaveable { mutableStateOf("") }
    var editId by remember { mutableStateOf<String?>(null) }
    var schedId by remember { mutableStateOf<Mission?>(null) }
    var schedTime by rememberSaveable { mutableStateOf("09:00") }
    var schedAuto by rememberSaveable { mutableStateOf(false) }
    var schedAutoConfirm by remember { mutableStateOf(false) }
    var maxAutoRetries by rememberSaveable { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(vm.currentProfile) {
        confirmStart = null
        confirmStop = null
        suppId = null
        reworkId = null
        editId = null
        showForm = false
        busy = false
        schedId = null
        schedAutoConfirm = false
        goal = ""
        criteria = ""
        scopeText = ""
        constraints = ""
        ownerId = ""
        maxAutoRetries = 0
    }

    val lines = { v: String -> v.split("\n").map { it.trim() }.filter { it.isNotEmpty() } }
    val missions = vm.missions.sortedByDescending { it.updatedAt }
    val filtered = missions.filter { filterMatch(it, filter) }

    Card(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
    ) {
        Column(Modifier.padding(12.dp)) {
            DecisionBlock(vm, S)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${S.missionSection} (${missions.size})", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { showForm = !showForm }) { Text(S.missionNew) }
            }
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                FILTERS.forEach { k ->
                    val count = missions.count { filterMatch(it, k) }
                    TextButton(onClick = { filter = k }) {
                        Text("${filterLabel(S, k)} $count", color = if (filter == k) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Text(S.missionRiskNotice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            vm.missionError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            if (showForm) {
                if (rooms.isEmpty()) {
                    Text(S.missionNoRoom, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onCreateRoom) { Text(S.missionCreateRoom) }
                } else {
                    var roomMenu by remember { mutableStateOf(false) }
                    var ownerMenu by remember { mutableStateOf(false) }
                    Column {
                        Box {
                            OutlinedButton(onClick = { if (editId == null) roomMenu = true }, enabled = editId == null) { Text(room?.name ?: "-") }
                            DropdownMenu(expanded = roomMenu, onDismissRequest = { roomMenu = false }) {
                                rooms.forEach { r ->
                                    DropdownMenuItem(text = { Text(r.name) }, onClick = { roomId = r.roomId; ownerId = ""; roomMenu = false })
                                }
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        Box {
                            OutlinedButton(onClick = { ownerMenu = true }) { Text(if (ownerId.isBlank()) S.missionOwnerAuto else ownerName(room, ownerId)) }
                            DropdownMenu(expanded = ownerMenu, onDismissRequest = { ownerMenu = false }) {
                                DropdownMenuItem(text = { Text(S.missionOwnerAuto) }, onClick = { ownerId = ""; ownerMenu = false })
                                (room?.members ?: emptyList()).forEach { (sid, name) ->
                                    DropdownMenuItem(text = { Text(name) }, onClick = { ownerId = sid; ownerMenu = false })
                                }
                            }
                        }
                    }
                    OutlinedTextField(value = goal, onValueChange = { goal = it }, label = { Text(S.missionGoal) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(value = criteria, onValueChange = { criteria = it }, label = { Text(S.missionCriteria) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = scopeText, onValueChange = { scopeText = it }, label = { Text(S.missionScope) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(value = constraints, onValueChange = { constraints = it }, label = { Text(S.missionConstraints) }, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(S.missionAutoRetries, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        (0..3).forEach { n ->
                            TextButton(onClick = { maxAutoRetries = n }) { Text("$n", color = if (maxAutoRetries == n) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                    Text(S.missionAutoRetriesHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    Button(
                        onClick = {
                            if (busy || room == null) return@Button
                            val ac = lines(criteria)
                            if (goal.isBlank() || ac.isEmpty()) return@Button
                            busy = true
                            if (editId != null) {
                                vm.updateMissionContract(editId!!, goal.trim(), ac, scopeText.trim(), lines(constraints), ownerId.ifBlank { null }, maxAutoRetries) { ok ->
                                    busy = false
                                    if (ok) { editId = null; showForm = false; goal = ""; criteria = ""; scopeText = ""; constraints = ""; maxAutoRetries = 0 }
                                }
                            } else {
                                vm.createMission(room.roomId, goal.trim(), ac, scopeText.trim(), lines(constraints), ownerId.ifBlank { null }, maxAutoRetries) { created ->
                                    busy = false
                                    if (created != null) { showForm = false; goal = ""; criteria = ""; scopeText = ""; constraints = ""; maxAutoRetries = 0 }
                                }
                            }
                        },
                        enabled = !busy && goal.isNotBlank() && lines(criteria).isNotEmpty(),
                    ) { Text(if (editId != null) S.missionEditContract else S.missionSaveDraft) }
                }
            }
            if (filtered.isEmpty()) {
                Text(S.missionEmpty, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            filtered.forEach { m ->
                androidx.compose.runtime.key(m.id) {
                val rm = rooms.firstOrNull { it.roomId == m.roomId }
                var acceptNote by rememberSaveable(m.id) { mutableStateOf("") }
                val allPassed = m.acceptanceCriteria.indices.all { i -> m.reviews.find { it.index == i }?.verdict == "pass" }
                Card(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
                ) {
                    Column(Modifier.padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(missionStatusLabel(S, m.status), style = MaterialTheme.typography.labelSmall, color = missionColor(m.status))
                            Spacer(Modifier.width(8.dp))
                            Text(m.goal, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        }
                        Text(
                            buildString {
                                append(rm?.name ?: m.roomId)
                                append(" · ${S.missionOwner}: ${ownerName(rm, m.ownerSessionId)}")
                                if (m.scope.isNotBlank()) append(" · ${S.missionScope}: ${m.scope}")
                                if (m.constraints.isNotEmpty()) append(" · ${m.constraints.joinToString("；")}")
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text("${S.missionCriteriaShort}: ${m.acceptanceCriteria.joinToString("；")}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        m.reworkReason?.let { Text("${S.missionReworkReason}: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        if (m.maxAutoRetries > 0 || m.autoRetryCount > 0) {
                            Text(String.format(S.missionAutoRetryCount, m.autoRetryCount, m.maxAutoRetries), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (m.supplements.isNotEmpty()) {
                            Text(
                                "${S.missionSupplement}: ${m.supplements.joinToString("；") { "${it.text}(${if (it.delivered) S.missionDelivered else S.missionRecordedOnly})" }}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (m.status == "awaiting-acceptance") {
                            Text(S.missionAwaitingHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                        }
                        m.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                        MissionEvidence(m, S)
                        if (m.events.isNotEmpty()) {
                            var showEvents by remember { mutableStateOf(false) }
                            Text(
                                "${S.missionEventsDetail} (${m.events.size})",
                                Modifier.clickable { showEvents = !showEvents },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            if (showEvents) {
                                m.events.forEach { e ->
                                    Text("[${missionEventLabel(S, e.kind)}] ${e.text}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        if (m.status in listOf("accepted", "failed", "stopped") && m.reviews.any { it.verdict != "unverified" }) {
                            m.acceptanceCriteria.forEachIndexed { i, c ->
                                val rv = m.reviews.find { it.index == i }
                                val vl = when (rv?.verdict) { "pass" -> S.missionReviewPass; "fail" -> S.missionReviewFail; else -> S.missionReviewUnverified }
                                Text("${i + 1}. $c — $vl${rv?.note?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            m.acceptanceNote?.let { Text("${S.missionAcceptedNote}: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        ReviewBlock(m, vm, S)
                        if (m.status == "awaiting-acceptance") {
                            OutlinedTextField(value = acceptNote, onValueChange = { acceptNote = it }, label = { Text(S.missionReviewNote) }, modifier = Modifier.fillMaxWidth())
                            Button(
                                onClick = { busy = true; vm.acceptMission(m.id, acceptNote) { busy = false } },
                                enabled = allPassed && !busy,
                            ) { Text(S.missionAccept) }
                        }
                        androidx.compose.foundation.layout.FlowRow {
                            if (m.status == "draft") {
                                TextButton(onClick = { confirmStart = m }, enabled = !busy) { Text(S.missionStart) }
                                TextButton(onClick = {
                                    editId = m.id
                                    showForm = true
                                    roomId = m.roomId
                                    ownerId = m.ownerSessionId
                                    maxAutoRetries = m.maxAutoRetries
                                    goal = m.goal
                                    criteria = m.acceptanceCriteria.joinToString("\n")
                                    scopeText = m.scope
                                    constraints = m.constraints.joinToString("\n")
                                }) { Text(S.missionEditContract) }
                            }
                            if (m.status == "draft") {
                                TextButton(onClick = { confirmStop = m }, enabled = !busy) { Text(S.missionDraftClose, color = MaterialTheme.colorScheme.error) }
                            }
                            if (m.status == "waiting-user" && m.flow?.get("phase")?.jsonPrimitive?.contentOrNull == "awaiting-retry") {
                                TextButton(onClick = { busy = true; vm.retryMission(m.id) { busy = false } }, enabled = !busy) { Text(S.missionRetry) }
                            }
                            if (m.status in listOf("running", "waiting-user", "awaiting-acceptance")) {
                                TextButton(onClick = { confirmStop = m }, enabled = !busy) { Text(S.missionStop, color = MaterialTheme.colorScheme.error) }
                            }
                            if (m.status in listOf("running", "waiting-user")) {
                                if (suppId == m.id) {
                                    OutlinedTextField(value = suppText, onValueChange = { suppText = it }, modifier = Modifier.fillMaxWidth())
                                    TextButton(onClick = { busy = true; vm.supplementMission(m.id, suppText) { ok -> busy = false; if (ok) { suppId = null; suppText = "" } } }) { Text(S.missionSupplement) }
                                } else {
                                    TextButton(onClick = { suppId = m.id; suppText = "" }) { Text(S.missionSupplement) }
                                }
                            }
                            if (m.status in listOf("awaiting-acceptance", "failed", "stopped")) {
                                if (reworkId == m.id) {
                                    OutlinedTextField(value = reworkNote, onValueChange = { reworkNote = it }, modifier = Modifier.fillMaxWidth(), label = { Text(S.missionReworkNote) })
                                    TextButton(onClick = { busy = true; vm.reworkMission(m.id, reworkNote) { ok -> busy = false; if (ok != null) { reworkId = null; reworkNote = "" } } }, enabled = reworkNote.isNotBlank() && !busy) { Text(S.missionRework) }
                                } else {
                                    TextButton(onClick = { reworkId = m.id; reworkNote = "" }) { Text(S.missionRework) }
                                }
                            }
                            TextButton(onClick = { schedId = m; schedAuto = false }) { Text(S.missionSchedule) }
                            if (rm != null) {
                                TextButton(onClick = { vm.openRoom(rm) }) { Text(S.missionViewRoom) }
                            }
                        }
                        if (suppId == m.id) {
                            Text(S.missionSupplementHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                }
            }
        }
    }

    confirmStart?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmStart = null },
            title = { Text(S.missionStart) },
            text = { Text("${S.missionStartConfirm}\n\n${m.goal}\n${S.missionRiskNotice}") },
            confirmButton = {
                TextButton(onClick = { busy = true; vm.startMission(m.id) { busy = false }; confirmStart = null }) { Text(S.missionStart) }
            },
            dismissButton = { TextButton(onClick = { confirmStart = null }) { Text(S.cancel) } },
        )
    }
    confirmStop?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmStop = null },
            title = { Text(S.missionStop) },
            text = { Text(S.missionStopConfirm) },
            confirmButton = {
                TextButton(onClick = { busy = true; vm.stopMission(m.id) { busy = false }; confirmStop = null }) { Text(S.missionStop, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmStop = null }) { Text(S.cancel) } },
        )
    }
    schedId?.let { m ->
        val rm = rooms.firstOrNull { it.roomId == m.roomId }
        AlertDialog(
            onDismissRequest = { schedId = null; schedAutoConfirm = false },
            title = { Text(S.missionSchedule) },
            text = {
                Column {
                    Text("${S.missionFrozenContract}: ${m.goal}", style = MaterialTheme.typography.bodySmall)
                    m.acceptanceCriteria.forEach { Text("· $it", style = MaterialTheme.typography.bodySmall) }
                    if (m.scope.isNotBlank()) Text("${S.missionScope}: ${m.scope}", style = MaterialTheme.typography.bodySmall)
                    if (m.constraints.isNotEmpty()) Text(m.constraints.joinToString("；"), style = MaterialTheme.typography.bodySmall)
                    Text(S.missionScheduleDraftOnly, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(value = schedTime, onValueChange = { schedTime = it }, label = { Text(S.missionTimeLabel) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(checked = schedAuto, onCheckedChange = { schedAuto = it; schedAutoConfirm = false })
                        Text(S.missionAutoStart, style = MaterialTheme.typography.bodySmall)
                    }
                    if (schedAuto) Text(S.missionAutoStartConfirm, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (schedAuto && !schedAutoConfirm) { schedAutoConfirm = true; return@TextButton }
                    busy = true
                    vm.createMissionSchedule(m.goal.take(40), m.roomId, rm?.name ?: m.roomId, "${S.missionSchedule}: ${m.goal.take(80)}", schedTime, m.id, schedAuto) { ok -> busy = false; if (ok) schedId = null }
                }, enabled = !busy) { Text(S.missionScheduleSave) }
            },
            dismissButton = { TextButton(onClick = { schedId = null; schedAutoConfirm = false }) { Text(S.cancel) } },
        )
    }
    if (schedAutoConfirm && schedId != null) {
        AlertDialog(
            onDismissRequest = { schedAutoConfirm = false },
            title = { Text(S.missionAutoStart) },
            text = { Text(S.missionAutoStartConfirm) },
            confirmButton = {
                TextButton(onClick = {
                    val m = schedId ?: return@TextButton
                    val rm = rooms.firstOrNull { it.roomId == m.roomId }
                    busy = true
                    schedAutoConfirm = false
                    vm.createMissionSchedule(m.goal.take(40), m.roomId, rm?.name ?: m.roomId, "${S.missionSchedule}: ${m.goal.take(80)}", schedTime, m.id, true) { ok -> busy = false; if (ok) schedId = null }
                }) { Text(S.missionAutoStart) }
            },
            dismissButton = { TextButton(onClick = { schedAutoConfirm = false }) { Text(S.cancel) } },
        )
    }
}
