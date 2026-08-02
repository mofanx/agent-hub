import { invoke } from "@tauri-apps/api/core";

export async function loadConfig(): Promise<string> {
  return invoke<string>("load_config");
}

export async function saveConfig(config: string): Promise<void> {
  return invoke("save_config", { config });
}

export async function showNotification(title: string, body: string): Promise<void> {
  return invoke("show_notification", { title, body });
}

export async function isNotificationPermissionGranted(): Promise<boolean> {
  return invoke<boolean>("is_notification_permission_granted");
}

export async function requestNotificationPermission(): Promise<string> {
  return invoke<string>("request_notification_permission");
}

export async function showWindow(): Promise<void> {
  return invoke("show_window");
}

export async function hideWindow(): Promise<void> {
  return invoke("hide_window");
}

export async function toggleWindow(): Promise<boolean> {
  return invoke<boolean>("toggle_window");
}

export async function setTrayTooltip(tooltip: string): Promise<void> {
  return invoke("set_tray_tooltip", { tooltip });
}

export async function setTrayTitle(title: string): Promise<void> {
  return invoke("set_tray_title", { title });
}
