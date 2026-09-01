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

### Gradle 版本统一（Android）

- **一律使用项目内的 `./gradlew`，禁止直接调用系统 `gradle`。**
  系统包（如 apt 的 `gradle 4.4.1`）版本陈旧且与项目无关，不要用它构建，也不要为了"省事"再装一个全局 gradle。
- 版本由 `android/gradle/wrapper/gradle-wrapper.properties` 中的 `distributionUrl` 锁定（当前 **9.5.1**）。
  首次运行 `./gradlew` 会自动下载到 `~/.gradle/wrapper/dists/`，之后离线可用，重启不丢。
- 升级 gradle 时**只改 wrapper 配置**，不要在机器上手动铺新版本：
  ```bash
  cd android
  ./gradlew wrapper --gradle-version <新版本>
  ```
  提交 `gradle-wrapper.properties` 即可，所有协作者拉取后自动同步。
- 如需切换本机默认 JDK，配 `org.gradle.java.home` 或用 `JAVA_HOME`，不要靠改系统 gradle 来绕。
- 依赖版本统一走 `gradle/libs.versions.toml`，不要在 `build.gradle.kts` 里硬编码版本号。

### Gradle 版本统一（Android）

- **一律使用项目内的 `./gradlew`，禁止直接调用系统 `gradle`。**
  系统包（如 apt 的 `gradle 4.4.1`）版本陈旧且与项目无关，不要用它构建，也不要为了"省事"再装一个全局 gradle。
- 版本由 `android/gradle/wrapper/gradle-wrapper.properties` 中的 `distributionUrl` 锁定（当前 **9.5.1**）。
  首次运行 `./gradlew` 会自动下载到 `~/.gradle/wrapper/dists/`，之后离线可用，重启不丢。
- 升级 gradle 时**只改 wrapper 配置**，不要在机器上手动铺新版本：
  ```bash
  cd android
  ./gradlew wrapper --gradle-version <新版本>
  ```
  提交 `gradle-wrapper.properties` 即可，所有协作者拉取后自动同步。
- 如需切换本机默认 JDK，配 `org.gradle.java.home` 或用 `JAVA_HOME`，不要靠改系统 gradle 来绕。
- 依赖版本统一走 `gradle/libs.versions.toml`，不要在 `build.gradle.kts` 里硬编码版本号。

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

## 本地 Agent 启动问题排查

- Windows 下 `npx`/`npm` 等入口是 `.cmd` 脚本，Hub 使用 `cross-spawn` 自动解析 `PATHEXT` 和 `.cmd` 后缀。
- 若使用 pm2 启动 Hub，请确保 pm2 进程的 `PATH` 包含 Node 和 npm，否则 `npx` 仍会找不到。
- 此时可通过环境变量指定完整可执行路径绕过 PATH 问题：
  - `CLAUDE_ACP_BIN`：`claude` 本地 Agent 的入口
  - `CODEX_ACP_BIN`：`codex` 本地 Agent 的入口
  - `OPENCODE_BIN` / `DEVIN_BIN`：其他本地 Agent 的入口
- 启动失败的具体原因会通过 `agent.status` 事件推送到桌面端，并在顶部错误条中显示。

## 当前架构要点

- **群聊编排**：支持 mention、conductor、roundrobin、parallel、pipeline、debate、auto 七种模式。
- **Conductor**：指挥家拆解任务为 JSON 工单，Hub 自动派发；完成后汇总。
- **Flow 状态**：`room.flow` API + `room.flowUpdate` 事件，前后端同步编排进度。
- **Artifact 自动捕获**：从子任务输出中扫描 ````bash` 块、diff 块、文件路径和显式文件声明。
- **ACP fs 能力**：Hub 声明 `fs.readTextFile` / `fs.writeTextFile`，直接感知 agent 文件写入并同步产物与事件。
- **tool_call 捕获**：解析 `session/update` 中的 `tool_call` / `tool_call_update`，记录 edit/delete/move/execute 等关键动