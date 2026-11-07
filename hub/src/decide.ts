/**
 * decision-model 一期：auto 模式的廉价裁决层骨架。
 * 默认 shadow——并行给出裁决并落 ndjson 日志供标注/回放，编排行为零变化；
 * enforce（HUB_DECIDE_MODE=enforce）时无参模式+高置信可直执行，
 * 其余一切（低置信/超时/未配置/解析失败/conductor）fail-open 走主持人 LLM 现行路径。
 * 裁决词汇对齐 dsh 三档：explicit=确定性规则命中 / inferred=模型判 / ignore=不值得裁决。
 */
import { createHash } from "node:crypto";
import { logWarn } from "./logger.js";

export type DecideMode =
  | "self" | "mention" | "conductor" | "roundrobin" | "parallel" | "pipeline" | "debate";
const VALID_MODES = new Set(["self", "mention", "conductor", "roundrobin", "parallel", "pipeline", "debate"]);
/** 无参模式：廉价裁决可直接执行（conductor 需主持人拆任务，pipeline/debate 需参数，一律交回） */
export const DIRECT_MODES = new Set<DecideMode>(["self", "mention", "parallel", "roundrobin"]);
export const DECIDE_CONFIDENCE_MIN = 0.6;

export type DecideTier = "explicit" | "inferred" | "ignore";
export type DecideAction = "direct" | "host" | "skip";

export type DecideVerdict = {
  tier: DecideTier;
  mode?: DecideMode | undefined;
  confidence: number;
  action: DecideAction;
  via: "rule" | "model" | "off" | "error";
  reason: string;
  ms: number;
};

export type DecideInput = {
  roomId: string;
  text: string;
  members: { sessionId: string; name: string }[];
};

type DecideLogRec = Record<string, unknown>;

export class ModeDecider {
  constructor(
    private readonly opts: {
      model?: string | undefined;
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      timeoutMs?: number | undefined;
      /** enforce=true 才允许直执行；默认 false（shadow 纯记录） */
      enforce?: boolean | undefined;
      fetchImpl?: typeof fetch | undefined;
      /** 决策日志 sink（ndjson 追加），由调用方注入落盘策略 */
      log?: ((rec: DecideLogRec) => void) | undefined;
      now?: (() => number) | undefined;
    } = {},
  ) {}

  get configured(): boolean {
    return !!this.opts.model;
  }

  get enforced(): boolean {
    return this.opts.enforce === true;
  }

  /** 输入哈希：日志不落原文，回放时可定位同一输入 */
  static stateHash(input: DecideInput): string {
    const h = createHash("sha256");
    h.update(input.roomId);
    h.update("\0");
    h.update(input.text);
    for (const m of input.members) h.update(`\0${m.sessionId}:${m.name}`);
    return h.digest("hex").slice(0, 16);
  }

  /** 规则层：@成员 → explicit mention；明显闲聊/超短 → ignore（不值得起模型） */
  private ruleTier(input: DecideInput): DecideVerdict | undefined {
    const text = input.text.trim();
    for (const m of input.members) {
      const re = new RegExp(`@${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
      if (re.test(text)) {
        return {
          tier: "explicit", mode: "mention", confidence: 1,
          action: "direct", via: "rule", reason: `mention:@${m.name}`, ms: 0,
        };
      }
    }
    if (text.length < 4) {
      return { tier: "ignore", confidence: 0, action: "host", via: "rule", reason: "too-short", ms: 0 };
    }
    return undefined;
  }

  /** shadow/enforce 入口：返回裁决；任何不确定路径都 fail-open（action!=="direct"） */
  async decide(input: DecideInput): Promise<DecideVerdict> {
    const t0 = (this.opts.now ?? Date.now)();
    const rule = this.ruleTier(input);
    let v: DecideVerdict;
    if (rule) {
      v = rule;
    } else if (!this.opts.model) {
      v = { tier: "inferred", confidence: 0, action: "skip", via: "off", reason: "unconfigured", ms: 0 };
    } else {
      try {
        v = await this.modelJudge(input);
      } catch (err) {
        v = { tier: "inferred", confidence: 0, action: "host", via: "error", reason: String(err).slice(0, 120), ms: 0 };
      }
    }
    v.ms = (this.opts.now ?? Date.now)() - t0;
    // enforce 闸门：仅无参模式+阈值置信可 direct；其余一律交主持人
    if (
      v.action === "direct" &&
      !(this.opts.enforce && v.mode !== undefined && DIRECT_MODES.has(v.mode) && v.confidence >= DECIDE_CONFIDENCE_MIN)
    ) {
      v.action = "host";
    } else if (v.mode !== undefined && !DIRECT_MODES.has(v.mode)) {
      v.action = "host";
    }
    if (v.action !== "skip") this.opts.log?.({ kind: "decide", ...inputSummary(input), verdict: v });
    return v;
  }

  /** 主持人实际裁决回收：与 shadow 判决成对落日志，攒标注对 */
  recordHostOutcome(input: DecideInput, verdict: DecideVerdict | undefined, hostMode: string): void {
    this.opts.log?.({
      kind: "outcome",
      ...inputSummary(input),
      shadow: verdict ? { tier: verdict.tier, mode: verdict.mode, confidence: verdict.confidence, via: verdict.via } : null,
      hostMode,
      agree: verdict?.mode !== undefined && verdict.mode === hostMode,
    });
  }

  private async modelJudge(input: DecideInput): Promise<DecideVerdict> {
    const base = (this.opts.baseUrl ?? "http://127.0.0.1:8317/v1").replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const roster = input.members.map((m) => `${m.name}(id:${m.sessionId})`).join("、");
    const doFetch = this.opts.fetchImpl ?? fetch;
    const resp = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Route a group-chat message to a collaboration mode. " +
              "Modes: self(one member answers alone), mention(call out specific members), " +
              "parallel(all members answer independently), roundrobin(sequential turns), " +
              "pipeline(ordered stages), debate(two-sided review), conductor(decompose into subtasks). " +
              'Reply JSON only: {"mode":"...","confidence":0..1}. When unsure use confidence<0.6.',
          },
          { role: "user", content: `成员：${roster}\n消息：${input.text.slice(0, 800)}` },
        ],
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    });
    if (!resp.ok) throw new Error(`decide model http ${resp.status}`);
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (data.choices?.[0]?.message?.content ?? "").trim();
    const obj = JSON.parse(raw) as { mode?: unknown; confidence?: unknown };
    const mode = String(obj.mode ?? "").toLowerCase();
    const confidence = Number(obj.confidence ?? 0);
    if (!VALID_MODES.has(mode) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { tier: "inferred", confidence: 0, action: "host", via: "error", reason: `bad-verdict:${raw.slice(0, 80)}`, ms: 0 };
    }
    return {
      // 模型判一律 inferred——explicit 仅留给确定性规则命中，防标注集污染
      tier: "inferred",
      mode: mode as DecideMode,
      confidence,
      action: "direct",
      via: "model",
      reason: "model",
      ms: 0,
    };
  }
}

function inputSummary(input: DecideInput): Record<string, unknown> {
  return {
    at: Date.now(),
    roomId: input.roomId,
    stateHash: ModeDecider.stateHash(input),
    memberCount: input.members.length,
  };
}
