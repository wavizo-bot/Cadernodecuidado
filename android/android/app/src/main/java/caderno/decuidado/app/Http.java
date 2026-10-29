package caderno.decuidado.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** HTTP mínimo (sem OkHttp) usado pelo OAuth e pela Drive API v3. */
final class Http {

    static final class Resp {
        final int code;
        final String body;

        Resp(int code, String body) {
            this.code = code;
            this.body = body == null ? "" : body;
        }

        boolean ok() {
            return code >= 200 && code < 300;
        }
    }

    private Http() {}

    static Resp send(String method, String url, String contentType, byte[] body, String bearer)
            throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(45000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "CadernoDeCuidado/Android");
            c.setRequestProperty("Accept", "application/json");
            if (contentType != null) c.setRequestProperty("Content-Type", contentType);
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                c.getOutputStream().write(body);
                c.getOutputStream().close();
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : readAll(in);
            return new Resp(code, text);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            try { in.close(); } catch (IOException ignored) {}
        }
    }

    static String readAsset(InputStream in) throws IOException {
        return readAll(in);
    }
}
