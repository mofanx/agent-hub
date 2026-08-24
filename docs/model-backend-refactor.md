# 模型后端多支持改造决策文档

**日期**: 2025-08-24
**目标**: 架构解耦，支持多后端（Devin/Claude/Codex/OpenCode/自定义）的模型切换

---

## 一、背景

### 1.1 原始需求
- 支持多个后端（Devin、Claude Code、Codex、OpenCode、自定义 API）
- 模型选择器按后端分组显示
- 架构解耦：Hub 不应侵入 Agent 自身的配置空间

### 1.2 旧实现的问题
1. **强耦合**：Hub 写入 `~/.config/devin/acp-model.json`（Devin CLI 特定实现）
2. **配置越界**：`backends.json` 也放在 `~/.config/devin/` 下，但后端管理是 Hub 的职责
3. **无法扩展**：其他 ACP Agent（Claude/Codex）不支持 `acp-model.json`
4. **同步硬编码**：`setConfigOption` 同步只针对 `agent === "devin"`，无法泛化到其他后端

---

## 二、改造方案

### 2.1 核心原则
1. **配置隔离**：Hub 自己的配置全部放在 `~/.config/agent-hub/`
2. **ACP 标准优先**：运行时模型切换通过 `agent.setConfigOption(sessionId, "model", uid)`，所有 ACP agent 通用
3. **不侵入 Agent 配置**：不再写入 `acp-model.json`，降级为只读 fallback
4. **同步泛化**：`setConfigOption` 同步去掉 `agent === "devin"` 硬编码

### 2.2 架构

```
用户切换模型
  → Hub 写入 ~/.config/agent-hub/model-preference.json（Hub 自己的偏好）
  → Hub 调用 agent.setConfigOption(sessionId, "model", uid)（ACP 标准，运行时生效）
  → 所有活跃 session 的 agent 内部处理模型切换

新建/恢复 session
  → Hub 读 model-preference.json 获取当前偏好
  → 调用 setConfigOption 同步给新 session

后端管理
  → ~/.config/agent-hub/backends.json 记录启用/禁用状态
  → ModelManager 按启用的后端聚合模型列表
```

### 2.3 配置路径变更

| 路径 | 改造前 | 改造后 |
|------|--------|--------|
| 模型偏好 | `~/.config/devin/acp-model.json`（Hub 写入） | `~/.config/agent-hub/model-preference.json`（Hub 写入） |
| 后端配置 | `~/.config/devin/backends.json`（Hub 写入） | `~/.config/agent-hub/backends.json`（Hub 写入） |
| Devin 主配置 | `~/.config/devin/config.json` | 不变（Hub 只读 fallback） |
| acp-model.json | Hub 写入（主写入位置） | 只读 fallback（兼容旧版迁移） |

### 2.4 模型偏好优先级

```
1. ~/.config/agent-hub/model-preference.json   ← Hub 自己的偏好（主）
2. ~/.config/devin/acp-model.json              ← 旧版兼容（fallback）
3. ~/.config/devin/config.json                 ← Devin 默认配置（fallback）
4. "swe-1-7"                                    ← 硬编码默认
```

### 2.5 setConfigOption 同步泛化

改造前：4 处 `if (connection.agent === "devin")` 硬编码
改造后：所有 ACP agent 都同步（`setConfigOption` 是 ACP 标准，失败时 warn 不中断）

---

## 三、实施进度

### ✅ 阶段 1：Hub 端解耦
- `model.ts`：引入 `HUB_CONFIG_DIR`，模型偏好和后端配置移到 `~/.config/agent-hub/`
- `model.ts`：`current()` 优先读 Hub 偏好，`acp-model.json` 降级为 fallback
- `model.ts`：`set()` 写入 `model-preference.json`，不再写 `acp-model.json`
- `index.ts`：`setConfigOption` 同步泛化到所有 agent（去掉 devin 硬编码）

### ✅ 阶段 2：多后端框架
- `ModelBackend` 类型（devin/claude/codex/opencode/custom）
- `BackendConfig` 后端管理（启用/禁用、增删改）
- 按后端分组加载模型
- RPC：`model.list` / `model.set` / `model.backends.*`

### ✅ 阶段 3：桌面端 UI
- ModelPicker 按后端分组显示
- 后端筛选标签栏

### ✅ 阶段 4：其他后端真实接入
- **OpenCode**：通过 `opencode models --verbose` CLI 获取真实模型列表（102 个模型，4 个 provider）
- **Claude/Codex**：通过 ACP `session.new` 返回的 `configOptions` 动态获取模型列表
  - `AcpAgent.createSession` 缓存 `configOptions`
  - `ModelManager.injectConfigOptions(backend, configOptions)` 注入并刷新
  - Hub 在 session 创建后自动注入

---

## 四、测试验证

### 4.1 Devin 后端（已验证）
- ✅ 模型列表获取（178 个模型）
- ✅ 模型切换：写入 `model-preference.json` + `setConfigOption` 调用
- ✅ 运行时无缝切换（不重启会话）
- ✅ Devin CLI 日志确认 `apply_model_change` 执行
- ✅ 配置隔离：`acp-model.json` 和 `config.json` 不被修改

### 4.2 OpenCode 后端（已验证）
- ✅ 通过 `opencode models --verbose` 获取 102 个真实模型
- ✅ 支持 4 个 provider（google/openai/opencode/xai）
- ✅ 自动解析模型元信息（名称、family、cost）

### 4.3 Claude/Codex 后端（已实现，待实际连接验证）
- ✅ AcpAgent.createSession 缓存 configOptions
- ✅ ModelManager.injectConfigOptions 从 configOptions 解析模型
- ✅ Hub 在 session 创建后自动注入
- ⏳ 需要实际连接 Claude/Codex agent 后验证模型列表

---

## 五、决策记录

| 决策 | 理由 |
|------|------|
| 配置移到 `~/.config/agent-hub/` | 架构解耦，Hub 不侵入 Agent 配置空间 |
| `acp-model.json` 降级为只读 fallback | 兼容旧版迁移，新安装不再依赖 |
| `setConfigOption` 同步泛化 | ACP 标准，支持多后端切换 |
| 后端配置移到 agent-hub 目录 | 后端管理是 Hub 职责，与 Agent 无关 |
| 保留 `devin models list` 获取模型 | 当前唯一可用后端，其他待 API 配置 |
