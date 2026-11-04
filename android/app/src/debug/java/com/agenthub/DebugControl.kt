package com.agenthub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 无 UI 测试面（仅 debug 构建注册）：ADB 显式广播驱动 ChatViewModel 公共 API，
 * 查询结果经 logcat tag AHCTL 返回——真机验证不抢屏、不干扰前台使用。
 *
 * 用法：
 *   adb shell am broadcast -n com.agenthub/.DebugControl -a com.agenthub.DEBUG_CONTROL --es op status
 *   adb logcat -d -s AHCTL
 *
 * op：status|rooms|missions|flow|send|open_room|subscribe_task|refresh_missions
 * extras：send→text；open_room/subscribe_task→roomId/taskId
 */
class DebugControl : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val vm = ChatViewModel.debugInstance
        if (vm == null) { Log.w(TAG, """{"error":"no_vm"}"""); return }
        when (val op = intent.getStringExtra("op") ?: "status") {
            "status" -> log(buildJsonObject {
                put("connection", vm.connectionState.name)
                put("roomId", vm.currentRoom?.roomId ?: "")
                put("roomName", vm.currentRoom?.name ?: "")
                put("rooms", vm.rooms.size)
                put("missions", vm.missions.size)
                put("flowPhase", vm.flow?.phase ?: "")
                put("flowTasks", vm.flow?.tasks?.size ?: 0)
                put("deliveryError", vm.deliveryError ?: "")
                put("deliveryRecords", vm.deliveryRecords.size)
            })
            "rooms" -> log(buildJsonObject {
                putJsonArray("rooms") {
                    vm.rooms.forEach { r ->
                        add(buildJsonObject { put("roomId", r.roomId); put("name", r.name); put("mode", r.mode) })
                    }
                }
            })
            "missions" -> log(buildJsonObject {
                putJsonArray("missions") {
                    vm.missions.forEach { m ->
                        add(buildJsonObject {
                            put("id", m.id); put("goal", m.goal.take(80)); put("status", m.status)
                            put("criteria", m.acceptanceCriteria.size)
                        })
                    }
                }
            })
            "flow" -> log(buildJsonObject {
                val f = vm.flow
                put("flowId", f?.flowId ?: ""); put("phase", f?.phase ?: "")
                putJsonArray("tasks") {
                    f?.tasks?.forEach { t ->
                        add(buildJsonObject {
                            put("id", t.id); put("name", t.name); put("status", t.status)
                            put("task", t.task.take(60)); put("outputLen", t.output?.length ?: 0)
                        })
                    }
                }
            })
            "send" -> {
                val text = intent.getStringExtra("text") ?: ""
                if (text.isBlank()) { Log.w(TAG, """{"error":"blank_text"}"""); return }
                vm.sendRoomMessage(text)
                log(buildJsonObject { put("sent", text.take(80)) })
            }
            "open_room" -> {
                val rid = intent.getStringExtra("roomId") ?: ""
                val room = vm.rooms.find { it.roomId == rid || it.name == rid }
                if (room == null) { Log.w(TAG, """{"error":"room_not_found","roomId":"$rid"}"""); return }
                vm.openRoom(room)
                log(buildJsonObject { put("opened", room.roomId) })
            }
            "subscribe_task" -> {
                val tid = intent.getStringExtra("taskId") ?: ""
                vm.subscribeTask(tid)
                log(buildJsonObject { put("subscribed", tid) })
            }
            "refresh_missions" -> { vm.refreshMissions(); log(buildJsonObject { put("refresh", "missions") }) }
            "refresh_rooms" -> { vm.refreshAll(); log(buildJsonObject { put("refresh", "rooms") }) }
            "create_mission" -> {
                // 模拟草稿卡确认：goal/criteria(分号分隔)/scope 由 extras 传，owner=auto
                val rid = intent.getStringExtra("roomId") ?: vm.currentRoom?.roomId ?: ""
                val goal = intent.getStringExtra("goal") ?: ""
                val criteria = (intent.getStringExtra("criteria") ?: "").split(";").map { it.trim() }.filter { it.isNotEmpty() }
                val scope = intent.getStringExtra("scope") ?: ""
                val room = vm.rooms.find { it.roomId == rid || it.name == rid }
                if (goal.isBlank() || criteria.isEmpty() || room == null) {
                    Log.w(TAG, """{"error":"create_mission_bad_params","roomId":"$rid","goal":"${goal.take(40)}","criteria":${criteria.size}}"""); return
                }
                vm.createMission(room.roomId, goal, criteria, scope, emptyList(), null, 0) { m ->
                    log(buildJsonObject {
                        if (m != null) { put("created", m.id); put("goal", m.goal.take(60)) }
                        else put("error", "create_failed")
                    })
                }
            }
            else -> Log.w(TAG, """{"error":"unknown_op","op":"$op"}""")
        }
    }

    private fun log(obj: JsonObject) = Log.i(TAG, obj.toString())

    companion object {
        const val TAG = "AHCTL"
        const val ACTION = "com.agenthub.DEBUG_CONTROL"
    }
}
