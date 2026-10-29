package caderno.decuidado.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Salva os arquivos que o app exporta (backup JSON, ficha CSV) em
 * Downloads/Caderno de Cuidado. No Android 10+ nem pede permissão: usa
 * MediaStore. No 7.0–9.0 pede WRITE_EXTERNAL_STORAGE só na primeira vez.
 *
 * O download de blob: do WebView não existe; a ponte JS intercepta o clique
 * do <a download> e manda o conteúdo para cá em base64.
 */
@CapacitorPlugin(
        name = "CadernoFiles",
        permissions = {
                @Permission(
                        alias = "storage",
                        strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
        })
public class FilesPlugin extends Plugin {

    private static final String FOLDER = "Caderno de Cuidado";

    @PluginMethod
    public void saveBase64(PluginCall call) {
        String data = call.getString("base64");
        if (data == null || data.isEmpty()) {
            resolveError(call, "Arquivo vazio.");
            return;
        }
        final String name = sanitize(call.getString("name", "caderno.json"));
        final String mime = call.getString("mime", "application/octet-stream");
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (Exception e) {
            resolveError(call, "Não foi possível ler o arquivo gerado.");
            return;
        }

        if (Build.VERSION.SDK_INT >= 29) {
            saveModern(call, name, mime, bytes);
            return;
        }
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePerm");
            return;
        }
        saveLegacy(call, name, mime, bytes);
    }

    @PermissionCallback
    private void storagePerm(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            String data = call.getString("base64");
            String name = sanitize(call.getString("name", "caderno.json"));
            String mime = call.getString("mime", "application/octet-stream");
            try {
                saveLegacy(call, name, mime, Base64.decode(data, Base64.DEFAULT));
            } catch (Exception e) {
                resolveError(call, "Não foi possível salvar o arquivo.");
            }
        } else {
            resolveError(call, "Permissão negada. Autorize o armazenamento nas "
                    + "configurações do aplicativo para salvar em Downloads.");
        }
    }

    private void saveModern(PluginCall call, String name, String mime, byte[] bytes) {
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = null;
        try {
            uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IllegalStateException("MediaStore recusou o arquivo");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new IllegalStateException("sem stream de escrita");
                os.write(bytes);
                os.flush();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            toast("Salvo em Downloads/" + FOLDER + "/" + name);
            resolveOk(call, name, "Downloads/" + FOLDER);
        } catch (Exception e) {
            if (uri != null) {
                try { cr.delete(uri, null, null); } catch (Exception ignored) {}
            }
            resolveError(call, "Não foi possível salvar em Downloads: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void saveLegacy(PluginCall call, String name, String mime, byte[] bytes) {
        try {
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS), FOLDER);
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IllegalStateException("não foi possível criar a pasta Downloads/" + FOLDER);
            }
            File file = unique(dir, name);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            MediaScannerConnection.scanFile(getContext(),
                    new String[]{file.getAbsolutePath()}, new String[]{mime}, null);
            toast("Salvo em Downloads/" + FOLDER + "/" + file.getName());
            resolveOk(call, file.getName(), "Downloads/" + FOLDER);
        } catch (Exception e) {
            resolveError(call, "Não foi possível salvar em Downloads: " + e.getMessage());
        }
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private static String sanitize(String raw) {
        String name = raw == null ? "caderno.json" : raw;
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.isEmpty()) name = "caderno.json";
        if (name.length() > 120) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 ? name.substring(dot) : "";
            name = name.substring(0, Math.max(1, 120 - ext.length())) + ext;
        }
        return name;
    }

    private void toast(final String text) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            try {
                Toast.makeText(getContext(), text, Toast.LENGTH_LONG).show();
            } catch (Exception ignored) {}
        });
    }

    private static void resolveOk(PluginCall call, String name, String location) {
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("name", name);
        o.put("location", location);
        call.resolve(o);
    }

    private static void resolveError(PluginCall call, String message) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", message);
        call.resolve(o);
    }
}
