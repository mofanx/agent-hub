package com.agenthub.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownAnimations
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.rememberMarkdownState
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor

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
        val baseSp = fontSize.value

        val h1 = style.copy(fontSize = (baseSp * 1.5).sp)
        val h2 = style.copy(fontSize = (baseSp * 1.35).sp)
        val h3 = style.copy(fontSize = (baseSp * 1.2).sp)
        val h4 = style.copy(fontSize = (baseSp * 1.1).sp)
        val h5 = style.copy(fontSize = (baseSp * 1.05).sp)
        val h6 = style.copy(fontSize = baseSp.sp)

        val code = style.copy(fontSize = (baseSp * 0.9).sp)
        val inlineCode = style.copy(fontSize = (baseSp * 0.9).sp)

        val markdownState = rememberMarkdownState(
            content = text,
            lookupLinks = true,
            retainState = true,
            immediate = false,
            flavour = GFMFlavourDescriptor(),
        )

        Markdown(
            markdownState = markdownState,
            modifier = modifier,
            colors = markdownColor(text = textColor),
            typography = markdownTypography(
                text = style,
                h1 = h1,
                h2 = h2,
                h3 = h3,
                h4 = h4,
                h5 = h5,
                h6 = h6,
                code = code,
                inlineCode = inlineCode,
                table = style,
            ),
            dimens = markdownDimens(
                tableMaxWidth = Dp.Infinity,
                tableCellWidth = 120.dp,
                tableCellPadding = 8.dp,
            ),
            animations = markdownAnimations(
                animateTextSize = { this },
            ),
            loading = {
                Text(text, modifier = it, style = style, color = textColor)
            },
        )
    }
}
