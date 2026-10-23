
import org.jetbrains.changelog.markdownToHTML

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.20"
    id("org.jetbrains.intellij.platform") version "2.10.2"
    id("org.jetbrains.changelog") version "2.2.1"
}

group = "org.netrexx"
version = "1.0.5"

repositories {
    maven {
        url = uri("https://plugins.jetbrains.com/maven")
    }
//    maven { url = uri("https://mvn.falsepattern.com/releases/") }

    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }

}

// Read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
dependencies {
    implementation(files("lib/NetRexxC.jar"))

    compileOnly("com.jetbrains.plugins:com.redhat.devtools.lsp4ij:0.19.1")
    intellijPlatform {
        intellijIdea("2025.3.1")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
        plugin("com.redhat.devtools.lsp4ij", "0.19.1")
        bundledPlugin("org.jetbrains.plugins.textmate")   // ships with the IDE, just needs declaring
        // Add plugin dependencies for compilation here:
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "252.25557"
        }
        description = providers.fileContents(layout.projectDirectory.file("README.md")).asText.map {
            val start = "<!-- Plugin description -->"
            val end = "<!-- Plugin description end -->"

            with(it.lines()) {
                if (!containsAll(listOf(start, end))) {
                    throw GradleException("Plugin description section not found in README.md:\n$start ... $end")
                }
                subList(indexOf(start) + 1, indexOf(end)).joinToString("\n").let(::markdownToHTML)
            }
        }

        changeNotes = """
          <ul>  
            <li>Updated LSP server</li>
            <li>Added DAP server</li>
            <li>Added TextMate syntax highlighting</li>
          </ul>  
        """.trimIndent()
    }
}

val nrxSourceDir = file("src/main/nrx")
val nrxOutputDir = layout.buildDirectory.dir("classes/nrx/main")

// NetRexxC compiles files sequentially, not as a two-pass batch like javac — a class that
// references another class's static final field (e.g. NetRexxFileType needs
// NetRexxLanguage.INSTANCE) will fail with a "forward reference" error unless the class it
// depends on was compiled earlier in the same invocation. List dependency-order-sensitive
// files explicitly rather than relying on directory/alphabetical order; anything not listed
// here is appended afterward, sorted, since it has no known ordering constraint yet.
val nrxCompileOrder = listOf(
    "NetRexxLanguage.nrx",            // defines NetRexxLanguage.INSTANCE
    "NetRexxFileType.nrx",            // references NetRexxLanguage.INSTANCE
    "NetRexxSettingsService.nrx",     // defines NetRexxSettingsService.State
    "NetRexxLspServerLauncher.nrx",   // references NetRexxSettingsService.State
    "NetRexxConfigurable.nrx",        // references NetRexxSettingsService.State
    "NetRexxLspServerLauncherFactory.nrx",
    "NetRexxLspControlService.nrx",
    "NetRexxDapServerLauncher.nrx",
    "NetRexxDapServerLauncherFactory.nrx",
    "NetRexxDapSettingsEditor.nrx",
    "NetRexxDapConfigurationType.nrx",
    "NetRexxDapConfigurationFactory.nrx",
    "NetRexxDapConfiguration.nrx",
)

val compileNetRexx by tasks.registering(JavaExec::class) {
    group = "buildPlugin"
    description = "Compile NetRexx (.nrx) sources directly to .class files"

    // Resolve everything to plain, already-computed values right here, at configuration
    // time, as local vals — not wrapped in provider{}/argumentProviders lambdas. Those
    // lambdas implicitly capture the whole build script instance in a .kts file, which the
    // configuration cache refuses to serialize ("cannot serialize Gradle script object
    // references"). Plain List<String>/FileCollection properties don't have that problem.
    val compilerJar = file("lib/NetRexxC.jar")
    val runtimeClasspath = files(compilerJar) + sourceSets.main.get().compileClasspath
    val allNrxFiles = nrxSourceDir.walkTopDown().filter { it.extension == "nrx" }.toList()
    val orderedNrxFiles = nrxCompileOrder.mapNotNull { name -> allNrxFiles.find { it.name == name } } +
        allNrxFiles.filterNot { it.name in nrxCompileOrder }.sortedBy { it.name }
    val outputDir = nrxOutputDir.get().asFile

    inputs.dir(nrxSourceDir)
    outputs.dir(nrxOutputDir)

    classpath = runtimeClasspath
    mainClass.set("org.netrexx.process.NetRexxC")

    // NetRexxC has no -d/destination flag: it writes .class files into the current
    // working directory, but — unlike javac — it does NOT nest them into org/netrexx/
    // subdirectories matching the package statement; it drops them flat (confirmed:
    // NetRexxLanguage.class ends up directly in outputDir, not outputDir/org/netrexx/).
    // A flat .class file at the wrong path is invisible to any classloader looking for
    // org.netrexx.NetRexxLanguage, so we relocate everything into the correct package
    // directory ourselves once compilation finishes.
    doFirst {
        outputDir.mkdirs()
    }
    workingDir = outputDir

    args = listOf(
        "-classpath", runtimeClasspath.asPath,
        "-compile",   // compile straight through to .class (no intermediate .java kept)
        "-warnexit0",
        "-replace"    // overwrite previously compiled output
    ) + orderedNrxFiles.map { it.absolutePath }

    doLast {
        val packageDir = File(outputDir, "org/netrexx")
        packageDir.mkdirs()
        outputDir.listFiles { f -> f.isFile && f.extension == "class" }?.forEach { classFile ->
            classFile.copyTo(File(packageDir, classFile.name), overwrite = true)
            classFile.delete()
        }
    }
}

sourceSets {
    main {
        // No .java sources at all anymore — everything lives in src/main/nrx now. Clearing
        // this explicitly means compileJava has nothing to compile even if a stray .java
        // file ever ends up back under src/main/java, so build/classes/java/main stays
        // genuinely empty rather than silently picking up duplicate/stale sources.
        java.setSrcDirs(emptyList<String>())
        // fold the NetRexx-compiled classes into the same output the jar/plugin packaging picks up
        output.dir(mapOf("builtBy" to compileNetRexx), nrxOutputDir)
    }
}

tasks {
    // Set the JVM compatibility versions
    withType<JavaCompile> {
        sourceCompatibility = "21"
        targetCompatibility = "21"
    }

    named<JavaCompile>("compileJava") {
        dependsOn(compileNetRexx)
    }

    named("jar") {
        dependsOn(compileNetRexx)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}
