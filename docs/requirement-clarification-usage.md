# Agent-Hub 需求澄清与验证使用说明

> 本文档面向最终用户，说明如何启用和使用 `docs/quality-lifecycle.md` 中定义的 L0 需求澄清、L3 需求验证功能。

## 1. 功能定位

- **L0 需求澄清**：在用户发起代码改动请求后、Agent 开始实现前，由 Hub 自动评估需求是否完整。若发现明显缺口，会弹出若干问题让用户补充说明。
- **L3 需求验证**：实现完成后，Hub 对照需求规范里的验收标准，检查是否有足够证据（测试、检查、review 等）证明需求已被满足。

目标不是增加流程，而是在实现前消除“目标、边界、验收标准”的不确定性，减少返工。

## 2. 为什么默认没有生效

需求澄清和验证默认是关闭的，原因是项目策略里对应的开关为 `off`：

```json
{
  "requirements": { "mode": "off", "maxQuestions": 3 },
  "verification": { "mode": "off" }
}
```

这两个字段位于 `<项目根目录>/.devin/quality.json` 中。

## 3. 如何启用

### 3.1 通过 Desktop 质量面板

1. 打开 Desktop 客户端，进入"质量"标签。
2. 选择要配置的项目。
3. 展开"需求/验证配置"卡片。
4. 设置：
   - **需求澄清模式**：`off` / `suggest` / `require`
   - **最多问题数**：建议保持 `3`
   - **L3 验证模式**：`off` / `suggest` / `require-evidence`
5. 点击"保存需求/验证配置"。

对应代码：
- `desktop/src/screens/QualityScreen.tsx` 中的 `RequirementsConfigForm`
- `desktop/src/hub/store.ts` 中的 `saveRequirementVerificationPolicy`

### 3.2 通过 Desktop 聊天内快捷开关（无需跳转）

Desktop 端支持在聊天界面直接调整需求/验证配置，无需切换到质量面板：

1. 在单聊中，质量状态条（`QualityStatusBar`）会显示当前 run 的阶段。
2. 点击状态条展开详情区域。
3. 展开区底部有"需求/验证快捷配置"面板（`RequirementQuickToggle`），包含：
   - **需求模式**下拉：`off` / `suggest` / `require` / `require-high-risk`
   - **验证模式**下拉：`off` / `suggest` / `require-evidence`
   - **最大提问数**输入框
4. 修改后点击"保存"即可生效，配置会写入当前会话关联项目的 `.devin/quality.json`。

> 注意：快捷开关读取的是当前会话关联的项目策略（`sessionPolicy`），与质量面板中的配置是同一份策略文件，修改一处即全局生效。

对应代码：
- `desktop/src/screens/ChatScreen.tsx` 中的 `RequirementQuickToggle`
- `desktop/src/hub/store.ts` 中的 `saveRequirementVerificationPolicy`、`loadSessionProjectPolicy`

### 3.3 通过 Android 质量面板

1. 打开 Android 客户端，进入"质量"标签。
2. 选择项目。
3. 展开"需求/验证配置"。
4. 设置相同的三项，点击保存。

对应代码：
- `android/app/src/main/java/com/agenthub/ui/QualityScreen.kt` 中的 `RequirementVerificationConfigForm`
- `android/app/src/main/java/com/agenthub/ChatViewModel.kt` 中的 `saveRequirementVerificationPolicy`

### 3.4 直接编辑策略文件

修改项目根目录下的 `.devin/quality.json`：

```json
{
  "requirements": { "mode": "suggest", "maxQuestions": 3 },
  "verification": { "mode": "suggest" }
}
```

> 注意：`.devin/quality.json` 受保护路径策略保护，修改前请确保 `enforcement.mode` 不是 `require-pass`，否则可能被拦截。

## 4. 模式说明

### 4.1 需求澄清 `requirements.mode`

| 模式 | 行为 |
|------|------|
| `off` | 不评估需求，用户消息直接派发给 Agent。 |
| `suggest` | 评估需求，若发现缺口则弹出澄清卡片，但不阻塞原消息派发。 |
| `require` | 评估需求，若存在待澄清问题，暂停原消息派发，直到用户回答、跳过或取消。 |

### 4.2 L3 验证 `verification.mode`

| 模式 | 行为 |
|------|------|
| `off` | 不运行需求验证。 |
| `suggest` | 生成覆盖矩阵并展示结果，但不阻断运行进入 `accepted`。 |
| `require-evidence` | 必须有通过的证据才能进入 `accepted`，否则失败。 |

## 5. 使用流程

### 5.1 L0 澄清

1. 用户在会话或群聊中发送代码改动请求。
2. 若 `requirements.mode` 不是 `off` 且请求被识别为 `code-change`，Hub 调用 `handleL0Request` 评估需求。
3. 若生成澄清问题，用户会收到卡片：
   - Desktop：`ChatScreen.tsx` 中的 `ClarificationCard`
   - Android：`ChatScreen.kt` 中的 `is ChatItem.Clarification`
4. 用户可以：
   - **提交回答**：回答每个问题后提交，Hub 更新 `RequirementSpec` 并重新生成验收标准。
   - **跳过**：不回答，继续使用当前需求。
   - **取消**：取消本次请求。
5. 对于 `require` 模式，提交或跳过后，Hub 调用 `resumeSuspendedPrompt` 继续派发原消息给 Agent。

### 5.2 L3 验证

1. Agent 实现完成后，质量运行进入 `requirement-verifying` 阶段。
2. Hub 自动调用 `autoRunVerification`，结合 checks、findings、review 等证据生成覆盖矩阵。
3. 结果写入 `quality_requirement_verifications` 表，并广播 `quality.verification.auto`。
4. 在 Desktop/Android 质量面板中，用户可以看到：
   - 验收标准列表
   - 每条标准的通过状态
   - 支持证据
   - 需求目标、约束、风险

对应代码：
- `hub/src/quality/verification.ts`
- `hub/src/quality/service.ts` 中的 `autoRunVerification`
- Desktop `AcceptanceCriteriaPanel`
- Android `AcceptanceCriteriaCard`

### 5.3 聊天内查看需求规格（无需跳转）

Desktop 端支持在聊天界面直接查看当前 run 关联的需求规格，无需切换到质量面板：

1. 当 run 进入 `requirement-verifying` 阶段或终态（accepted/failed/inconclusive）时，聊天界面会自动插入可折叠的 `SpecSummaryCard`。
2. 卡片展示：
   - **spec ID 和版本**（如 `spec a1b2c3d4 v2`）
   - **spec 状态**（草稿/澄清中/已接受/已废弃/已取消）
   - **当前 run 阶段**（如"需求验证中"、"已通过（终态）"）
   - **目标**（goal）
   - **验收标准**列表（含 required 标记、evidenceMode、证据数量）
   - **约束**列表
   - **风险**列表
3. 点击卡片可折叠/展开。
4. **单聊**：当 `sessionQuality` 存在且对应 run 已标记为"已展示 spec"时显示。
5. **群聊**：当 flow 中有 task 的 qualityRunId 已标记为"已展示 spec"时显示。

> 标记机制：`shownSpecRunIds` 防止同一 run 重复插入卡片。切换会话/房间时自动清空标记。

对应代码：
- `desktop/src/screens/ChatScreen.tsx` 中的 `SpecSummaryCard`
- `desktop/src/hub/store.ts` 中的 `shownSpecRunIds` 状态和 `quality.verification.auto` 事件处理

## 6. 验收标准的来源

验收标准由 L0 阶段根据用户需求和澄清答案自动生成，并随 `RequirementSpec` 保存。用户也可以在质量面板中查看，但不能直接编辑生成的验收标准；如需调整需求，可通过 `requirement.specUpdate` 更新 `goal` 并重新生成。

## 7. 常见问题

### Q：为什么我之前没有看到澄清卡片？

A：因为默认 `requirements.mode = off`。请按第 3 节启用。

### Q：为什么 `require` 模式下发送消息后 Agent 不响应？

A：消息已被挂起，等待澄清。请查看聊天中的澄清卡片并提交回答或跳过。

### Q：L3 验证结果在哪里看？

A：有两种方式：
1. **聊天内**（Desktop）：run 进入 `requirement-verifying` 或终态后，聊天界面会自动插入 `SpecSummaryCard`，展示 goal/验收标准/约束/风险，无需跳转。
2. **质量面板**（Desktop/Android）：选中一个 run，若该 run 已产生 `RequirementVerification` 记录，会自动加载并展示 `AcceptanceCriteriaPanel` / `AcceptanceCriteriaCard`。

### Q：能否在聊天里直接修改需求/验证配置？

A：可以。Desktop 端点击质量状态条展开后，底部有"需求/验证快捷配置"面板，可直接修改 `requirements.mode`、`verification.mode`、`maxQuestions` 并保存，无需跳转到质量面板。

### Q：群聊中能看到需求规格卡片吗？

A：可以。群聊中当 flow 里有 task 的质量运行进入 `requirement-verifying` 或终态时，聊天界面会显示 `SpecSummaryCard`。单聊和群聊共用同一套卡片渲染逻辑。

### Q：能否只对高风险请求启用澄清？

A：当前版本 `requirements.mode` 是全局开关，不区分风险。后续可通过 `requirementRules` 和 `riskRules` 组合实现更细粒度控制。

## 8. 相关文件

- 设计文档：`docs/quality-lifecycle.md`
- 后端实现：
  - `hub/src/quality/requirement.ts`
  - `hub/src/quality/verification.ts`
  - `hub/src/quality/service.ts`
  - `hub/src/index.ts` 中的 `runL0Intercept`、`resumeSuspendedPrompt`
- Desktop 实现：
  - `desktop/src/hub/types.ts`
  - `desktop/src/hub/store.ts`
  - `desktop/src/screens/ChatScreen.tsx`
  - `desktop/src/screens/QualityScreen.tsx`
- Android 实现：
  - `android/app/src/main/java/com/agenthub/ChatViewModel.kt`
  - `android/app/src/main/java/com/agenthub/ui/ChatScreen.kt`
  - `android/app/src/main/java/com/agenthub/ui/QualityScreen.kt`
