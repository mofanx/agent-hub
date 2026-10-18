package com.agenthub.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agenthub.Mission
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull

private fun JsonObject.str(key: String): String? =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }

@Composable
private fun Field(label: String, value: String?, S: Strings) {
    if (value == null) {
        Text("$label: ${S.missionNotProvided}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        Text("$label: $value", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun MissionEvidence(m: Mission, S: Strings) {
    val tasks = (m.flow?.get("tasks") as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
    if (tasks.isEmpty() && m.output.isNullOrBlank()) return
    var expanded by remember { mutableStateOf(false) }
    Column {
        if (!m.output.isNullOrBlank()) {
            Text("${S.missionOutput}: ${m.output}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (tasks.isNotEmpty()) {
        Text(
            "${S.missionSelfReport} · ${S.missionPeerReview} · ${S.missionIsolatedCheck}",
            Modifier.clickable { expanded = !expanded }.padding(vertical = 2.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
        )
        if (expanded) {
            tasks.forEach { t ->
                val id = t.str("id") ?: ""
                val name = t.str("name") ?: ""
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text("${id}${if (name.isNotEmpty()) " $name" else ""}: ${t.str("status") ?: S.missionNotProvided}", style = MaterialTheme.typography.labelMedium)
                    Field("${S.missionSelfReport} ${S.missionFieldOutput}", t.str("output"), S)
                    Field("${S.missionSelfReport} ${S.missionFieldDiff}", t.str("diff"), S)
                    Field("${S.missionSelfReport} ${S.missionFieldBaseline}", t.str("baseline"), S)
                    Field("${S.missionSelfReport} ${S.missionFieldReproSteps}",
                        (t["reproSteps"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }?.joinToString("\n")
                            ?: t.str("reproSteps"), S)
                    val vc = t.str("verifyCommand")
                    val vec = t.str("verifyExitCode") ?: (t["verifyExitCode"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
                    Field("${S.missionSelfReport} ${S.missionFieldCommand}", vc?.let { "$it${vec?.let { c -> " → ${S.missionFieldExitCode} $c" } ?: ""}${if (vec == "0") " (${S.missionExitZero})" else ""}" }, S)
                    Field("${S.missionSelfReport} ${S.missionFieldStdout}", t.str("verifyStdout"), S)
                    Field("${S.missionSelfReport} ${S.missionFieldStderr}", t.str("verifyStderr"), S)
                    
                    val vers = (t["verifications"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
                    vers.forEach { v ->
                        Field("${S.missionPeerReview} ${v.str("by") ?: ""} ${S.missionFieldVerdict}", v.str("verdict"), S)
                        Field("${S.missionPeerReview} ${S.missionFieldEvidence}", v.str("evidence"), S)
                        val ed = v["evidenceDetail"] as? JsonObject
                        if (ed != null) {
                            Field("${S.missionPeerReview} ${S.missionFieldSummary}", ed.str("summary"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldBaseline}", ed.str("baseline"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldDiff}", ed.str("diff"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldReproSteps}",
                                (ed["reproSteps"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }?.joinToString("\n")
                                    ?: ed.str("reproSteps"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldCommand}", ed.str("command"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldExitCode}",
                                (ed.str("exitCode") ?: (ed["exitCode"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull)
                                    ?.let { c -> "$c${if (c == "0") " (${S.missionExitZero})" else ""}" }, S)
                            Field("${S.missionPeerReview} ${S.missionFieldStdout}", ed.str("stdout"), S)
                            Field("${S.missionPeerReview} ${S.missionFieldStderr}", ed.str("stderr"), S)
                            val arts = (ed["artifactRefs"] as? kotlinx.serialization.json.JsonArray)
                            Field("${S.missionPeerReview} ${S.missionFieldArtifacts}", arts?.mapNotNull { (it as? JsonObject)?.str("path") ?: (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }?.joinToString(", "), S)
                        }
                    }
                    
                    val ac = t["automaticCheck"] as? JsonObject
                    if (ac != null && ac.str("status") != "not_run") {
                        val stale = ac.str("snapshotCurrent") == "false"
                        Field("${S.missionIsolatedCheck} ${S.missionFieldStatus}", ac.str("status"), S)
                        Field("${S.missionIsolatedCheck} ${S.missionFieldExitCode}", ac.str("exitCode") ?: (ac["exitCode"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull, S)
                        Field("${S.missionIsolatedCheck} ${S.missionFieldStdout}", ac.str("stdout"), S)
                        Field("${S.missionIsolatedCheck} ${S.missionFieldStderr}", ac.str("stderr"), S)
                        if (stale) Text(S.missionSnapshotStale, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        }
    }
}
