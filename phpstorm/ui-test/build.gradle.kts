// The UI tests of the plugin only: build.sh builds the plugin, and the tests install its zip.
plugins {
    kotlin("jvm") version "2.4.21"
}

repositories {
    mavenCentral()
    maven("https://www.jetbrains.com/intellij-repository/releases")
    maven("https://cache-redirector.jetbrains.com/intellij-dependencies")
}

// The Starter and Driver of the platform of the PhpStorm that run.sh downloads.
val starter = "262.12573.28"

dependencies {
    testImplementation("com.jetbrains.intellij.tools:ide-starter-squashed:$starter")
    testImplementation("com.jetbrains.intellij.tools:ide-starter-junit5:$starter")
    testImplementation("com.jetbrains.intellij.tools:ide-starter-driver:$starter")
    testImplementation("com.jetbrains.intellij.driver:driver-client:$starter")
    testImplementation("com.jetbrains.intellij.driver:driver-sdk:$starter")
    testImplementation("com.jetbrains.intellij.driver:driver-model:$starter")
    testImplementation("org.junit.jupiter:junit-jupiter:5.14.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("org.kodein.di:kodein-di-jvm:7.26.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.10.2")
}

kotlin {
    jvmToolchain(25)
}

tasks.test {
    useJUnitPlatform()
    systemProperty("ide", providers.gradleProperty("ide").get())
    systemProperty("plugin", providers.gradleProperty("plugin").get())
    systemProperty("repo", rootDir.resolve("../..").canonicalPath)
    outputs.upToDateWhen { false }
    testLogging { events("passed", "failed"); showStandardStreams = true; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
