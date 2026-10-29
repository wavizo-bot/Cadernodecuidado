package caderno.decuidado.app;

import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/**
 * Google Drive v3, espaco appDataFolder. Mesmo modelo do app Windows:
 * um arquivo por dispositivo (caderno-ops-&lt;deviceId&gt;.json) e o legado
 * caderno-backup.json. So REST: nenhuma biblioteca do Google entra no APK.
 *
 * O tamanho do arquivo NUNCA e criterio de validade nem de escolha: o
 * sync-ui.js valida esquema/checksum de cada candidato e mescla todos.
 */
final class DriveApi {

    static final String LEGACY_NAME = "caderno-backup.json";
    private static final String FILES = "https://www.googleapis.com/drive/v3/files";
    private static final String UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

    static final class FileInfo {
        final String id;
        final String name;
        final long modifiedTime;
        final long size;

        FileInfo(String id, String name, long modifiedTime, long size) {
            this.id = id;
            this.name = name;
            this.modifiedTime = modifiedTime;
            this.size = size;
        }
    }

    private final OAuthFlow auth;

    DriveApi(OAuthFlow auth) {
        this.auth = auth;
    }

    /** Lista TODOS os backups (legado + por dispositivo), mais recentes antes. */
    List<FileInfo> list() throws Exception {
        String url = Uri.parse(FILES).buildUpon()
                .appendQueryParameter("spaces", "appDataFolder")
                .appendQueryParameter("q", "trashed = false")
                .appendQueryParameter("fields", "files(id,name,modifiedTime,size)")
                .appendQueryParameter("orderBy", "modifiedTime desc")
                .appendQueryParameter("pageSize", "100")
                .build().toString();
        Http.Resp r = authed("GET", url, null, null);
        List<FileInfo> out = new ArrayList<>();
        JSONObject j = new JSONObject(r.body);
        JSONArray arr = j.optJSONArray("files");
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject f = arr.optJSONObject(i);
            if (f == null) continue;
            String name = f.optString("name", "");
            if (name.isEmpty()) continue;
            if (!name.startsWith("caderno-") && !name.equals(LEGACY_NAME)) continue;
            out.add(new FileInfo(
                    f.optString("id", ""),
                    name,
                    parseTime(f.optString("modifiedTime", "")),
                    f.optLong("size", 0)));
        }
        return out;
    }

    FileInfo findByName(String name) throws Exception {
        for (FileInfo f : list()) {
            if (f.name.equalsIgnoreCase(name)) return f;
        }
        return null;
    }

    /** Cria ou atualiza o arquivo deste dispositivo e devolve o horario do servidor. */
    long upload(String deviceId, String payload) throws Exception {
        String name = backupName(deviceId);
        FileInfo current = findByName(name);
        String query = "?uploadType=media&fields=id,modifiedTime";
        if (current != null) {
            String url = UPLOAD + "/" + Uri.encode(current.id) + query;
            Http.Resp r = authed("PATCH", url, "application/json; charset=UTF-8",
                    payload.getBytes(StandardCharsets.UTF_8));
            long t = parseTime(new JSONObject(r.body).optString("modifiedTime", ""));
            return t != 0 ? t : modifiedOrNow(name);
        }
        String boundary = "caderno_" + UUID.randomUUID().toString().replace("-", "");
        String meta = "{\"name\":\"" + name + "\",\"parents\":[\"appDataFolder\"]}";
        String head = "--" + boundary + "\r\n"
                + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
                + meta + "\r\n"
                + "--" + boundary + "\r\n"
                + "Content-Type: application/json; charset=UTF-8\r\n\r\n";
        byte[] tail = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(payload.getBytes(StandardCharsets.UTF_8));
        out.write(tail);
        String url = UPLOAD + "?uploadType=multipart&fields=id,modifiedTime";
        Http.Resp r = authed("POST", url,
                "multipart/related; boundary=\"" + boundary + "\"", out.toByteArray());
        long t = parseTime(new JSONObject(r.body).optString("modifiedTime", ""));
        return t != 0 ? t : modifiedOrNow(name);
    }

    String download(String fileId) throws Exception {
        if (fileId == null || fileId.isEmpty()) {
            List<FileInfo> all = list();
            if (all.isEmpty()) {
                throw new OAuthFlow.AuthError("Nenhum backup no Google Drive desta conta.");
            }
            fileId = all.get(0).id;
        }
        String url = Uri.parse(FILES + "/" + fileId).buildUpon()
                .appendQueryParameter("alt", "media")
                .build().toString();
        Http.Resp r = authed("GET", url, null, null);
        return r.body;
    }

    /** Exclusao total: apaga todos os backups (legado e por dispositivo). */
    void deleteAll() throws Exception {
        for (FileInfo f : list()) {
            if (f.id == null || f.id.isEmpty()) continue;
            String url = FILES + "/" + Uri.encode(f.id);
            Http.Resp r = Http.send("DELETE", url, null, null, auth.accessToken());
            if (r.code == 401) {
                auth.invalidateAccessToken();
                r = Http.send("DELETE", url, null, null, auth.accessToken());
            }
            if (!r.ok() && r.code != 404) {
                throw new OAuthFlow.AuthError(friendlyError(r));
            }
        }
    }

    private long modifiedOrNow(String name) throws Exception {
        FileInfo again = findByName(name);
        return again == null ? System.currentTimeMillis() : again.modifiedTime;
    }

    private Http.Resp authed(String method, String url, String contentType, byte[] body)
            throws Exception {
        String token = auth.accessToken();
        Http.Resp r = Http.send(method, url, contentType, body, token);
        if (r.code == 401) {
            auth.invalidateAccessToken();
            token = auth.accessToken();
            r = Http.send(method, url, contentType, body, token);
        }
        if (!r.ok()) {
            throw new OAuthFlow.AuthError(friendlyError(r));
        }
        return r;
    }

    private static String friendlyError(Http.Resp r) {
        String detail = OAuthFlow.jsonError(r.body);
        if (r.code == 401) {
            return "A autorizacao do Google expirou. Entre novamente com a conta Google.";
        }
        if (r.code == 403) {
            return "O Google Drive nao liberou o acesso para esta conta. Saia e entre "
                    + "novamente aceitando a permissao do Drive. (" + detail + ")";
        }
        if (r.code == 404) {
            return "O backup nao esta mais no Google Drive. Sincronize novamente pelo app.";
        }
        if (r.code == 429) {
            return "Muitas sincronizacoes em pouco tempo. Aguarde um minuto e tente de novo.";
        }
        if (r.code >= 500) {
            return "O Google Drive esta instavel agora (HTTP " + r.code + "). Tente mais tarde.";
        }
        return "Falha no Google Drive (HTTP " + r.code + "): " + detail;
    }

    static String backupName(String deviceId) {
        if (deviceId == null || deviceId.trim().isEmpty()) return LEGACY_NAME;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < deviceId.length() && sb.length() < 64; i++) {
            char c = deviceId.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_') {
                sb.append(c);
            }
        }
        if (sb.length() == 0) return LEGACY_NAME;
        return "caderno-ops-" + sb + ".json";
    }

    static long parseTime(String iso) {
        if (iso == null || iso.isEmpty()) return 0;
        String[] patterns = {
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"
        };
        for (String p : patterns) {
            try {
                SimpleDateFormat f = new SimpleDateFormat(p, Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("UTC"));
                java.util.Date d = f.parse(iso);
                if (d != null) return d.getTime();
            } catch (Exception ignored) {}
        }
        return 0;
    }
}
