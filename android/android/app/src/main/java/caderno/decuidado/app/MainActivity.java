package caderno.decuidado.app;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DrivePlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(Color.parseColor("#F7F5EE")));
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        // Abaixo do Android 8.1 o ícone da barra de navegação é só branco:
        // fundo verde da marca garante contraste. Do 9 em diante, barra clara.
        window.setNavigationBarColor(Build.VERSION.SDK_INT < 27
                ? Color.parseColor("#174A3A")
                : Color.TRANSPARENT);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(Build.VERSION.SDK_INT >= 27);

        // targetSdk 35+ é edge-to-edge obrigatório: sem este padding nativo o
        // conteúdo ficaria atrás da barra de status/navegação e do teclado.
        final View content = findViewById(android.R.id.content);
        if (content != null) {
            ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
                Insets bars = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars()
                                | WindowInsetsCompat.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                int bottom = Math.max(bars.bottom, ime.bottom);
                v.setPadding(bars.left, bars.top, bars.right, bottom);
                return insets;
            });
            ViewCompat.requestApplyInsets(content);
        }
    }
}
