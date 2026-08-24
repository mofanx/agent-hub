import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { logError } from "./logger.js";

export type ModelBackend = "devin" | "claude" | "codex" | "opencode" | "custom";

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
const HUB_BACKENDS_PATH = path.join(HUB_CONFIG_DIR, "backends.json");
const ACP_MODEL_PATH = path.join(homedir(), ".config/devin/acp-model.json");
const CONFIG_PATH = path.join(homedir(), ".config/devin/config.json");

export class ModelManager {
  private all: ModelInfo[] | null = null;
  private backends: BackendConfig[] = [];
  private loading: Promise<void> | null = null;
  private lastError: string | null = null;

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
   * 优先级：agent-hub 偏好 > acp-model.json（兼容旧版） > config.json
   */
  current(): { uid: string; label?: string } {
    if (existsSync(HUB_MODEL_PREF_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(HUB_MODEL_PREF_PATH, "utf8"));
        if (raw.model) return { uid: String(raw.model) };
      } catch {
        // fallthrough
      }
    }
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
    return { uid: "swe-1-7" };
  }

  /** 切换到指定模型，写入 agent-hub 自己的配置（不侵入 Agent 配置） */
  async set(name: string): Promise<ModelInfo> {
    await this.list();
    const match = this.find(name);
    if (!match) throw new Error(`unknown model: ${name}`);
    this.writeModelPreference(match.uid);
    return match;
  }

  /** 强制刷新模型列表缓存 */
  async refresh(): Promise<ModelInfo[]> {
    this.all = null;
    this.loading = null;
    return this.list();
  }

  lastLoadError(): string | null {
    return this.lastError;
  }

  private writeModelPreference(model: string): void {
    if (!existsSync(HUB_CONFIG_DIR)) mkdirSync(HUB_CONFIG_DIR, { recursive: true });
    writeFileSync(
      HUB_MODEL_PREF_PATH,
      JSON.stringify({ model, updatedAt: Date.now() }, null, 2),
    );
  }

  private loadBackends(): void {
    if (this.backends.length > 0) return;
    const defaults: BackendConfig[] = [
      { id: "devin", name: "Devin", type: "devin", enabled: true },
      { id: "claude", name: "Claude Code", type: "claude", enabled: false },
      { id: "codex", name: "Codex", type: "codex", enabled: false },
      { id: "opencode", name: "OpenCode", type: "opencode", enabled: false },
    ];
    if (existsSync(HUB_BACKENDS_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(HUB_BACKENDS_PATH, "utf8"));
        this.backends = Array.isArray(raw) ? raw : defaults;
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
    // TODO: 实现 Claude Code 模型列表获取
    // 可能通过 Anthropic API 或 Claude Code CLI
    return [
      {
        uid: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        family: "Claude",
        familyUid: "claude",
        slug: "claude-sonnet-4",
        aliases: ["sonnet-4", "claude-3-5-sonnet"],
        costTier: "med",
        costSummary: "$3 / 1M Input · $15 / 1M Output",
        backend: "claude",
      },
      {
        uid: "claude-opus-4-20250514",
        label: "Claude Opus 4",
        family: "Claude",
        familyUid: "claude",
        slug: "claude-opus-4",
        aliases: ["opus-4", "claude-3-5-opus"],
        costTier: "high",
        costSummary: "$15 / 1M Input · $75 / 1M Output",
        backend: "claude",
      },
    ];
  }

  private async loadCodexModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    // TODO: 实现 Codex 模型列表获取
    return [
      {
        uid: "codex-gpt-4-turbo",
        label: "Codex GPT-4 Turbo",
        family: "OpenAI",
        familyUid: "openai",
        slug: "codex-gpt-4-turbo",
        aliases: ["gpt-4-turbo"],
        costTier: "med",
        costSummary: "$0.01 / 1K tokens",
        backend: "codex",
      },
    ];
  }

  private async loadOpenCodeModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    // TODO: 实现 OpenCode 模型列表获取
    return [
      {
        uid: "opencode-gpt-4",
        label: "OpenCode GPT-4",
        family: "OpenAI",
        familyUid: "openai",
        slug: "opencode-gpt-4",
        aliases: ["gpt-4"],
        costTier: "med",
        costSummary: "$0.03 / 1K tokens",
        backend: "opencode",
      },
    ];
  }

  private async loadCustomModels(config?: Record<string, string>): Promise<ModelInfo[]> {
    // 支持通过 cc-switch 等方式接入的自定义模型
    // 配置可能包含 API endpoint、API key 等
    if (!config?.endpoint) return [];
    
    try {
      // 这里可以调用自定义 API 获取模型列表
      // 示例：通过 cc-switch 或直接调用 OpenAI 兼容 API
      const id = config.id ?? "custom";
      return [
        {
          uid: `custom-${id}`,
          label: config.name || "Custom Model",
          family: "Custom",
          familyUid: "custom",
          slug: id,
          aliases: [],
          costTier: "free",
          costSummary: "Custom API",
          backend: "custom",
        },
      ];
    } catch {
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
