# Agent Hub for Windows

Tauri 2 + React + TypeScript 桌面客户端，复用 Android 端的 WebSocket JSON-RPC 协议。

## 功能

- 通过 WebSocket 连接 Hub（支持断线重连、心跳保活）
- JSON-RPC 请求-响应映射 + 事件流分发
- 全局状态 store：会话/群聊/角色/连接管理、历史搜索、批量选择、快捷指令、权限审批
- 原生能力：系统通知、系统托盘、本地配置持久化
- Windows 安装包输出：MSI / NSIS

## 开发

```bash
cd desktop
pnpm install
pnpm tauri dev
```

## Windows 构建

在 Windows 环境运行：

```bash
cd desktop
pnpm install
pnpm tauri build
```

产物位于 `src-tauri/target/release/bundle/`：

- `msi/Agent Hub_0.2.0_x64_en-US.msi`
- `nsis/Agent Hub_0.2.0_x64-setup.exe`

## 目录

- `src/hub/`：WebSocket 客户端、Zustand store、Tauri 命令封装
- `src/screens/`：连接、会话/群聊列表、聊天、设置界面
- `src-tauri/src/lib.rs`：Rust 后端命令、托盘、通知插件
