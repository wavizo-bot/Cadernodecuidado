package caderno.decuidado.app;

import android.content.Context;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Sessão Google do app Android. O consentimento NÃO acontece em navegador:
 * o único fluxo de abertura de sessão é o seletor nativo de conta do Play
 * Services (DrivePlugin.requestNativeToken), janela própria que o usuário
 * fecha quando quiser (regra A8 e pedido do usuário).
 *
 * Esta classe guarda/renova o token que o fluxo nativo entregou e mantém a
 * compatibilidade com sessões antigas: um refresh token de versões anteriores
 * ainda vale para renovação silenciosa (rede, sem janela).
 */
final class OAuthFlow {

    private static final String USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

    static final class AuthError extends Exception {
        AuthError(String message) {
            super(message);
        }
    }

    private final Context ctx;
    private final GoogleConfig cfg;
    private final AuthStore store;

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

    private void refreshAccessToken() throws AuthError {
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
