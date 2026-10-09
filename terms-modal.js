/* Modal bloqueante de aceite — exibido na primeira execucao e sempre que
   TERMS_VERSION mudar. Sem aceite registrado, o app nao e liberado.
   Aceite salvo em localStorage (flag + versao dos termos + instalacao). */
(function () {
  'use strict';
  var TERMS_VERSION = '1.0';
  var KEY = 'caderno-termos-v1';
  var CONTACT_EMAIL = 'mmr05@hotmail.com';
  var CONTACT_PHONE = '11978831938';

  var TABS = [
    {
      id: 'priv', label: 'Políticas de Privacidade',
      html:
        '<h3>Quais dados são coletados</h3>' +
        '<p>O Caderno de Cuidado registra os dados que você cadastra no aplicativo: informações de gestantes e bebês acompanhados (identificação, consultas, eventos, observações) e dados da equipe de saúde. Quando você ativa a sincronização opcional com o Google Drive, também são tratados seu nome e e-mail da conta Google, exclusivamente para identificar a conta conectada.</p>' +
        '<h3>Como são armazenados</h3>' +
        '<p>Por padrão, todos os dados ficam somente no seu dispositivo (armazenamento local do aplicativo). Se você ativar o backup, uma cópia é guardada na pasta reservada do aplicativo dentro do seu próprio Google Drive. O token de acesso fica protegido no seu aparelho pelos recursos de segurança do Windows.</p>' +
        '<h3>Como são utilizados</h3>' +
        '<p>Os dados são usados apenas para as funcionalidades do aplicativo: organizar cadastros, calcular próximas consultas, exibir cronologias e gerar exportações. Não utilizamos seus dados para publicidade, perfilamento ou qualquer finalidade diversa.</p>' +
        '<h3>Direitos do usuário sobre os dados (LGPD/GDPR)</h3>' +
        '<p>Você pode consultar, corrigir e excluir seus dados a qualquer momento dentro do aplicativo. Pode ainda revogar o acesso à sua conta Google quando quiser. A desinstalação do aplicativo pode remover os dados locais — exporte ou sincronize antes, se precisar mantê-los.</p>' +
        '<h3>Como contatar o desenvolvedor</h3>' +
        '<p>E-mail: ' + CONTACT_EMAIL + '<br>Telefone/WhatsApp: ' + CONTACT_PHONE + '</p>'
    },
    {
      id: 'uso', label: 'Termos de Uso',
      html:
        '<h3>Como o aplicativo funciona</h3>' +
        '<p>O Caderno de Cuidado é uma agenda digital de apoio ao acompanhamento de gestantes e bebês: cadastros, agenda de consultas, registro de eventos e exportação de dados. Funciona offline; a sincronização com o Google Drive é opcional e ativada por você.</p>' +
        '<h3>Uso permitido</h3>' +
        '<p>O aplicativo destina-se ao uso lícito em atividades de cuidado em saúde, por profissionais, equipes e responsáveis. Você é responsável por possuir autorização para registrar os dados inseridos e por tratá-los conforme a legislação aplicável.</p>' +
        '<h3>O que é permitido e o que é proibido</h3>' +
        '<p>É permitido instalar e usar o aplicativo nos seus dispositivos para a finalidade descrita. É proibido: usar o aplicativo para qualquer atividade ilegal; tentar copiar, modificar, descompilar ou revender o aplicativo; inserir dados falsos ou de terceiros sem autorização; e burlar os mecanismos de licenciamento.</p>' +
        '<h3>Propriedade intelectual</h3>' +
        '<p>Todos os direitos sobre o aplicativo — código, layout, marcas, textos e atualizações — pertencem ao desenvolvedor. Estes termos concedem apenas uma licença pessoal, intransferível e revogável de uso, sem transferência de propriedade.</p>' +
        '<h3>Versão de demonstração gratuita</h3>' +
        '<p>Esta é uma versão de demonstração gratuita, válida por <b>um mês após a primeira instalação</b> neste aparelho. Para continuar usando após esse prazo, adquira a versão licenciada.</p>' +
        '<h3>Como adquirir a versão licenciada</h3>' +
        '<p>E-mail: ' + CONTACT_EMAIL + '<br>Telefone/WhatsApp: ' + CONTACT_PHONE + '</p>'
    },
    {
      id: 'aviso', label: 'Aviso Legal',
      html:
        '<h3>Limites de uso para manter a legalidade</h3>' +
        '<p>Use o aplicativo somente para as finalidades descritas nestes termos e em conformidade com as leis vigentes, incluindo as normas de proteção de dados (LGPD/GDPR) e os regulamentos da sua instituição de saúde.</p>' +
        '<h3>Isenção de responsabilidade por funcionalidades não projetadas</h3>' +
        '<p>O aplicativo é uma ferramenta de apoio organizacional e não substitui prontuários oficiais, sistemas institucionais ou o julgamento clínico. Não nos responsabilizamos por decisões tomadas com base exclusiva nas informações exibidas, nem pelo uso do aplicativo para finalidades para as quais ele não foi projetado.</p>' +
        '<h3>Isenção de responsabilidade por uso indevido</h3>' +
        '<p>Não nos responsabilizamos por danos decorrentes de uso indevido, inserção de dados incorretos ou sem autorização, perda de dados por falta de backup, falhas do dispositivo, da conta Google ou de serviços de terceiros. O aplicativo é fornecido no estado em que se encontra.</p>'
    }
  ];

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; }
    catch (e) { return {}; }
  }
  function save(o) { localStorage.setItem(KEY, JSON.stringify(o)); }

  function host() {
    try {
      return (window.chrome && window.chrome.webview &&
              window.chrome.webview.hostObjects &&
              window.chrome.webview.hostObjects.cadernoDrive) || null;
    } catch (e) { return null; }
  }

  function blackout() {
    document.documentElement.innerHTML = '';
    var d = document.createElement('div');
    d.id = 'cc-blackout';
    document.documentElement.appendChild(d);
    try { window.stop(); } catch (e) {}
  }

  function quitApp() {
    // 1) Pede ao app instalado para encerrar de verdade
    try {
      var h = host();
      if (h && h.Quit) { try { h.Quit(); } catch (e) {} }
    } catch (e) {}
    // 2) Tenta fechar a janela (funciona se aberta via script)
    try { window.close(); } catch (e) {}
    // 3) Fallback garantido: tela totalmente escurecida, sem nada utilizavel
    setTimeout(blackout, 400);
  }

  function show() {
    var ov = document.createElement('div');
    ov.id = 'cc-terms-overlay';
    var tabsBtns = '', i;
    for (i = 0; i < TABS.length; i++) {
      tabsBtns += '<button data-tab="' + i + '"' + (i === 0 ? ' class="active"' : '') + '>' +
                  TABS[i].label + '</button>';
    }
    ov.innerHTML =
      '<div id="cc-terms-modal" role="dialog" aria-modal="true" aria-label="Termos e Condições de Uso">' +
        '<header><h2>Termos e Condições de Uso</h2><small>Versão dos termos: v' + TERMS_VERSION +
        ' — leia as 3 abas para liberar o aplicativo</small></header>' +
        '<div id="cc-terms-tabs">' + tabsBtns + '</div>' +
        '<div id="cc-terms-body"><div id="cc-terms-text"></div></div>' +
        '<div id="cc-terms-footer">' +
          '<button id="cc-btn-quit">Quero sair</button>' +
          '<button id="cc-btn-accept">Eu concordo</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var text = ov.querySelector('#cc-terms-text');
    function select(idx) {
      var btns = ov.querySelectorAll('#cc-terms-tabs button');
      var k;
      for (k = 0; k < btns.length; k++) {
        if (parseInt(btns[k].getAttribute('data-tab'), 10) === idx) btns[k].className = 'active';
        else btns[k].className = '';
      }
      text.innerHTML = TABS[idx].html;
      text.scrollTop = 0;
    }
    var btns = ov.querySelectorAll('#cc-terms-tabs button');
    var k;
    for (k = 0; k < btns.length; k++) {
      (function (b) {
        b.onclick = function () { select(parseInt(b.getAttribute('data-tab'), 10)); };
      })(btns[k]);
    }
    select(0);

    ov.querySelector('#cc-btn-accept').onclick = function () {
      var cur = load();
      if (!cur.installedAt) cur.installedAt = Date.now();
      cur.acceptedVersion = TERMS_VERSION;
      cur.acceptedAt = Date.now();
      save(cur);
      ov.parentNode.removeChild(ov);
      document.removeEventListener('keydown', blockKeys, true);
    };
    ov.querySelector('#cc-btn-quit').onclick = quitApp;
    document.addEventListener('keydown', blockKeys, true);
  }

  function blockKeys(e) {
    // Modal bloqueante: sem ESC, sem atalhos — so os dois botoes do rodape
    if (e.key === 'Escape' || e.keyCode === 27) { e.preventDefault(); e.stopPropagation(); }
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    var cur = load();
    if (!cur.installedAt) { cur.installedAt = Date.now(); save(cur); }
    if (cur.acceptedVersion !== TERMS_VERSION) show();
  }
  boot();
})();
