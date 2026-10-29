package caderno.decuidado.app;

import android.net.Uri;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * Mini servidor HTTP em loopback (127.0.0.1, porta efêmera) que existe só
 * durante o login Google. Recebe o redirect http://localhost:PORTA/?code=...
 * do navegador (Custom Tab) e devolve uma página com um botão para voltar
 * ao app. Nenhum dado fica exposto fora do loopback e o socket fecha ao fim.
 *
 * Importante: o redirect usa o nome "localhost" (não 127.0.0.1). O Google
 * bloqueia o fluxo de loopback quando o código usa IP literal.
 */
final class LoopbackServer implements Closeable {

    static final class Result {
        final String code;
        final String error;
        final String errorDescription;

        Result(String code, String error, String errorDescription) {
            this.code = code;
            this.error = error;
            this.errorDescription = errorDescription;
        }
    }

    private static final String DONE_URI = "caderno.decuidado.app://oauth-done";

    private final ServerSocket server;
    final int port;

    private LoopbackServer(ServerSocket server) {
        this.server = server;
        this.port = server.getLocalPort();
    }

    static LoopbackServer start() throws IOException {
        ServerSocket s = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        s.setReuseAddress(true);
        return new LoopbackServer(s);
    }

    String redirectUri() {
        return "http://localhost:" + port + "/";
    }

    /** Bloqueia até o callback, o erro ou o timeout. null = expirou. */
    Result await(String expectedState, long timeoutMs) throws IOException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            int wait = (int) Math.max(1000, Math.min(5000, deadline - System.currentTimeMillis()));
            server.setSoTimeout(wait);
            Socket sock = null;
            try {
                sock = server.accept();
                sock.setSoTimeout(5000);
                String target = readRequestTarget(sock);
                if (target == null) {
                    continue;
                }
                if (target.startsWith("/favicon")) {
                    respond(sock, 204, "text/plain; charset=utf-8", "");
                    continue;
                }
                Uri uri = Uri.parse("http://localhost" + target);
                String state = uri.getQueryParameter("state");
                String code = uri.getQueryParameter("code");
                String error = uri.getQueryParameter("error");
                String desc = uri.getQueryParameter("error_description");

                if (state == null || !state.equals(expectedState)) {
                    respond(sock, 400, "text/html; charset=utf-8",
                            page("Não foi possível validar a resposta do Google.",
                                    "Verifique se o login foi iniciado neste aparelho e tente novamente.", false));
                    continue;
                }
                if (error != null && !error.isEmpty()) {
                    respond(sock, 200, "text/html; charset=utf-8",
                            page("Login não concluído.",
                                    desc == null || desc.isEmpty() ? error : desc, false));
                    return new Result(null, error, desc);
                }
                if (code != null && !code.isEmpty()) {
                    respond(sock, 200, "text/html; charset=utf-8",
                            page("Login concluído.",
                                    "Conta autorizada. Volte ao Caderno de Cuidado para sincronizar — "
                                    + "esta janela do navegador pode ser fechada.", true));
                    return new Result(code, null, null);
                }
                respond(sock, 400, "text/html; charset=utf-8",
                        page("Resposta inesperada do Google.", "Tente entrar novamente pelo app.", false));
            } catch (SocketTimeoutException e) {
                // segue aguardando
            } finally {
                if (sock != null) {
                    try { sock.close(); } catch (IOException ignored) {}
                }
            }
        }
        return null;
    }

    private static String readRequestTarget(Socket sock) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                sock.getInputStream(), StandardCharsets.ISO_8859_1));
        String line = in.readLine();
        if (line == null) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        String target = parts[1];
        // Consome o restante do cabeçalho para o navegador não travar.
        String h;
        int guard = 0;
        while ((h = in.readLine()) != null && !h.isEmpty() && guard++ < 100) {
            // descarta
        }
        return target;
    }

    private static void respond(Socket sock, int code, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String status = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : "Error";
        String head = "HTTP/1.1 " + code + " " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream out = sock.getOutputStream();
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    private static String page(String title, String message, boolean success) {
        String accent = success ? "#174A3A" : "#8A4B3A";
        String icon = success ? "✓" : "!";
        String button = success
                ? "<a class=\"btn\" href=\"" + DONE_URI + "\">Voltar ao Caderno de Cuidado</a>"
                : "<a class=\"btn\" href=\"" + DONE_URI + "\">Voltar ao Caderno</a>";
        String auto = success
                ? "<script>setTimeout(function(){try{location.href='" + DONE_URI + "';}catch(e){}},1200);</script>"
                : "";
        return "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>" + title + "</title><style>"
                + "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;"
                + "background:#F7F5EE;color:#2F4A3C;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}"
                + ".card{background:#FFFEFA;border:1px solid #E4E2DA;border-radius:20px;max-width:420px;width:100%;"
                + "padding:32px 26px;text-align:center;box-shadow:0 18px 50px rgba(23,74,58,.10)}"
                + ".mark{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;"
                + "background:" + accent + ";color:#fff;font-size:26px;font-weight:700}"
                + "h1{font-family:Georgia,serif;font-size:26px;line-height:1.15;margin:0 0 10px;color:#174A3A}"
                + "p{font-size:15px;line-height:1.5;color:#5E7268;margin:0 0 24px}"
                + ".btn{display:inline-block;background:#174A3A;color:#fff;text-decoration:none;border-radius:12px;"
                + "padding:14px 22px;font-size:15px;font-weight:650;letter-spacing:.01em}"
                + "small{display:block;margin-top:18px;color:#8A9A90;font-size:12px}"
                + "</style></head><body><div class=\"card\"><div class=\"mark\">" + icon + "</div>"
                + "<h1>" + title + "</h1><p>" + message + "</p>" + button
                + "<small>O app abrirá sozinho. Se não abrir, use o botão. Esta aba pode ser fechada.</small>"
                + "</div>" + auto + "</body></html>";
    }

    @Override
    public void close() {
        try { server.close(); } catch (IOException ignored) {}
    }
}
