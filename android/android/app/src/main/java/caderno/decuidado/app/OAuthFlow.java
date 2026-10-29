package caderno.decuidado.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsIntent;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import android.util.Base64;

/**
 * Login Google sem SDK proprietário: Authorization Code + PKCE (S256) em
 * Custom Tab, redirect para loopback http://localhost:PORTA/ e troca do
 * código no endpoint de token com o client "Desktop" já usado pelo MSIX.
 *
 * É o fluxo que o Google aceita para apps instalados. O consentimento acontece
 * no navegador do sistema (nunca dentro de WebView embutida, que o Google
 * bloqueia).
 */
final class OAuthFlow {

    static final String SCOPE =
            "openid email profile https://www.googleapis.com/auth/drive.appdata";
    private static final String USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
    private static final long LOGIN_TIMEOUT_MS = 150000;

    static final class AuthError extends Exception {
        AuthError(String message) {
            super(message);
        }
    }

    private final Context ctx;
    private final GoogleConfig cfg;
    private final AuthStore store;
    private final SecureRandom random = new SecureRandom();

    private String accessToken;
    private long accessExpiresAt;
    private String nativeToken;
    private long nativeExpiresAt;

    OAuthFlow(Context ctx) throws Exception {
        this.ctx = ctx.getApplicationContext();
        this.cfg = GoogleConfig.load(ctx);
        this.store = new AuthStore(ctx);
        this.nativeToken = store.nativeToken();
        this.nativeExpiresAt = store.nativeExpiresAt();
    }

    boolean hasSession() {
        return store.token() != null || nativeToken != null;
    }

    /** Sessão que ainda consegue falar com o Drive sem pedir consentimento. */
    boolean hasUsableSession() {
        return store.token() != null
                || (nativeToken != null && System.currentTimeMillis() < nativeExpiresAt - 60000L);
    }

    /** Confere de verdade: renova o refresh token ou falha com mensagem clara. */
    void ensureSession() throws AuthError {
        accessToken();
    }

    String email() {
        return store.email();
    }

    /**
     * Guarda o access token do login nativo (Play Services) e busca o e-mail.
     * Chamado em thread de background (a busca do e-mail é rede).
     */
    synchronized String acceptNativeToken(String token) throws AuthError {
        if (token == null || token.isEmpty()) {
            throw new AuthError("O Google não devolveu o token de acesso.");
        }
        verifyDriveScope(token);
        nativeToken = token;
        nativeExpiresAt = System.currentTimeMillis() + 55L * 60L * 1000L;
        store.saveNative(token, nativeExpiresAt);
        loadEmail(token);
        return store.email();
    }

    /**
     * O login nativo pode devolver um token só com e-mail/perfil se o usuário
     * não marcar o Drive. Sem este teste o app dizia "logado" e o Drive
     * respondia 403 depois, sem explicar o motivo.
     */
    private void verifyDriveScope(String token) throws AuthError {
        try {
            Http.Resp r = Http.send("GET",
                    "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token="
                            + URLEncoder.encode(token, StandardCharsets.UTF_8),
                    null, null, null);
            if (!r.ok()) {
                throw new AuthError("Não foi possível conferir a permissão do Google Drive. "
                        + "Tente entrar novamente.");
            }
            String scope = new JSONObject(r.body).optString("scope", "");
            if (scope == null || !scope.contains("drive.appdata")) {
                throw new AuthError("A permissão do Google Drive não foi concedida. "
                        + "Entre novamente e marque a caixa de acesso ao Drive.");
            }
        } catch (AuthError e) {
            throw e;
        } catch (Exception e) {
            throw new AuthError("Não foi possível conferir a permissão do Google Drive. "
                    + "Verifique a internet e tente novamente.");
        }
    }

    synchronized String accessToken() throws AuthError {
        if (nativeToken != null && System.currentTimeMillis() < nativeExpiresAt - 60000L) {
            return nativeToken;
        }
        if (accessToken != null && System.currentTimeMillis() < accessExpiresAt - 60000L) {
            return accessToken;
        }
        if (store.token() != null) {
            refreshAccessToken();
            return accessToken;
        }
        if (nativeToken != null) {
            throw new AuthError("A sessão do Google expirou. Toque em Reconectar.");
        }
        throw new AuthError("Entre com a conta Google para sincronizar.");
    }

    synchronized void invalidateAccessToken() {
        accessToken = null;
        accessExpiresAt = 0;
        nativeToken = null;
        nativeExpiresAt = 0;
        store.clearNative();
    }

    /**
     * Único fluxo de consentimento: Custom Tab + PKCE + loopback localhost.
     * WebView embutida é proibida pelo Google e pela regra A8.
     */
    void signInBrowser(Activity activity) throws Exception {
        if (activity == null) {
            throw new AuthError("App indisponível no momento. Abra o Caderno novamente.");
        }
        if (hasSession()) {
            try {
                refreshAccessToken();
                return;
            } catch (Exception e) {
                store.clear();
            }
        }
        String verifier = randomB64(48);
        String challenge = b64url(MessageDigest.getInstance("SHA-256")
                .digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        String state = randomB64(24);

        LoopbackServer server = LoopbackServer.start();
        try {
            String redirect = server.redirectUri();
            launchBrowser(activity, buildAuthUrl(redirect, challenge, state));

            LoopbackServer.Result r = server.await(state, LOGIN_TIMEOUT_MS);
            if (r == null) {
                throw new AuthError("O login expirou. Toque em Entrar com Google e conclua no navegador.");
            }
            if (r.error != null) {
                if ("access_denied".equals(r.error)) {
                    throw new AuthError("Acesso não autorizado. Confirme se este e-mail está "
                            + "cadastrado como usuário de teste do projeto Google.");
                }
                throw new AuthError("Login não concluído: "
                        + (r.errorDescription != null ? r.errorDescription : r.error));
            }
            exchangeCode(r.code, verifier, redirect);
        } finally {
            server.close();
        }
    }

    private String buildAuthUrl(String redirect, String challenge, String state) {
        Uri.Builder q = new Uri.Builder()
                .appendQueryParameter("client_id", cfg.clientId)
                .appendQueryParameter("redirect_uri", redirect)
                .appendQueryParameter("response_type", "code")
                .appendQueryParameter("scope", SCOPE)
                .appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("code_challenge_method", "S256")
                .appendQueryParameter("state", state)
                .appendQueryParameter("access_type", "offline")
                .appendQueryParameter("prompt", "consent");

        String loginHint = store.email();
        if (!loginHint.isEmpty()) q.appendQueryParameter("login_hint", loginHint);

        return GoogleConfig.withQuery(cfg.authUri, q);
    }

    private void launchBrowser(Activity activity, String url) throws Exception {
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final CountDownLatch latch = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                CustomTabsIntent.Builder b = new CustomTabsIntent.Builder();
                b.setShowTitle(true);
                b.setUrlBarHidingEnabled(true);
                b.build().launchUrl(activity, Uri.parse(url));
            } catch (ActivityNotFoundException e) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(i);
                } catch (Throwable t) {
                    failure.set(t);
                }
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                latch.countDown();
            }
        });
        latch.await(8, TimeUnit.SECONDS);
        if (failure.get() != null) {
            throw new AuthError("Nenhum navegador disponível para abrir o login do Google. "
                    + "Instale ou ative o Chrome e tente novamente.");
        }
    }

    private void exchangeCode(String code, String verifier, String redirect) throws Exception {
        byte[] body = form(
                "code", code,
                "client_id", cfg.clientId,
                "client_secret", cfg.clientSecret,
                "redirect_uri", redirect,
                "grant_type", "authorization_code",
                "code_verifier", verifier).getBytes(StandardCharsets.UTF_8);

        Http.Resp resp = Http.send("POST", cfg.tokenUri,
                "application/x-www-form-urlencoded; charset=UTF-8", body, null);
        if (!resp.ok()) {
            throw new AuthError("O Google recusou o login: " + jsonError(resp.body));
        }
        JSONObject j = new JSONObject(resp.body);
        String token = j.optString("access_token", "");
        if (token.isEmpty()) throw new AuthError("O Google não devolveu o token de acesso.");
        long expiresIn = j.optLong("expires_in", 3600);
        String scope = j.optString("scope", "");
        if (!scope.contains("drive.appdata")) {
            store.clear();
            throw new AuthError("A permissão do Google Drive não foi concedida. "
                    + "Entre novamente e marque a caixa de acesso ao Google Drive.");
        }
        accessToken = token;
        accessExpiresAt = System.currentTimeMillis() + expiresIn * 1000L;

        String refresh = j.optString("refresh_token", "");
        if (!refresh.isEmpty()) {
            store.saveToken(refresh);
        } else if (store.token() == null) {
            throw new AuthError("O Google não devolveu a autorização permanente. Tente entrar novamente.");
        }
        loadEmail(token);
    }

    private synchronized void refreshAccessToken() throws AuthError {
        String refresh = store.token();
        if (refresh == null) throw new AuthError("Entre com a conta Google para sincronizar.");
        byte[] body = form(
                "client_id", cfg.clientId,
                "client_secret", cfg.clientSecret,
                "refresh_token", refresh,
                "grant_type", "refresh_token").getBytes(StandardCharsets.UTF_8);
        Http.Resp resp;
        try {
            resp = Http.send("POST", cfg.tokenUri,
                    "application/x-www-form-urlencoded; charset=UTF-8", body, null);
        } catch (Exception e) {
            throw new AuthError("Sem conexão com o Google. Verifique a internet e tente de novo.");
        }
        if (!resp.ok()) {
            if (resp.code == 400 || resp.code == 401 || resp.body.contains("invalid_grant")) {
                store.clear();
                throw new AuthError("A autorização do Google expirou. Entre novamente.");
            }
            throw new AuthError("O Google recusou a renovação do acesso: " + jsonError(resp.body));
        }
        JSONObject j;
        try {
            j = new JSONObject(resp.body);
        } catch (Exception e) {
            throw new AuthError("Resposta inválida do Google ao renovar o acesso.");
        }
        String token = j.optString("access_token", "");
        if (token.isEmpty()) throw new AuthError("O Google não renovou o acesso.");
        accessToken = token;
        accessExpiresAt = System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000L;
        String newRefresh = j.optString("refresh_token", "");
        if (!newRefresh.isEmpty()) store.saveToken(newRefresh);
        if (store.email().isEmpty()) loadEmail(token);
    }

    private void loadEmail(String token) {
        try {
            Http.Resp r = Http.send("GET", USERINFO, null, null, token);
            if (r.ok()) {
                String email = new JSONObject(r.body).optString("email", "");
                if (!email.isEmpty()) store.setEmail(email);
            }
        } catch (Exception ignored) {
            // O e-mail é informativo; a sincronização não depende dele.
        }
    }

    void signOut() {
        accessToken = null;
        accessExpiresAt = 0;
        nativeToken = null;
        nativeExpiresAt = 0;
        store.clear();
    }

    private static String form(String... kv) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (sb.length() > 0) sb.append('&');
            sb.append(URLEncoder.encode(kv[i], StandardCharsets.UTF_8));
            sb.append('=');
            sb.append(URLEncoder.encode(kv[i + 1] == null ? "" : kv[i + 1], StandardCharsets.UTF_8));
        }
        return sb.toString();
    }

    private String randomB64(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        return b64url(b);
    }

    private static String b64url(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    static String jsonError(String body) {
        try {
            JSONObject j = new JSONObject(body);
            JSONObject err = j.optJSONObject("error");
            if (err != null) {
                String msg = err.optString("message", "");
                if (!msg.isEmpty()) return msg;
            }
            String s = j.optString("error_description", "");
            if (!s.isEmpty()) return s;
            return j.optString("error", "erro desconhecido");
        } catch (Exception e) {
            return body == null || body.isEmpty() ? "erro desconhecido" : body.substring(0, Math.min(160, body.length()));
        }
    }
}
