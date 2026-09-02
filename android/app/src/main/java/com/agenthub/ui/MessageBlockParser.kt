package com.agenthub.ui

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.MarkdownParser

enum class MessageBlockType {
    Paragraph,
    Heading,
    Code,
    List,
    Table,
    Quote,
    Rule,
    Html,
    Other,
}

/** 按 Markdown 顶层块元素切分后的段落。 */
data class MessageBlock(
    val text: String,
    val type: MessageBlockType,
    val index: Int,
    val isFirst: Boolean,
    val isLast: Boolean,
)

/** 用 org.intellij.markdown 把 Markdown 文本按顶层块级节点切成若干块。 */
fun splitMessageBlocks(text: String): List<MessageBlock> {
    if (text.isBlank()) {
        return listOf(MessageBlock(text, MessageBlockType.Other, 0, true, true))
    }

    val parser = MarkdownParser(GFMFlavourDescriptor())
    val root = parser.parse(MarkdownElementTypes.MARKDOWN_FILE, text, true)

    val children = root.children
    val blocks = mutableListOf<MessageBlock>()
    var idx = 0

    for (child in children) {
        val blockText = text.substring(child.startOffset, child.endOffset)
        if (blockText.isBlank()) continue

        val type = child.toBlockType()
        blocks.add(MessageBlock(blockText, type, idx, false, false))
        idx++
    }

    if (blocks.isEmpty()) {
        return listOf(MessageBlock(text, MessageBlockType.Other, 0, true, true))
    }

    val merged = blocks.mergeShortBlocks()
    return merged.mapIndexed { i, block ->
        block.copy(index = i, isFirst = i == 0, isLast = i == merged.lastIndex)
    }
}

private const val MERGE_MAX_CHARS = 1200
private const val MERGE_MAX_LINES = 24

private fun MessageBlockType.isMergeable(): Boolean {
    return this == MessageBlockType.Paragraph ||
        this == MessageBlockType.Heading ||
        this == MessageBlockType.List ||
        this == MessageBlockType.Other
}

private fun canMerge(a: MessageBlock, b: MessageBlock): Boolean {
    val combinedChars = a.text.length + b.text.length + 2
    val combinedLines = a.text.lines().size + b.text.lines().size
    return combinedChars <= MERGE_MAX_CHARS && combinedLines <= MERGE_MAX_LINES
}

private fun mergeType(a: MessageBlockType, b: MessageBlockType): MessageBlockType {
    return if (a == b) a else MessageBlockType.Paragraph
}

private fun List<MessageBlock>.mergeShortBlocks(): List<MessageBlock> {
    if (isEmpty()) return this
    val result = mutableListOf<MessageBlock>()
    var current: MessageBlock? = null
    for (block in this) {
        val acc = current
        if (acc == null) {
            current = block
        } else if (acc.type.isMergeable() && block.type.isMergeable() && canMerge(acc, block)) {
            current = acc.copy(
                text = "${acc.text}\n\n${block.text}",
                type = mergeType(acc.type, block.type),
                isLast = block.isLast,
            )
        } else {
            result.add(acc)
            current = block
        }
    }
    current?.let { result.add(it) }
    return result
}

private fun ASTNode.toBlockType(): MessageBlockType {
    return when (type) {
        MarkdownElementTypes.PARAGRAPH -> MessageBlockType.Paragraph
        MarkdownElementTypes.CODE_FENCE,
        MarkdownElementTypes.CODE_BLOCK -> MessageBlockType.Code
        MarkdownElementTypes.UNORDERED_LIST,
        MarkdownElementTypes.ORDERED_LIST -> MessageBlockType.List
        MarkdownElementTypes.BLOCK_QUOTE -> MessageBlockType.Quote
        MarkdownElementTypes.ATX_1,
        MarkdownElementTypes.ATX_2,
        MarkdownElementTypes.ATX_3,
        MarkdownElementTypes.ATX_4,
        MarkdownElementTypes.ATX_5,
        MarkdownElementTypes.ATX_6,
        MarkdownElementTypes.SETEXT_1,
        MarkdownElementTypes.SETEXT_2 -> MessageBlockType.Heading
        MarkdownTokenTypes.HORIZONTAL_RULE -> MessageBlockType.Rule
        MarkdownElementTypes.HTML_BLOCK -> MessageBlockType.Html
        GFMElementTypes.TABLE -> MessageBlockType.Table
        else -> MessageBlockType.Other
    }
}
