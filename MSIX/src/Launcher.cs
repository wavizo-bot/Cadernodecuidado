using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CadernoDeCuidado
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public class MainForm : Form
    {
        private readonly WebView2 _web = new WebView2();
        // Referencia enraizada: o host object NUNCA pode ser coletado pelo GC,
        // senao as chamadas JS falham com 0x80070490 (ELEMENT_NOT_FOUND).
        private readonly DriveSync _sync;

        public MainForm()
        {
            Text = "Caderno de Cuidado";
            Width = 1200;
            Height = 800;
            StartPosition = FormStartPosition.CenterScreen;
            _web.Dock = DockStyle.Fill;
            Controls.Add(_web);
            _sync = new DriveSync(ShowGoogleLoginPopup);
            Load += InitAsync;
        }

        // Login Google em janela filha com WebView2 proprio (padrao Acompanha Digital):
        // abre a URL de autorizacao, intercepta o redirect de loopback (?code=...),
        // devolve a URL de retorno e fecha a janela sozinha. Sem navegador externo,
        // sem HttpListener, sem aba perdida. Retorna null se cancelado/expirado.
        private Task<string> ShowGoogleLoginPopup(string authUrl)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            Action open = () =>
            {
                Form loginForm = null;
                WebView2 loginWeb = null;
                System.Threading.Timer timeout = null;
                bool done = false;
                bool inFormClosed = false;
                Action<string> finish = null;
                finish = (result) =>
                {
                    if (done) return; // sem reentrancia: Close() dentro de FormClosed nao refaz nada
                    done = true;
                    try { if (timeout != null) timeout.Dispose(); } catch { }
                    tcs.TrySetResult(result);
                    try
                    {
                        if (loginForm != null && !loginForm.IsDisposed && !inFormClosed)
                        {
                            if (loginForm.InvokeRequired)
                                loginForm.BeginInvoke(new Action(() => { try { loginForm.Close(); } catch { } }));
                            else loginForm.Close();
                        }
                    }
                    catch { }
                };
                try
                {
                    loginForm = new Form();
                    loginForm.Text = "Entrar com o Google";
                    loginForm.Width = 560;
                    loginForm.Height = 700;
                    loginForm.StartPosition = FormStartPosition.CenterParent;
                    loginForm.MinimizeBox = false;
                    loginWeb = new WebView2();
                    loginWeb.Dock = DockStyle.Fill;
                    loginForm.Controls.Add(loginWeb);
                    loginForm.FormClosed += (s, e) =>
                    {
                        inFormClosed = true;
                        try { if (loginWeb != null) loginWeb.Dispose(); } catch { }
                        finish(null);
                    };
                    loginForm.Shown += async (s, e) =>
                    {
                        try
                        {
                            await loginWeb.EnsureCoreWebView2Async(null);
                            CoreWebView2 core = loginWeb.CoreWebView2;
                            core.Settings.AreDefaultContextMenusEnabled = false;
                            core.Settings.AreDevToolsEnabled = false;
                            try { core.Settings.IsStatusBarEnabled = false; } catch { }
                            core.PermissionRequested += DriveSync.DenyPermissions;
                            core.AddWebResourceRequestedFilter(
                                "http://localhost*", CoreWebView2WebResourceContext.All);
                            core.WebResourceRequested += (ss, ee) =>
                            {
                                try
                                {
                                    string url = ee.Request.Uri;
                                    string code, err;
                                    if (DriveSync.TryParseAuthRedirect(url, out code, out err)
                                        && (code != null || err != null))
                                    {
                                        byte[] body = Encoding.UTF8.GetBytes(
                                            "<!doctype html><meta charset=\"utf-8\"><title>Autorizando...</title>" +
                                            "<body style=\"font-family:sans-serif;text-align:center;padding-top:4rem;color:#444\">" +
                                            "<p>Autorizando...<br><small>Voltando para o aplicativo.</small></p></body>");
                                        var ms = new MemoryStream(body);
                                        ee.Response = core.Environment.CreateWebResourceResponse(
                                            ms, 200, "OK",
                                            "{\"Content-Type\":\"text/html; charset=utf-8\",\"Content-Length\":\"" + body.Length + "\"}");
                                        finish(url);
                                    }
                                }
                                catch { }
                            };
                            core.Navigate(authUrl);
                        }
                        catch { finish(null); }
                    };
                    timeout = new System.Threading.Timer(state => finish(null), null,
                        TimeSpan.FromMinutes(5), TimeSpan.FromMilliseconds(-1));
                    loginForm.Show(this);
                }
                catch { finish(null); }
            };
            try
            {
                if (InvokeRequired) BeginInvoke(open);
                else open();
            }
            catch { tcs.TrySetResult(null); }
            return tcs.Task;
        }

        private async void InitAsync(object s, EventArgs e)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string wwwFolder = Path.Combine(baseDir, "www");
                if (!Directory.Exists(wwwFolder)) wwwFolder = baseDir;

                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "wavizo", "CadernoDeCuidado", "WebView2");
                Directory.CreateDirectory(userData);

                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
                await _web.EnsureCoreWebView2Async(env);

                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                _web.CoreWebView2.Settings.IsZoomControlEnabled = true;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.AreHostObjectsAllowed = true;
                _web.CoreWebView2.PermissionRequested += DriveSync.DenyPermissions;

                _web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "app.caderno.local", wwwFolder, CoreWebView2HostResourceAccessKind.Allow);

                // Nome "cadernoDrive": "sync" e reservado pelo WebView2
                // (hostObjects.sync = acessador de chamadas sincronas) e quebra o dispatch.
                _web.CoreWebView2.AddHostObjectToScript("cadernoDrive", _sync);
                _web.Source = new Uri("https://app.caderno.local/index.html");
            }
            catch (Exception ex)
            {
                try
                {
                    string fallback = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "www", "index.html");
                    _web.Source = new Uri(fallback);
                }
                catch { }
                MessageBox.Show("Falha ao iniciar WebView2:\n" + ex.Message +
                    "\n\nVerifique se o Microsoft Edge WebView2 Runtime esta instalado.",
                    "Caderno de Cuidado", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    // Ponte JS <-> Google Drive. Metodos async viram Promises no JS.
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class DriveSync
    {
        private const string Scopes = "openid email profile https://www.googleapis.com/auth/drive.appdata";
        private const string BackupName = "caderno-backup.json";

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static readonly HttpClient Http = new HttpClient();

        // Abre a URL de autorizacao numa janela propria e devolve a URL de
        // retorno (ou null). Injetado pelo MainForm (padrao popup interno).
        private readonly Func<string, Task<string>> _popup;

        public DriveSync() : this(null) { }

        public DriveSync(Func<string, Task<string>> popupOpener)
        {
            _popup = popupOpener;
        }

        // Extrai ?code= / ?error= da URL de retorno do Google. Publico para teste.
        public static bool TryParseAuthRedirect(string url, out string code, out string error)
        {
            code = null;
            error = null;
            try
            {
                if (string.IsNullOrEmpty(url)) return false;
                int q = url.IndexOf('?');
                if (q < 0) return false;
                string qs = url.Substring(q + 1);
                int h = qs.IndexOf('#');
                if (h >= 0) qs = qs.Substring(0, h);
                string[] parts = qs.Split('&');
                foreach (string part in parts)
                {
                    if (string.IsNullOrEmpty(part)) continue;
                    int eq = part.IndexOf('=');
                    string k = eq < 0 ? part : part.Substring(0, eq);
                    string v = eq < 0 ? "" : WebUtility.UrlDecode(part.Substring(eq + 1));
                    if (string.Equals(k, "code", StringComparison.OrdinalIgnoreCase)) code = v;
                    else if (string.Equals(k, "error", StringComparison.OrdinalIgnoreCase)) error = v;
                }
                return true;
            }
            catch { return false; }
        }

        private static string BaseDir()
        {
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private static string TokenPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "wavizo", "CadernoDeCuidado");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "google-token.dat");
        }

        private static Dictionary<string, object> LoadToken()
        {
            try
            {
                string path = TokenPath();
                if (!File.Exists(path)) return null;
                byte[] prot = File.ReadAllBytes(path);
                byte[] raw = ProtectedData.Unprotect(prot, null, DataProtectionScope.CurrentUser);
                return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(raw));
            }
            catch { return null; }
        }

        private static void SaveToken(Dictionary<string, object> t)
        {
            byte[] raw = Encoding.UTF8.GetBytes(Json.Serialize(t));
            byte[] prot = ProtectedData.Protect(raw, null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(TokenPath(), prot);
        }

        private static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            if (d != null && d.TryGetValue(k, out v) && v != null) return v.ToString();
            return null;
        }

        private static Dictionary<string, string> LoadClient()
        {
            string[] candidates = new string[]
            {
                Path.Combine(BaseDir(), "google-client.json"),
                Path.Combine(BaseDir(), "www", "google-client.json"),
            };
            foreach (string p in candidates)
            {
                try
                {
                    if (!File.Exists(p)) continue;
                    Dictionary<string, object> root =
                        Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(p));
                    object inst;
                    if (root != null && root.TryGetValue("installed", out inst))
                    {
                        Dictionary<string, object> d = inst as Dictionary<string, object>;
                        if (d != null)
                        {
                            return new Dictionary<string, string>()
                            {
                                { "id", Str(d, "client_id") },
                                { "secret", Str(d, "client_secret") },
                            };
                        }
                    }
                }
                catch { }
            }
            return null;
        }

        private static string B64Url(byte[] b)
        {
            return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static int FreePort()
        {
            System.Net.Sockets.TcpListener l =
                new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        public async Task<string> GetState()
        {
            Dictionary<string, object> t = LoadToken();
            bool signed = t != null && Str(t, "refresh_token") != null;
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["signedIn"] = signed;
            r["email"] = signed ? Str(t, "email") : null;
            r["reachable"] = false; // verificado apenas em operacoes reais (login/backup/restore)
            return Json.Serialize(r);
        }

        public async Task<string> Logout()
        {
            try { File.Delete(TokenPath()); }
            catch { }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = true;
            return Json.Serialize(r);
        }

        // Privacidade: o app nao usa camera, microfone, localizacao nem notificacoes
        // do sistema — nega tudo explicitamente para que nenhum conteudo web
        // (nem mesmo a pagina de login do Google) gere pedidos no Windows.
        // O login Google (OAuth) nao precisa dessas permissoes.
        public static void DenyPermissions(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            try { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; } catch { }
        }

        // Versao real do pacote instalado (lida do AppxManifest). O rodape do app
        // mostra texto estatico do build web; o JS corrige com este valor.
        // Async (Task) para atravessar o proxy WebView2 como Promise.
        public async Task<string> GetAppVersion()
        {
            try
            {
                string mf = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AppxManifest.xml");
                if (File.Exists(mf))
                {
                    Match m = Regex.Match(File.ReadAllText(mf),
                        "(?m)^\\s*Version=\"([0-9.]+)\"");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            catch { }
            return null;
        }

        // Encerra o aplicativo (botao "Quero sair" do aceite de termos).
        public string Quit()
        {
            try
            {
                Form f = Application.OpenForms.Count > 0 ? Application.OpenForms[0] : null;
                if (f != null) f.BeginInvoke(new Action(() => Application.Exit()));
                else Task.Run(() => System.Threading.Thread.Sleep(800)).ContinueWith(delegate { try { Environment.Exit(0); } catch { } });
            }
            catch { }
            return "closing";
        }

        public async Task<string> Login()
        {
            try
            {
                Dictionary<string, string> client = LoadClient();
                if (client == null || string.IsNullOrEmpty(client["id"]))
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "google-client.json nao encontrado no pacote." } });

                byte[] rnd = new byte[32];
                using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(rnd);
                string verifier = B64Url(rnd);
                byte[] chBytes;
                using (SHA256 sha = SHA256.Create())
                    chBytes = sha.ComputeHash(Encoding.ASCII.GetBytes(verifier));
                string challenge = B64Url(chBytes);

                int port = FreePort();
                // Regra 5.9.3/W13/A8: loopback sempre pelo nome "localhost".
                // O Google bloqueia IP literal (127.0.0.1) no fluxo instalado.
                string redirect = "http://localhost:" + port + "/";
                string authUrl = "https://accounts.google.com/o/oauth2/auth" +
                    "?client_id=" + Uri.EscapeDataString(client["id"]) +
                    "&redirect_uri=" + Uri.EscapeDataString(redirect) +
                    "&response_type=code" +
                    "&scope=" + Uri.EscapeDataString(Scopes) +
                    "&code_challenge=" + challenge +
                    "&code_challenge_method=S256" +
                    "&access_type=offline&prompt=consent";

                // Janela propria do app (fecha sozinha ao concluir). O redirect
                // de loopback nunca chega a rede: o WebView o intercepta.
                // Sem _popup (modo web), nao ha como logar: instrui o usuario.
                if (_popup == null)
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "Login Google disponivel somente no app instalado." } });

                string redirectUrl = await _popup(authUrl);
                string code = null, authErr = null;
                if (!string.IsNullOrEmpty(redirectUrl))
                    TryParseAuthRedirect(redirectUrl, out code, out authErr);

                if (!string.IsNullOrEmpty(authErr))
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "Login recusado: " + authErr } });

                if (string.IsNullOrEmpty(code))
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "Login cancelado ou tempo esgotado." } });

                FormUrlEncodedContent body = new FormUrlEncodedContent(new Dictionary<string, string>()
                {
                    { "client_id", client["id"] },
                    { "client_secret", client["secret"] ?? "" },
                    { "code", code },
                    { "code_verifier", verifier },
                    { "grant_type", "authorization_code" },
                    { "redirect_uri", redirect },
                });
                HttpResponseMessage tr = await Http.PostAsync("https://oauth2.googleapis.com/token", body);
                string ts = await tr.Content.ReadAsStringAsync();
                if (!tr.IsSuccessStatusCode)
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "Token: " + Snip(ts) } });
                Dictionary<string, object> tok = Json.Deserialize<Dictionary<string, object>>(ts);
                string access = Str(tok, "access_token");
                string refresh = Str(tok, "refresh_token");
                string granted = Str(tok, "scope");
                if (string.IsNullOrEmpty(granted) || granted.IndexOf("drive.appdata",
                        StringComparison.Ordinal) < 0)
                {
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "A permissao do Google Drive nao foi concedida. "
                            + "Entre novamente e marque a caixa de acesso ao Google Drive." } });
                }
                if (string.IsNullOrEmpty(refresh))
                {
                    Dictionary<string, object> old = LoadToken();
                    refresh = Str(old, "refresh_token"); // re-login pode nao devolver refresh_token
                }
                if (string.IsNullOrEmpty(access) || string.IsNullOrEmpty(refresh))
                    return Json.Serialize(new Dictionary<string, object>()
                        { { "ok", false }, { "error", "Google nao devolveu refresh_token." } });

                string email = await FetchEmail(access);
                Dictionary<string, object> save = new Dictionary<string, object>();
                save["refresh_token"] = refresh;
                save["email"] = email;
                SaveToken(save);

                return Json.Serialize(new Dictionary<string, object>()
                    { { "ok", true }, { "email", email } });
            }
            catch (Exception ex)
            {
                return Json.Serialize(new Dictionary<string, object>()
                    { { "ok", false }, { "error", ex.Message } });
            }
        }

        public async Task<string> Backup(string payloadJson)
        {
            try
            {
                string access = await AccessToken();
                if (access == null) return Json.Serialize(Error(AuthError()));
                if (string.IsNullOrEmpty(payloadJson) || payloadJson.Length < 10)
                    return Json.Serialize(Error("Nada para sincronizar."));
                Dictionary<string, object> p = null;
                try { p = Json.Deserialize<Dictionary<string, object>>(payloadJson); }
                catch { return Json.Serialize(Error("Backup em formato invalido.")); }
                if (p == null) return Json.Serialize(Error("Backup em formato invalido."));
                bool force = false;
                try { if (p.ContainsKey("force")) force = Convert.ToBoolean(p["force"]); }
                catch { }
                if (!force && !PayloadHasData(p))
                    return Json.Serialize(Error("A base deste aparelho esta vazia; nada foi enviado."));
                string deviceId = Str(p, "deviceId");
                Dictionary<string, object> result = await UploadPayload(
                    access, BackupNameFor(deviceId), payloadJson);
                return Json.Serialize(result);
            }
            catch (Exception ex) { return Json.Serialize(Error(ex.Message)); }
        }

        // Exclusao total: apaga TODOS os backups (legado e por dispositivo) e
        // cria a base vazia com a geracao nova. So e chamada pela acao
        // explicita "Iniciar novo caderno", nunca pelo fluxo de sincronizar.
        public async Task<string> ResetCloud(string payloadJson)
        {
            try
            {
                string access = await AccessToken();
                if (access == null) return Json.Serialize(Error(AuthError()));
                Dictionary<string, object> p = null;
                try { p = Json.Deserialize<Dictionary<string, object>>(payloadJson); }
                catch { return Json.Serialize(Error("Backup em formato invalido.")); }
                if (p == null) return Json.Serialize(Error("Backup em formato invalido."));
                List<Dictionary<string, object>> files = await ListBackups(access);
                int failures = 0;
                foreach (Dictionary<string, object> f in files)
                {
                    string id = Str(f, "id");
                    if (string.IsNullOrEmpty(id)) continue;
                    HttpRequestMessage del = new HttpRequestMessage(HttpMethod.Delete,
                        "https://www.googleapis.com/drive/v3/files/" + Uri.EscapeDataString(id));
                    del.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                    HttpResponseMessage dr = await Http.SendAsync(del);
                    if (dr.StatusCode != HttpStatusCode.NoContent &&
                        dr.StatusCode != HttpStatusCode.NotFound) failures++;
                }
                if (failures > 0)
                    return Json.Serialize(Error("Nao foi possivel apagar todos os backups antigos. Tente novamente."));
                Dictionary<string, object> result = await UploadPayload(
                    access, BackupNameFor(Str(p, "deviceId")), payloadJson);
                return Json.Serialize(result);
            }
            catch (Exception ex) { return Json.Serialize(Error(ex.Message)); }
        }

        public async Task<string> Restore()
        {
            try
            {
                string access = await AccessToken();
                if (access == null) return Json.Serialize(Error(AuthError()));
                List<Dictionary<string, object>> files = await ListBackups(access);
                if (files.Count == 0) return Json.Serialize(Error("Nenhum backup no Drive."));
                return await DownloadPayload(access, Str(files[0], "id"));
            }
            catch (Exception ex) { return Json.Serialize(Error(ex.Message)); }
        }

        // Baixa um candidato especifico. A validacao semantica (esquema,
        // checksum, versao) e feita no sync-ui.js, que conhece o formato v2.
        public async Task<string> RestoreFile(string fileId)
        {
            try
            {
                string access = await AccessToken();
                if (access == null) return Json.Serialize(Error(AuthError()));
                if (string.IsNullOrEmpty(fileId)) return await Restore();
                return await DownloadPayload(access, fileId);
            }
            catch (Exception ex) { return Json.Serialize(Error(ex.Message)); }
        }

        // ---- internos ----

        private static async Task<string> AccessToken()
        {
            Dictionary<string, object> t = LoadToken();
            string refresh = Str(t, "refresh_token");
            if (refresh == null) return null;
            Dictionary<string, string> client = LoadClient();
            if (client == null) return null;
            FormUrlEncodedContent body = new FormUrlEncodedContent(new Dictionary<string, string>()
            {
                { "client_id", client["id"] },
                { "client_secret", client["secret"] ?? "" },
                { "refresh_token", refresh },
                { "grant_type", "refresh_token" },
            });
            HttpResponseMessage resp = await Http.PostAsync("https://oauth2.googleapis.com/token", body);
            string s = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode) return null; // refresh revogado/expirado -> relogar
            Dictionary<string, object> tok = Json.Deserialize<Dictionary<string, object>>(s);
            return Str(tok, "access_token");
        }

        // Lista TODOS os backups (legado + um por dispositivo). O JS valida
        // cada candidato por esquema/checksum; o tamanho nunca e criterio.
        public async Task<string> CheckRemote()
        {
            try
            {
                string access = await AccessToken();
                if (access == null) return Json.Serialize(Error(AuthError()));
                List<Dictionary<string, object>> list = await ListBackups(access);
                List<Dictionary<string, object>> files = new List<Dictionary<string, object>>();
                long max = 0;
                foreach (Dictionary<string, object> f in list)
                {
                    long t = ParseMs(Str(f, "modifiedTime"));
                    if (t > max) max = t;
                    long size = 0;
                    long.TryParse(Str(f, "size"), out size);
                    Dictionary<string, object> item = new Dictionary<string, object>();
                    item["id"] = Str(f, "id");
                    item["name"] = Str(f, "name");
                    item["modifiedTime"] = t;
                    item["size"] = size;
                    files.Add(item);
                }
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["ok"] = true;
                r["exists"] = files.Count > 0;
                r["files"] = files;
                r["modifiedTime"] = max;
                return Json.Serialize(r);
            }
            catch (Exception ex) { return Json.Serialize(Error(ex.Message)); }
        }

        private static Dictionary<string, object> Error(string message)
        {
            return new Dictionary<string, object>()
                { { "ok", false }, { "error", message ?? "Falha inesperada." } };
        }

        private static bool HasRefreshToken()
        {
            Dictionary<string, object> t = LoadToken();
            return t != null && Str(t, "refresh_token") != null;
        }

        private static string AuthError()
        {
            return HasRefreshToken()
                ? "A sessao do Google expirou ou foi revogada. Entre novamente com a conta Google."
                : "Desconectado do Google. Entre com a conta Google.";
        }

        private static async Task<List<Dictionary<string, object>>> ListBackups(string access)
        {
            string url = "https://www.googleapis.com/drive/v3/files" +
                "?spaces=appDataFolder" +
                "&q=" + Uri.EscapeDataString("trashed=false") +
                "&fields=files(id,name,modifiedTime,size)&pageSize=100&orderBy=modifiedTime%20desc";
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
            HttpResponseMessage resp = await Http.SendAsync(req);
            string s = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
                throw new Exception("Check: " + Snip(s));
            Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(s);
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            object files;
            if (d == null || !d.TryGetValue("files", out files)) return list;
            ArrayList arr = files as ArrayList; // JavaScriptSerializer: ArrayList, nunca object[]
            if (arr == null) return list;
            foreach (object o in arr)
            {
                Dictionary<string, object> f = o as Dictionary<string, object>;
                if (f == null) continue;
                string name = Str(f, "name");
                if (string.IsNullOrEmpty(name)) continue;
                if (name.StartsWith("caderno-", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(name, "caderno-backup.json", StringComparison.OrdinalIgnoreCase))
                    list.Add(f);
            }
            return list;
        }

        private static async Task<Dictionary<string, object>> UploadPayload(
            string access, string name, string payloadJson)
        {
            Dictionary<string, object> existing = null;
            foreach (Dictionary<string, object> f in await ListBackups(access))
            {
                if (string.Equals(Str(f, "name"), name, StringComparison.OrdinalIgnoreCase))
                { existing = f; break; }
            }
            byte[] data = Encoding.UTF8.GetBytes(payloadJson ?? "{}");
            string fileId = existing == null ? null : Str(existing, "id");
            long serverMs = 0;
            if (existing == null)
            {
                string meta = "{\"name\":\"" + JsonEscape(name) + "\",\"parents\":[\"appDataFolder\"]}";
                MultipartContent mp = new MultipartContent("related");
                StringContent metaPart = new StringContent(meta, Encoding.UTF8, "application/json");
                ByteArrayContent mediaPart = new ByteArrayContent(data);
                mediaPart.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                mp.Add(metaPart);
                mp.Add(mediaPart);
                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Post,
                    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                req.Content = mp;
                HttpResponseMessage resp = await Http.SendAsync(req);
                string rs = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode) return Error("Upload: " + Snip(rs));
                Dictionary<string, object> created = Json.Deserialize<Dictionary<string, object>>(rs);
                fileId = Str(created, "id");
                serverMs = ParseMs(Str(created, "modifiedTime"));
            }
            else
            {
                ByteArrayContent content = new ByteArrayContent(data);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                HttpRequestMessage req = new HttpRequestMessage(new HttpMethod("PATCH"),
                    "https://www.googleapis.com/upload/drive/v3/files/" +
                    Uri.EscapeDataString(fileId) + "?uploadType=media&fields=id,modifiedTime");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                req.Content = content;
                HttpResponseMessage resp = await Http.SendAsync(req);
                string rs = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode) return Error("Upload: " + Snip(rs));
                Dictionary<string, object> updated = Json.Deserialize<Dictionary<string, object>>(rs);
                serverMs = ParseMs(Str(updated, "modifiedTime"));
            }
            if (serverMs == 0 && !string.IsNullOrEmpty(fileId))
                serverMs = await GetModifiedTime(access, fileId);
            if (serverMs == 0) serverMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = true;
            r["fileId"] = fileId;
            r["name"] = name;
            r["backedUpAt"] = serverMs;
            return r;
        }

        private static async Task<long> GetModifiedTime(string access, string fileId)
        {
            try
            {
                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get,
                    "https://www.googleapis.com/drive/v3/files/" + Uri.EscapeDataString(fileId) +
                    "?fields=modifiedTime");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                HttpResponseMessage resp = await Http.SendAsync(req);
                if (!resp.IsSuccessStatusCode) return 0;
                string s = await resp.Content.ReadAsStringAsync();
                Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(s);
                return ParseMs(Str(d, "modifiedTime"));
            }
            catch { return 0; }
        }

        private static async Task<string> DownloadPayload(string access, string fileId)
        {
            HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get,
                "https://www.googleapis.com/drive/v3/files/" + Uri.EscapeDataString(fileId) + "?alt=media");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
            HttpResponseMessage resp = await Http.SendAsync(req);
            string payload = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
                return Json.Serialize(Error("Download: " + Snip(payload)));
            if (string.IsNullOrEmpty(payload))
                return Json.Serialize(Error("Backup vazio."));
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = true;
            r["payload"] = payload;
            return Json.Serialize(r);
        }

        private static long ParseMs(string iso)
        {
            try
            {
                if (string.IsNullOrEmpty(iso)) return 0;
                DateTime mt = DateTime.Parse(iso, null,
                    System.Globalization.DateTimeStyles.RoundtripKind);
                return new DateTimeOffset(mt).ToUnixTimeMilliseconds();
            }
            catch { return 0; }
        }

        private static string BackupNameFor(string deviceId)
        {
            if (string.IsNullOrEmpty(deviceId)) return BackupName;
            StringBuilder sb = new StringBuilder();
            foreach (char c in deviceId)
            {
                if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_') sb.Append(c);
                if (sb.Length >= 64) break;
            }
            if (sb.Length == 0) return BackupName;
            return "caderno-ops-" + sb.ToString() + ".json";
        }

        private static bool PayloadHasData(Dictionary<string, object> p)
        {
            if (p == null) return false;
            object v;
            if (p.TryGetValue("ops", out v))
            {
                ArrayList a = v as ArrayList;
                if (a != null && a.Count > 0) return true;
            }
            if (p.TryGetValue("reg", out v))
            {
                string s = v as string;
                if (!string.IsNullOrEmpty(s) && s.Trim() != "[]" && s.Trim() != "{}") return true;
                ArrayList a = v as ArrayList;
                if (a != null && a.Count > 0) return true;
            }
            if (p.TryGetValue("state", out v))
            {
                Dictionary<string, object> st = v as Dictionary<string, object>;
                if (st != null && PayloadHasData(st)) return true;
            }
            if (p.TryGetValue("cfg", out v))
            {
                string s = v as string;
                if (!string.IsNullOrEmpty(s) && s.Trim() != "{}" && s.Trim() != "[]") return true;
                Dictionary<string, object> d = v as Dictionary<string, object>;
                if (d != null && d.Count > 0) return true;
            }
            return false;
        }

        private static string JsonEscape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static async Task<string> FetchEmail(string access)
        {
            try
            {
                HttpRequestMessage req = new HttpRequestMessage(HttpMethod.Get,
                    "https://openidconnect.googleapis.com/v1/userinfo");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                HttpResponseMessage resp = await Http.SendAsync(req);
                if (!resp.IsSuccessStatusCode) return "";
                string s = await resp.Content.ReadAsStringAsync();
                Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(s);
                return Str(d, "email") ?? "";
            }
            catch { return ""; }
        }

        private static string Snip(string s)
        {
            if (s == null) return "";
            s = s.Replace("\r", " ").Replace("\n", " ");
            return s.Length > 220 ? s.Substring(0, 220) : s;
        }
    }
}
