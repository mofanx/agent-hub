import { Marked } from "marked";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(href: string, image = false): boolean {
  const t = href.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return true;
  if (/^(?:https?|mailto):/i.test(t)) return true;
  // data: 仅放行 <img> 上下文——img 加载的 svg 脚本不执行；<a href> 顶层导航可执行，全拦
  return image && /^data:image\//i.test(t);
}

const fileRefExt = {
  name: "fileRef",
  level: "inline" as const,
  start(src: string) {
    const m = src.match(/(?:^|[\s（(，,;；:：])#(?=[^#\s])/);
    return m ? (m.index ?? 0) + m[0]!.length - 1 : -1;
  },
  tokenizer(src: string) {
    const rule = /^#([^#\s][^\s，,;；。!！?？\)\]\n]*)/;
    const match = rule.exec(src);
    if (match) {
      return { type: "fileRef", raw: match[0], path: match[1]!.replace(/\/+$/, "") };
    }
    return undefined;
  },
  renderer(token: { raw: string; path: string }) {
    return `<span class="file-pill" data-path="${escapeHtml(token.path)}">${escapeHtml(token.raw)}</span>`;
  },
};

const md = new Marked({
  gfm: true,
  extensions: [fileRefExt as never],
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, token: { href: string; title?: string | null; tokens: unknown[] }) {
      const text = this.parser.parseInline(token.tokens);
      const href = token.href;
      if (!isSafeUrl(href)) return text;
      let out = `<a href="${escapeHtml(href)}"`;
      if (token.title) out += ` title="${escapeHtml(token.title)}"`;
      return out + ">" + text + "</a>";
    },
    image(this: { parser: { parseInline(tokens: unknown[], renderer?: unknown): string; textRenderer?: unknown } }, token: { href: string; title?: string | null; text: string; tokens?: unknown[] }) {
      let text = token.text;
      if (token.tokens) text = this.parser.parseInline(token.tokens, this.parser.textRenderer);
      if (!isSafeUrl(token.href, true)) return escapeHtml(text);
      let out = `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(text)}"`;
      if (token.title) out += ` title="${escapeHtml(token.title)}"`;
      return out + ">";
    },
  } as never,
});

export function renderMarkdown(text: string, labels: { copy: string; copied: string }): string {
  try {
    const html = md.parse(text) as string;
    const withScrollableTables = html
      .replace(/<table([^>]*)>/g, '<div class="table-wrap"><table$1>')
      .replace(/<\/table>/g, "</table></div>");
    const copyLabel = JSON.stringify(labels.copy);
    const copiedLabel = JSON.stringify(labels.copied);
    return withScrollableTables
      .replace(
        /<pre><code/g,
        `<div class="code-block"><button class="copy-code" title="${escapeHtml(labels.copy)}" onclick='const n=this.nextElementSibling;if(n){navigator.clipboard.writeText(n.textContent).catch(()=>{});this.textContent=${copiedLabel};setTimeout(()=>this.textContent=${copyLabel},1500)}'>${escapeHtml(labels.copy)}</button><pre><code`,
      )
      .replace(/<\/code><\/pre>/g, "</code></pre></div>");
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
  }
}
