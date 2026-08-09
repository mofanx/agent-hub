# Agent Hub 协作指南

## 项目结构

```
agent-hub/
├── hub/        # Node.js WebSocket 网关（TS）
├── desktop/    # Tauri + React 桌面客户端
├── android/    # Kotlin + Jetpack Compose App
└── deploy/     # VPS 中继部署套件
```

## 验证命令

提交前至少跑通以下检查：

```bash
# Hub: 类型检查 + 单元测试
cd hub
npx tsc --noEmit
npm test

# Desktop: 类型检查
cd desktop
npx tsc --noEmit

# Android: 编译
cd android
./gradlew :app:compileDebugKotlin
```

## 测试

- Hub 测试使用 Node 原生 `node:test`，通过 `tsx` 运行 TS。
- 命令：`cd hub && npm test`（即 `node --import=tsx --test 'src/**/*.test.ts'`）。
- 新增测试文件放在 `hub/src/*.test.ts`，不要额外引入测试框架。

## 依赖管理

- 优先使用标准库 / 平台原生能力，避免新增依赖。
- 必须新增时，选择已发布至少 7 天的版本，避免 `latest`、`*` 等浮动范围。
- Android 依赖通过 `gradle/libs.versions.toml` 管理。

## 代码约定

- **不要**主动新增注释或文档文件，除非明确要求。
- 不要主动修改 `.npmrc` 等安全策略配置。
- 优先编辑现有文件，而不是创建新文件。
- TypeScript 默认紧凑代码，避免过度错误处理。
- Android 包名：`com.agenthub.ui`（UI 组件）、`com.agenthub`（ViewModel/业务）。

## 常用开发命令

```bash
# 启动 Hub（本地开发）
cd hub
HUB_TOKEN=dev-token npx tsx src/index.ts

# 运行验证脚本（无手机时）
cd hub
npx tsx scripts/conductor-check.ts
npx tsx scripts/room-check.ts
npx tsx scripts/m1-check.ts

# 安装 Android 调试包
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

## 当前架构要点

- **群聊编排**：支持 mention、conductor、roundrobin、parallel、pipeline、debate、auto 七种模式。
- **Conductor**：指挥家拆解任务为 JSON 工单，Hub 自动派发；完成后汇总。
- **Flow 状态**：`room.flow` API + `room.flowUpdate` 事件，前后端同步编排进度。
- **Artifact 自动捕获**：从子任务输出中扫描 ````bash` 块、diff 块、文件路径和显式文件声明。
- **角色卡绑定**：房间成员可绑定 `memberRoles`，prompt 注入对应 persona。
- **持久化**：SQLite（`hub/data/hub.db`），Hub 重启自动恢复。
