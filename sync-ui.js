/* Sincronizacao Caderno de Cuidado: botao unico + modal + Google Drive.
   Reusa os botoes originais de export/import (clicados de forma oculta).
   Fala com o Launcher MSIX via window.chrome.webview.hostObjects.sync. */
(function () {
  'use strict';
  var REG_KEY = 'caderno-cuidado-registros-v1';
  var CFG_KEY = 'caderno-cuidado-config-v1';
  var META_KEY = 'caderno-drive-sync-v1';
  var CONTACT_TTL = 15 * 60 * 1000;   // contato Drive vale por 15 min
  var BLUE_MS = 4000;                 // "acabou de salvar" dura 4 s
  var AUTOSYNC_DELAY = 12000;         // auto-backup 12 s apos alteracao

  function host() {
    try {
      return (window.chrome && window.chrome.webview &&
              window.chrome.webview.hostObjects &&
              window.chrome.webview.hostObjects.sync) || null;
    } catch (e) { return null; }
  }
  function snapshot() {
    return { reg: localStorage.getItem(REG_KEY), cfg: localStorage.getItem(CFG_KEY) };
  }
  function hash(snap) {
    var s = (snap.reg || '') + '|' + (snap.cfg || '');
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  function meta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveMeta(m) { localStorage.setItem(META_KEY, JSON.stringify(m)); }

  var state = {
    signedIn: false, email: '', lastContactAt: 0,
    lastHash: hash(snapshot()), blueUntil: 0, backupBusy: false,
    lastChangeAt: 0, cur: 'idle', timer: null
  };
  var m = meta();
  var btn = null, statusEl = null, overlay = null;

  var LABEL = {
    ok:    'Sincronizado com o Google Drive',
    saved: 'Salvo agora — atualizando...',
    idle:  'Sem contato com o Drive — nada a perder',
    risk:  'Sem contato com o Drive — HÁ alterações não salvas!'
  };

  function compute() {
    var now = Date.now();
    var h = hash(snapshot());
    if (h !== state.lastHash) {
      state.lastHash = h;
      state.lastChangeAt = now;
      state.blueUntil = now + BLUE_MS;
    }
    var mm = meta();
    var dirty = h !== mm.lastSyncedHash;
    var online = state.signedIn && (now - state.lastContactAt) < CONTACT_TTL;
    var s;
    if (now < state.blueUntil || state.backupBusy) s = 'saved';
    else if (!online && dirty) s = 'risk';
    else if (!online && !dirty) s = 'idle';
    else if (online && !dirty) s = 'ok';
    else s = 'saved'; // online + dirty => sincronizando em instantes
    return { s: s, dirty: dirty, online: online, hash: h };
  }

  function paint() {
    var c = compute();
    state.cur = c.s;
    if (btn) {
      btn.setAttribute('data-state', c.s);
      btn.title = 'Sincronizar — ' + LABEL[c.s];
    }
    if (statusEl) renderStatus(c);
    // auto-backup quando logado e ha alteracoes ha mais de AUTOSYNC_DELAY
    if (c.dirty && state.signedIn && !state.backupBusy &&
        (Date.now() - state.lastChangeAt) > AUTOSYNC_DELAY) {
      doBackup(true);
    }
  }

  function fmtTime(ts) {
    if (!ts) return 'nunca';
    try { return new Date(ts).toLocaleString('pt-BR'); } catch (e) { return ''; }
  }

  function renderStatus(c) {
    c = c || compute();
    var mm = meta();
    var dot = { ok: '#1B7A43', saved: '#2563EB', idle: '#CA8A04', risk: '#DC2626' }[c.s];
    var acc = state.signedIn
      ? 'Conectado: ' + esc(state.email || 'conta Google')
      : 'Google Drive: desconectado';
    statusEl.innerHTML =
      '<div><span class="dot" style="background:' + dot + '"></span><b>' + LABEL[c.s] + '</b></div>' +
      '<div style="margin-top:5px">' + acc + '<br>Última sincronização: ' + fmtTime(mm.lastBackupAt) + '</div>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function origBtn(title) {
    var els = document.querySelectorAll('button[title="' + title + '"]');
    return els.length ? els[0] : null;
  }

  function doExport() {
    var b = origBtn('Exportar backup JSON');
    if (b) b.click();
    closeModal();
  }
  function doImport() {
    var b = origBtn('Importar backup JSON ou CSV');
    if (b) b.click();
    closeModal();
  }

  function parseRes(p) {
    return Promise.resolve(p).then(function (r) {
      if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { ok: false, error: r }; } }
      return r || {};
    });
  }

  function refreshHostState() {
    var h = host();
    if (!h) return Promise.resolve();
    return parseRes(h.GetState()).then(function (st) {
      state.signedIn = !!st.signedIn;
      state.email = st.email || '';
      if (st.reachable) state.lastContactAt = Date.now();
      paint();
    }).catch(function () {});
  }

  function doLogin() {
    var h = host();
    if (!h) return;
    setBusy(true);
    parseRes(h.Login()).then(function (r) {
      setBusy(false);
      if (r.ok) {
        state.signedIn = true; state.email = r.email || '';
        state.lastContactAt = Date.now(); state.blueUntil = Date.now() + BLUE_MS;
      } else {
        alert('Falha no login Google: ' + (r.error || 'desconhecido'));
      }
      paint();
    });
  }
  function doLogout() {
    var h = host();
    if (!h) return;
    parseRes(h.Logout()).then(function () {
      state.signedIn = false; state.email = ''; paint();
    });
  }
  function doBackup(auto) {
    var h = host();
    if (!h || state.backupBusy) return;
    var snap = snapshot();
    if (!snap.reg && !snap.cfg) { if (!auto) alert('Nada para sincronizar.'); return; }
    state.backupBusy = true; paint();
    var payload = JSON.stringify({ v: 1, savedAt: new Date().toISOString(), reg: snap.reg, cfg: snap.cfg });
    parseRes(h.Backup(payload)).then(function (r) {
      state.backupBusy = false;
      if (r.ok) {
        var mm = meta();
        mm.lastSyncedHash = hash(snapshot());
        mm.lastBackupAt = r.backedUpAt || Date.now();
        saveMeta(mm);
        state.lastContactAt = Date.now();
        state.blueUntil = Date.now() + BLUE_MS;
      } else if (!auto) {
        alert('Falha ao enviar para o Drive: ' + (r.error || 'desconhecido'));
      }
      paint();
    });
  }
  function doRestore() {
    var h = host();
    if (!h) return;
    if (!confirm('Substituir os dados deste aparelho pelos dados do Google Drive?')) return;
    setBusy(true);
    parseRes(h.Restore()).then(function (r) {
      setBusy(false);
      if (r.ok && r.payload) {
        var p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        if (p.reg !== undefined && p.reg !== null) localStorage.setItem(REG_KEY, p.reg); else localStorage.removeItem(REG_KEY);
        if (p.cfg !== undefined && p.cfg !== null) localStorage.setItem(CFG_KEY, p.cfg); else localStorage.removeItem(CFG_KEY);
        var mm = meta();
        mm.lastSyncedHash = hash(snapshot());
        mm.lastBackupAt = Date.now();
        saveMeta(mm);
        state.lastContactAt = Date.now();
        location.reload();
      } else {
        alert('Falha ao baixar do Drive: ' + (r.error || 'nenhum backup encontrado'));
      }
      paint();
    });
  }

  var busyCount = 0;
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    var o = document.getElementById('cc-sync-overlay');
    if (o) o.style.cursor = busyCount ? 'wait' : '';
  }

  function openModal() {
    closeModal();
    refreshHostState();
    overlay = document.createElement('div');
    overlay.id = 'cc-sync-overlay';
    var hasHost = !!host();
    overlay.innerHTML =
      '<div id="cc-sync-modal" role="dialog" aria-label="Sincronizar">' +
        '<h2>Sincronizar dados</h2>' +
        '<div id="cc-sync-status"></div>' +
        '<div class="row">' +
          '<button class="action primary" id="cc-m-sync">Sincronizar agora</button>' +
          '<button class="action" id="cc-m-export">Exportar</button>' +
          '<button class="action" id="cc-m-import">Importar</button>' +
        '</div>' +
        '<div class="row">' +
          (state.signedIn
            ? '<button class="action" id="cc-m-restore">Baixar do Drive</button>' +
              '<button class="action" id="cc-m-logout">Sair do Google</button>'
            : '<button class="action primary" id="cc-m-login" style="flex:2">Entrar com Google</button>') +
        '</div>' +
        (hasHost ? '' : '<div class="hint">Login Google disponível somente no app instalado (Microsoft Store). Neste modo, use Exportar/Importar.</div>') +
        '<button class="close" id="cc-m-close">Fechar</button>' +
      '</div>';
    document.body.appendChild(overlay);
    statusEl = document.getElementById('cc-sync-status');
    renderStatus();
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    document.getElementById('cc-m-close').onclick = closeModal;
    document.getElementById('cc-m-export').onclick = doExport;
    document.getElementById('cc-m-import').onclick = doImport;
    var bs = document.getElementById('cc-m-sync');
    if (bs) { bs.disabled = !hasHost || !state.signedIn; bs.onclick = function () { doBackup(false); }; }
    var bl = document.getElementById('cc-m-login');
    if (bl) { bl.disabled = !hasHost; bl.onclick = doLogin; }
    var bo = document.getElementById('cc-m-logout');
    if (bo) bo.onclick = function () { doLogout(); closeModal(); };
    var br = document.getElementById('cc-m-restore');
    if (br) br.onclick = doRestore;
  }
  function closeModal() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; statusEl = null;
  }

  function install() {
    var imp = origBtn('Importar backup JSON ou CSV');
    var exp = origBtn('Exportar backup JSON');
    if (!imp || !exp) return false;
    var parent = imp.parentNode;
    imp.style.display = 'none';
    exp.style.display = 'none';
    btn = document.createElement('button');
    btn.id = 'cc-sync-btn';
    btn.setAttribute('data-state', 'idle');
    btn.setAttribute('aria-label', 'Sincronizar dados');
    btn.innerHTML = '&#8646;'; // ⇄
    btn.onclick = openModal;
    parent.insertBefore(btn, imp);
    paint();
    if (!state.timer) {
      state.timer = setInterval(paint, 2000);
      setInterval(refreshHostState, 30000);
      refreshHostState();
    }
    return true;
  }

  var tries = 0;
  var boot = setInterval(function () {
    if (install() || ++tries > 60) clearInterval(boot);
  }, 500);
  // Reinstala se o React redesenhar o cabecalho
  var obs = new MutationObserver(function () {
    if (!document.getElementById('cc-sync-btn')) install();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
