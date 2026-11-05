/** 成员可控文本净化：防 prompt 注入伪造保留行头 */

/** 换行类分隔符全集：CR/LF/U+2028/U+2029/NEL/U+0085/vtab/ff */
const BREAKS = /[\r\n\u2028\u2029\u0085\v\f]+/g;

/** 单行化：一切换行分隔符→空格，行首永不出现 - /用户消息：/[群聊 等保留行头 */
export const sanitizeInline = (t: string): string => t.replace(BREAKS, " ").trim();

/** 多行：分隔符归一为 \n，续行强制缩进 2 空格——行首无法伪造保留前缀 */
export const sanitizeBlock = (t: string): string =>
  t
    .replace(BREAKS, "\n")
    .split("\n")
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join("\n");
