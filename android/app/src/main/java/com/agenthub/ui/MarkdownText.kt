package com.agenthub.ui

import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon

private const val TAG_MARKWON = "markwon"

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    fontSize: TextUnit = MaterialTheme.typography.bodyLarge.fontSize,
) {
    val fontSizeSp = if (fontSize.isSp) fontSize.value else 16f
    AndroidView(
        factory = { ctx ->
            val markwon = Markwon.create(ctx)
            TextView(ctx).apply {
                setTextColor(textColor.toArgb())
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, fontSizeSp)
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                isClickable = false
                isLongClickable = false
                isFocusable = false
                tag = markwon
            }
        },
        update = { view ->
            val markwon = view.tag as Markwon
            markwon.setMarkdown(view, text)
        },
        modifier = modifier,
    )
}
