import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { logError } from "./logger.js";

export type ModelInfo = {
  uid: string;
  label: string;
  family: string;
  familyUid: string;
  slug: string;
  aliases: string[];
  costTier: string;
  costSummary?: string;
};

const ACP_MODEL_PATH = path.join(homedir(), ".config/devin/acp-model.json");
const CONFIG_PATH = path.join(homedir(), ".config/devin/config.json");

export class ModelManager {
  private all: ModelInfo[] | null = null;
  private loading: Promise<void> | null = null;
  private lastError: string | null = null;

  /** 返回可用模型列表，首次调用会拉取并缓存 */
  async list(): Promise<ModelInfo[]> {
    if (this.all) return this.all;
    if (!this.loading) this.loading = this.load();
    await this.loading;
    return this.all ?? [];
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

  /** 当前生效的模型 uid，优先 acp-model.json，再回退 config.json */
  current(): { uid: string; label?: string } {
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

  /** 切换到指定模型，写入 acp-model.json */
  async set(name: string): Promise<ModelInfo> {
    await this.list();
    const match = this.find(name);
    if (!match) throw new Error(`unknown model: ${name}`);
    this.writeAcpModel(match.uid);
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

  private writeAcpModel(model: string): void {
    const dir = path.dirname(ACP_MODEL_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      ACP_MODEL_PATH,
      JSON.stringify({ model, updatedAt: Date.now() }, null, 2),
    );
  }

  private async load(): Promise<void> {
    try {
      const json = await runDevinModelsList();
      const parsed = parseModels(json);
      this.all = parsed;
      this.lastError = null;
      console.log(`[model] loaded ${parsed.length} models`);
    } catch (err) {
      this.lastError = String(err);
      logError("model load", err);
    } finally {
      this.loading = null;
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
      };
      if (v.cost_summary !== undefined) m.costSummary = String(v.cost_summary);
      models.push(m);
    }
  }
  return models;
}
