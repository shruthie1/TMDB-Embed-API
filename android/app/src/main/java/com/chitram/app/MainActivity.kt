package com.chitram.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import com.chitram.app.ui.common.Nav
import com.chitram.app.ui.common.Screen
import com.chitram.app.ui.phone.PhoneApp
import com.chitram.app.ui.tv.TvApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as App
        if (!app.isTv) enableEdgeToEdge()
        setContent {
            // First run asks for languages (with Skip), as on the web.
            val nav = remember { Nav(if (app.prefs.hasPrefs()) Screen.Home else Screen.Langs(firstRun = true)) }
            if (app.isTv) TvApp(nav) else PhoneApp(nav)
        }
    }
}
