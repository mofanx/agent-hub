# Deepseek Harness 接入待办

## 已完成

- Deepseek 默认接入改为固定版本官方 npm ACP profile：`npx -y @deepseek-ai/dsh@0.2.0-rc.2 --profile acp`。
- 保留 `DSH_ACP_BIN` / `DSH_ACP_ARGS` 显式覆盖，以及 `DSH_ROOT` 源码开发模式。
- `DSH_ACP_ARGS` 支持 JSON 数组和带引号的 shell 风格参数拆分。
- Hub 本机、单 worker、multiplex worker 统一走 `spawnAgentProcess`，转发 `cwd` / `env` 并兼容 Windows `.cmd`。
- `ModelBackend`、Desktop、Android 的 agent 类型链路已补充 `deepseek`。
- 新增 `hub/src/agent-defs.test.ts` 覆盖参数解析、注册矩阵和 spawn 环境传递。

## 当前机器已完成验证

- `cd hub && npx tsc --noEmit`：通过。
- `cd hub && node --import=tsx --test src/agent-defs.test.ts`：10/10 通过。
- `cd hub && npm test`：256 pass / 3 fail；3 个失败均为既有 `/usr/bin/git` 硬编码环境问题，与本次改动无关。
- `cd desktop && npx tsc --noEmit`：通过。

## 待完成

1. **Android 编译验证**
   - 当前机器没有 `java` / `javac` / `JAVA_HOME`。
   - 在有 JDK 的环境执行：
     ```bash
     cd android
     ./gradlew :app:compileDebugKotlin
     ```

2. **Linux 实机验证**
   - 当前机器没有 WSL，未做 Linux 运行时验证。
   - 建议在 Linux 环境重复：
     ```bash
     cd hub && npx tsc --noEmit
     cd hub && node --import=tsx --test src/agent-defs.test.ts
     ```

3. **Deepseek 真实 ACP E2E**
   - 当前 `DEEPSEEK_API_KEY` 未配置，无法验证真实模型会话。
   - 配置后可验证：
     - `agent.info` 是否包含 `deepseek`
     - 创建 `deepseek` connection / session
     - `initialize`、`session/new`、`session/prompt`、取消与恢复链路
     - Desktop / Android 是否能选择并运行 `deepseek`

4. **重启线上 Hub**
   - 当前 PM2 进程仍可能运行旧代码。
   - 在空闲窗口执行：
     ```bash
     pm2 restart agent-hub
     ```
   - 注意：重启会中断正在运行的本地 agent 会话。

5. **Worker 启动级验证**
   - 重启后验证 `connection.create` / `agent.info` 返回 `deepseek`。
   - 可用 `AGENTS=deepseek` 显式测试 multiplex worker 是否能 announce 与 spawn。

## 可选后续优化

- `DSH_ACP_ARGS` 为非法 JSON 时，在回退 shell 拆分前输出 warning，便于发现配置错误。
- 修复仓库既有的 `/usr/bin/git` 硬编码，消除 Windows 下 3 个既有测试失败。
- `member.status` 请求目前返回 `unknown method`，需确认是否为客户端协议版本不一致。
