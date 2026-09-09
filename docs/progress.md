# agent-hub 质量链路落地进度（Q1-09）

## 已落地

- `1821316` feat(quality): 落地 P2/P3/P4 质量链路，安装新版 APK
  - P2: ReviewOrchestrator、FixerOrchestrator、运行时权限绑定
  - P3: Incident/Rule 候选、reviewer 精度指标、本地执行与恢复
  - P4: eval 评测、incident 自动沉淀
  - Desktop/Android 质量面板、finding 操作、Incident/Rule 列表
- 验证通过：`hub` 518 tests / 0 failures，`desktop tsc`、`android compileDebugKotlin` BUILD SUCCESSFUL
- debug APK 已安装到 `11.0.0.2:5555`，质量面板可见

## 本次修复

- 修复 Android 群聊会话在返回列表再进入时状态被清空/被误判为“结束”的问题
  - `android/app/src/main/java/com/agenthub/ChatViewModel.kt`
  - `backToList()` 返回列表时保留 `currentRoom`/`currentSession`/`flow`/`currentArtifacts`/`blackboard` 等运行中状态
  - `openRoom()` 在重新进入同一房间时保留 `flow`、`currentArtifacts`、`blackboard` 等状态
  - `openChat()` 在重新进入同一单聊会话时保留状态
  - 已重新构建安装 APK，手机验证通过

## 质量状态机自驱（本轮由主持人完成）

- `hub/src/quality/service.ts`：新增 `quickRunner`/`fullRunner` 类型并在 `QualityService.advance` 中触发
- `hub/src/index.ts`：
  - 注册 `quickRunner`/`fullRunner`，实现 `makeGateRunner`/`advanceAfterGate`
  - 在 `startRunForTask` 创建 run 后自动推进：`queued → preflight → implementing → collecting → quick-verifying`，触发 quick gate
  - gate 结果自动推进到 `reviewing`/`fixing`/`full-verifying`/`awaiting-approval`/`accepted`/`failed`
- `hub/src/quality/service.test.ts`：补充 quickRunner/fullRunner 触发测试
- 验证：`cd hub && npx tsc --noEmit` 通过，`cd hub && npm test` 577 tests / 0 failures

## 历史遗留 run 清理（已完成）

- 3 条历史 `trigger=conductor` 的 quality run 此前卡在 `queued`，现已全部置为 `cancelled`（2026-09-07 11:56:39）：
  - `q-7ce17f4a24152102`（task_id=t2, risk=medium, 无 checks/findings/decisions 残留）
  - `q-c444fa6a402021f2`（task_id=t2, risk=medium）
  - `q-e0dcfd75af610efd`（task_id=t2, risk=medium）
- 原因：老版本 Conductor 派发后无 `advance` 自驱，Hub 重启后 in-memory 推进链丢失
- 新版本 `startRunForTask` 已自动推进新创建的 run；主 DB 与沙盒 DB 均无残留非终态 run

## 沙盒准备

- `/tmp/agent-hub-sandbox` 已创建
- 沙盒内 `hub/src/sandbox-canary.test.ts` 已新增可控问题
- 沙盒内 `.devin/quality.json` 已启用 `review.enabled = true`

## 未提交改动

- `hub/src/index.ts`（新增 `quality.project.register` / `quality.run.advance` / `quality.check.list` / 自驱 `startRunForTask`）
- `hub/scripts/rollback.sh`
- `hub/scripts/trigger-quality-run.ts`
- `hub/scripts/quality-ui-verify.ts`（本轮新增验证脚本）
- `android/app/src/main/java/com/agenthub/ChatViewModel.kt`（本次修复）
- `hub/data-sandbox/`
- `docs/progress.md`（本文件）

## 本轮验证（重启 Hub 后）

- Conductor 派发的 run `q-bdf3255a6c93bf8c` 已自动推进到 `awaiting-approval`，4 项 checks 全部 passed（hub-typecheck / hub-test / desktop-typecheck / android-compile），验证 `startRunForTask` 自驱有效
- 通过 `hub/scripts/quality-ui-verify.ts` 直接调用 WebSocket RPC 验证 approve/reject 路径：
  - `q-475040f666de34f8`：`awaiting-approval → accepted`（approve 成功，patchHash 存在）
  - `q-221a26aa2f21c4ab`：`awaiting-approval → failed`（reject 成功）
- Desktop `QualityScreen.tsx` 与 Android `QualityScreen.kt` 中 `awaiting-approval` 时渲染“批准/拒绝”按钮，分别调用 `quality.run.approve` / `quality.run.reject`，RPC 已验证可用
- 注意：`accepted` 终态仍要求 `patchHash` 非空（`run.ts` 硬约束），非 Git 项目 run 若无 patchHash 会卡在 `awaiting-approval` 无法 approve；这是预期行为，reject/cancel 仍可用

## 下一步

1. a-1: 修改 `trigger-quality-run.ts` 支持 `QUALITY_PROJECT_ROOT`，手动跑通沙盒 review → fix → accepted 链
2. ~~a-3: 手动取消或推进 3 条历史 stuck queued run~~ ✅ 已完成，3 条均已 cancelled
3. 5-ui: 手机上手动打开质量面板截图（当前设备屏幕处于锁屏/AOD，自动化截图受限）
4. 商议 `awaiting-approval` 阶段是否需要通知 Conductor 继续/终止，避免 observe 模式下任务长期 `verifying`

## L0-L4 全链路落地（2026-09-08）

本轮在 P2/P3/P4 基础上补齐 L0 需求门、L3 需求验证、L4 受控学习、Phase 6 高自治、policy v1/v2 迁移，形成完整 L0-L4 闭环。基线测试：`cd hub && npx tsc --noEmit` 通过；`cd hub && npm test` 890 tests / 0 fail（连跑稳定）。

### Phase 0 可信基础与度量

- `hub/src/quality/gate.ts`：required/optional 分离、空 tier 通过、`inconclusive` 分类、`fixRound + 1` 避免 stale check 复用
- `hub/src/quality/change-set.ts`：baseline 与 ChangeSet 收集、untracked/二进制哈希
- `hub/src/quality/execution*.ts`：执行 provider 抽象与按 `project.connectionId` 路由
- `hub/src/quality/lease.ts`：writer lease 行为
- `hub/src/quality/recovery.ts`：Hub 重启恢复，stale generation → inconclusive，当前 generation → inconclusive + `hub-restart`
- `hub/src/quality/run.ts`：状态机迁移表，含 `fixing → awaiting-approval`
- 测试：`phase0.test.ts` 34、`t2-trusted-exec.test.ts`、`lease.test.ts`、`recovery.test.ts` 全 pass
- ~~已知偏差：L1 p95 时间预算、artifact 保留期、迁移窗口等参数尚未记录实际默认值（`quality-lifecycle.md` §19 待办）~~ → 已在 §19 记录实际默认值

### Phase 1 L1 最小纵向闭环

- `hub/src/quality/service.ts`：`quickRunner`/`fullRunner` 类型与 `advance` 触发
- `hub/src/index.ts`：`makeGateRunner`/`advanceAfterGate`，`startRunForTask` 自动推进 `queued → preflight → implementing → collecting → quick-verifying`
- 测试：`service.test.ts` 48 pass
- 已知偏差：默认 review/fix 仍为关闭，符合预期；dogfood 真实 run 证据链尚未评审

### Phase 2 跨模式一致性

- `hub/src/quality/dirty-tracker.ts`：统一 dirty 信号跟踪，替代 `sessionsWithFileChanges` Set
- `hub/src/index.ts`：`triggerGateForSession` 覆盖所有非 conductor 模式，`startRunForTask` 覆盖 conductor
- `hub/src/lifecycle-integration.test.ts`：45 个集成测试覆盖生命周期全链路、run-context、dirty/collect 边界、generation/stale、取消恢复、Conductor enforcement 解锁、跨模式一致接入、L0/L3/L4 链路、禁止事项验证
- 已知偏差：按适用性不强制全层

### Phase 3 L0 建议式需求辅助

- `hub/src/quality/requirement.ts`：意图分类、7 个通用需求维度、澄清协议（`clarifying` phase，单轮最多 3 问、可跳过）、WorkRequest/RequirementSpec 持久化
- `hub/src/store.ts`：`quality_clarification_requests` 表
- `hub/src/index.ts`：L0 RPC handlers
- 测试：`requirement.test.ts` 40 pass
- 已知偏差：L0 已在 `room.message`/`prompt.send` 入口横切接入（shadow 不阻断）；从 shadow 升级 advisory 需度量数据

### Phase 4 L3 需求证据验证

- `hub/src/quality/verification.ts`：`EvidenceExpectation`、AcceptanceCriterion 与 evidence 匹配、`RequirementVerification` 持久化、覆盖矩阵、waive
- `hub/src/store.ts`：`quality_requirement_verifications` 表
- `hub/src/index.ts`：L3 RPC handlers
- 测试：`verification.test.ts` 44 pass
- 已知偏差：L3 已在 `requirement-verifying` 阶段自动触发 `runVerification`；dogfood 真实 run 证据链待评审

### Phase 5 L4 受控学习

- `hub/src/quality/learning.ts`：Observation → confirm/dismiss → Incident → RuleCandidate → shadow → promote → retire 完整生命周期
- `hub/src/quality/incident.ts`、`hub/src/quality/rule.ts`：incident 与 typed rule 定义
- `hub/src/store.ts`：`quality_observations`、`quality_incidents`、`quality_rules`、`quality_active_controls` 表
- `hub/src/index.ts`：6 个 L4 RPC handlers（`quality.control.listShadow`/`quality.policy.exportPatch`/`quality.policy.verifyPatch`/`quality.rule.evaluateSandbox`/`quality.rule.recordSandbox` 等）
- 测试：`learning.test.ts` 57、`incident.test.ts`、`rule.test.ts` 全 pass
- 已知偏差：Observation 已从 run 终态 failed/inconclusive 自动创建；从 candidate 升级为 incident 仍需人工 confirm

### Phase 6 AI 审查、修复与隔离应用

- `hub/src/quality/worktree.ts`：worktree 创建/移除、rollback point、stale 清理、approval-risk/protected-path 检查
- `hub/src/quality/fixer-orchestrator.ts`：预算预检、worktree 创建（受控回退）、rollback 处理、证据清除、approval gate、worktree 缓存清理
- `hub/src/quality/review-orchestrator.ts`：reviewer 只读权限绑定
- `hub/src/quality/recovery.ts`：中断 run 的 worktree 清理 + 清理成功/失败摘要
- `hub/src/quality/run.ts`：新增 `fixing → awaiting-approval` 迁移
- `hub/src/store.ts`：`clearChecks`/`clearFindings`/`clearReviewDecisions`/`clearRequirementVerifications`/`clearRunEvidence`
- `hub/src/quality/service.ts`：`clearRunEvidence()` 包装与广播
- 测试：`phase6.test.ts` 24、`fixer-orchestrator.test.ts` 20、`review-orchestrator.test.ts` 13 全 pass
- 已知偏差：非 Git 项目 run 无 patchHash 会卡在 `awaiting-approval`，符合 `run.ts` 硬约束

### Policy v1/v2 迁移

- `hub/src/quality/policy.ts`：`migrateV1ToV2Write` 原子写入 v2 policy + CAS 检查（`expectedOldHash`）+ 旧文件备份为 `.v1.bak` + 临时文件 rename 保证原子性
- `hub/src/quality/service.ts`：`migratePolicyToV2` service 方法
- `hub/src/index.ts`：v1 fallback（`autonomy=observe` → `require-approval`，其他 → `require-pass`）与 v2 enforcement lookup
- 测试：`policy.test.ts` 37 pass（含 4 个 `migrateV1ToV2Write` 测试：成功迁移+备份、hash 不匹配拒绝、无文件返回 `invalid-v1`、已迁移文件再次迁移返回 `invalid-v1`）

### 未提交改动（本轮）

本轮 L0/L3/L4/Phase 6/policy v2 全部源码与测试均未提交，本地领先 `origin/main` 12 commit。按约束未 commit/push/重启 Hub。主要未跟踪文件：

- `hub/src/quality/{requirement,verification,learning,worktree,dirty-tracker}.ts`
- `hub/src/quality/{phase0,phase6,requirement,verification,learning,policy}.test.ts`
- `hub/src/lifecycle-integration.test.ts`
- `hub/src/dispatch-plan.{ts,test.ts}`
- `docs/quality-lifecycle.md`

### 下一步

1. **端到端 dogfood 验证**：用真实 Agent 跑一次完整 QualityRun，验证 L0→L1→L2→L3→L4 全链路证据完整性（L0/L3/L4 已自动触发）
2. **dogfood 指标基线**：按 `quality-lifecycle.md` §19 记录 L1 p95、artifact 保留期、迁移窗口等参数实际默认值
3. **Desktop/Android UI 适配**：clarification 入口、L3 验证矩阵、L4 规则候选展示
4. **shadow 模式度量收集**：L0 提问率、跳过率、有用率、返工变化
5. **提交前评审**：用户确认后按 Phase 分组提交（不 push）
