package com.agenthub.ui

import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.BackgroundColorSpan
import android.view.View
import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.doOnLayout
import io.noties.markwon.Markwon
import java.util.regex.Pattern

private const val TAG_MARKWON = "markwon"

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    textColor: Color = MaterialTheme.colorScheme.onSurface,
    fontSize: TextUnit = MaterialTheme.typography.bodyLarge.fontSize,
    highlight: String = "",
    onMatchKeywordY: ((Float) -> Unit)? = null,
) {
    val fontSizeSp = if (fontSize.isSp) fontSize.value else 16f
    val highlightColor = Color(0xFFFFEB3B).copy(alpha = 0.7f).toArgb()
    val keywordOffset = remember { object { var value: Float? = null } }
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
            view.setTextColor(textColor.toArgb())
            markwon.setMarkdown(view, text)
            if (highlight.isNotBlank()) {
                val rendered = view.text
                val spannable = if (rendered is Spannable) {
                    rendered
                } else {
                    SpannableStringBuilder(rendered)
                }
                val pattern = Pattern.compile(Pattern.quote(highlight), Pattern.CASE_INSENSITIVE)
                val matcher = pattern.matcher(rendered)
                var firstMatchStart = -1
                while (matcher.find()) {
                    if (firstMatchStart == -1) firstMatchStart = matcher.start()
                    spannable.setSpan(
                        BackgroundColorSpan(highlightColor),
                        matcher.start(),
                        matcher.end(),
                        Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                    )
                }
                if (spannable !== view.text) {
                    view.setText(spannable, TextView.BufferType.SPANNABLE)
                }
                if (onMatchKeywordY != null && firstMatchStart >= 0) {
                    view.doOnLayout {
                        val layout = view.layout ?: return@doOnLayout
                        val line = layout.getLineForOffset(firstMatchStart)
                        val lineTop = layout.getLineTop(line)
                        keywordOffset.value = (view.totalPaddingTop + lineTop).toFloat()
                        val loc = IntArray(2)
                        view.getLocationInWindow(loc)
                        val y = (loc[1] + (keywordOffset.value ?: 0f)).toFloat()
                        android.util.Log.d("SearchScroll", "MarkdownText keywordY=$y")
                        onMatchKeywordY(y)
                    }
                } else {
                    keywordOffset.value = null
                }
            } else {
                keywordOffset.value = null
            }
        },
        modifier = modifier.onGloballyPositioned { coordinates ->
            val offset = keywordOffset.value
            if (offset != null && onMatchKeywordY != null) {
                val y = coordinates.positionInWindow().y + offset
                android.util.Log.d("SearchScroll", "MarkdownText keywordY=$y")
                onMatchKeywordY(y)
            }
        },
    )
}
