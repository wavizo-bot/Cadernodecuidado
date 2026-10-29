package caderno.decuidado.app;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.InputStream;

/**
 * Credenciais OAuth do app (client tipo "Desktop", o mesmo do MSIX).
 * O JSON NÃO é versionado no git: o build copia
 * C:\APPS\ID.OAuth\client_secret_768118833529-....json para
 * android/app/src/main/assets/google-client.json (regras 3.1/3.3).
 */
final class GoogleConfig {

    final String clientId;
    final String clientSecret;
    final String authUri;
    final String tokenUri;

    private GoogleConfig(String clientId, String clientSecret, String authUri, String tokenUri) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.authUri = authUri;
        this.tokenUri = tokenUri;
    }

    static GoogleConfig load(Context ctx) throws Exception {
        String text;
        try (InputStream in = ctx.getAssets().open("google-client.json")) {
            text = Http.readAsset(in);
        }
        JSONObject root = new JSONObject(text);
        JSONObject installed = root.optJSONObject("installed");
        if (installed == null) installed = root.optJSONObject("web");
        if (installed == null) throw new IllegalStateException("google-client.json sem 'installed'");
        String id = installed.optString("client_id", "");
        String secret = installed.optString("client_secret", "");
        if (id.isEmpty() || secret.isEmpty()) {
            throw new IllegalStateException("google-client.json incompleto (client_id/client_secret)");
        }
        String auth = installed.optString("auth_uri", "https://accounts.google.com/o/oauth2/auth");
        String token = installed.optString("token_uri", "https://oauth2.googleapis.com/token");
        return new GoogleConfig(id, secret, auth, token);
    }

    static String withQuery(String base, Uri.Builder q) {
        return base + "?" + q.build().getEncodedQuery();
    }
}
