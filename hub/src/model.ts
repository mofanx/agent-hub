import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { logError } from "./logger.js";

export type ModelBackend = "devin" | "claude" | "codex" | "opencode" | "openclaw" | "custom";

export type ModelInfo = {
  uid: string;
  label: string;
  family: string;
  familyUid: string;
  slug: string;
  aliases: string[];
  costTier: string;
  costSummary?: string;
  backend: ModelBackend;
};

export type BackendConfig = {
  id: string;
  name: string;
  type: ModelBackend;
  enabled: boolean;
  config?: Record<string, string>;
};

const HUB_CONFIG_DIR = path.join(homedir(), ".config/agent-hub");
const HUB_MODEL_PREF_PATH = path.join(HUB_CONFIG_DIR, "model-preference.json");
const HUB_SESSION_PREF_PATH = path.join(HUB_CONFIG_DIR, "session-model-preferences.json");
const HUB_BACKENDS_PATH = path.join(HUB_CONFIG_DIR, "backends.json");
const ACP_MODEL_PATH = path.join(homedir(), ".config/devin/acp-model.json");
const CONFIG_PATH = path.join(homedir(), ".config/devin/config.json");

export class ModelManager {
  private all: ModelInfo[] | null = null;
  private backends: BackendConfig[] = [];
  private loading: Promise<void> | null = null;
  private lastError: string | null = null;
  private injectedModels = new Map<ModelBackend, ModelInfo[]>();

  /** 返回可用模型列表，首次调用会拉取并缓存 */
  async list(): Promise<ModelInfo[]> {
    if (this.all) return this.all;
    if (!this.loading) this.loading = this.load();
    await this.loading;
    return this.all ?? [];
  }

  /** 返回启用的后端列表 */
  async listBackends(): Promise<BackendConfig[]> {
    this.loadBackends();
    return this.backends.filter(b => b.enabled);
  }

  /** 添加自定义后端配置 */
  addBackend(config: BackendConfig): void {
    this.loadBackends();
    const existing = this.backends.findIndex(b => b.id === config.id);
    if (existing >= 0) {
      this.backends[existing] = config;
    } else {
      this.backends.push(config);
    }
    this.saveBackends();
  }

  /** 移除后端配置 */
  removeBackend(id: string): void {
    this.loadBackends();
    this.backends = this.backends.filter(b => b.id !== id);
    this.saveBackends();
  }

  /** 切换后端启用状态 */
  toggleBackend(id: string): void {
    this.loadBackends();
    const backend = this.backends.find(b => b.id === id);
    if (backend) {
      backend.enabled = !backend.enabled;
      this.saveBackends();
    }
  }

  /** 根据 uid / slug / alias 查找模型，不区分大小写 */
  find(name: string): ModelInfo | undefined {
    if (!this.all) return undefined;
    const q = name.trim().toLowerCase();
    return this.all.find((m) => {
      if (m.uid.toLowerCase() === q) return true;
      if (m.slug.toLowerCase() === q) return true;
      if (m.aliases.some((a) => a.toLowerCase() === q)) return true;
      return false;
    });
  }

  /** 根据 uid / slug / alias 查找模型，不区分大小写 */
  findByBackend(backend: ModelBackend): ModelInfo[] {
    if (!this.all) return [];
    return this.all.filter(m => m.backend === backend);
  }

  /**
   * 当前生效的模型 uid
   * @param backend 后端类型，按后端分别读取偏好
   * @param sessionId 可选，指定 session 时优先读 session 级偏好
   * 优先级：session 偏好 > 后端偏好 > acp-model.json（devin 兼容旧版） > config.json（devin） > 默认
   */
  current(backend: ModelBackend = "devin", sessionId?: string): { uid: string; label?: string } {
    const prefs = this.loadModelPreferences();
    const sessionPrefs = this.loadSessionPreferences();
    if (sessionId && sessionPrefs[sessionId]) return { uid: sessionPrefs[sessionId] };
    if (prefs[backend]) return { uid: prefs[backend] };
    // devin 后端回退到旧版兼容文件
    if (backend === "devin") {
      if (existsSync(ACP_MODEL_PATH)) {
        try {
          const raw = JSON.parse(readFileSync(ACP_MODEL_PATH, "utf8"));
          if (raw.model) return { uid: String(raw.model) };
        } catch {
          // fallthrough
        }
      }
      if (existsSync(CONFIG_PATH)) {
        try {
          const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
          const model = raw?.agent?.model;
          if (model) return { uid: String(model) };
        } catch {
          // fallthrough
        }
      }
    }
    return { uid: this.defaultModel(backend) };
  }

  /** 切换到指定模型，按后端写入 agent-hub 自己的配置 */
  async set(name: string): Promise<ModelInfo> {
    await this.list();
    const match = this.find(name);
    if (!match) throw new Error(`unknown model: ${name}`);
    this.writeModelPreference(match.backend, match.uid);
    return match;
  }

  /** 按 session 切换模型，只影响该 session，不影响同后端其他 session */
  async setForSession(name: string, sessionId: string): Promise<ModelInfo> {
    await this.list();
    const match = this.find(name);
    if (!match) throw new Error(`unknown model: ${name}`);
    this.writeSessionPreference(sessionId, match.uid);
    return match;
  }

  /** 强制刷新模型列表缓存 */
  async refresh(): Promise<ModelInfo[]> {
    this.all = null;
    this.loading = null;
    return this.list();
  }

  /**
   * 从 ACP agent 的 configOptions 注入模型列表（用于 Claude/Codex 等无 CLI list 命令的后端）
   * 注入后需要 refresh 才会生效
   */
  injectConfigOptions(backend: ModelBackend, configOptions: unknown[]): void {
    const models = parseConfigOptionsModels(configOptions, backend);
    if (models.length > 0) {
      this.injectedModels.set(backend, models);
      this.all = null;
      this.loading = null;
    }
  }

  lastLoadError(): string | null {
    return this.lastError;
  }

  private defaultModel(backend: ModelBackend): string {
    // 返回空字符串表示"使用 agent 默认模型"，不硬编码具体模型名
    // 实际模型列表由 ACP agent 上报的 configOptions 注入
    switch (backend) {
      case "devin": return "swe-1-7";
      case "opencode": return "opencode/big-pickle";
      default: return "";
    }
  }

  private loadModelPreferences(): Record<string, string> {
    if (existsSync(HUB_MODEL_PREF_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(HUB_MODEL_PREF_PATH, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          // 新格式: { devin: "uid", opencode: "uid", ... }
          if (raw.models && typeof raw.models === "object") return raw.models as Record<string, string>;
          // 旧格式兼容: { model: "uid", updatedAt: ... }
          if (raw.model) return { devin: String(raw.model) };
        }
      } catch {
        // fallthrough
      }
    }
    return {};
  }

  private writeModelPreference(backend: ModelBackend, model: string): void {
    if (!existsSync(HUB_CONFIG_DIR)) mkdirSync(HUB_CONFIG_DIR, { recursive: true });
    const prefs = this.loadModelPreferences();
    prefs[backend] = model;
    writeFileSync(
      HUB_MODEL_PREF_PATH,
      JSON.stringify({ models: prefs, updatedAt: Date.now() }, null, 2),
    );
  }

  private loadSessionPreferences(): Record<string, string> {
    if (existsSync(HUB_SESSION_PREF_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(HUB_SESSION_PREF_PATH, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          return raw as Record<string, string>;
        }
      } catch {
        // fallthrough
      }
    }
    return {};
  }

  private writeSessionPreference(sessionId: string, model: string): void {
    if (!existsSync(HUB_CONFIG_DIR)) mkdirSync(HUB_CONFIG_DIR, { recursive: true });
    const prefs = this.loadSessionPreferences();
    prefs[sessionId] = model;
    writeFileSync(HUB_SESSION_PREF_PATH, JSON.stringify(prefs, null, 2));
  }

  private loadBackends(): void {
    if (this.backends.length > 0) return;
    const defaults: BackendConfig[] = [
      { id: "devin", name: "Devin", type: "devin", enabled: true },
      { id: "claude", name: "Claude Code", type: "claude", enabled: true },
      { id: "codex", name: "Codex", type: "codex", enabled: true },
      { id: "opencode", name: "OpenCode", type: "opencode", enabled: true },
      { id: "openclaw", name: "OpenClaw", type: "openclaw", enabled: true },
    ];
    if (existsSync(HUB_BACKENDS_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(HUB_BACKENDS_PATH, "utf8"));
        const loaded = Array.isArray(raw) ? raw : defaults;
        // 合并：确保已知标准后端存在
        const knownIds = new Set(loaded.map((b: BackendConfig) => b.id));
        for (const d of defaults) {
          if (!knownIds.has(d.id)) loaded.push(d);
        }
        this.backends = loaded;
      } catch {
        this.backends = defaults;
      }
    } else {
      this.backends = defaults;
    }
  }

  private saveBackends(): void {
    if (!existsSync(HUB_CONFIG_DIR)) mkdirSync(HUB_CONFIG_DIR, { recursive: true });
    writeFileSync(HUB_BACKENDS_PATH, JSON.stringify(this.backends, null, 2));
  }

  private async load(): Promise<void> {
    try {
      const models: ModelInfo[] = [];
      const enabledBackends = await this.listBackends();
      
      for (const backend of enabledBackends) {
        try {
          const backendModels = await this.loadBackendModels(backend);
          models.push(...backendModels);
        } catch (err) {
          logError(`backend ${backend.id} load error`, err);
        }
      }
      
      this.all = models;
      this.lastError = null;
      console.log(`[model] loaded ${models.length} models from ${enabledBackends.length} backends`);
    } catch (err) {
      this.lastError = String(err);
      logError("model load", err);
    } finally {
      this.loading = null;
    }
  }

  private async loadBackendModels(backend: BackendConfig): Promise<ModelInfo[]> {
    switch (backend.type) {
      case "devin":
        return this.loadDevinModels();
      case "claude":
        return this.loadClaudeModels(backend.config);
      case "codex":
        return this.loadCodexModels(backend.config);
      case "opencode":
        return this.loadOpenCodeModels(backend.config);
      case "openclaw":
        return this.loadOpenClawModels(backend.config);
      case "custom":
        return this.loadCustomModels(backend.config);
      default:
        return [];
    }
  }

  private async loadDevinModels(): Promise<ModelInfo[]> {
    const json = await runDevinModelsList();
    return parseModels(json);
  }

  private async loadClaudeModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    const injected = this.injectedModels.get("claude");
    if (injected && injected.length > 0) return injected;
    return [];
  }

  private async loadCodexModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    const injected = this.injectedModels.get("codex");
    if (injected && injected.length > 0) return injected;
    return [];
  }

  private async loadOpenCodeModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    try {
      const stdout = await runOpenCodeModelsList();
      return parseOpenCodeModels(stdout);
    } catch (err) {
      logError("opencode models load", err);
      return [];
    }
  }

  private async loadOpenClawModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    try {
      const stdout = await runOpenClawModelsList();
      return parseOpenClawModels(stdout);
    } catch (err) {
      logError("openclaw models load", err);
      return [];
    }
  }

  private async loadCustomModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    if (!config?.endpoint) return [];
    try {
      const models = await fetchOpenAICompatibleModels(config.endpoint, config.apiKey, config.id ?? "custom");
      return models;
    } catch (err) {
      logError("custom models load", err);
      return [];
    }
  }
}

function runDevinModelsList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("devin", ["models", "list", "--format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    proc.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("devin models list timeout"));
    }, 60000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`devin models list exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseModels(json: string): ModelInfo[] {
  const data = JSON.parse(json);
  const families = Array.isArray(data?.families) ? data.families : [];
  const models: ModelInfo[] = [];
  for (const f of families) {
    const variants = Array.isArray(f?.variants) ? f.variants : [];
    for (const v of variants) {
      const m: ModelInfo = {
        uid: String(v.model_uid ?? ""),
        label: String(v.label ?? ""),
        family: String(f.family_label ?? ""),
        familyUid: String(f.family_uid ?? ""),
        slug: String(f.slug ?? ""),
        aliases: Array.isArray(f.aliases) ? f.aliases.map(String) : [],
        costTier: String(v.cost_tier ?? ""),
        backend: "devin",
      };
      if (v.cost_summary !== undefined) m.costSummary = String(v.cost_summary);
      models.push(m);
    }
  }
  return models;
}

function runOpenCodeModelsList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["models", "--verbose"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    proc.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("opencode models timeout"));
    }, 30000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`opencode models exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOpenCodeModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const lines = stdout.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line || !/^[a-z]+\//.test(line)) { i++; continue; }
    const uid = line;
    i++;
    const jsonStart = lines.slice(i).findIndex((l) => l.trim().startsWith("{"));
    if (jsonStart < 0) break;
    i += jsonStart;
    let jsonStr = "";
    let depth = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      jsonStr += l + "\n";
      for (const ch of l) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0 && jsonStr.trim()) { i++; break; }
      i++;
    }
    try {
      const data = JSON.parse(jsonStr.trim());
      const provider = String(data.providerID ?? uid.split("/")[0] ?? "");
      const id = String(data.id ?? uid.split("/")[1] ?? "");
      const cost = data.cost;
      const costSummary = cost
        ? `$${Number(cost.input ?? 0) / 1_000_000}/1M in · $${Number(cost.output ?? 0) / 1_000_000}/1M out`
        : undefined;
      const tier = cost && (Number(cost.input) > 0 || Number(cost.output) > 0) ? "paid" : "free";
      models.push({
        uid,
        label: String(data.name ?? id),
        family: String(data.family ?? provider),
        familyUid: provider,
        slug: id,
        aliases: [],
        costTier: tier,
        ...(costSummary ? { costSummary } : {}),
        backend: "opencode",
      });
    } catch {
      // skip unparseable
    }
  }
  return models;
}

function runOpenClawModelsList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("openclaw", ["models", "list", "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    proc.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("openclaw models timeout"));
    }, 30000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`openclaw models list exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOpenClawModels(stdout: string): ModelInfo[] {
  const data = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> };
  const list = Array.isArray(data?.models) ? data.models : [];
  return list.map((m) => {
    const key = String(m.key ?? "");
    const [provider, ...rest] = key.split("/");
    const id = rest.join("/") || key;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    return {
      uid: key,
      label: String(m.name ?? id),
      family: String(provider ?? key),
      familyUid: String(provider ?? "").toLowerCase(),
      slug: id,
      aliases: [],
      costTier: tags.includes("default") ? "default" : "unknown",
      backend: "openclaw" as ModelBackend,
    };
  });
}

function parseConfigOptionsModels(configOptions: unknown[], backend: ModelBackend): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const opt of configOptions) {
    if (typeof opt !== "object" || opt === null) continue;
    const o = opt as Record<string, unknown>;
    if (o.id !== "model" || o.category !== "model") continue;
    const options = Array.isArray(o.options) ? o.options : [];
    for (const option of options) {
      if (typeof option !== "object" || option === null) continue;
      const op = option as Record<string, unknown>;
      const uid = String(op.value ?? "");
      if (!uid) continue;
      const label = String(op.name ?? uid);
      const family = String(op.family ?? backend);
      models.push({
        uid,
        label,
        family,
        familyUid: family.toLowerCase(),
        slug: uid,
        aliases: [],
        costTier: String(op.costTier ?? "unknown"),
        backend,
      });
    }
  }
  return models;
}

async function fetchOpenAICompatibleModels(
  endpoint: string,
  apiKey?: string,
  backendId?: string,
): Promise<ModelInfo[]> {
  const url = endpoint.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`custom API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { data?: Array<{ id: string; owned_by?: string }> };
  const list = Array.isArray(data?.data) ? data.data : [];
  return list.map((m) => {
    const uid = `custom/${m.id}`;
    const owner = String(m.owned_by ?? backendId ?? "custom");
    return {
      uid,
      label: String(m.id),
      family: owner,
      familyUid: owner.toLowerCase(),
      slug: String(m.id),
      aliases: [],
      costTier: "unknown",
      backend: "custom" as ModelBackend,
    };
  });
}
