package com.chitram.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
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
        // The app is always dark: light status and navigation bar icons on any
        // system theme (the default follows the system and drew dark icons).
        if (!app.isTv) enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(0xFF06070C.toInt()), // 3-button nav otherwise got a light scrim
        )
        setContent {
            // No first-run language picker: a new install starts with every
            // language (Telugu first) and opens Home. Languages tab changes them.
            val nav = remember { app.prefs.seedDefault(); Nav(Screen.Home) }
            if (app.isTv) TvApp(nav) else PhoneApp(nav)
        }
    }
}
