# ---------------------------------------------------------------------------
# Caderno de Cuidado — R8 (regras A1/A2 das Regras.txt)
# ---------------------------------------------------------------------------

# A2: stack traces desofuscáveis (o mapping.txt também vai dentro do AAB).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor descobre métodos de plugin por reflexão (@PluginMethod).
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}

# Plugins deste app: poucas classes, mantê-las é barato e evita surpresa em
# runtime quando o bridge resolve o nome do plugin.
-keep class caderno.decuidado.app.** { *; }

# WebView + JavaScript interface (o app não expõe @JavascriptInterface, mas o
# Capacitor usa addWebViewAssetLoader e classes de bridge que o R8 já cobre.
-dontwarn org.apache.commons.**
-dontwarn org.json.**
