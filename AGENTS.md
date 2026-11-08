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
- **i18n（硬性要求）**：所有用户可见文案必须走既有双语机制——Android 用 `Strings.kt`/`stringsFor(lang)`，Desktop 用 `hub/strings.ts`/`stringsFor(store.lang)`；禁止在 UI 代码中硬编码任何单语言字符串（含提示、确认框、占位符、空态、tooltip）。逻辑判断用稳定 key（如状态 id），仅在渲染时映射为文案；新增字段须同步更新接口与中英两份字典。协议/持久化数据标记（如 `"我"`）、双语关键词匹配正则、注释不受此限。

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

## 发版流程（版本提升/推送前必须完成）

`adb install` 返回 Success 只代表安装成功，不代表应用可用。**版本号提升与 tag/push 之前必须实测 App 能正常启动**，避免把"构建通过但打开即崩"的版本推给用户。

```bash
# 安装后启动验证：进程存活且无 FATAL
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.agenthub -c android.intent.category.LAUNCHER 1
sleep 4
adb shell pidof com.agenthub          # 应输出 PID
adb logcat -d | grep -i FATAL          # 应无输出
```

- Kotlin 成员属性/`by mutableStateOf` 委托按声明顺序初始化：`init {}` 块（如自动连接）若在构造期触达在其后声明的属性，会因委托字段未初始化而 NPE——崩溃只在真机启动时暴露，编译和单测都测不出来。
- 历史教训：0.14.0 曾因 `missionFocusId` 等属性声明在 `init{}` 之后、被 `connect()→disconnect()` 提前访问导致启动即崩；修复方式是把声明上移到 `init` 块之前。

## 本地 Agent 启动问题排查

- Windows 下 `npx`/`npm` 等入口是 `.cmd` 脚本，Hub 使用 `cross-spawn` 自动解析 `PATHEXT` 和 `.cmd` 后缀。
- 若使用 pm2 启动 Hub，请确保 pm2 进程的 `PATH` 包含 Node 和 npm，否则 `npx` 仍会找不到。
- 此时可通过环境变量指定完整可执行路径绕过 PATH 问题：
  - `CLAUDE_ACP_BIN`：`claude` 本地 Agent 的入口
  - `CODEX_ACP_BIN`：`codex` 本地 Agent 的入口
  - `OPENCODE_BIN` / `DEVIN_BIN`：其他本地 Agent 的入口
- 启动失败的具体原因会通过 `agent.status` 事件推送到桌面端，并在顶部错误条中显示。

## 跨平台兼容

- 测试脚本中 shell glob 使用双引号（`"src/**/*.test.ts"`），避免 Windows `cmd.exe` 不剥离单引号导致匹配失败。
- 不要硬编码 POSIX 路径（如 `/usr/bin/git`），改用命令名走 `PATH` 解析。
- `path.relative` / `path.join` 等产生的路径比较前统一规范化（`split(path.sep).join("/")`），避免 Windows 反斜杠分隔符导致字符串不匹配。
- 涉及文件系统/子进程的新代码需同时考虑 Linux、macOS、Windows 行为差异。

## 当前架构要点

- **群聊编排**：支持 mention、conductor、roundrobin、parallel、pipeline、debate、auto 七种模式。
- **Auto 决策可拆分性**：`buildAutoPrompt` 在任务性质之外评估可拆分性——任务量大不是拆分理由；存在共享文件/类型定义/统一词汇表等收敛点时偏向 self/mention；不确定时保守降级并在 `reason` 中说明。
- **Conductor**：指挥家拆解任务为 JSON 工单，Hub 自动派发；完成后汇总。各 worker 任务应文件级排他，避免并行写同一文件（可用 `files` 声明，Hub 会自动合并重叠任务）。
- **协作约定**：
  - 大任务的只读前置工作（全量扫描、清单、审计）可拆给子 agent/其他成员并行做，改动统一由主执行者落地——调研并行安全，写入串行。
  - 大范围改造完成后，尽量由**非执行者**做独立漏网检查（扫描残留、review diff），避免自查盲区。
- **Flow 状态**：`room.flow` API + `room.flowUpdate` 事件，前后端同步编排进度。
- **Artifact 自动捕获**：从子任务输出中扫描 ````bash` 块、diff 块、文件路径和显式文件声明。
- **ACP fs 能力**：Hub 声明 `fs.readTextFile` / `fs.writeTextFile`，直接感知 agent 文件写入并同步产物与事件。
- **回合治理**：turn 提交不变量——外发 prompt 时记录房史"最后一条用户条目"游标，prompt.done 消费前若游标被新用户消息推进，输出作废并按原 prompt 重跑（上限 1 次，重跑仍过期则强制接受；被 cancel 的 turn 不重跑）；被流程吸收的补充与被过滤丢弃的闲聊经 `excuseRoomTurns` 推进游标豁免，不作废在途回合。回合看门狗分两阶段：未出输出按 `HUB_PROMPT_ACK_TIMEOUT_MS`（180s）判超时，出过输出后连续静默按 `HUB_TURN_STALL_MS`（180s）判 stalled 并 cancel 回收（挂起的 permission/elicitation 属活跃，不误判）。单聊 busy 排队发 `session.notice`（落 system 条目，订阅分层 global 白名单含之）。`OperationLedger`（内存 5000 LRU）按 opId 去重外发副作用（assistant 条目、过程卡、文件写入），防断连重放/重试重发重复提交，重跑生成新 opId 不受影响。mention 只向被 @ 成员派发（未点名零成本静默；无 @ 回退全体成员）。conductor 跟进派发轮次上限 `flow.maxRounds`（默认 8，`room.maxRounds` 覆盖），超限置 `awaiting-retry`/`waitingFor=user` 交还用户。worker 过程输出聚合为带 `flowId`/`taskId` 的 process 卡，为客户端归卡铺路。
- **tool_call 捕获**：解析 `session/update` 中的 `tool_call` / `tool_call_update`，记录 edit/delete/move/execute 等关键动
## 待验证（短期无法自动化验证，待真实使用浮现）

- **ntfy 断连到达 + 点击深链定位**：通道/env/推送链路已实证，唯一未验环是真实离线 waitingFor 通知到达后点击 `agenthub://attention?roomId=…` 拉起并定位。下次收到离线通知时点一下即闭环。
- **RSS 24h 曲线**：`dropScopeCache`/`dropRoomAttention` 内存清理成效待观察——`pm2 monit`（或 adb 侧内存）看 RSS 是否仍单调上行，上行则还有漏网 map（已知残余：`roomMemberModels`/`roomMemberTypes` sessionId 键小残留）。
- **IFC 真机 UI 过眼**：协议层 10/10 已实证；私密房标题 🔒、跨房读"待批准"提示在 Android/Desktop 上的实际渲染待肉眼走查。
- **观察指标待真实负载**：`wakeSkips` 拦截率（Jev 二阶段判据：高→YAGNI）、静默复现误触发率（误报→调 contains 关键词白名单）、`SilentReproBook` 每房日限 2 轮触顶率、IFC 误触发率（10 处门控漏标调用点会浮现）、蒸馏近重复堆积率（前缀去重判据）、`session.update` 降幅（订阅分层验收）。
- **decision-model shadow 指标（攒 1-2 周 ndjson 再评二期）**：`decisions.ndjson` 与 hostOutcome 成对一致率（`decide-eval.ts` 回放，达标前不开 enforce）、skip 分布（unconfigured/error/低置信占比——unconfigured 高说明端点没配、error 高说明模型不稳）、host 决策耗时对照 30s `HUB_AUTO_DECIDE_TIMEOUT_MS`（常态逼近上限说明预算偏紧）。
