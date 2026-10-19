package com.agenthub.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.ChatViewModel
import com.agenthub.ScheduledTask
import com.agenthub.Screen
import com.agenthub.TaskLog
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlinx.serialization.json.contentOrNull

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleScreen(vm: ChatViewModel, onMenuClick: () -> Unit = {}) {
    val S = LocalStrings.current

    LaunchedEffect(Unit) { vm.loadScheduledTasks() }

    BackHandler { vm.screen = vm.scheduleReturnScreen }

    var showEditor by remember { mutableStateOf<ScheduledTask?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var showLogs by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(S.scheduledTasks) },
                navigationIcon = {
                    IconButton(onClick = { vm.screen = vm.scheduleReturnScreen }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = S.back)
                    }
                },
                actions = {
                    IconButton(onClick = {
                        vm.loadTaskLogs()
                        showLogs = true
                    }) {
                        Icon(Icons.Filled.History, contentDescription = S.logsTitle)
                    }
                    IconButton(onClick = { showCreate = true }) {
                        Icon(Icons.Filled.Add, contentDescription = S.createTask)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            if (vm.scheduledTasks.isEmpty() && showEditor == null && !showCreate) {
                Card(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                    ),
                ) {
                    Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            Icons.Filled.CalendarMonth,
                            contentDescription = null,
                            modifier = Modifier.size(32.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(S.noTasks, style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.height(12.dp))
                        TextButton(onClick = { showCreate = true }) {
                            Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.size(4.dp))
                            Text(S.createTask)
                        }
                    }
                }
            }

            vm.scheduledTasks.forEach { task ->
                TaskCard(
                    task = task,
                    S = S,
                    onToggle = { vm.toggleScheduledTask(task.id) },
                    onEdit = { showEditor = task },
                    onDelete = { vm.deleteScheduledTask(task.id) },
                )
                Spacer(Modifier.height(8.dp))
            }

            if (showCreate) {
                TaskEditorDialog(
                    vm = vm,
                    S = S,
                    task = null,
                    onDismiss = { showCreate = false },
                    onSave = { name, targetType, targetId, targetName, message,
                               scheduleMode, simpleKind, time, intervalMinutes, at, cronExpr, enabled ->
                        vm.createScheduledTask(
                            name, targetType, targetId, targetName, message,
                            scheduleMode, simpleKind, time, intervalMinutes, at, cronExpr, enabled,
                        ) { showCreate = false }
                    },
                )
            }

            showEditor?.let { task ->
                TaskEditorDialog(
                    vm = vm,
                    S = S,
                    task = task,
                    onDismiss = { showEditor = null },
                    onSave = { name, targetType, targetId, targetName, message,
                               scheduleMode, simpleKind, time, intervalMinutes, at, cronExpr, enabled ->
                        vm.updateScheduledTask(
                            task.id, name, targetType, targetId, targetName, message,
                            scheduleMode, simpleKind, time, intervalMinutes, at, cronExpr, enabled,
                        ) { showEditor = null }
                    },
                )
            }

            if (showLogs) {
                LogsPanel(
                    logs = vm.taskLogs,
                    onClear = { vm.clearTaskLogs() },
                    onClose = { showLogs = false },
                )
            }
        }
    }
}

@Composable
private fun LogsPanel(
    logs: List<TaskLog>,
    onClear: () -> Unit,
    onClose: () -> Unit,
) {
    val S = LocalStrings.current
    val df = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
    Card(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.History, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.size(8.dp))
                Text(S.runLogsTitle, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                IconButton(onClick = onClear, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Filled.Delete, contentDescription = S.actionClear, modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.error)
                }
            }
            Spacer(Modifier.height(8.dp))
            if (logs.isEmpty()) {
                Text(S.noRunRecords, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                logs.forEach { log ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            if (log.success) "✓" else "✗",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (log.success) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(log.taskName, style = MaterialTheme.typography.labelMedium)
                            Text("${df.format(Date(log.at))} → ${if (log.targetType == "room") S.roomLabel else S.sessionLabel} · ${log.targetName}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(S.messageFmt.format(log.message.take(60) + if (log.message.length > 60) "…" else ""),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (log.error != null) {
                                Text(S.errorFmt.format(log.error),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(
    task: ScheduledTask,
    S: Strings,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val df = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (task.enabled)
                MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
            else
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.CalendarMonth, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.size(8.dp))
                Text(
                    task.name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    if (task.enabled) S.taskEnabled else S.disabledTag,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (task.enabled) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(8.dp))
            val desc = describeSchedule(task, S)
            Text(S.targetFmt.format(if (task.targetType == "room") S.roomLabel else S.sessionLabel, task.targetName),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(S.scheduleFmt.format(desc),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(S.messageFmt.format(task.message.take(80) + if (task.message.length > 80) "…" else ""),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            task.missionTemplate?.let { tpl ->
                val tplScope = (tpl["scope"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull ?: ""
                val tplConstraints = (tpl["constraints"] as? kotlinx.serialization.json.JsonArray)
                    ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull } ?: emptyList()
                Text("${S.missionFrozenContract}: ${(tpl["goal"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull ?: ""}" +
                    "${if (tplScope.isNotBlank()) " · ${S.missionScope}: $tplScope" else ""}" +
                    "${if (tplConstraints.isNotEmpty()) " · ${tplConstraints.joinToString("; ")}" else ""}" +
                    " · ${if (task.missionAutoStart) S.missionAutoStart else S.taskTemplateDraftOnly}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(S.taskTemplateRebuild, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("${
                if (task.nextRunAt != null) "${S.nextRun}: ${df.format(Date(task.nextRunAt))}"
                else "${S.nextRun}: —"
            }",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("${
                if (task.lastRunAt != null) "${S.lastRun}: ${df.format(Date(task.lastRunAt))}"
                else "${S.lastRun}: —"
            }",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                IconButton(onClick = onToggle, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.PowerSettingsNew, contentDescription = S.toggle,
                        modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Edit, contentDescription = S.edit,
                        modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Delete, contentDescription = S.delete,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

private fun describeSchedule(task: ScheduledTask, S: Strings): String {
    if (task.scheduleMode == "cron") return "Cron: ${task.cronExpr ?: ""}"
    return when (task.simpleKind) {
        "daily" -> "${S.scheduleDaily} ${task.time ?: "09:00"}"
        "interval" -> S.schedIntervalFmt.format(task.intervalMinutes ?: 0)
        "once" -> "${S.scheduleOnce} ${task.at?.let { SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(it)) } ?: "—"}"
        else -> "—"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskEditorDialog(
    vm: ChatViewModel,
    S: Strings,
    task: ScheduledTask?,
    onDismiss: () -> Unit,
    onSave: (name: String, targetType: String, targetId: String, targetName: String,
             message: String, scheduleMode: String, simpleKind: String?,
             time: String?, intervalMinutes: Int?, at: Long?, cronExpr: String?,
             enabled: Boolean) -> Unit,
) {
    var name by remember { mutableStateOf(task?.name ?: "") }
    var targetType by remember { mutableStateOf(task?.targetType ?: "session") }
    var targetId by remember { mutableStateOf(task?.targetId ?: "") }
    var message by remember { mutableStateOf(task?.message ?: "") }
    var scheduleMode by remember { mutableStateOf(task?.scheduleMode ?: "simple") }
    var simpleKind by remember { mutableStateOf(task?.simpleKind ?: "daily") }
    var time by remember { mutableStateOf(task?.time ?: "09:00") }
    var intervalMinutes by remember { mutableStateOf((task?.intervalMinutes ?: 60).toString()) }
    var atTimestamp by remember { mutableStateOf(task?.at ?: 0L) }
    var cronExpr by remember { mutableStateOf(task?.cronExpr ?: "0 9 * * *") }
    var enabled by remember { mutableStateOf(task?.enabled ?: true) }
    var showCronHelp by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }

    val targets = if (targetType == "room") vm.rooms.map { it.roomId to it.name }
    else vm.sessions.map { it.sessionId to it.name }

    val df = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (task == null) S.createTask else S.editTask) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(S.taskName) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                if (task?.missionTemplate != null) {
                    Text(S.taskTemplateLocked, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                }

                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    SegmentedButton(
                        selected = targetType == "session",
                        onClick = { if (task?.missionTemplate == null) { targetType = "session"; targetId = "" } },
                        enabled = task?.missionTemplate == null,
                        shape = SegmentedButtonDefaults.itemShape(0, 2),
                    ) { Text(S.sessionLabel) }
                    SegmentedButton(
                        selected = targetType == "room",
                        onClick = { if (task?.missionTemplate == null) { targetType = "room"; targetId = "" } },
                        enabled = task?.missionTemplate == null,
                        shape = SegmentedButtonDefaults.itemShape(1, 2),
                    ) { Text(S.roomLabel) }
                }
                Spacer(Modifier.height(8.dp))

                Text(S.taskTarget, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    targets.forEach { (id, label) ->
                        FilterChip(
                            selected = targetId == id,
                            onClick = { if (task?.missionTemplate == null) targetId = id },
                            enabled = task?.missionTemplate == null,
                            label = { Text(label, maxLines = 1, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = message,
                    onValueChange = { if (task?.missionTemplate == null) message = it },
                    enabled = task?.missionTemplate == null,
                    label = { Text(S.taskMessage) },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))

                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    SegmentedButton(
                        selected = scheduleMode == "simple",
                        onClick = { scheduleMode = "simple" },
                        shape = SegmentedButtonDefaults.itemShape(0, 2),
                    ) { Text(S.scheduleSimple) }
                    SegmentedButton(
                        selected = scheduleMode == "cron",
                        onClick = { scheduleMode = "cron" },
                        shape = SegmentedButtonDefaults.itemShape(1, 2),
                    ) { Text(S.scheduleCron) }
                }
                Spacer(Modifier.height(8.dp))

                if (scheduleMode == "simple") {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        FilterChip(selected = simpleKind == "daily", onClick = { simpleKind = "daily" }, label = { Text(S.scheduleDaily) })
                        FilterChip(selected = simpleKind == "interval", onClick = { simpleKind = "interval" }, label = { Text(S.scheduleInterval) })
                        FilterChip(selected = simpleKind == "once", onClick = { simpleKind = "once" }, label = { Text(S.scheduleOnce) })
                    }
                    Spacer(Modifier.height(8.dp))
                    when (simpleKind) {
                        "daily" -> {
                            OutlinedTextField(
                                value = time,
                                onValueChange = { time = it },
                                label = { Text(S.missionTimeLabel) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        "interval" -> {
                            OutlinedTextField(
                                value = intervalMinutes,
                                onValueChange = { intervalMinutes = it.filter { c -> c.isDigit() } },
                                label = { Text(S.intervalMinutesLabel) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        "once" -> {
                            Row(
                                Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    if (atTimestamp > 0) df.format(Date(atTimestamp)) else S.pickTimeHint,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                TextButton(onClick = { showDatePicker = true }) {
                                    Text(S.pickDateTime)
                                }
                            }
                        }
                    }
                } else {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        OutlinedTextField(
                            value = cronExpr,
                            onValueChange = { cronExpr = it },
                            label = { Text(S.cronLabel) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { showCronHelp = true }) {
                            Icon(Icons.Filled.Info, contentDescription = S.cronHelp)
                        }
                    }
                    Text(S.cronDailyHint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(8.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(S.taskEnabled, modifier = Modifier.weight(1f))
                    Switch(checked = enabled, onCheckedChange = { enabled = it })
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (name.isBlank() || targetId.isBlank() || message.isBlank()) return@TextButton
                    val intervalVal = intervalMinutes.toIntOrNull()
                    val atVal = if (simpleKind == "once" && atTimestamp > 0) atTimestamp else null
                    onSave(name, targetType, targetId,
                        targets.find { it.first == targetId }?.second ?: "",
                        message, scheduleMode, simpleKind,
                        if (simpleKind == "daily") time else null,
                        if (simpleKind == "interval") intervalVal else null,
                        atVal,
                        if (scheduleMode == "cron") cronExpr else null,
                        enabled)
                },
                enabled = name.isNotBlank() && targetId.isNotBlank() && message.isNotBlank(),
            ) { Text(S.save) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(S.cancel) } },
    )

    if (showCronHelp) {
        CronHelpDialog(onDismiss = { showCronHelp = false }, onPick = { expr ->
            cronExpr = expr
            showCronHelp = false
        })
    }

    if (showDatePicker) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = if (atTimestamp > 0) atTimestamp else System.currentTimeMillis(),
        )
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { dateMs ->
                        val cal = Calendar.getInstance()
                        cal.timeInMillis = dateMs
                        if (atTimestamp > 0) {
                            val oldCal = Calendar.getInstance()
                            oldCal.timeInMillis = atTimestamp
                            cal.set(Calendar.HOUR_OF_DAY, oldCal.get(Calendar.HOUR_OF_DAY))
                            cal.set(Calendar.MINUTE, oldCal.get(Calendar.MINUTE))
                        }
                        atTimestamp = cal.timeInMillis
                        showDatePicker = false
                        showTimePicker = true
                    }
                }) { Text(S.nextStep) }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text(S.cancel) } },
        ) { DatePicker(state = state) }
    }

    if (showTimePicker) {
        val cal = Calendar.getInstance()
        if (atTimestamp > 0) cal.timeInMillis = atTimestamp
        val state = rememberTimePickerState(
            initialHour = cal.get(Calendar.HOUR_OF_DAY),
            initialMinute = cal.get(Calendar.MINUTE),
            is24Hour = true,
        )
        AlertDialog(
            onDismissRequest = { showTimePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    val cal2 = Calendar.getInstance()
                    cal2.timeInMillis = atTimestamp
                    cal2.set(Calendar.HOUR_OF_DAY, state.hour)
                    cal2.set(Calendar.MINUTE, state.minute)
                    cal2.set(Calendar.SECOND, 0)
                    atTimestamp = cal2.timeInMillis
                    showTimePicker = false
                }) { Text(S.ok) }
            },
            dismissButton = { TextButton(onClick = { showTimePicker = false }) { Text(S.cancel) } },
            text = { TimePicker(state = state) },
        )
    }
}

@Composable
private fun CronHelpDialog(onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val S = LocalStrings.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(S.cronHelpTitle) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(S.cronFormatLine, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(4.dp))
                Text(S.cronRanges,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(4.dp))
                Text(S.cronSyntax,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Text(S.cronExamples, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(4.dp))
                S.cronPresets.forEach { (expr, desc) ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(expr, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                        Text(desc, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.size(8.dp))
                        TextButton(onClick = { onPick(expr) }) { Text(S.useIt) }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(S.actionClose) } },
    )
}
