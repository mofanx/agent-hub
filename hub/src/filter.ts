/**
 * nano 相关性过滤：auto/mention 广播唤起前的廉价预过滤。
 * 规则层先行，uncertain 时才走可选轻量模型档（HUB_FILTER_MODEL）。
 */
import { logWarn } from "./logger.js";

export type FilterVerdict = "relevant" | "chatter" | "uncertain";

/** 任务信号：问号、斜杠命令、中英动词/任务词 */
const TASK_SIGNAL =
  /[?？]|\/\w+|做|写|改|修|查|看|跑|测|审|译|算|找|搜|读|列|删|建|装|搬|发|回答|回复|部署|实现|检查|分析|总结|翻译|解释|评估|生成|创建|更新|对比|帮|请|告诉|说明|设计|重构|优化|排查|执行|运行|安装|配置|提交|合并|推送|下载|打开|关闭|讨论|review|fix|write|build|run|test|check|list|show|explain|analyze|implement|create|update|delete|search|deploy|commit|merge|push|help|please/i;

/** 整句寒暄/敷衍应答（全匹配） */
const GREETING =
  /^\s*(?:你\s*好|您\s*好|hi+|hello+|hey+|yo|喂|在吗|在么|早|早上好|上午好|下午好|晚上好|早安|晚安|谢谢|谢啦|谢了|多谢|thanks|thank\s*you|thx|ok+|okay|okk+|好的|好哒|好嘞|嗯+|恩+|哦+|哦哦|啊|哈+|嘿|lol+|lmao|haha+|bye+|拜拜|再见|收到|行|可以|加油|辛苦|辛苦了|是的|对啊|没错|不|不了|算了|没事|随便)[\s~!！?？。.…、,，·]*$/i;

/** 是否含任何字母/数字/中日韩文字（没有则视为纯表情/符号） */
const WORD_CHAR = /[A-Za-z0-9\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * 规则分类：
 * - chatter：纯表情/符号、整句寒暄、<8 字符且无任何任务信号
 * - uncertain：8~31 字符、无问号/动词/任务词（可选模型档兜底；未配置默认放行）
 * - relevant：其余一律相关（含 >=32 字符的实质消息、含任务信号、/@/命令）
 */
export function classifyUtterance(text: string): FilterVerdict {
  const t = text.trim();
  if (!t) return "chatter";
  if (!WORD_CHAR.test(t)) return "chatter";
  if (GREETING.test(t)) return "chatter";
  if (TASK_SIGNAL.test(t)) return "relevant";
  if (t.length >= 32) return "relevant";
  if (t.length < 8) return "chatter";
  return "uncertain";
}

export type FilterResult = {
  relevant: boolean;
  via: "off" | "rule" | "model";
  reason: string;
};

export class RelevanceFilter {
  constructor(
    private readonly opts: {
      enabled?: boolean;
      model?: string | undefined;
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
    } = {},
  ) {}

  get enabled(): boolean {
    return this.opts.enabled !== false;
  }

  get modelConfigured(): boolean {
    return !!this.opts.model;
  }

  async isRelevant(text: string): Promise<FilterResult> {
    if (!this.enabled) return { relevant: true, via: "off", reason: "disabled" };
    const verdict = classifyUtterance(text);
    if (verdict === "relevant") {
      return { relevant: true, via: "rule", reason: "task-signal" };
    }
    if (verdict === "chatter") {
      return { relevant: false, via: "rule", reason: "chatter" };
    }
    if (!this.opts.model) {
      return { relevant: true, via: "rule", reason: "uncertain-pass" };
    }
    try {
      const ok = await this.modelJudge(text);
      return { relevant: ok, via: "model", reason: ok ? "model:relevant" : "model:filtered" };
    } catch (err) {
      logWarn("filter", `model judge failed, pass through: ${String(err)}`);
      return { relevant: true, via: "model", reason: "model-error" };
    }
  }

  /** OpenAI 兼容 chat 端点的 isRelevant 布尔判定；仅 uncertain 档位触发 */
  private async modelJudge(text: string): Promise<boolean> {
    const base = (this.opts.baseUrl ?? "http://127.0.0.1:8317/v1").replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        max_tokens: 4,
        messages: [
          {
            role: "system",
            content:
              "Judge whether the user message requests work/information or is mere chit-chat. Reply with exactly YES (needs an answer/task) or NO (chit-chat).",
          },
          { role: "user", content: text.slice(0, 500) },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`filter model http ${resp.status}`);
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const out = (data.choices?.[0]?.message?.content ?? "").trim();
    return /^(yes|y|是|true)/i.test(out);
  }
}
