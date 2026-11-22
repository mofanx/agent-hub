import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../../desktop/src/hub/markdown.js";

const labels = { copy: "Copy", copied: "Copied" };

test("markdown escapes raw html blocks", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>', labels);
  assert.doesNotMatch(out, /<img[^>]*onerror/i);
  assert.match(out, /&lt;img/);
});

test("markdown escapes script tags", () => {
  const out = renderMarkdown("<script>alert(1)</script>", labels);
  assert.doesNotMatch(out, /<script/);
});

test("markdown blocks javascript: links", () => {
  const out = renderMarkdown("[x](javascript:alert(1))", labels);
  assert.doesNotMatch(out, /href="javascript:/i);
});

test("markdown blocks javascript: images", () => {
  const out = renderMarkdown("![a](javascript:x)", labels);
  assert.doesNotMatch(out, /src="javascript:/i);
});

test("markdown keeps safe https links", () => {
  const out = renderMarkdown("[ok](https://a.com)", labels);
  assert.match(out, /href="https:\/\/a\.com"/);
});

test("markdown renders emphasis", () => {
  const out = renderMarkdown("**b**", labels);
  assert.match(out, /<strong>b<\/strong>/);
});

test("markdown fenced code gets copy button", () => {
  const out = renderMarkdown("```ts\nconst a = 1;\n```", labels);
  assert.match(out, /class="code-block"/);
  assert.match(out, /Copy/);
});

test("markdown tables get table-wrap", () => {
  const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", labels);
  assert.match(out, /table-wrap/);
});

test("markdown escapes inline html", () => {
  const out = renderMarkdown("a <b>x</b> c", labels);
  assert.doesNotMatch(out, /<b>x<\/b>/);
  assert.match(out, /&lt;b&gt;/);
});

test("markdown renders #path as file pill", () => {
  const out = renderMarkdown("改下 #src/foo/bar.ts 这里", labels);
  assert.match(out, /<span class="file-pill" data-path="src\/foo\/bar\.ts">#src\/foo\/bar\.ts<\/span>/);
});

test("markdown file pill strips trailing slash at CJK boundary", () => {
  const out = renderMarkdown("看 #dir/sub/ 。", labels);
  assert.match(out, /data-path="dir\/sub"/);
});

test("markdown file pill escapes quotes in path", () => {
  const out = renderMarkdown('#a"<b>', labels);
  assert.doesNotMatch(out, /data-path="[^"]*</);
  assert.match(out, /data-path="a&quot;&lt;b&gt;/);
});

test("markdown allows data:image inline images", () => {
  const out = renderMarkdown("![a](data:image/png;base64,iVBOR)", labels);
  assert.match(out, /<img src="data:image\/png;base64,iVBOR"/);
});

test("markdown still blocks data:text/html in images and links", () => {
  const img = renderMarkdown("![a](data:text/html;base64,PHN2Zz4=)", labels);
  assert.doesNotMatch(img, /<img src="data:/);
  const link = renderMarkdown("[x](data:text/html,<svg>)", labels);
  assert.doesNotMatch(link, /href="data:/);
});

test("markdown allows svg data uri in img but blocks it in link href", () => {
  const img = renderMarkdown("![m](data:image/svg+xml;base64,PHN2Zz4=)", labels);
  assert.match(img, /<img src="data:image\/svg\+xml/);
  const svg = renderMarkdown("[x](data:image/svg+xml,<svg onload=alert(1)>)", labels);
  assert.doesNotMatch(svg, /href="data:/);
  const png = renderMarkdown("[x](data:image/png;base64,iVBOR)", labels);
  assert.doesNotMatch(png, /href="data:/);
});
