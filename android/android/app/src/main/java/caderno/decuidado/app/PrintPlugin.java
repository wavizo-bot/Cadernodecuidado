package caderno.decuidado.app;

import android.app.Activity;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Impressão via sistema (PrintManager). O app já monta o relatório de
 * impressão no DOM (classes printing-* + @media print); aqui só abrimos o
 * diálogo "Salvar como PDF"/impressora do Android com o WebView atual.
 */
@CapacitorPlugin(name = "CadernoPrint")
public class PrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            error(call, "App indisponível para imprimir.");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                if (webView == null || pm == null) {
                    error(call, "Impressão não disponível neste aparelho.");
                    return;
                }
                String job = "Caderno de Cuidado";
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(job);
                PrintAttributes.Builder attrs = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setColorMode(PrintAttributes.COLOR_MODE_COLOR);
                pm.print(job, adapter, attrs.build());
                JSObject o = new JSObject();
                o.put("ok", true);
                call.resolve(o);
            } catch (Exception e) {
                error(call, "Não foi possível abrir a impressão: " + e.getMessage());
            }
        });
    }

    private static void error(PluginCall call, String message) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", message);
        call.resolve(o);
    }
}
