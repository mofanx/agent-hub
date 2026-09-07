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
