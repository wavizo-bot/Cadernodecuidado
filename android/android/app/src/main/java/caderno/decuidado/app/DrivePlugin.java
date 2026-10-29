package caderno.decuidado.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.Log;
import android.widget.Toast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import org.json.JSONObject;

import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Implementa o MESMO contrato que o host WebView2 do MSIX expõe ao
 * sync-ui.js: GetState, CheckRemote, Restore, Backup(payload), Login,
 * Logout, GetAppVersion. Toda falha vira {ok:false,error} (nunca reject),
 * porque o sync-ui.js marca o host como quebrado ao primeiro reject.
 *
 * Login: primeiro tenta o seletor NATIVO de conta do Google (Play Services
 * AuthorizationClient, o fluxo recomendado, sem navegador). Se o aparelho não
 * tiver Play Services ou o client Android não estiver registrado para a
 * assinatura instalada, cai no Custom Tab + PKCE com loopback localhost.
 * Nunca usa WebView embutida (regra A8).
 */
@CapacitorPlugin(name = "CadernoDrive")
public class DrivePlugin extends Plugin {

    private static final int REQ_NATIVE_AUTH = 4821;
    private static final String DRIVE_SCOPE =
            "https://www.googleapis.com/auth/drive.appdata";

    private interface Work {
        JSObject run() throws Exception;
    }

    private static final class NativeResult {
        final String token;
        final boolean fallback;
        final boolean cancel;
        final String reason;

        private NativeResult(String token, boolean fallback, boolean cancel, String reason) {
            this.token = token;
            this.fallback = fallback;
            this.cancel = cancel;
            this.reason = reason;
        }

        static NativeResult token(String token) {
            return new NativeResult(token, false, false, "");
        }
        static NativeResult fallback(String reason) {
            return new NativeResult(null, true, false, reason == null ? "" : reason);
        }
        static NativeResult cancel() {
            return new NativeResult(null, false, true, "cancelado");
        }
    }

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final AtomicBoolean loginBusy = new AtomicBoolean(false);
    private final BlockingQueue<NativeResult> nativeResults = new ArrayBlockingQueue<>(1);

    private OAuthFlow oauth;
    private DriveApi drive;
    private volatile long lastOkAt;

    private synchronized OAuthFlow oauth() throws Exception {
        if (oauth == null) {
            oauth = new OAuthFlow(getContext());
            drive = new DriveApi(oauth);
        }
        return oauth;
    }

    private synchronized DriveApi drive() throws Exception {
        oauth();
        return drive;
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject o = new JSObject();
        try {
            OAuthFlow f = oauth();
            boolean signed = f.hasSession();
            o.put("signedIn", signed);
            o.put("email", f.email());
            o.put("reachable", signed && (System.currentTimeMillis() - lastOkAt) < 15L * 60L * 1000L);
        } catch (Exception e) {
            o.put("signedIn", false);
            o.put("email", "");
            o.put("reachable", false);
            o.put("error", message(e));
        }
        call.resolve(o);
    }

    @PluginMethod
    public void checkRemote(PluginCall call) {
        run(call, () -> {
            if (!oauth().hasSession()) throw new OAuthFlow.AuthError("Entre com a conta Google.");
            java.util.List<DriveApi.FileInfo> all = drive().list();
            org.json.JSONArray files = new org.json.JSONArray();
            long max = 0;
            for (DriveApi.FileInfo f : all) {
                JSONObject item = new JSONObject();
                item.put("id", f.id);
                item.put("name", f.name);
                item.put("modifiedTime", f.modifiedTime);
                item.put("size", f.size);
                files.put(item);
                if (f.modifiedTime > max) max = f.modifiedTime;
            }
            JSObject o = new JSObject();
            o.put("ok", true);
            o.put("exists", all.size() > 0);
            o.put("files", files);
            o.put("modifiedTime", max);
            lastOkAt = System.currentTimeMillis();
            return o;
        });
    }

    @PluginMethod
    public void restore(PluginCall call) {
        run(call, () -> {
            if (!oauth().hasSession()) throw new OAuthFlow.AuthError("Entre com a conta Google.");
            String payload = drive().download(null);
            lastOkAt = System.currentTimeMillis();
            JSObject o = new JSObject();
            o.put("ok", true);
            o.put("payload", payload);
            return o;
        });
    }

    /** Baixa um candidato especifico; a validacao v2 fica no sync-ui.js. */
    @PluginMethod
    public void restoreFile(PluginCall call) {
        final String fileId = call.getString("fileId", "");
        run(call, () -> {
            if (!oauth().hasSession()) throw new OAuthFlow.AuthError("Entre com a conta Google.");
            if (fileId == null || fileId.isEmpty()) {
                throw new OAuthFlow.AuthError("Arquivo de backup invalido.");
            }
            String payload = drive().download(fileId);
            lastOkAt = System.currentTimeMillis();
            JSObject o = new JSObject();
            o.put("ok", true);
            o.put("payload", payload);
            return o;
        });
    }

    @PluginMethod
    public void backup(PluginCall call) {
        final String payload = call.getString("payload");
        run(call, () -> {
            if (!oauth().hasSession()) throw new OAuthFlow.AuthError("Entre com a conta Google.");
            if (payload == null || payload.trim().isEmpty()) {
                throw new OAuthFlow.AuthError("Nada para sincronizar.");
            }
            JSONObject j = new JSONObject(payload);
            boolean force = j.optBoolean("force", false);
            if (!force && !payloadHasData(j)) {
                throw new OAuthFlow.AuthError(
                        "A base deste aparelho esta vazia; nada foi enviado.");
            }
            String deviceId = j.optString("deviceId", "");
            long at = drive().upload(deviceId, payload);
            lastOkAt = System.currentTimeMillis();
            JSObject o = new JSObject();
            o.put("ok", true);
            o.put("backedUpAt", at);
            o.put("name", DriveApi.backupName(deviceId));
            return o;
        });
    }

    /** Exclusao total explicita ("Iniciar novo caderno"). */
    @PluginMethod
    public void resetCloud(PluginCall call) {
        final String payload = call.getString("payload");
        run(call, () -> {
            if (!oauth().hasSession()) throw new OAuthFlow.AuthError("Entre com a conta Google.");
            if (payload == null || payload.trim().isEmpty()) {
                throw new OAuthFlow.AuthError("Backup em formato invalido.");
            }
            JSONObject j = new JSONObject(payload);
            String deviceId = j.optString("deviceId", "");
            drive().deleteAll();
            long at = drive().upload(deviceId, payload);
            lastOkAt = System.currentTimeMillis();
            JSObject o = new JSObject();
            o.put("ok", true);
            o.put("backedUpAt", at);
            o.put("name", DriveApi.backupName(deviceId));
            return o;
        });
    }

    @PluginMethod
    public void login(PluginCall call) {
        if (!loginBusy.compareAndSet(false, true)) {
            JSObject o = new JSObject();
            o.put("ok", false);
            o.put("error", "Já existe um login em andamento.");
            call.resolve(o);
            return;
        }
        pool.execute(() -> {
            JSObject o = new JSObject();
            try {
                OAuthFlow f = oauth();
                if (f.hasUsableSession()) {
                    try {
                        f.ensureSession();
                        finishLogin(call, o, f, f.email());
                        return;
                    } catch (OAuthFlow.AuthError expired) {
                        // Token local inválido: segue para novo consentimento.
                        Log.i("CadernoLogin", "sessão local inválida: " + expired.getMessage());
                    }
                }

                NativeResult nr = requestNativeToken();
                if (nr == null) {
                    // Sem resposta do seletor nativo em 25 s (client Android
                    // ausente/incompatível). O Google bloqueia OAuth dentro de
                    // WebView; vai direto ao navegador do sistema, que aceita.
                    Log.i("CadernoLogin", "nativo sem resposta em 25 s; fallback navegador");
                    f.signInBrowser(getActivity());
                    finishLogin(call, o, f, f.email());
                    return;
                }
                if (nr.cancel) {
                    throw new OAuthFlow.AuthError("Login cancelado.");
                }
                if (nr.token != null) {
                    String email = f.acceptNativeToken(nr.token);
                    finishLogin(call, o, f, email);
                    return;
                }

                // Falha do nativo: o motivo vai para o log (sem token) e o
                // fluxo continua no Custom Tab + loopback, nunca em WebView.
                Log.i("CadernoLogin", "nativo indisponível: " + nr.reason
                        + "; fallback navegador");
                f.signInBrowser(getActivity());
                finishLogin(call, o, f, f.email());
            } catch (Exception e) {
                o.put("ok", false);
                o.put("error", message(e));
                call.resolve(o);
            } finally {
                // Garante que uma excecao inesperada nao deixe o botao preso
                // em "ja existe um login em andamento" para sempre.
                loginBusy.set(false);
            }
        });
    }

    private void finishLogin(PluginCall call, JSObject o, OAuthFlow f, String email)
            throws OAuthFlow.AuthError {
        if (f == null) {
            throw new OAuthFlow.AuthError("O login não foi concluído. Tente novamente.");
        }
        f.ensureSession(); // lança erro se não houver token utilizável
        o.put("ok", true);
        o.put("email", email == null ? "" : email);
        lastOkAt = System.currentTimeMillis();
        final String toastText = (email == null || email.isEmpty())
                ? "Conta Google conectada."
                : "Conectado: " + email;
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    Toast.makeText(getContext(), toastText, Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {}
            });
        }
        loginBusy.set(false);
        call.resolve(o);
    }

    /**
     * Abre o seletor nativo de conta do Google e devolve o access token.
     * Se o aparelho não tiver Play Services ou o OAuth Android não estiver
     * registrado para a assinatura instalada, devolve fallback (o chamador
     * cai no Custom Tab + loopback). Se o usuário fechar o seletor, devolve
     * cancel.
     */
    private NativeResult requestNativeToken() throws InterruptedException {
        final Activity activity = getActivity();
        if (activity == null) return NativeResult.fallback("sem activity");
        nativeResults.clear();
        activity.runOnUiThread(() -> {
            try {
                AuthorizationRequest request = AuthorizationRequest.builder()
                        .setRequestedScopes(Arrays.asList(
                                new Scope("email"),
                                new Scope("profile"),
                                new Scope(DRIVE_SCOPE)))
                        .build();
                Identity.getAuthorizationClient(activity)
                        .authorize(request)
                        .addOnSuccessListener(result -> {
                            if (result == null) {
                                nativeResults.offer(NativeResult.fallback("sem resultado"));
                                return;
                            }
                            if (result.hasResolution()) {
                                try {
                                    activity.startIntentSenderForResult(
                                            result.getPendingIntent().getIntentSender(),
                                            REQ_NATIVE_AUTH, null, 0, 0, 0);
                                } catch (Exception e) {
                                    nativeResults.offer(NativeResult.fallback(e.getMessage()));
                                }
                            } else {
                                String token = result.getAccessToken();
                                nativeResults.offer(token == null || token.isEmpty()
                                        ? NativeResult.fallback("sem token")
                                        : NativeResult.token(token));
                            }
                        })
                        .addOnFailureListener(e ->
                                nativeResults.offer(NativeResult.fallback(e.getMessage())));
            } catch (Throwable t) {
                nativeResults.offer(NativeResult.fallback(t.getMessage()));
            }
        });
        return nativeResults.poll(25, TimeUnit.SECONDS);
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_NATIVE_AUTH) return;
        if (resultCode != Activity.RESULT_OK || data == null) {
            nativeResults.offer(NativeResult.cancel());
            return;
        }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity())
                    .getAuthorizationResultFromIntent(data);
            String token = result == null ? null : result.getAccessToken();
            nativeResults.offer(token == null || token.isEmpty()
                    ? NativeResult.fallback("sem token")
                    : NativeResult.token(token));
        } catch (Exception e) {
            nativeResults.offer(NativeResult.cancel());
        }
    }

    @PluginMethod
    public void logout(PluginCall call) {
        try {
            if (oauth != null) oauth.signOut();
            lastOkAt = 0;
            final Activity activity = getActivity();
            if (activity != null) {
                activity.runOnUiThread(() -> {
                    try {
                        Identity.getSignInClient(activity).signOut();
                    } catch (Exception ignored) {}
                });
            }
            JSObject o = new JSObject();
            o.put("ok", true);
            call.resolve(o);
        } catch (Exception e) {
            JSObject o = new JSObject();
            o.put("ok", false);
            o.put("error", message(e));
            call.resolve(o);
        }
    }

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        JSObject o = new JSObject();
        try {
            String v = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
            o.put("version", v == null ? "" : v);
        } catch (PackageManager.NameNotFoundException e) {
            o.put("version", "");
        }
        call.resolve(o);
    }

    /* --------------------------------------------------------------- infra -- */

    private void run(PluginCall call, Work work) {
        pool.execute(() -> {
            try {
                call.resolve(work.run());
            } catch (Exception e) {
                JSObject o = new JSObject();
                o.put("ok", false);
                o.put("error", message(e));
                call.resolve(o);
            }
        });
    }

    private String message(Exception e) {
        if (e instanceof UnknownHostException || e instanceof SocketTimeoutException) {
            return "Sem conexão com a internet. Verifique a rede e tente de novo.";
        }
        String m = e.getMessage();
        return (m == null || m.trim().isEmpty()) ? "Falha inesperada na sincronização." : m;
    }

    /**
     * v2: ops nao vazias. v1 (legado): reg/cfg com conteudo. Nunca usa
     * tamanho em bytes como sinal de "tem dados".
     */
    private static boolean payloadHasData(JSONObject p) {
        if (p == null) return false;
        org.json.JSONArray ops = p.optJSONArray("ops");
        if (ops != null && ops.length() > 0) return true;
        JSONObject st = p.optJSONObject("state");
        if (st != null && rawHasData(st.opt("reg"), st.opt("cfg"))) return true;
        return rawHasData(p.opt("reg"), p.opt("cfg"));
    }

    private static boolean rawHasData(Object reg, Object cfg) {
        if (hasRecords(reg)) return true;
        if (cfg instanceof JSONObject) return ((JSONObject) cfg).length() > 0;
        if (cfg instanceof String) {
            String s = ((String) cfg).trim();
            return !s.isEmpty() && !s.equals("{}") && !s.equals("[]");
        }
        return false;
    }

    private static boolean hasRecords(Object reg) {
        if (reg instanceof org.json.JSONArray) return ((org.json.JSONArray) reg).length() > 0;
        if (reg instanceof String) {
            String s = ((String) reg).trim();
            if (s.isEmpty() || s.equals("[]") || s.equals("{}")) return false;
            try {
                if (s.startsWith("[")) return new org.json.JSONArray(s).length() > 0;
                if (s.startsWith("{")) {
                    org.json.JSONArray a = new JSONObject(s).optJSONArray("records");
                    return a != null && a.length() > 0;
                }
            } catch (Exception ignored) {}
        }
        return false;
    }
}
