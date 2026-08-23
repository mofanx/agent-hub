export interface Strings {
  bypassEnabled: string;
  bypassDisabled: string;
  slashHelpTitle: string;
  slashHelpHelp: string;
  slashHelpStop: string;
  slashHelpBypass: string;
  slashHelpModel: string;
  unknownCommandHint: string;
  connectError: string;
  agentDisconnected: string;
  notConnected: string;
  connected: string;
  permissionRequest: string;
  modelSwitched: string;
  modelUnknown: string;
  modelListError: string;
  copy: string;
  selectText: string;
  quoting: string;
  copied: string;
  modelListTitle: string;
  modelCurrentLabel: string;
  modelNoResults: string;
  modelClearFilters: string;
  modelFilterHint: string;
}

const zh: Strings = {
  bypassEnabled: "已开启审批自动通过",
  bypassDisabled: "已关闭审批自动通过",
  slashHelpTitle: "可用指令：",
  slashHelpHelp: "/help — 显示帮助",
  slashHelpStop: "/stop — 停止当前生成",
  slashHelpBypass: "/bypass [on|off] — 切换审批自动通过",
  slashHelpModel: "/model [模型] — 切换模型",
  unknownCommandHint: "未知指令，输入 /help 查看可用指令",
  connectError: "连接失败",
  agentDisconnected: "连接已断开",
  notConnected: "未连接",
  connected: "已连接",
  permissionRequest: "工具调用",
  modelSwitched: "已切换到 %s（%s）",
  modelUnknown: "未知模型: %s",
  modelListError: "获取模型列表失败: %s",
  copy: "复制",
  selectText: "选取文字",
  quoting: "引用",
  copied: "已复制",
  modelListTitle: "可选模型",
  modelCurrentLabel: "当前",
  modelNoResults: "没有匹配的模型",
  modelClearFilters: "清除筛选",
  modelFilterHint: "搜索模型名称、UID 或别名",
};

const en: Strings = {
  bypassEnabled: "Permission bypass enabled",
  bypassDisabled: "Permission bypass disabled",
  slashHelpTitle: "Available commands:",
  slashHelpHelp: "/help — show help",
  slashHelpStop: "/stop — stop current generation",
  slashHelpBypass: "/bypass [on|off] — toggle permission bypass",
  slashHelpModel: "/model [model] — switch model",
  unknownCommandHint: "Unknown command, type /help for available commands",
  connectError: "Connection failed",
  agentDisconnected: "Disconnected",
  notConnected: "Not connected",
  connected: "Connected",
  permissionRequest: "Tool call",
  modelSwitched: "Switched to %s (%s)",
  modelUnknown: "Unknown model: %s",
  modelListError: "Failed to load model list: %s",
  copy: "Copy",
  selectText: "Select text",
  quoting: "Quote",
  copied: "Copied",
  modelListTitle: "Available models",
  modelCurrentLabel: "Current",
  modelNoResults: "No matching models",
  modelClearFilters: "Clear filters",
  modelFilterHint: "Search by name, UID or alias",
};

export function stringsFor(lang: string): Strings {
  return lang === "zh" ? zh : en;
}
