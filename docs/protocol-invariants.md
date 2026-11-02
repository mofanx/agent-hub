# 消息可靠性不变量（Protocol Invariants）

本文档固化 agent-hub 消息/连接可靠性的协议约定——这些规则是本轮多次同类回归（乱序/重复/丢消息/双落库）后沉淀的**不变量**，后续改动必须遵守；破坏任一条即视为 bug。

## 1. 条目归属：持久化为准，live 为瞬态

- **持久化条目是最终事实**：`history`/`room.process` 落库条目（`id > 0` 或有 `historyId`）代表已提交的历史，客户端合并层不得修改其内容、顺序、归属。
- **live 条目是瞬态副本**：流式 `agent_message_chunk`/`agent_thought_chunk` 在客户端产生的条目（`at <= 0` 或无 `historyId`）只代表"正在写的内容"，落库副本到达后 live 副本必须被去重移除。
- **锚定排序**：迟到的持久化条目按 `at` 排序插入；`at <= 0`（零/负时间戳）的无日期 live 条目视为"最新在途"跳过不参与锚定，有日期的陈旧 live 条目按 `at` 正常排序——不得无条件跳过所有 live 条目（`persistedInsertIndex` 约束）。

## 2. ID 命名空间隔离

- 持久化条目 `id > 0`；客户端 live 条目自增 `itemSeq` 为**正数本地 id**，与持久化 `historyId` 分属两个命名空间——合并判重只看 `historyId`/内容指纹，不得把本地 id 当历史 id 用。
- 卡类条目（flow/process/event/artifact）使用**负数 id** 命名空间，与消息 id 互不冲突；重进房历史重放时负 id 卡参与尾部去重与锚定排序。

## 3. 去重窗口与指纹匹配

- **弱键窗口受限**：`user`/`system`/`error` 类与所有前缀匹配仅在 300 秒窗口内去重——刻意重发的相同文本必须保留。
- **强键指纹不限窗口**：assistant/thought **完全相同的文本**、`tool` 的 `toolCallId`、`plan` 的完整 `entries` 相同视为同一实体指纹，长回合跨窗也去重；前缀匹配仍受窗口约束。
- 已知取舍：完全相同的短回复跨 turn 会被吞——可接受（长回合 live 副本滞留的代价更低）；如需收紧按"长度阈值"收紧而非恢复窗口。

## 4. clientMessageId 幂等域

- `room.message`/`prompt.send` 携带 `clientMessageId`（`cm-<uuid>`）时，hub 以 `client_msgs` 表（5000 LRU）幂等返回首次结果——**重发不产生第二条记录、不二次派发**。
- 幂等域**只覆盖发送提交**：重试指令（`retry`/`resume`/`stop`）与查询类接口不在幂等域，重发按正常语义执行。
- in-flight 并发保护：同一 `clientMessageId` 并发调用返回同一 Promise 结果，不产生中间态重复。

## 5. 恢复语义：afterId 增量 + room.sync 校准

- 客户端断线重连优先 `room.history`/`session.history` 的 `afterId` 游标增量拉取（`hasMore` 由 `entries.length === limit` 判定）；游标缺失/条目被物理删除时 `truncated` 标记驱动全量回退。
- `room.sync` 快照（flow/blackboard/subMode/activeSpeaker）用于重连后的状态校准——客户端不得把快照当增量事件处理，也不得用旧快照覆盖更新的本地状态。
- **chunk 可丢、控制不丢**：事件缓冲满时仅 `agent_message_chunk`/`agent_thought_chunk` 可丢（后续 chunk 自愈），控制/终态事件必须经 `emitTail` 串行保序送达。

## 6. Outbox 白名单回放

- 断网/断连时待发送消息入 outbox（按 `hub+scope` 隔离，上限 30 条/scope，24h TTL，可取消）。
- **自动回放白名单**：仅普通文本消息自动重发；带附件/上下文已变（scope 不匹配/流程已结束）的条目标 `failed` 交还用户确认，不静默重放。
- 回放必须复用原 `clientMessageId`——服务侧幂等表是重复提交的最后防线。

## 7. 自激免疫

- Loop 事件唤醒有 `wakeSelfSuppress` 窗口（当前 10min）：由唤醒任务自身产生的事件不得再次唤醒同一任务，防闭环自激。
- conductor `awaiting-retry` 收录不改派：等待重试期间继续收录结果/错误/求助/答案，但**不自动恢复派发**——恢复必须用户显式指令。

## 8. 连接状态机

- 网络回调触发 `kickReconnect` 取消退避立即重连；`isConnecting` 防并发多连接；`shouldReconnect=false`（显式断开/鉴权失败）不被回调拉起。
- 鉴权失败（401/403）与断网分流：前者停止重连交上层处理，后者走退避。

## 回归测试对照

| 不变量 | 测试位置 |
|---|---|
| 锚定排序/at 门控 | `hub/src/*.test.ts`（android-outbox/dedupe 相关）、双端 `persistedInsertIndex`/`isCoveredByHistory` |
| 指纹去重 | `de6494d` 相关双端同构逻辑（ChatViewModel dedupeTail / store.ts isCoveredByHistory） |
| clientMessageId 幂等 | `hub/src/idempotency.test.ts`（读回/覆盖/LRU/afterId 游标/truncated） |
| Outbox 状态机 | `hub/src/android-outbox.test.ts`（真实 Kotlin/JVM 场景 harness，RESULT cases=23） |
| HubClient 重连 | `hub/src/android-client.test.ts`（JVM 场景，RESULT cases=14） |
| 自激/唤醒 | `hub/src/event-wake.test.ts`（去抖/上限/游标不推进） |
| awaiting-retry 收录 | `hub/src/conductor.test.ts`（重试指令恢复/同批求助收录/中断收录） |
| 回合治理/副作用去重 | `hub/src/turn-governance.test.ts`（stale 重跑/turnGuards 生命周期/OperationLedger） |
