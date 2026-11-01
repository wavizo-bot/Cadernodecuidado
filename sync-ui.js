/* Sincronizacao Caderno de Cuidado.
   Modelo de dados (regras 5.3-5.6):
   - cada ficha/configuracao e um documento;
   - cada alteracao local vira uma OPERACAO atomica com opId (UUID), deviceId,
     baseVersion, baseOpId e version (contador logico de Lamport);
   - exclusoes viram tombstones (type "del"), nunca desaparecem do historico;
   - a nuvem recebe operacoes (nao um bloco unico carimbado com a hora);
   - conflito real (mesma base, dispositivos diferentes) NAO e resolvido por
     relogio: as duas versoes ficam guardadas e o usuario decide;
   - exclusao total e uma acao separada, com dupla confirmacao e geracao da base.
   O host (MSIX/Android) so transporta o payload; a merge acontece aqui. */
(function () {
  'use strict';

  var REG_KEY = 'caderno-cuidado-registros-v1';
  var CFG_KEY = 'caderno-cuidado-config-v1';
  var META_KEY = 'caderno-drive-sync-v1';
  var OPS_KEY = 'caderno-sync-ops-v1';
  var HEADS_KEY = 'caderno-sync-heads-v1';
  var CONF_KEY = 'caderno-sync-conflicts-v1';
  var CONFIG_DOC = '__config__';

  var CONTACT_TTL = 15 * 60 * 1000;
  var BLUE_MS = 4000;
  var AUTOSYNC_DELAY = 12000;
  var POLL_MS = 15000;          // regra 5.7: latencia maxima de 15 s
  var IDLE_MS = 30000;
  var FLUSH_MS = 550;           // coalesce digitacao; ainda e uma acao por ficha

  var LABEL = {
    ok:       'Sincronizado com o Google Drive',
    saved:    'Salvo agora — atualizando...',
    idle:     'Sem contato com o Drive — nada a perder',
    risk:     'Sem contato com o Drive — HÁ alterações não salvas!',
    empty:    'Nuvem sem backup — enviando os dados deste aparelho',
    pending:  'Conferindo a nuvem...',
    conflict: 'Conflito — decida qual versão manter'
  };

  function rawGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function rawSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function rawDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function meta() {
    try { return JSON.parse(rawGet(META_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveMeta(m) {
    try { rawSet(META_KEY, JSON.stringify(m || {})); } catch (e) {}
  }
  function uuid() {
    try { return crypto.randomUUID(); }
    catch (e) {
      return 'op-' + Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 12);
    }
  }
  function hashStr(s) {
    var h = 5381, i;
    s = String(s == null ? '' : s);
    for (i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  function sha256Hex(s) {
    try {
      if (window.crypto && crypto.subtle && window.TextEncoder) {
        return crypto.subtle.digest('SHA-256',
          new TextEncoder().encode(String(s))).then(function (buf) {
            var b = new Uint8Array(buf), out = '', i;
            for (i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
            return out;
          });
      }
    } catch (e) {}
    return Promise.resolve('djb2-' + hashStr(s));
  }
  function sortObj(v) {
    if (Array.isArray(v)) return v.map(sortObj);
    if (v && typeof v === 'object') {
      var o = {}, k;
      var keys = Object.keys(v).sort();
      for (var i = 0; i < keys.length; i++) { k = keys[i]; o[k] = sortObj(v[k]); }
      return o;
    }
    return v;
  }
  function canon(v) { return JSON.stringify(sortObj(v)); }
  function same(a, b) { return canon(a) === canon(b); }

  function parseReg(raw) {
    try {
      var v = JSON.parse(raw || '[]');
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.records)) return v.records;
    } catch (e) {}
    return [];
  }
  function parseCfg(raw) {
    try {
      var v = JSON.parse(raw || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) { return {}; }
  }
  function snapshot() {
    return { reg: rawGet(REG_KEY), cfg: rawGet(CFG_KEY) };
  }
  // Hash semantico: indentacao/ordem de chaves do JSON nao contam como
  // alteracao (evita upload e "sujo" falso a cada render do React).
  function hash(snap) {
    return hashStr(canon({ reg: parseReg(snap.reg), cfg: parseCfg(snap.cfg) }));
  }
  function regCount(raw) {
    return parseReg(raw).filter(function (r) { return r && r.id; }).length;
  }

  // ---------------------------------------------------------------- modelo --
  var model = { ops: [], heads: {}, conflicts: [] };
  var m0 = meta();
  if (!m0.deviceId) { m0.deviceId = uuid(); saveMeta(m0); }
  var state = {
    signedIn: false, email: '', lastContactAt: 0,
    lastHash: null, blueUntil: 0, backupBusy: false,
    lastChangeAt: 0, cur: 'idle', timer: null, hostBroken: false,
    lastActivityAt: Date.now(), pulling: false, remote: null,
    remoteError: '', conflict: false, emptyBlocked: false, needsReload: false,
    connecting: false, loginSeq: 0, initialPullDone: false, gateTimer: null,
    remoteFingerprint: '', remoteAllValid: null, generationBlocked: false,
    preserving: false
  };
  var btn = null, statusEl = null, overlay = null;
  var suppress = false, lastSnap = snapshot();
  var bootUntil = Date.now() + 2500;
  var flushTimer = null;

  function loadModel() {
    try {
      var ops = JSON.parse(rawGet(OPS_KEY) || '[]');
      var heads = JSON.parse(rawGet(HEADS_KEY) || '{}');
      var conf = JSON.parse(rawGet(CONF_KEY) || '[]');
      model.ops = Array.isArray(ops) ? ops.filter(validOp) : [];
      model.heads = (heads && typeof heads === 'object' && !Array.isArray(heads)) ? heads : {};
      model.conflicts = Array.isArray(conf) ? conf : [];
    } catch (e) {
      model = { ops: [], heads: {}, conflicts: [] };
    }
    var mm = meta();
    var maxVer = 0;
    model.ops.forEach(function (o) { if (o.version > maxVer) maxVer = o.version; });
    if (!mm.lamport || mm.lamport < maxVer) { mm.lamport = maxVer; saveMeta(mm); }
    if (!mm.generation || mm.generation < 0) { mm.generation = 0; saveMeta(mm); }
    // Primeira execucao depois de atualizar: a base local vira semente de
    // operacoes deterministicas (mesmo conteudo = mesmo opId, sem duplicar).
    if (!model.ops.length) {
      seedLocal();
    } else {
      // Cabecas e conflitos sao reconstruidos do historico (fonte da verdade),
      // nunca de um cache que possa ficar inconsistente.
      recompute();
      ensureHeadsForLocal();
      if (!Array.isArray(mm.recordOrder)) {
        mm.recordOrder = parseReg(rawGet(REG_KEY)).map(function (r) { return r.id; })
          .filter(Boolean);
        saveMeta(mm);
      }
    }
    lastSnap = snapshot();
    state.lastHash = hash(lastSnap);
    persistModel();
  }

  function validOp(o) {
    if (!(o && typeof o.opId === 'string' && typeof o.docId === 'string' &&
      (o.type === 'put' || o.type === 'del') &&
      isInt(o.version) && o.version >= 1 &&
      isInt(o.baseVersion) && o.baseVersion >= 0)) return false;
    if (o.resolves !== undefined) {
      if (!Array.isArray(o.resolves)) return false;
      for (var i = 0; i < o.resolves.length; i++) {
        if (typeof o.resolves[i] !== 'string') return false;
      }
    }
    return true;
  }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  function seedLocal() {
    var reg = parseReg(rawGet(REG_KEY));
    var cfg = parseCfg(rawGet(CFG_KEY));
    var ops = [], heads = {};
    reg.forEach(function (r) {
      if (!r || !r.id) return;
      var op = seedOp(r.id, r);
      ops.push(op); heads[r.id] = headFromOp(op);
    });
    if (cfg && Object.keys(cfg).length) {
      var oc = seedOp(CONFIG_DOC, cfg);
      ops.push(oc); heads[CONFIG_DOC] = headFromOp(oc);
    }
    model.ops = ops;
    model.heads = heads;
    model.conflicts = [];
    var mm = meta();
    mm.lamport = Math.max(mm.lamport || 0, 1);
    mm.recordOrder = reg.map(function (r) { return r.id; }).filter(Boolean);
    saveMeta(mm);
    persistModel();
  }
  function seedOp(docId, data) {
    return {
      opId: 'seed:' + docId + ':' + hashStr(canon(data)),
      deviceId: 'seed', docId: docId, type: 'put',
      baseVersion: 0, baseOpId: null, version: 1, data: data,
      createdAt: new Date().toISOString() // exibicao; nunca desempate
    };
  }
  function headFromOp(o) {
    return { version: o.version, opId: o.opId, deviceId: o.deviceId,
             deleted: o.type === 'del', data: o.type === 'del' ? null : o.data };
  }
  function persistModel() {
    try { rawSet(OPS_KEY, JSON.stringify(model.ops)); } catch (e) {}
    try { rawSet(HEADS_KEY, JSON.stringify(model.heads)); } catch (e) {}
    try { rawSet(CONF_KEY, JSON.stringify(model.conflicts)); } catch (e) {}
  }

  function ensureHeadsForLocal() {
    var reg = parseReg(rawGet(REG_KEY));
    var changed = false;
    reg.forEach(function (r) {
      if (!r || !r.id) return;
      if (!model.heads[r.id]) {
        var op = seedOp(r.id, r);
        model.ops.push(op); model.heads[r.id] = headFromOp(op); changed = true;
      }
    });
    var cfg = parseCfg(rawGet(CFG_KEY));
    if (cfg && Object.keys(cfg).length && !model.heads[CONFIG_DOC]) {
      var oc = seedOp(CONFIG_DOC, cfg);
      model.ops.push(oc); model.heads[CONFIG_DOC] = headFromOp(oc); changed = true;
    }
    if (changed) persistModel();
  }

  function isAncestor(ancestorId, headId, byId) {
    var guard = 0, cur = byId[headId];
    while (cur && guard++ < 5000) {
      if (cur.opId === ancestorId) return true;
      cur = cur.baseOpId ? byId[cur.baseOpId] : null;
    }
    return false;
  }

  function addConflict(docId, localHead, remoteOp) {
    for (var i = 0; i < model.conflicts.length; i++) {
      var c = model.conflicts[i];
      if (c.docId === docId && c.remote && c.remote.opId === remoteOp.opId) return;
    }
    model.conflicts.push({
      docId: docId,
      local: {
        version: localHead.version, opId: localHead.opId,
        deviceId: localHead.deviceId, deleted: !!localHead.deleted,
        data: localHead.deleted ? null : localHead.data
      },
      remote: remoteOp,
      detectedAt: new Date().toISOString() // exibicao apenas
    });
  }

  // Remove apenas os conflitos que a operacao de resolucao realmente
  // encerrou. Uma terceira ramificacao do mesmo documento continua visivel.
  function dropResolvedConflicts(docId, resolvedIds, newHead) {
    var keep = [];
    for (var i = 0; i < model.conflicts.length; i++) {
      var c = model.conflicts[i];
      if (c.docId !== docId) { keep.push(c); continue; }
      // A ramificacao do outro lado foi resolvida: este par acabou.
      if (resolvedIds.indexOf(c.remote.opId) >= 0) continue;
      // O lado "em uso" era a cabeca substituida: o conflito continua, mas
      // agora contra a nova cabeca (uma terceira ramificacao nao some).
      if (resolvedIds.indexOf(c.local.opId) >= 0) {
        if (!newHead || newHead.opId === c.remote.opId) continue;
        c.local = {
          version: newHead.version, opId: newHead.opId,
          deviceId: newHead.deviceId, deleted: !!newHead.deleted,
          data: newHead.deleted ? null : newHead.data
        };
      }
      keep.push(c);
    }
    model.conflicts = keep;
  }

  // Reconstroi cabecas e conflitos a partir de TODAS as operacoes. A ordem e
  // por contador logico e, no empate, por opId (nunca pelo relogio). Uma
  // operacao de resolucao (resolves: [opA, opB]) encerra o conflito e vira a
  // cabeca, mesmo em outro aparelho que ainda estava na outra ramificacao.
  function recompute() {
    var all = model.ops.slice().sort(function (a, b) {
      if (a.version !== b.version) return a.version - b.version;
      return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
    });
    model.heads = {}; model.conflicts = [];
    var byId = {};
    all.forEach(function (o) { if (validOp(o)) byId[o.opId] = o; });
    all.forEach(function (op) {
      if (!validOp(op)) return;
      var h = model.heads[op.docId];
      if (!h) { model.heads[op.docId] = headFromOp(op); return; }
      if (h.opId === op.opId) return;
      if (op.resolves) {
        var resolvesHead = op.resolves.indexOf(h.opId) >= 0;
        var nh = resolvesHead ? headFromOp(op) : h;
        if (resolvesHead) model.heads[op.docId] = nh;
        dropResolvedConflicts(op.docId, op.resolves, nh);
        return;
      }
      if (isAncestor(op.opId, h.opId, byId)) return; // ja incorporada
      if (op.baseOpId && op.baseOpId === h.opId) {
        model.heads[op.docId] = headFromOp(op);
        return;
      }
      if (op.type === (h.deleted ? 'del' : 'put') && same(op.data, h.data)) {
        return; // mesma alteracao em outro aparelho: idempotente
      }
      // Concorrencia real ou base desatualizada: preserva as duas versoes.
      addConflict(op.docId, h, op);
    });
    persistModel();
  }

  function applyRemoteOps(remoteOps) {
    var known = {}, i;
    for (i = 0; i < model.ops.length; i++) known[model.ops[i].opId] = true;
    var fresh = [];
    for (i = 0; i < remoteOps.length; i++) {
      var o = remoteOps[i];
      if (!validOp(o) || known[o.opId]) continue;
      fresh.push(o);
    }
    if (!fresh.length) {
      return { applied: 0, fresh: 0, conflicts: model.conflicts.length };
    }
    var before = canon(model.heads);
    model.ops = model.ops.concat(fresh);
    recompute();
    var changed = canon(model.heads) !== before;
    return { applied: changed ? fresh.length : 0, fresh: fresh.length,
             conflicts: model.conflicts.length };
  }

  // ------------------------------------------------------- diff local -------
  function flushLocal() {
    flushTimer = null;
    if (suppress) return;
    var cur = snapshot();
    if (cur.reg === lastSnap.reg && cur.cfg === lastSnap.cfg) return;
    var oldReg = parseReg(lastSnap.reg), newReg = parseReg(cur.reg);
    var oldCfg = parseCfg(lastSnap.cfg), newCfg = parseCfg(cur.cfg);
    var oldMap = {}, i;
    for (i = 0; i < oldReg.length; i++) if (oldReg[i] && oldReg[i].id) oldMap[oldReg[i].id] = oldReg[i];
    var mm = meta();
    var changed = false;
    function putDoc(id, data) {
      var h = model.heads[id] || { version: 0, opId: null, deviceId: null, deleted: false, data: null };
      var version = Math.max(mm.lamport || 0, h.version) + 1;
      var op = {
        opId: uuid(), deviceId: mm.deviceId, docId: id, type: 'put',
        baseVersion: h.version, baseOpId: h.opId || null, version: version,
        data: data, createdAt: new Date().toISOString()
      };
      mm.lamport = version;
      model.ops.push(op);
      model.heads[id] = headFromOp(op);
      changed = true;
    }
    function delDoc(id) {
      var h = model.heads[id];
      if (!h) return;
      var version = Math.max(mm.lamport || 0, h.version) + 1;
      var op = {
        opId: uuid(), deviceId: mm.deviceId, docId: id, type: 'del',
        baseVersion: h.version, baseOpId: h.opId || null, version: version,
        data: null, createdAt: new Date().toISOString()
      };
      mm.lamport = version;
      model.ops.push(op);
      model.heads[id] = headFromOp(op);
      changed = true;
    }
    var seen = {};
    for (i = 0; i < newReg.length; i++) {
      var r = newReg[i];
      if (!r || !r.id) continue;
      seen[r.id] = true;
      var old = oldMap[r.id];
      if (!old || !same(old, r)) putDoc(r.id, r);
    }
    for (i = 0; i < oldReg.length; i++) {
      var or = oldReg[i];
      if (or && or.id && !seen[or.id]) delDoc(or.id);
    }
    if (!same(oldCfg, newCfg)) {
      if (newCfg && Object.keys(newCfg).length) putDoc(CONFIG_DOC, newCfg);
      else delDoc(CONFIG_DOC);
    }
    mm.recordOrder = newReg.map(function (x) { return x.id; }).filter(Boolean);
    mm.lastLocalChangeAt = Date.now();
    saveMeta(mm);
    if (changed) {
      persistModel();
      state.lastChangeAt = Date.now();
      state.blueUntil = Date.now() + BLUE_MS;
      state.emptyBlocked = false;
    }
    lastSnap = cur;
    paint();
  }

  function localChanged() {
    if (suppress) return;
    var now = Date.now();
    if (now < bootUntil) { lastSnap = snapshot(); return; }
    state.lastChangeAt = now;
    state.lastActivityAt = now;
    var mm = meta();
    if (!mm.lastLocalChangeAt) { mm.lastLocalChangeAt = now; saveMeta(mm); }
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushLocal, FLUSH_MS);
    paint();
  }

  // hook de escrita: o React grava o array inteiro; o diff vira operacoes
  try {
    var proto = window.Storage && Storage.prototype;
    if (proto && !proto.__ccHooked) {
      var nativeSet = proto.setItem;
      var nativeRemove = proto.removeItem;
      proto.setItem = function (k, v) {
        var r = nativeSet.apply(this, arguments);
        if (k === REG_KEY || k === CFG_KEY) { try { localChanged(); } catch (e) {} }
        return r;
      };
      proto.removeItem = function (k) {
        var r = nativeRemove.apply(this, arguments);
        if (k === REG_KEY || k === CFG_KEY) { try { localChanged(); } catch (e) {} }
        return r;
      };
      proto.__ccHooked = true;
    }
  } catch (e) {}

  // -------------------------------------------------------------- material --
  function materialize() {
    var mm = meta();
    var order = Array.isArray(mm.recordOrder) ? mm.recordOrder.slice() : [];
    var seen = {};
    order.forEach(function (id) { seen[id] = true; });
    Object.keys(model.heads).forEach(function (id) {
      if (id !== CONFIG_DOC && !seen[id]) { order.push(id); seen[id] = true; }
    });
    var reg = [];
    order.forEach(function (id) {
      var h = model.heads[id];
      if (h && !h.deleted && id !== CONFIG_DOC && h.data) reg.push(h.data);
    });
    var cfg = model.heads[CONFIG_DOC]
      ? (model.heads[CONFIG_DOC].deleted ? {} : model.heads[CONFIG_DOC].data)
      : parseCfg(rawGet(CFG_KEY));
    suppress = true;
    try {
      rawSet(REG_KEY, JSON.stringify(reg));
      rawSet(CFG_KEY, JSON.stringify(cfg || {}));
    } finally { suppress = false; }
    mm.recordOrder = order;
    mm.lastSyncedHash = hash(snapshot());
    saveMeta(mm);
    lastSnap = snapshot();
    state.lastHash = mm.lastSyncedHash;
    persistModel();
  }

  // --------------------------------------------------------------- payload --
  function buildPayload() {
    flushLocal();
    var snap = snapshot();
    var mm = meta();
    var base = {
      v: 2, app: 'caderno', generation: mm.generation || 0,
      deviceId: mm.deviceId, ops: model.ops,
      state: { reg: snap.reg, cfg: snap.cfg }
    };
    return sha256Hex(canon({ generation: base.generation, ops: base.ops }))
      .then(function (sum) {
        base.checksum = sum;
        base.savedAt = new Date().toISOString(); // exibicao apenas
        return base;
      });
  }

  function validatePayload(p) {
    if (!p || typeof p !== 'object') return Promise.resolve({ ok: false, error: 'não é um objeto JSON' });
    if (p.v === 1 || (p.v === undefined && ('reg' in p || 'cfg' in p))) {
      if (!('reg' in p) && !('cfg' in p)) return Promise.resolve({ ok: false, error: 'backup sem dados' });
      var rr = parseReg(typeof p.reg === 'string' ? p.reg : JSON.stringify(p.reg || []));
      var cc = p.cfg && typeof p.cfg === 'object' ? p.cfg : {};
      return Promise.resolve({ ok: true, legacy: true, reg: rr, cfg: cc });
    }
    if (p.v !== 2) return Promise.resolve({ ok: false, error: 'versão de backup desconhecida' });
    if (!isInt(p.generation) || p.generation < 0) return Promise.resolve({ ok: false, error: 'geração inválida' });
    if (!Array.isArray(p.ops)) return Promise.resolve({ ok: false, error: 'lista de operações ausente' });
    for (var i = 0; i < p.ops.length; i++) {
      var o = p.ops[i];
      if (!validOp(o) || typeof o.docId !== 'string') {
        return Promise.resolve({ ok: false, error: 'operação inválida na posição ' + i });
      }
    }
    if (!p.checksum || typeof p.checksum !== 'string') {
      return Promise.resolve({ ok: false, error: 'checksum ausente' });
    }
    return sha256Hex(canon({ generation: p.generation, ops: p.ops })).then(function (sum) {
      if (sum !== p.checksum) return { ok: false, error: 'checksum não confere' };
      if (p.state) {
        if (p.state.reg != null && typeof p.state.reg !== 'string') return { ok: false, error: 'estado local inválido' };
        if (p.state.cfg != null && typeof p.state.cfg !== 'string') return { ok: false, error: 'configuração inválida' };
      }
      return { ok: true, legacy: false };
    });
  }

  function stateOps(reg, cfg) {
    var ops = [];
    (reg || []).forEach(function (r) {
      if (!r || !r.id) return;
      var op = seedOp(r.id, r);
      op.deviceId = 'legacy';
      ops.push(op);
    });
    if (cfg && Object.keys(cfg).length) {
      var oc = seedOp(CONFIG_DOC, cfg);
      oc.deviceId = 'legacy';
      ops.push(oc);
    }
    return ops;
  }

  function payloadToOps(p) {
    if (p.v === 2) {
      var ops = p.ops.slice();
      if (!ops.length && p.state) {
        ops = stateOps(parseReg(p.state.reg), parseCfg(p.state.cfg));
      }
      return ops;
    }
    // v1 gravava reg/cfg como texto JSON (nao como array/objeto).
    return stateOps(parseReg(typeof p.reg === 'string' ? p.reg : JSON.stringify(p.reg || [])),
                    parseCfg(typeof p.cfg === 'string' ? p.cfg : JSON.stringify(p.cfg || {})));
  }

  // --------------------------------------------------------------- host -----
  function host() {
    try {
      return (window.chrome && window.chrome.webview &&
              window.chrome.webview.hostObjects &&
              window.chrome.webview.hostObjects.cadernoDrive) || null;
    } catch (e) { return null; }
  }
  function parseRes(p) {
    return Promise.resolve(p).then(function (r) {
      if (typeof r === 'string') { try { return JSON.parse(r); } catch (e) { return { ok: false, error: r }; } }
      return r || {};
    });
  }
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

  // ------------------------------------------------------------ download ----
  function remoteFingerprint(files) {
    return (files || []).map(function (f) {
      return (f && f.id ? f.id : '') + ':' + (f && f.modifiedTime ? f.modifiedTime : 0);
    }).sort().join('|');
  }

  // Baixa TODOS os candidatos e valida cada um. Nunca escolhe por tamanho:
  // um backup legítimo pode ser pequeno; o inválido é descartado pelo
  // esquema/checksum. Vários arquivos (um por dispositivo) são mesclados.
  function downloadValid(force) {
    return callHost('CheckRemote').then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || 'o Google Drive não respondeu');
      var files = [];
      if (Array.isArray(r.files) && r.files.length) files = r.files.slice();
      else if (r.exists) files = [{ id: null, modifiedTime: r.modifiedTime || 0 }];
      state.remoteFingerprint = remoteFingerprint(files);
      if (!files.length) return { exists: false, valid: false, files: [] };
      var fp = state.remoteFingerprint;
      var mm = meta();
      if (!force && state.remoteValid && state.remoteAllValid !== false &&
          fp && fp === (mm.lastRemoteFingerprint || '')) {
        return { exists: true, valid: true, cached: true, files: files,
                 allValid: true, fingerprint: fp,
                 modifiedTime: state.remote ? (state.remote.modifiedTime || 0) : 0 };
      }
      var payloads = [], validFiles = [], failed = 0, i = 0, maxTime = 0;
      files.forEach(function (f) {
        if (f && f.modifiedTime && f.modifiedTime > maxTime) maxTime = f.modifiedTime;
      });
      function next() {
        if (i >= files.length) {
          if (!payloads.length) {
            return { exists: true, valid: false, files: files, modifiedTime: maxTime,
                     fingerprint: fp, allValid: false,
                     error: 'nenhum backup passou na validação' };
          }
          return { exists: true, valid: true, payloads: payloads, files: validFiles,
                   allFiles: files, modifiedTime: maxTime, fingerprint: fp,
                   allValid: failed === 0 };
        }
        var f = files[i++];
        var req;
        if (f.id && typeof host()['RestoreFile'] === 'function') req = callHost('RestoreFile', f.id);
        else req = callHost('Restore');
        return req.then(function (rr) {
          if (!rr || !rr.ok || !rr.payload) { failed++; return next(); }
          var p;
          try { p = typeof rr.payload === 'string' ? JSON.parse(rr.payload) : rr.payload; }
          catch (e) { failed++; return next(); }
          return validatePayload(p).then(function (v) {
            if (!v.ok) { failed++; return next(); }
            payloads.push(p);
            validFiles.push(f);
            return next();
          });
        }).catch(function () { failed++; return next(); });
      }
      return next();
    });
  }

  // -------------------------------------------------------------- merge -----
  function handleGeneration(remoteGen, interactive) {
    var mm = meta();
    var localGen = mm.generation || 0;
    var localHasData = regCount(rawGet(REG_KEY)) > 0 || model.ops.length > 0;
    if (remoteGen > localGen) {
      if (localHasData) {
        // Um poll automático não pode descartar dados sem o usuário decidir.
        if (!interactive) {
          state.generationBlocked = true;
          state.remoteError = 'Sincronização pausada: a nuvem foi reiniciada em ' +
            'outro aparelho. Toque em "Verificar agora" para decidir.';
          return { blocked: true };
        }
        var msg = 'A nuvem foi apagada de propósito em outro aparelho ' +
          '(geração ' + remoteGen + ').\n\nOs dados deste aparelho serão ' +
          'descartados para não ressuscitar o que foi apagado.\n\nContinuar?';
        if (!window.confirm(msg)) {
          state.generationBlocked = true;
          state.remoteError = 'Sincronização pausada: a nuvem foi reiniciada em outro aparelho.';
          return { blocked: true };
        }
      }
      model.ops = []; model.heads = {}; model.conflicts = [];
      mm.generation = remoteGen; mm.recordOrder = [];
      saveMeta(mm); persistModel();
      state.generationBlocked = false;
      return { reset: true };
    }
    state.generationBlocked = false;
    if (remoteGen < localGen) {
      // Este aparelho reiniciou o caderno; a nuvem antiga não deve voltar.
      return { localReset: true };
    }
    return {};
  }

  function mergePayloads(payloads, modifiedTime, interactive, fingerprint, validFiles) {
    if (!payloads || !payloads.length) {
      return { applied: 0, fresh: 0, uploadNeeded: false,
               conflicts: model.conflicts.length };
    }
    // v2 e a fonte da verdade. Se existe pelo menos um v2, os snapshots v1
    // (sem tombstones) ficam de fora para nao ressuscitar ficha excluida.
    var v2 = [], i;
    for (i = 0; i < payloads.length; i++) {
      if (payloads[i] && payloads[i].v === 2) v2.push(payloads[i]);
    }
    var maxGen = 0, source = [], files = validFiles || [];
    if (v2.length) {
      for (i = 0; i < v2.length; i++) {
        if (isInt(v2[i].generation) && v2[i].generation > maxGen) maxGen = v2[i].generation;
      }
      for (i = 0; i < v2.length; i++) {
        // Depois de uma exclusao total, so a geracao nova vale; as antigas
        // ressuscitariam o que foi apagado de proposito.
        if ((v2[i].generation || 0) === maxGen) source.push(v2[i]);
      }
    } else {
      // Migracao: snapshots v1 nao guardam exclusoes. Usa apenas o mais
      // recente (pelo modifiedTime do servidor; empate pelo nome/id).
      var best = -1, bestTime = -1, bestKey = '';
      for (i = 0; i < payloads.length; i++) {
        var f = files[i] || {};
        var t = f.modifiedTime || 0;
        var key = String(f.id || f.name || i);
        if (best < 0 || t > bestTime || (t === bestTime && key > bestKey)) {
          best = i; bestTime = t; bestKey = key;
        }
      }
      if (best >= 0) source.push(payloads[best]);
    }
    var g = handleGeneration(maxGen, interactive);
    if (g.blocked) return { blocked: true, applied: 0, fresh: 0, uploadNeeded: false };
    var mm = meta();
    if (g.localReset) {
      mm.lastSeenRemote = modifiedTime || 0;
      mm.lastBackupAt = Math.max(mm.lastBackupAt || 0, modifiedTime || 0);
      if (fingerprint) mm.lastRemoteFingerprint = fingerprint;
      saveMeta(mm);
      state.remoteValid = true;
      state.remoteAllValid = true;
      return { localReset: true, applied: 0, fresh: 0, uploadNeeded: false };
    }
    var ops = [];
    source.forEach(function (p) { ops = ops.concat(payloadToOps(p)); });
    // Operacoes que existem aqui e ainda nao existem em nenhum arquivo da
    // nuvem precisam subir depois da mesclagem (senao ficariam so locais).
    var remoteIds = {}, localOnly = 0;
    for (i = 0; i < ops.length; i++) remoteIds[ops[i].opId] = true;
    for (i = 0; i < model.ops.length; i++) {
      if (!remoteIds[model.ops[i].opId]) localOnly++;
    }
    var res = applyRemoteOps(ops);
    res.uploadNeeded = localOnly > 0;
    if (res.applied || g.reset) {
      materialize();
      state.needsReload = true;
    }
    mm = meta();
    mm.lastSeenRemote = modifiedTime || 0;
    mm.lastBackupAt = Math.max(mm.lastBackupAt || 0, modifiedTime || 0);
    if (fingerprint) mm.lastRemoteFingerprint = fingerprint;
    saveMeta(mm);
    state.remoteValid = true;
    state.conflict = model.conflicts.length > 0;
    paint();
    if (interactive && res.applied) {
      setTimeout(function () { location.reload(); }, 250);
    } else if (res.applied) {
      state.needsReload = true;
    }
    // As duas versões de um conflito também precisam existir na nuvem.
    if (res.fresh > 0 && model.conflicts.length) preserveConflicts();
    return res;
  }

  function resolutionOp(conf, choice) {
    var mm = meta();
    var chosen = choice === 'remote' ? conf.remote : conf.local;
    var baseVersion = Math.max(conf.local.version || 0, conf.remote.version || 0);
    var version = Math.max(mm.lamport || 0, baseVersion) + 1;
    var op = {
      opId: uuid(), deviceId: mm.deviceId, docId: conf.docId,
      type: chosen.deleted ? 'del' : 'put',
      baseVersion: baseVersion,
      baseOpId: conf.local.opId,
      resolves: [conf.local.opId, conf.remote.opId],
      version: version,
      data: chosen.deleted ? null : chosen.data,
      createdAt: new Date().toISOString()
    };
    mm.lamport = version;
    saveMeta(mm);
    return op;
  }

  function resolveConflict(docId, choice) {
    var resolved = null;
    model.conflicts.forEach(function (c) {
      if (c.docId === docId && !resolved) resolved = c;
    });
    if (!resolved) return;
    var op = resolutionOp(resolved, choice);
    model.ops.push(op);
    recompute();
    materialize();
    paint();
    if (model.conflicts.length === 0 && state.signedIn) doBackup(true);
  }

  // ---------------------------------------------------------------- status --
  function compute() {
    var now = Date.now();
    var h = hash(snapshot());
    if (state.lastHash === null) state.lastHash = h;
    var mm = meta();
    var dirty = h !== mm.lastSyncedHash && (mm.lastLocalChangeAt || 0) > 0;
    var online = state.signedIn && !state.remoteError &&
                 (now - state.lastContactAt) < CONTACT_TTL;
    var cloudOk = !!(state.remote && state.remote.exists && state.remote.valid &&
                    state.remoteAllValid !== false);
    var synced = h === mm.lastSyncedHash && model.conflicts.length === 0 && cloudOk;
    var s;
    if (model.conflicts.length) s = 'conflict';
    else if (state.generationBlocked) s = 'risk';
    else if (state.connecting) s = 'saved';
    else if (now < state.blueUntil || state.backupBusy) s = 'saved';
    else if (!online && dirty) s = 'risk';
    else if (!online && !dirty) s = 'idle';
    else if (online && !dirty && cloudOk && synced) s = 'ok';
    else if (online && !dirty && cloudOk) s = 'pending';
    else if (online && !dirty) s = 'empty';
    else s = 'saved';
    return { s: s, dirty: dirty, online: online, hash: h, cloudOk: cloudOk, conflicts: model.conflicts.length };
  }

  function paint() {
    var c = compute();
    state.cur = c.s;
    if (btn) {
      btn.setAttribute('data-state', c.s);
      btn.title = 'Conta e backup — ' + LABEL[c.s];
    }
    if (statusEl) renderStatus(c);
    var mmP = meta();
    // Novidade na nuvem e comparada por diferenca (!=) de conjunto/carimbo,
    // nunca por ">" do relogio local (regras 5.4, 5.9.1, W5, A13).
    var remoteChanged = !!(state.remote && state.remote.exists &&
      ((state.remoteFingerprint && state.remoteFingerprint !== (mmP.lastRemoteFingerprint || '')) ||
       (state.remote.modifiedTime && state.remote.modifiedTime !== (mmP.lastSeenRemote || 0))));
    if (remoteChanged && state.signedIn && !state.backupBusy && !state.pulling &&
        !state.remoteError && !state.generationBlocked) {
      pullFromCloud(false);
    }
    if (c.dirty && state.signedIn && !state.backupBusy && !state.pulling &&
        !remoteChanged && !state.remoteError && !state.generationBlocked &&
        !state.emptyBlocked && !state.needsReload && !state.preserving &&
        !model.conflicts.length &&
        (Date.now() - state.lastChangeAt) > AUTOSYNC_DELAY) {
      doBackup(true);
    }
    if (state.needsReload && !state.backupBusy &&
        (Date.now() - state.lastActivityAt) > IDLE_MS &&
        !overlay && !document.getElementById('cc-terms-overlay') &&
        !document.getElementById('cc-conflict-overlay')) {
      state.needsReload = false;
      location.reload();
    }
  }

  function fmtTime(ts) {
    if (!ts) return 'nunca';
    try { return new Date(ts).toLocaleString('pt-BR'); } catch (e) { return ''; }
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderStatus(c) {
    c = c || compute();
    var mm = meta();
    var dot = { ok: '#1B7A43', saved: '#2563EB', idle: '#CA8A04', risk: '#DC2626',
                empty: '#CA8A04', pending: '#CA8A04', conflict: '#B45309' }[c.s];
    var acc = state.signedIn
      ? 'Conectado: ' + esc(state.email || 'conta Google')
      : 'Google Drive: desconectado';
    if (state.connecting) acc = 'Conectando ao Google…';
    else if (state.remoteError) acc = 'Conta Google: ' + esc(state.email || 'conta Google') + ' — sem acesso ao Drive';
    var cloud = '';
    var localCount = regCount(rawGet(REG_KEY));
    if (state.signedIn) {
      if (state.remoteError) cloud = '<br>Nuvem: ' + esc(state.remoteError);
      else if (state.remote && state.remote.exists && state.remote.valid) {
        cloud = '<br>Nuvem: backup válido de ' + fmtTime(state.remote.modifiedTime);
        if (state.remoteAllValid === false) {
          cloud += '<br><b>Atenção:</b> alguns arquivos da nuvem não puderam ser lidos; ' +
            'o Caderno tenta de novo a cada 15 s.';
        }
        if (localCount === 0) {
          cloud += '<br><b>Este aparelho está sem fichas.</b> O backup será baixado automaticamente.';
        }
      } else if (state.remote && state.remote.exists) {
        cloud = '<br>Nuvem: backup encontrado, mas nenhum candidato passou na validação.';
      } else if (state.remote) {
        cloud = '<br>Nuvem: nenhum backup nesta conta';
      }
      if (model.conflicts.length) {
        cloud += '<br><b>Atenção:</b> ' + model.conflicts.length +
          ' conflito(s) de edição. As duas versões ficam guardadas na nuvem; ' +
          'novas edições dessas fichas ficam pausadas até você decidir.';
      }
      if (state.generationBlocked) {
        cloud += '<br><b>Atenção:</b> a nuvem foi reiniciada em outro aparelho. ' +
          'Toque em "Verificar agora" para decidir o que fazer com os dados deste aparelho.';
      }
      if (state.emptyBlocked) {
        cloud += '<br><b>Atenção:</b> a base deste aparelho está vazia; ' +
          'o backup da nuvem não foi substituído.';
      }
    }
    statusEl.innerHTML =
      '<div><span class="dot" style="background:' + dot + '"></span><b>' + LABEL[c.s] + '</b></div>' +
      '<div style="margin-top:5px">' + acc + '<br>Última sincronização: ' + fmtTime(mm.lastBackupAt) + cloud + '</div>';
    var rc = document.getElementById('cc-m-reconnect');
    if (rc) rc.style.display = (state.remoteError || state.generationBlocked) ? '' : 'none';
    var cb = document.getElementById('cc-m-conflicts');
    if (cb) {
      cb.style.display = model.conflicts.length ? '' : 'none';
      cb.textContent = 'Resolver conflitos (' + model.conflicts.length + ')';
    }
    var sb = document.getElementById('cc-m-sync');
    if (sb) {
      sb.textContent = (localCount === 0 && state.remote && state.remote.exists)
        ? 'Baixar dados da nuvem' : 'Verificar agora';
    }
  }

  // ---------------------------------------------------------------- login ---
  function doLogin() {
    if (!host() || state.hostBroken || state.connecting) return;
    var my = ++state.loginSeq;
    state.connecting = true; paint(); setBusy(true);
    var timer = setTimeout(function () {
      if (state.loginSeq !== my) return;
      state.loginSeq++;
      state.connecting = false; setBusy(false); paint();
      alert('O login do Google não terminou.\n\nToque em "Entrar com Google" ' +
            'e tente novamente.');
    }, 330000);
    callHost('Login').then(function (r) {
      if (state.loginSeq !== my) return;
      clearTimeout(timer);
      state.connecting = false; setBusy(false);
      if (r && r.ok) {
        state.signedIn = true; state.email = r.email || '';
        state.lastContactAt = Date.now(); state.blueUntil = Date.now() + BLUE_MS;
        state.remoteError = ''; state.conflict = false;
        state.remote = null; state.remoteValid = false; state.remoteAllValid = null;
        state.remoteFingerprint = ''; state.generationBlocked = false;
        state.initialPullDone = false;
        // Conta nova: o cache de carimbos da conta anterior nao vale.
        var mmLogin = meta();
        mmLogin.lastRemoteFingerprint = '';
        mmLogin.lastSeenRemote = 0;
        saveMeta(mmLogin);
        paint();
        pullFromCloud(true);
      } else if (!r || r.error !== 'host-broken') {
        alert('Falha no login Google: ' + ((r && r.error) || 'desconhecido'));
      }
      paint();
    });
  }
  function doLogout() {
    if (!host()) return Promise.resolve();
    return callHost('Logout').then(function () {
      state.signedIn = false; state.email = '';
      state.remoteError = ''; state.remote = null; state.conflict = false;
      state.remoteValid = false; state.remoteAllValid = null;
      state.remoteFingerprint = ''; state.generationBlocked = false;
      paint();
    });
  }
  function doReconnect() { doLogout().then(function () { doLogin(); }); }

  // -------------------------------------------------------------- backup ----
  function preserveConflicts() {
    if (state.preserving || state.backupBusy || !state.signedIn ||
        state.generationBlocked || !host() || state.hostBroken) return;
    state.preserving = true;
    doBackup(true, false, true).then(function () {
      state.preserving = false;
      paint();
    }, function () {
      state.preserving = false;
      paint();
    });
  }

  function doBackup(auto, force, preserve) {
    if (!host() || state.hostBroken || state.backupBusy) return Promise.resolve();
    if (state.generationBlocked && !force) {
      if (!auto) {
        alert('Sincronização pausada: a nuvem foi reiniciada em outro aparelho.\n\n' +
              'Use "Verificar agora" para decidir se descarta os dados deste aparelho.');
      }
      return Promise.resolve();
    }
    if (model.conflicts.length && !preserve && !force) {
      if (auto) preserve = true;
      else {
        alert('Há conflitos de edição pendentes. Resolva-os antes de enviar.');
        return Promise.resolve();
      }
    }
    flushLocal();
    var snap = snapshot();
    if (!snap.reg && !snap.cfg) {
      if (!auto) alert('Nada para sincronizar.');
      return Promise.resolve();
    }
    var localCount = regCount(snap.reg);
    if (localCount === 0 && !force) {
      state.emptyBlocked = true; paint();
      if (!auto) {
        if (state.remote && state.remote.exists) {
          alert('A base deste aparelho está vazia. Nada foi enviado nem apagado.\n\n' +
                'Para receber o backup da nuvem, use "Verificar agora".');
        } else {
          alert('Nada para sincronizar: não há fichas neste aparelho.');
        }
      }
      return Promise.resolve();
    }

    function uploadNow() {
      state.backupBusy = true; state.emptyBlocked = false; paint();
      return buildPayload().then(function (p) {
        if (force) p.force = true;
        if (preserve) p.preserve = true;
        return callHost('Backup', JSON.stringify(p));
      }).then(function (r) {
        state.backupBusy = false;
        if (r && r.ok) {
          var mm = meta();
          // Enquanto houver conflito, o estado local ainda não é o acordado;
          // não marcar como sincronizado. O upload serve para preservar as
          // duas versões na nuvem.
          if (model.conflicts.length === 0) {
            mm.lastSyncedHash = hash(snapshot());
          }
          mm.lastBackupAt = r.backedUpAt || Date.now();
          mm.lastSeenRemote = r.backedUpAt || mm.lastBackupAt;
          saveMeta(mm);
          state.lastContactAt = Date.now();
          state.blueUntil = Date.now() + BLUE_MS;
          state.remoteError = '';
          state.remote = { exists: true, valid: true, modifiedTime: r.backedUpAt || Date.now() };
          state.remoteValid = true;
          state.remoteAllValid = true;
          state.emptyBlocked = false;
          return anchorRemote();
        }
        state.remoteError = (r && r.error) || 'falha ao enviar para o Drive';
        state.lastContactAt = 0;
        if (!auto) alert('Falha ao enviar para o Drive: ' + state.remoteError);
        paint();
      }).catch(function (e) {
        state.backupBusy = false;
        state.remoteError = (e && e.message) || 'falha ao preparar o backup';
        paint();
      });
    }

    if (force) return uploadNow();

    // Antes de QUALQUER upload, confere a nuvem. Se o conjunto de arquivos
    // mudou (novo dispositivo, novo horário), baixa e concilia primeiro.
    state.backupBusy = true; paint();
    return callHost('CheckRemote').then(function (r) {
      state.backupBusy = false;
      if (!r || !r.ok) {
        state.remoteError = (r && r.error) || 'sem resposta do Drive';
        state.lastContactAt = 0; paint();
        return;
      }
      state.remoteError = '';
      var files = Array.isArray(r.files) ? r.files : [];
      var fp = remoteFingerprint(files);
      var mm = meta();
      var changed = !!(r.exists && files.length &&
        fp !== (mm.lastRemoteFingerprint || ''));
      if (changed) {
        state.remote = { exists: true, valid: false, modifiedTime: r.modifiedTime || 0 };
        state.conflict = true; paint();
        return pullFromCloud(false);
      }
      return uploadNow();
    });
  }

  function anchorRemote() {
    return callHost('CheckRemote').then(function (r) {
      if (!r || !r.ok) return;
      var files = Array.isArray(r.files) ? r.files : [];
      var fp = remoteFingerprint(files);
      var mm = meta();
      var maxTime = r.modifiedTime || 0;
      files.forEach(function (f) {
        if (f && f.modifiedTime && f.modifiedTime > maxTime) maxTime = f.modifiedTime;
      });
      mm.lastSeenRemote = maxTime || mm.lastSeenRemote || 0;
      mm.lastRemoteFingerprint = fp;
      saveMeta(mm);
      state.lastContactAt = Date.now();
      state.remote = { exists: !!r.exists, valid: files.length > 0, modifiedTime: maxTime };
      state.remoteValid = files.length > 0;
      state.remoteAllValid = files.length > 0;
      state.remoteError = '';
      paint();
    });
  }

  // ---------------------------------------------------------------- pull ----
  function pullFromCloud(interactive) {
    if (!host() || state.hostBroken || !state.signedIn || state.backupBusy || state.pulling) {
      return Promise.resolve();
    }
    state.pulling = true;
    return downloadValid().then(function (res) {
      state.pulling = false;
      state.lastContactAt = Date.now();
      state.remoteError = '';
      if (!res || !res.exists) {
        state.remote = { exists: false, valid: false, modifiedTime: 0 };
        state.remoteValid = false;
        state.remoteAllValid = null;
        var localCount0 = regCount(rawGet(REG_KEY));
        state.initialPullDone = true;
        closeGate();
        paint();
        if (localCount0 > 0) return doBackup(true);
        if (interactive) {
          alert('Login concluído, mas não há nenhum backup válido nesta conta do Google Drive.\n\n' +
                'Se os dados estão em outro computador, abra o Caderno lá, confira a mesma conta ' +
                'e toque em "Verificar agora" para enviar.');
        }
        return;
      }
      if (!res.valid) {
        state.remote = { exists: true, valid: false, modifiedTime: res.modifiedTime || 0 };
        state.remoteValid = false;
        state.remoteAllValid = false;
        state.remoteError = res.error || 'há backup no Drive, mas nenhum passou na validação';
        if (interactive) {
          alert('A nuvem tem backup, mas nenhum candidato passou na validação de esquema/checksum.\n\n' +
                'Nada foi baixado nem substituído. Se o problema persistir, exporte este aparelho ' +
                'e faça um novo backup.');
        }
        state.initialPullDone = true; closeGate(); paint(); return;
      }
      state.remote = { exists: true, valid: true, modifiedTime: res.modifiedTime };
      state.remoteValid = true;
      state.remoteAllValid = !!res.allValid;
      state.remoteFingerprint = res.fingerprint || state.remoteFingerprint;
      var out = res.cached ? { applied: 0, fresh: 0, uploadNeeded: false,
                               conflicts: model.conflicts.length }
        : mergePayloads(res.payloads, res.modifiedTime, interactive,
                        res.fingerprint, res.files);
      state.initialPullDone = true; closeGate(); paint();
      if (out && out.blocked) return out;
      var localCount = regCount(rawGet(REG_KEY));
      if ((out && out.uploadNeeded || compute().dirty) && localCount > 0 &&
          !model.conflicts.length && !state.generationBlocked) {
        return doBackup(true);
      }
      return out;
    }).catch(function (e) {
      state.pulling = false;
      state.remoteError = (e && e.message) || 'falha de comunicação com o Drive';
      state.remote = null;
      state.remoteValid = false;
      state.lastContactAt = 0;
      state.initialPullDone = true; closeGate(); paint();
      if (interactive) {
        alert('O login foi concluído, mas o Google Drive não respondeu:\n\n' +
              state.remoteError + '\n\nSe a sessão expirou, use "Entrar novamente".');
      }
    });
  }

  // -------------------------------------------------------------- manual ----
  function syncNow() {
    if (!host() || state.hostBroken) return;
    if (!state.signedIn) { doLogin(); return; }
    if (state.backupBusy || state.pulling) return;
    setBusy(true);
    pullFromCloud(true).then(function () { setBusy(false); }).catch(function () { setBusy(false); });
  }

  // ------------------------------------------------------------ novo caderno -
  function resetCloud() {
    if (!host() || !state.signedIn) { alert('Entre com a conta Google antes de reiniciar o caderno.'); return; }
    if (!confirm('INICIAR NOVO CADERNO\n\nIsto apaga TODAS as fichas deste aparelho E o backup do Google Drive desta conta.\n\nContinuar?')) return;
    if (!confirm('ÚLTIMA CONFIRMAÇÃO\n\nNão há como desfazer pelo app. Se precisar dos dados, exporte antes.\n\nApagar tudo agora?')) return;
    state.backupBusy = true; paint();
    downloadValid(true).then(function (res) {
      var remoteGen = 0;
      if (res && res.valid && res.payloads) {
        res.payloads.forEach(function (p) {
          var g = p && isInt(p.generation) ? p.generation : 0;
          if (g > remoteGen) remoteGen = g;
        });
      }
      var mm = meta();
      var nextGen = Math.max(mm.generation || 0, remoteGen) + 1;
      // Monta o payload vazio ANTES de apagar o local. Se o upload falhar,
      // as fichas deste aparelho continuam intactas.
      var empty = {
        v: 2, app: 'caderno', generation: nextGen, deviceId: mm.deviceId,
        ops: [], state: { reg: '[]', cfg: '{}' }, force: true
      };
      return sha256Hex(canon({ generation: empty.generation, ops: empty.ops }))
        .then(function (sum) {
          empty.checksum = sum;
          empty.savedAt = new Date().toISOString();
          if (typeof host()['ResetCloud'] === 'function') {
            return callHost('ResetCloud', JSON.stringify(empty));
          }
          return callHost('Backup', JSON.stringify(empty));
        }).then(function (r) {
          if (!r || !r.ok) return r;
          mm.generation = nextGen;
          mm.recordOrder = [];
          mm.lastSyncedHash = hash({ reg: '[]', cfg: '{}' });
          mm.lastLocalChangeAt = 0;
          mm.lastBackupAt = r.backedUpAt || Date.now();
          mm.lastSeenRemote = mm.lastBackupAt;
          saveMeta(mm);
          model.ops = []; model.heads = {}; model.conflicts = [];
          persistModel();
          suppress = true;
          try { rawSet(REG_KEY, '[]'); rawSet(CFG_KEY, '{}'); } finally { suppress = false; }
          lastSnap = snapshot();
          state.remote = { exists: true, valid: true, modifiedTime: mm.lastBackupAt };
          state.remoteValid = true;
          state.generationBlocked = false;
          return r;
        });
    }).then(function (r) {
      state.backupBusy = false;
      if (r && r.ok) {
        state.blueUntil = Date.now() + BLUE_MS;
        alert('Novo caderno iniciado. A nuvem foi substituída por uma base vazia.');
        location.reload();
      } else {
        state.remoteError = (r && r.error) || 'falha ao reiniciar a nuvem';
        alert('Não foi possível reiniciar a nuvem: ' + state.remoteError);
        paint();
      }
    }).catch(function (e) {
      state.backupBusy = false;
      state.remoteError = (e && e.message) || 'falha ao reiniciar';
      paint();
    });
  }

  // ------------------------------------------------------------ conflitos ----
  function conflictName(c) {
    if (c.docId === CONFIG_DOC) return 'Configurações';
    var h = model.heads[c.docId];
    var d = (c.remote && c.remote.data) || (h && h.data) || {};
    return d.name || c.docId;
  }
  function shortVal(v) {
    if (v === undefined || v === null) return '(vazio)';
    if (typeof v === 'object') {
      var s = canon(v);
      return s.length > 220 ? s.slice(0, 217) + '...' : s;
    }
    var t = String(v);
    return t.length > 220 ? t.slice(0, 217) + '...' : t;
  }
  function showConflicts() {
    closeConflicts();
    if (!model.conflicts.length) return;
    var ov = document.createElement('div');
    ov.id = 'cc-conflict-overlay';
    var cards = model.conflicts.map(function (c, i) {
      return '<div class="cc-conflict-card">' +
        '<h3>' + esc(conflictName(c)) + '</h3>' +
        '<div class="cc-conflict-cols">' +
          '<div><b>Versão em uso</b><pre>' + esc(shortVal(c.local.deleted ? '(excluído)' : c.local.data)) + '</pre>' +
            '<button data-cc-pick="local" data-cc-i="' + i + '">Manter versão em uso</button></div>' +
          '<div><b>Outra versão</b><pre>' + esc(shortVal(c.remote.deleted ? '(excluído)' : c.remote.data)) + '</pre>' +
            '<button data-cc-pick="remote" data-cc-i="' + i + '">Usar a outra versão</button></div>' +
        '</div></div>';
    }).join('');
    ov.innerHTML = '<div id="cc-conflict-modal" role="dialog" aria-label="Conflitos de edição">' +
      '<h2>Conflitos de edição</h2>' +
      '<p class="cc-conflict-hint">As duas versões foram preservadas. Escolha uma por ficha. ' +
      'O histórico continua guardado para auditoria.</p>' + cards +
      '<button class="close" id="cc-conflict-close">Fechar e decidir depois</button></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeConflicts(); });
    document.getElementById('cc-conflict-close').onclick = closeConflicts;
    var picks = ov.querySelectorAll('button[data-cc-pick]');
    for (var i = 0; i < picks.length; i++) {
      picks[i].onclick = function () {
        var idx = parseInt(this.getAttribute('data-cc-i'), 10);
        var conf = model.conflicts[idx];
        if (!conf) return;
        resolveConflict(conf.docId, this.getAttribute('data-cc-pick'));
        showConflicts();
      };
    }
  }
  function closeConflicts() {
    var o = document.getElementById('cc-conflict-overlay');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  // -------------------------------------------------------------- gate ------
  function showGate() {
    if (document.getElementById('cc-sync-gate')) return;
    var g = document.createElement('div');
    g.id = 'cc-sync-gate';
    g.innerHTML = '<div><div class="cc-spinner"></div><b>Atualizando dados da nuvem…</b>' +
      '<small>O Caderno confere a nuvem antes de liberar edições.</small></div>';
    document.body.appendChild(g);
    state.gateTimer = setTimeout(closeGate, 9000);
  }
  function closeGate() {
    if (state.gateTimer) { clearTimeout(state.gateTimer); state.gateTimer = null; }
    var g = document.getElementById('cc-sync-gate');
    if (g && g.parentNode) g.parentNode.removeChild(g);
  }

  // -------------------------------------------------------------- modal -----
  var busyCount = 0;
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    var o = document.getElementById('cc-sync-overlay');
    if (o) o.style.cursor = busyCount ? 'wait' : '';
  }

  function openModal() {
    closeModal();
    var hasHost = !!host() && !state.hostBroken;
    overlay = document.createElement('div');
    overlay.id = 'cc-sync-overlay';
    overlay.innerHTML =
      '<div id="cc-sync-modal" role="dialog" aria-label="Conta e backup">' +
        '<h2>Conta e backup</h2>' +
        '<div id="cc-sync-status"></div>' +
        '<div class="row"><button class="action" id="cc-m-sync">Verificar agora</button></div>' +
        '<div class="row">' +
          '<button class="action" id="cc-m-export">Exportar</button>' +
          '<button class="action" id="cc-m-import">Importar</button>' +
        '</div>' +
        '<div class="row">' +
          (state.signedIn
            ? '<button class="action" id="cc-m-reconnect" style="display:none">Entrar novamente</button>' +
              '<button class="action" id="cc-m-logout">Sair do Google</button>'
            : '<button class="action primary" id="cc-m-login" style="flex:2">Entrar com Google</button>') +
        '</div>' +
        '<div class="row"><button class="action" id="cc-m-conflicts" style="display:none">Resolver conflitos</button></div>' +
        (hasHost
          ? '<div class="hint">O Caderno sincroniza sozinho (a cada 15 s). ' +
            '<b>Verificar agora</b> serve só para conferir na hora. ' +
            'Conflitos de edição nunca são resolvidos sozinhos.</div>'
          : '<div class="hint">Login Google disponível somente no app instalado. Neste modo, use Exportar/Importar.</div>') +
        '<div class="row" style="margin-top:14px"><button class="action danger" id="cc-m-reset">Iniciar novo caderno</button></div>' +
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
    if (bs) { bs.disabled = !hasHost || !state.signedIn; bs.onclick = syncNow; }
    var bl = document.getElementById('cc-m-login');
    if (bl) { bl.disabled = !hasHost; bl.onclick = doLogin; }
    var bo = document.getElementById('cc-m-logout');
    if (bo) bo.onclick = function () { doLogout(); closeModal(); };
    var brc = document.getElementById('cc-m-reconnect');
    if (brc) brc.onclick = function () { doReconnect(); };
    var bc = document.getElementById('cc-m-conflicts');
    if (bc) bc.onclick = showConflicts;
    var br = document.getElementById('cc-m-reset');
    if (br) { br.disabled = !hasHost || !state.signedIn; br.onclick = resetCloud; }
    refreshHostState();
  }
  function closeModal() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; statusEl = null;
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

  // -------------------------------------------------------------- host state -
  function refreshHostState() {
    var h = host();
    if (!h || state.hostBroken) return Promise.resolve();
    return callHost('GetState').then(function (st) {
      if (!st) return;
      if (st.error) {
        state.remoteError = st.error;
        paint();
        return;
      }
      state.signedIn = !!st.signedIn;
      state.email = st.email || '';
      if (st.reachable) state.lastContactAt = Date.now();
      paint();
      if (state.signedIn && !state.hostBroken) {
        if (!state.initialPullDone) showGate();
        pullFromCloud(false);
      }
    });
  }

  // --------------------------------------------------------------- install --
  function install() {
    var imp = origBtn('Importar backup JSON ou CSV');
    var exp = origBtn('Exportar backup JSON');
    if (!imp || !exp) return false;
    imp.style.display = 'none';
    exp.style.display = 'none';
    var existing = document.querySelectorAll('#cc-sync-btn');
    if (existing.length > 0) {
      for (var i = 1; i < existing.length; i++) {
        var dup = existing[i];
        if (dup.parentNode) dup.parentNode.removeChild(dup);
      }
      btn = existing[0];
      btn.onclick = openModal;
    } else {
      var parent = imp.parentNode;
      btn = document.createElement('button');
      btn.id = 'cc-sync-btn';
      btn.setAttribute('data-state', 'idle');
      btn.setAttribute('aria-label', 'Conta e backup');
      btn.innerHTML = '&#8646;';
      btn.onclick = openModal;
      parent.insertBefore(btn, imp);
    }
    paint();
    if (!state.timer) {
      state.timer = setInterval(paint, 2000);
      setInterval(refreshHostState, 15000);
      setInterval(function () {
        if (state.signedIn && !state.hostBroken) pullFromCloud(false);
      }, POLL_MS);
      // Primeira conferencia: o gate bloqueia edicao ate a nuvem ser lida.
      setTimeout(function () {
        bootUntil = 0;
        refreshHostState();
      }, 800);
    }
    return true;
  }

  loadModel();
  var tries = 0;
  var boot = setInterval(function () {
    try {
      if (install() || ++tries > 60) clearInterval(boot);
    } catch (e) { if (++tries > 60) clearInterval(boot); }
  });
  var obs = new MutationObserver(function () {
    try {
      var btns = document.querySelectorAll('#cc-sync-btn');
      if (btns.length !== 1) { install(); return; }
      var imp = origBtn('Importar backup JSON ou CSV');
      var exp = origBtn('Exportar backup JSON');
      if (imp) imp.style.display = 'none';
      if (exp) exp.style.display = 'none';
    } catch (e) {}
  });
  try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
})();

/* Versao real instalada: o rodape mostra texto estatico do build web ("Versao X").
   Aqui ele e corrigido com a versao do pacote MSIX via host (GetAppVersion, async).
   Sem host (navegador/PWA), vale o texto carimbado no build. */
(function () {
  function fixFooter() {
    var h = null;
    try {
      h = (window.chrome && window.chrome.webview &&
           window.chrome.webview.hostObjects &&
           window.chrome.webview.hostObjects.cadernoDrive) || null;
    } catch (e) { return; }
    if (!h || !h.GetAppVersion) return;
    try {
      Promise.resolve(h.GetAppVersion()).then(function (raw) {
        if (!raw) return;
        if (raw && typeof raw === 'object' && raw.version) raw = raw.version;
        var parts = String(raw).split('.');
        if (parts.length < 2 || !/^\d+$/.test(parts[0])) return;
        var v = parts.slice(0, 3).join('.');
        var els = document.querySelectorAll('.sidebar-version');
        for (var i = 0; i < els.length; i++) {
          var t = 'Vers\u00e3o ' + v;
          if (els[i].textContent !== t) els[i].textContent = t;
        }
        var ks = document.querySelectorAll('.print-kicker');
        for (var k = 0; k < ks.length; k++) {
          var u = 'CADERNO DE CUIDADO VERS\u00c3O ' + v;
          if (ks[k].textContent !== u) ks[k].textContent = u;
        }
      }).catch(function () {});
    } catch (e) {}
  }
  var tries = 0;
  var boot = setInterval(function () {
    try { fixFooter(); } catch (e) {}
    if (++tries > 40) clearInterval(boot);
  }, 1000);
})();
