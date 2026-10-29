/* ==========================================================================
   Caderno de Cuidado — ponte Android (Capacitor) — exclusiva do pacote Android.

   O app web já sabe conversar com um host de sincronização: o MSIX usa
   window.chrome.webview.hostObjects.cadernoDrive (WebView2). Aqui expomos o
   MESMO contrato sobre os plugins nativos do Android, para que sync-ui.js e
   terms-modal.js rodem sem uma linha de alteração:

     GetState / CheckRemote / Restore / RestoreFile(fileId) / Backup(payload) /
     ResetCloud(payload) / Login / Logout / Quit / GetAppVersion
     ->  CadernoDrive (Java)

   Além disso: exportação de arquivos via Downloads (MediaStore), impressão
   nativa, botão Voltar, rótulos de acessibilidade e versão no modal de sync.
   ========================================================================== */
(function () {
  'use strict';

  // A camada de interface (menu do logo, aria, versão) vale mesmo se o
  // Capacitor não estiver disponível; os plugins nativos só são usados quando
  // existem (Drive, Files, Print, App). Assim o app não fica sem navegação
  // se a ponte nativa falhar.
  var Cap = window.cap || window.Capacitor || {};
  var P = Cap.Plugins || {};
  var Drive = P.CadernoDrive;
  var Files = P.CadernoFiles;
  var Print = P.CadernoPrint;
  var AppPlugin = P.App;

  var BUILD = (document.querySelector('meta[name="cc-build"]') || {}).content || '';
  var APP_VERSION = BUILD.replace(/^android-/, '');
  document.documentElement.classList.add('cc-android');

  /* ---------------------------------------------------------------- host -- */

  function call(name, args) {
    if (!Drive || typeof Drive[name] !== 'function') {
      return Promise.resolve({ ok: false, error: 'sem-host' });
    }
    var p;
    try {
      p = Drive[name](args || {});
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'host-broken' });
    }
    return Promise.resolve(p).catch(function (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    });
  }

  var hostObject = {
    GetState: function () { return call('getState'); },
    CheckRemote: function () { return call('checkRemote'); },
    Restore: function () { return call('restore'); },
    RestoreFile: function (fileId) {
      return call('restoreFile', { fileId: String(fileId == null ? '' : fileId) });
    },
    Backup: function (payload) { return call('backup', { payload: String(payload == null ? '' : payload) }); },
    ResetCloud: function (payload) {
      return call('resetCloud', { payload: String(payload == null ? '' : payload) });
    },
    Login: function () { return call('login'); },
    Logout: function () { return call('logout'); },
    GetAppVersion: function () {
      return call('getAppVersion').then(function (r) {
        if (r && r.version) APP_VERSION = String(r.version);
        paintStamp();
        return APP_VERSION;
      });
    },
    Quit: function () {
      try { if (AppPlugin) AppPlugin.exitApp(); } catch (e) {}
      return Promise.resolve({ ok: true });
    }
  };

  try {
    window.chrome = window.chrome || {};
    window.chrome.webview = window.chrome.webview || {};
    window.chrome.webview.hostObjects = window.chrome.webview.hostObjects || {};
    window.chrome.webview.hostObjects.cadernoDrive = hostObject;
  } catch (e) {
    /* Se o objeto já existir e estiver congelado, o app segue em modo local. */
  }

  /* --------------------------------------------------------- exportação -- */
  /* O bundle exporta com URL.createObjectURL(blob) + <a download>.click().
     O WebView do Android não implementa download de blob: guardamos o Blob,
     interceptamos o clique e gravamos em Downloads pelo plugin nativo. */

  var blobs = new Map();
  var nativeCreate = URL.createObjectURL;
  var nativeRevoke = URL.revokeObjectURL;

  URL.createObjectURL = function (obj) {
    var url = nativeCreate.call(URL, obj);
    try {
      if (obj instanceof Blob) {
        blobs.set(url, obj);
        setTimeout(function () { blobs.delete(url); }, 180000);
      }
    } catch (e) {}
    return url;
  };
  /* O app revoga logo após o clique; o Blob em si continua válido. Mantemos
     o mapa para que a gravação assíncrona ainda o encontre. */
  URL.revokeObjectURL = function (url) {
    try { nativeRevoke.call(URL, url); } catch (e) {}
  };

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function notify(msg) {
    try {
      if (AppPlugin && AppPlugin.toast) AppPlugin.toast({ text: msg });
    } catch (e) {}
    /* O app não expõe toast global; a exportação nativa já mostra um Toast. */
  }

  function saveBlob(name, blob) {
    if (!Files) return;
    blob.arrayBuffer().then(function (buf) {
      var base64 = bytesToBase64(new Uint8Array(buf));
      return Files.saveBase64({
        name: name,
        mime: blob.type || 'application/octet-stream',
        base64: base64
      });
    }).then(function (r) {
      if (!r || !r.ok) notify('Não foi possível salvar o arquivo.');
    }).catch(function () {
      notify('Não foi possível salvar o arquivo.');
    });
  }

  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      var href = this.getAttribute('href') || '';
      var download = this.getAttribute('download');
      if (download && blobs.has(href)) {
        saveBlob(download, blobs.get(href));
        return;
      }
      if (download && href.indexOf('data:') === 0) {
        var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(href);
        if (m) {
          var payload = m[2] ? m[3] : btoa(unescape(encodeURIComponent(decodeURIComponent(m[3]))));
          if (Files) {
            Files.saveBase64({ name: download, mime: m[1] || 'application/octet-stream', base64: payload });
          }
          return;
        }
      }
    } catch (e) {}
    return anchorClick.call(this);
  };

  /* ------------------------------------------------------------ impressão -- */
  var nativePrint = window.print;
  window.print = function () {
    if (!Print || typeof Print.print !== 'function') {
      nativePrint.call(window);
      return;
    }
    try {
      Print.print();
    } catch (e) {
      nativePrint.call(window);
    }
  };

  /* --------------------------------------------------------- navegação ---- */
  function labelNav() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      var btn = items[i];
      if (btn.getAttribute('aria-label')) continue;
      var span = btn.querySelector('span:not(.nav-count)');
      var text = span ? span.textContent.trim() : btn.textContent.trim();
      if (text) {
        btn.setAttribute('aria-label', text);
        btn.title = text;
      }
    }
  }

  /* ------------------------------------------------ menu do logo (telefone) */
  /* Em <=640 px o rail de 78 px sai do layout. O emblema do programa fica
     fixo no canto e abre um painel com as abas; fechar é tocar de novo nele,
     no fundo escurecido, em uma aba, no Voltar ou com Escape. */
  var NAV_BP = 640;
  var navOpen = false;

  function navSmall() {
    return window.innerWidth <= NAV_BP;
  }

  function navScrim() {
    return document.getElementById('cc-nav-scrim');
  }

  function ensureNavScrim() {
    if (navScrim()) return;
    var s = document.createElement('div');
    s.id = 'cc-nav-scrim';
    s.setAttribute('aria-hidden', 'true');
    document.body.appendChild(s);
  }

  function prepareNavTrigger() {
    var lock = document.querySelector('.brand-lockup');
    if (!lock) return null;
    var side = document.querySelector('.sidebar');
    if (side && !side.id) side.id = 'cc-sidebar';
    if (lock.getAttribute('role') !== 'button') {
      lock.setAttribute('role', 'button');
      lock.setAttribute('tabindex', '0');
    }
    lock.setAttribute('aria-expanded', navOpen ? 'true' : 'false');
    lock.setAttribute('aria-label',
      navOpen ? 'Fechar menu de navegação' : 'Abrir menu de navegação');
    if (side) lock.setAttribute('aria-controls', side.id);
    return lock;
  }

  function openMobileNav() {
    if (!navSmall() || navOpen) return;
    if (document.querySelector('.modal-backdrop, #cc-sync-overlay, #cc-terms-overlay')) {
      return;
    }
    navOpen = true;
    document.documentElement.classList.add('cc-nav-open');
    ensureNavScrim();
    prepareNavTrigger();
    /* O foco fica no próprio emblema (como um disclosure): Tab entra nas
       abas. Focar a aba ativa aqui pintava um anel de foco no toque. */
  }

  function closeMobileNav(restoreFocus) {
    if (!navOpen) return false;
    navOpen = false;
    document.documentElement.classList.remove('cc-nav-open');
    var s = navScrim();
    if (s && s.parentNode) s.parentNode.removeChild(s);
    var lock = prepareNavTrigger();
    if (restoreFocus && lock) {
      try { lock.focus({ preventScroll: true }); } catch (e) {}
    }
    return true;
  }

  function syncMobileNav() {
    if (!navSmall()) {
      if (navOpen) closeMobileNav(false);
      var scrim = navScrim();
      if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
      var lock = document.querySelector('.brand-lockup');
      if (lock) {
        lock.removeAttribute('role');
        lock.removeAttribute('tabindex');
        lock.removeAttribute('aria-expanded');
        lock.removeAttribute('aria-controls');
        lock.removeAttribute('aria-label');
      }
      document.documentElement.classList.remove('cc-hide-nav');
      return;
    }
    prepareNavTrigger();
    var overlay = document.querySelector(
      '.modal-backdrop, #cc-sync-overlay, #cc-terms-overlay');
    if (overlay) {
      if (navOpen) closeMobileNav(false);
      document.documentElement.classList.add('cc-hide-nav');
    } else {
      document.documentElement.classList.remove('cc-hide-nav');
    }
  }

  document.addEventListener('click', function (e) {
    if (!navSmall()) return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.brand-lockup')) {
      e.preventDefault();
      if (navOpen) closeMobileNav(true);
      else openMobileNav();
      return;
    }
    if (t.closest('#cc-nav-scrim')) {
      closeMobileNav(false);
      return;
    }
    if (navOpen && t.closest('.nav-item')) {
      /* deixa o React trocar a tela antes de esconder o painel; a nova aba
         abre no topo (sem herdar a rolagem da aba anterior) */
      setTimeout(function () {
        closeMobileNav(false);
        try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch (e) {}
      }, 30);
      return;
    }
    if (navOpen && !t.closest('.sidebar')) closeMobileNav(false);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!navSmall()) return;
    if (e.key === 'Escape' && navOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeMobileNav(true);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') &&
        e.target instanceof Element && e.target.closest('.brand-lockup')) {
      e.preventDefault();
      e.stopPropagation();
      if (navOpen) closeMobileNav(true);
      else openMobileNav();
    }
  }, true);

  window.addEventListener('resize', function () { syncMobileNav(); });

  // Emblema flutuante: visível no topo, recolhe ao descer (não cobre o
  // cartão), volta ao subir. O menu continua acessível com um gesto para cima.
  var lastLogoScrollY = 0;
  function syncLogoOnScroll() {
    if (!navSmall()) {
      document.documentElement.classList.remove('cc-logo-hidden');
      lastLogoScrollY = window.scrollY;
      return;
    }
    var y = window.scrollY;
    if (navOpen || y <= 24) {
      document.documentElement.classList.remove('cc-logo-hidden');
    } else if (y > lastLogoScrollY + 8) {
      document.documentElement.classList.add('cc-logo-hidden');
    } else if (y < lastLogoScrollY - 8) {
      document.documentElement.classList.remove('cc-logo-hidden');
    }
    lastLogoScrollY = y;
  }
  window.addEventListener('scroll', syncLogoOnScroll, { passive: true });

  function closeTopOverlay() {
    var terms = document.getElementById('cc-terms-overlay');
    if (terms) return true; /* aceite é bloqueante: Voltar não contorna */

    var sync = document.getElementById('cc-sync-overlay');
    if (sync) {
      var close = document.getElementById('cc-m-close');
      if (close) close.click();
      else if (sync.parentNode) sync.parentNode.removeChild(sync);
      return true;
    }

    var backdrop = document.querySelector('.modal-backdrop');
    if (backdrop) {
      /* Os painéis fecham no mousedown cujo target é o próprio backdrop. */
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return true;
    }
    return false;
  }

  function goHomeIfNeeded() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return false;
    var active = nav.querySelector('.nav-item.active');
    var first = nav.querySelector('.nav-item');
    if (active && first && active !== first) {
      first.click();
      return true;
    }
    return false;
  }

  try {
    if (AppPlugin && AppPlugin.addListener) {
      AppPlugin.addListener('backButton', function () {
        if (closeMobileNav(true)) return;
        if (closeTopOverlay()) return;
        if (goHomeIfNeeded()) return;
        if (AppPlugin.minimizeApp) AppPlugin.minimizeApp();
      });
    }
  } catch (e) {}

  /* -------------------------------------------------- modal de sincronização */
  function paintStamp() {
    var modal = document.getElementById('cc-sync-modal');
    if (!modal) return;
    var old = modal.querySelector('.cc-android-stamp');
    if (old) old.parentNode.removeChild(old);
    var hint = document.createElement('div');
    hint.className = 'hint cc-android-stamp';
    hint.textContent = 'Caderno de Cuidado para Android · versão ' + (APP_VERSION || '—');
    var close = modal.querySelector('.close');
    if (close) modal.insertBefore(hint, close);
    else modal.appendChild(hint);
  }

  /* ------------------------------------------------------ service worker -- */
  /* O app é offline por natureza no APK; um SW cacheando https://localhost
     só criaria risco de servir bundle velho depois de uma atualização. */
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        for (var i = 0; i < rs.length; i++) rs[i].unregister();
      }).catch(function () {});
    }
  } catch (e) {}

  /* ------------------------------------------------------------ observers -- */
  function tick() {
    syncMobileNav();
    labelNav();
    paintStamp();
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      tick();
    }, 250);
  }

  try {
    var obs = new MutationObserver(schedule);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  setInterval(tick, 2500);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
  window.addEventListener('load', tick);
})();
