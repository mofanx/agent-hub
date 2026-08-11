package com.agenthub.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.TextUnit
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    fontSize: TextUnit = MaterialTheme.typography.bodyLarge.fontSize,
    highlight: String = "",
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    if (highlight.isNotBlank()) {
        HighlightText(
            text = text,
            highlight = highlight,
            style = TextStyle(fontSize = fontSize, color = textColor),
            color = textColor,
            modifier = modifier,
            onMatchKeywordY = onMatchKeywordY,
        )
    } else {
        val style = TextStyle(fontSize = fontSize, color = textColor)
        Markdown(
            content = text,
            modifier = modifier,
            colors = markdownColor(text = textColor),
            typography = markdownTypography(text = style),
        )
    }
}
