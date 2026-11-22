package com.agenthub

import android.util.Log
import android.os.SystemClock

internal object PerfTrace {
    fun mark(event: String, extra: String = "") {
        Log.i("AHPERF", "$event t=${SystemClock.elapsedRealtime()} $extra")
    }
}
