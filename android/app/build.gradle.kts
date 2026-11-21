import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Release signing. The keystore lives outside the repo and its password is in
// the macOS Keychain; build-release.sh reads it into these env vars. Without
// them the release build is left unsigned rather than failing.
val ksFile = System.getenv("CHITRAM_KEYSTORE")
    ?: "${System.getProperty("user.home")}/Documents/Projects/local/chitram-android/release.jks"
val ksPass: String? = System.getenv("CHITRAM_KS_PASS")

android {
    namespace = "com.chitram.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.chitram.app"
        minSdk = 25
        targetSdk = 35
        versionCode = 52
        versionName = "1.2.39"
        // Only ship the locales and densities we use.
        resourceConfigurations += listOf("en")
    }

    // Fire TV's home row draws android:banner (wide 16:9), NOT android:icon.
    // Working apps (incl. sideloaded com.home.yt) all pair a SQUARE icon with a
    // wide banner; a wide icon gets squeezed into the square icon slot = the
    // compressed tile. So one square mipmap/ic_launcher + one drawable/banner
    // serve both phone and TV. No product flavors.
    signingConfigs {
        create("release") {
            if (ksPass != null && File(ksFile).exists()) {
                storeFile = File(ksFile)
                storePassword = ksPass
                keyAlias = "chitram"
                keyPassword = ksPass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (ksPass != null) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // minSdk 25 (Fire OS 6 is Android 7.1, API 25): java.util.Base64 (CastleResolver)
        // is API 26. Without desugaring it throws NoClassDefFoundError, an Error that
        // escapes the resolvers' catch (e: Exception) and kills the app on Play.
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += listOf("/META-INF/{AL2.0,LGPL2.1}", "DebugProbesKt.bin", "kotlin-tooling-metadata.json")
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    // R8 keeps only the icons the app uses.
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.tv:tv-material:1.0.0")

    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("io.coil-kt:coil-compose:2.7.0")

    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
