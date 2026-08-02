export interface Strings {
  bypassEnabled: string;
  bypassDisabled: string;
  slashHelpTitle: string;
  slashHelpHelp: string;
  slashHelpStop: string;
  slashHelpBypass: string;
  unknownCommandHint: string;
  connectError: string;
  agentDisconnected: string;
  notConnected: string;
  permissionRequest: string;
}

const zh: Strings = {
  bypassEnabled: "已开启审批自动通过",
  bypassDisabled: "已关闭审批自动通过",
  slashHelpTitle: "可用指令：",
  slashHelpHelp: "/help — 显示帮助",
  slashHelpStop: "/stop — 停止当前生成",
  slashHelpBypass: "/bypass [on|off] — 切换审批自动通过",
  unknownCommandHint: "未知指令，输入 /help 查看可用指令",
  connectError: "连接失败",
  agentDisconnected: "连接已断开",
  notConnected: "未连接",
  permissionRequest: "工具调用",
};

const en: Strings = {
  bypassEnabled: "Permission bypass enabled",
  bypassDisabled: "Permission bypass disabled",
  slashHelpTitle: "Available commands:",
  slashHelpHelp: "/help — show help",
  slashHelpStop: "/stop — stop current generation",
  slashHelpBypass: "/bypass [on|off] — toggle permission bypass",
  unknownCommandHint: "Unknown command, type /help for available commands",
  connectError: "Connection failed",
  agentDisconnected: "Disconnected",
  notConnected: "Not connected",
  permissionRequest: "Tool call",
};

export function stringsFor(lang: string): Strings {
  return lang === "zh" ? zh : en;
}
