/* Sincronizacao Caderno de Cuidado: botao unico + modal + Google Drive.
   Reusa os botoes originais de export/import (clicados de forma oculta).
   Fala com o Launcher MSIX via window.chrome.webview.hostObjects.cadernoDrive.
   (O nome "sync" e reservado pelo WebView2 e nao pode ser usado.) */
(function () {
  'use strict';
  var REG_KEY = 'caderno-cuidado-registros-v1';
  var CFG_KEY = 'caderno-cuidado-config-v1';
  var META_KEY = 'caderno-drive-sync-v1';
  var CONTACT_TTL = 15 * 60 * 1000;   // contato Drive vale por 15 min
  var BLUE_MS = 4000;                 // "acabou de salvar" dura 4 s
  var AUTOSYNC_DELAY = 12000;         // auto-backup 12 s apos alteracao
  var POLL_MS = 60000;                // verifica a nuvem a cada 60 s
  var IDLE_MS = 30000;                // recarrega sozinho se ocioso ha 30 s

  function host() {
    try {
      return (window.chrome && window.chrome.webview &&
              window.chrome.webview.hostObjects &&
              window.chrome.webview.hostObjects.cadernoDrive) || null;
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
    lastHash: null, blueUntil: 0, backupBusy: false,
    lastChangeAt: 0, cur: 'idle', timer: null, hostBroken: false,
    lastActivityAt: Date.now(), pendingRemote: false, pulling: false
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
    if (state.lastHash === null) state.lastHash = h;
    if (h !== state.lastHash) {
      state.lastHash = h;
      state.lastChangeAt = now;
      state.blueUntil = now + BLUE_MS;
      try {
        var mm0 = meta(); mm0.lastLocalChangeAt = now; saveMeta(mm0);
      } catch (e) {}
    }
    var mm = meta();
    var snap = snapshot();
    // Base vazia (instalacao nova, sem nenhum dado): nada a perder => limpo
    var dirty = !!(snap.reg || snap.cfg) && h !== mm.lastSyncedHash;
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
    // recarrega pendente de atualizacao remota quando ocioso
    if (state.pendingRemote && state.signedIn && !state.backupBusy &&
        (Date.now() - state.lastActivityAt) > IDLE_MS &&
        !overlay && !document.getElementById('cc-terms-overlay')) {
      state.pendingRemote = false;
      pullFromCloud();
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

  // Chama o host object (C#) sem NUNCA lancar excecao: se o host falhar
  // (ex. 0x80070490), marca hostBroken e o app segue com import/export local.
  function callHost(name, arg) {
    var h = host();
    if (!h) return Promise.resolve({ ok: false, error: 'sem-host' });
    var p;
    try {
      p = (arg === undefined) ? h[name]() : h[name](arg);
    } catch (e) {
      state.hostBroken = true;
      return Promise.resolve({ ok: false, error: 'host-broken' });
    }
    return parseRes(p).then(function (r) {
      if (r && (r.error === 'host-broken' || r.error === 'sem-host')) state.hostBroken = true;
      return r;
    }).catch(function () {
      state.hostBroken = true;
      return { ok: false, error: 'host-broken' };
    });
  }

  function markActivity() { state.lastActivityAt = Date.now(); state.pendingRemote = false; }
  try {
    document.addEventListener('keydown', markActivity, true);
    document.addEventListener('pointerdown', markActivity, true);
  } catch (e) {}

  // Ancoragem: apos enviar, le o modifiedTime oficial do servidor
  function anchorRemote() {
    return callHost('CheckRemote').then(function (r) {
      if (r && r.ok && r.exists && r.modifiedTime) {
        var mm = meta();
        mm.lastSeenRemote = r.modifiedTime;
        mm.lastBackupAt = r.modifiedTime;
        saveMeta(mm);
        state.lastContactAt = Date.now();
      }
    });
  }

  // Regra last-write-wins: o lado mais recente vence.
  function pullFromCloud() {
    if (!host() || state.hostBroken || !state.signedIn || state.backupBusy || state.pulling) {
      return Promise.resolve();
    }
    state.pulling = true;
    return callHost('CheckRemote').then(function (r) {
      state.pulling = false;
      if (!r || !r.ok || !r.exists || !r.modifiedTime) return;
      var mm = meta();
      if (r.modifiedTime <= (mm.lastSeenRemote || 0)) return; // nada novo
      state.lastContactAt = Date.now();
      return callHost('Restore').then(function (rr) {
        if (!rr || !rr.ok || !rr.payload) return;
        var p = typeof rr.payload === 'string' ? JSON.parse(rr.payload) : rr.payload;
        var remoteHash = hash({ reg: (p.reg === undefined ? null : p.reg),
                               cfg: (p.cfg === undefined ? null : p.cfg) });
        var localH = hash(snapshot());
        var mm2 = meta();
        if (remoteHash === localH) {
          mm2.lastSeenRemote = r.modifiedTime;
          mm2.lastBackupAt = r.modifiedTime;
          mm2.lastSyncedHash = localH;
          saveMeta(mm2);
          paint();
          return;
        }
        var remoteTime = r.modifiedTime;
        var localTime = mm2.lastLocalChangeAt || 0;
        if (remoteTime >= localTime) {
          applyRemote(p, remoteTime);   // nuvem venceu
        } else {
          mm2.lastSeenRemote = remoteTime; // local venceu: sobe o daqui
          saveMeta(mm2);
          doBackup(true);
        }
      });
    }).catch(function () { state.pulling = false; });
  }

  function applyRemote(p, remoteTime) {
    try {
      if (p.reg !== undefined && p.reg !== null) localStorage.setItem(REG_KEY, p.reg);
      else localStorage.removeItem(REG_KEY);
      if (p.cfg !== undefined && p.cfg !== null) localStorage.setItem(CFG_KEY, p.cfg);
      else localStorage.removeItem(CFG_KEY);
      var mm = meta();
      mm.lastSyncedHash = hash(snapshot());
      mm.lastBackupAt = remoteTime;
      mm.lastSeenRemote = remoteTime;
      saveMeta(mm);
      state.lastHash = mm.lastSyncedHash;
    } catch (e) { return; }
    var idle = (Date.now() - state.lastActivityAt) > IDLE_MS;
    var modalOpen = !!overlay || !!document.getElementById('cc-terms-overlay');
    if (idle && !modalOpen && !state.backupBusy) {
      location.reload();
    } else {
      state.pendingRemote = true; // tenta de novo no proximo poll
    }
  }

  function refreshHostState() {
    var h = host();
    if (!h || state.hostBroken) return Promise.resolve();
    return callHost('GetState').then(function (st) {
      if (!st || st.error) return;
      state.signedIn = !!st.signedIn;
      state.email = st.email || '';
      if (st.reachable) state.lastContactAt = Date.now();
      paint();
    });
  }

  function doLogin() {
    if (!host() || state.hostBroken) return;
    setBusy(true);
    callHost('Login').then(function (r) {
      setBusy(false);
      if (r.ok) {
        state.signedIn = true; state.email = r.email || '';
        state.lastContactAt = Date.now(); state.blueUntil = Date.now() + BLUE_MS;
        paint();
        pullFromCloud(); // baixa da nuvem logo apos logar
      } else if (r.error !== 'host-broken') {
        alert('Falha no login Google: ' + (r.error || 'desconhecido'));
      }
      paint();
    });
  }
  function doLogout() {
    if (!host()) return;
    callHost('Logout').then(function () {
      state.signedIn = false; state.email = ''; paint();
    });
  }
  function doBackup(auto) {
    if (!host() || state.hostBroken || state.backupBusy) return;
    var snap = snapshot();
    if (!snap.reg && !snap.cfg) { if (!auto) alert('Nada para sincronizar.'); return; }
    state.backupBusy = true; paint();
    var payload = JSON.stringify({ v: 1, savedAt: new Date().toISOString(), reg: snap.reg, cfg: snap.cfg });
    callHost('Backup', payload).then(function (r) {
      state.backupBusy = false;
      if (r.ok) {
        var mm = meta();
        mm.lastSyncedHash = hash(snapshot());
        mm.lastBackupAt = r.backedUpAt || Date.now();
        saveMeta(mm);
        state.lastContactAt = Date.now();
        state.blueUntil = Date.now() + BLUE_MS;
        anchorRemote(); // carimbo oficial do servidor
      } else if (!auto) {
        alert('Falha ao enviar para o Drive: ' + (r.error || 'desconhecido'));
      }
      paint();
    });
  }
  function doRestore() {
    if (!host()) return;
    if (!confirm('Substituir os dados deste aparelho pelos dados do Google Drive?')) return;
    setBusy(true);
    callHost('Restore').then(function (r) {
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
    // Monta o modal ANTES de qualquer chamada ao host: o clique sempre responde.
    var hasHost = !!host() && !state.hostBroken;
    overlay = document.createElement('div');
    overlay.id = 'cc-sync-overlay';
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
    refreshHostState(); // depois do modal montado: nunca bloqueia o clique
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
      setInterval(function () {
        if (state.signedIn && !state.hostBroken) pullFromCloud();
      }, POLL_MS);
      refreshHostState();
    }
    return true;
  }

  var tries = 0;
  var boot = setInterval(function () {
    try {
      if (install() || ++tries > 60) clearInterval(boot);
    } catch (e) { if (++tries > 60) clearInterval(boot); }
  });
  // Reinstala se o React redesenhar o cabecalho
  var obs = new MutationObserver(function () {
    if (!document.getElementById('cc-sync-btn')) install();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
