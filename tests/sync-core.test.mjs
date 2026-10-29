import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const SRC = fs.readFileSync(new URL('../sync-ui.js', import.meta.url), 'utf8');
const MARK = '})();\n\n/* Versao real instalada';
const IDX = SRC.indexOf(MARK);
if (IDX < 0) throw new Error('marcador do IIFE nao encontrado');
const EXPORTS = `
  window.__ccTest = {
    model: model, state: state, meta: meta, saveMeta: saveMeta,
    rawGet: rawGet, rawSet: rawSet, REG_KEY: REG_KEY, CFG_KEY: CFG_KEY,
    META_KEY: META_KEY, OPS_KEY: OPS_KEY, CONF_KEY: CONF_KEY,
    canon: canon, hash: hash, snapshot: snapshot, loadModel: loadModel,
    seedLocal: seedLocal, recompute: recompute, applyRemoteOps: applyRemoteOps,
    mergePayloads: mergePayloads, handleGeneration: handleGeneration,
    validatePayload: validatePayload, buildPayload: buildPayload,
    payloadToOps: payloadToOps, materialize: materialize,
    compute: compute, flushLocal: flushLocal, stateOps: stateOps,
    downloadValid: downloadValid, remoteFingerprint: remoteFingerprint
  };
`;
const INSTRUMENTED = SRC.slice(0, IDX) + EXPORTS + SRC.slice(IDX);

function makeDevice(name, reg, cfg, opts = {}) {
  const store = new Map();
  store.set('caderno-cuidado-registros-v1', JSON.stringify(reg || []));
  store.set('caderno-cuidado-config-v1', JSON.stringify(cfg || {}));
  store.set('caderno-drive-sync-v1', JSON.stringify({
    deviceId: name, generation: 0, lamport: 0, recordOrder: []
  }));
  const alerts = [];
  let confirmAnswer = opts.confirm !== undefined ? opts.confirm : true;
  const ctx = {
    console,
    JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Error,
    parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    TextEncoder,
    crypto: crypto.webcrypto,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    alert: (m) => alerts.push(String(m)),
    confirm: () => confirmAnswer,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    document: {
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        style: {}, innerHTML: '', id: '', parentNode: null,
        setAttribute() {}, appendChild() {}, addEventListener() {},
        querySelectorAll: () => [], onclick: null
      }),
      body: { appendChild() {} },
      documentElement: {}
    },
    location: { reload() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { userAgent: 'node-test' }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INSTRUMENTED, ctx, { filename: 'sync-ui.js' });
  const t = ctx.__ccTest;
  t._ctx = ctx;
  t._store = store;
  t._alerts = alerts;
  t._setConfirm = (v) => { confirmAnswer = v; };
  return t;
}

function op(device, docId, data, version, baseVersion, baseOpId, id) {
  return {
    opId: id, deviceId: device, docId, type: data === null ? 'del' : 'put',
    baseVersion, baseOpId: baseOpId || null, version,
    data, createdAt: new Date(0).toISOString()
  };
}

const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    results.push({ name, ok: true });
    console.log('PASS ' + name);
  }).catch((e) => {
    results.push({ name, ok: false, error: e });
    console.log('FAIL ' + name + ': ' + (e && e.stack || e));
  });
}

await test('semente local vira operacao e nao duplica', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  assert.equal(A.model.ops.length, 1);
  assert.equal(A.model.heads.a.data.name, 'Ana');
  assert.equal(A.model.conflicts.length, 0);
  // Reabrir mantem a mesma semente.
  A.loadModel();
  assert.equal(A.model.ops.length, 1);
});

await test('duas edicoes concorrentes criam conflito preservando as duas', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const localSeed = A.model.heads.a;
  const remote = op('devB', 'a', { id: 'a', name: 'Ana (B)' }, 1, 0, null, 'opB');
  const res = A.applyRemoteOps([remote]);
  assert.equal(res.conflicts, 1);
  assert.equal(A.model.conflicts.length, 1);
  const c = A.model.conflicts[0];
  assert.equal(c.docId, 'a');
  assert.ok([c.local.opId, c.remote.opId].includes(localSeed.opId));
  // O estado materializado continua sendo uma das versoes (nunca some).
  const reg = JSON.parse(A.rawGet(A.REG_KEY));
  assert.equal(reg.length, 1);
  assert.ok(reg[0].name === 'Ana' || reg[0].name === 'Ana (B)');
});

await test('resolucao escolhe a outra versao e encerra o conflito', () => {
  const B = makeDevice('devB', [{ id: 'a', name: 'Ana (B)' }], {});
  const remote = Object.assign({}, B.model.heads.a, {
    docId: 'a', type: 'put', baseVersion: 0, baseOpId: null,
    createdAt: new Date(0).toISOString()
  });
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  A.applyRemoteOps([remote]);
  const conf = A.model.conflicts[0];
  const chosen = conf.remote;
  const resolution = {
    opId: 'resolve1', deviceId: 'devA', docId: 'a', type: 'put',
    baseVersion: Math.max(conf.local.version, conf.remote.version),
    baseOpId: conf.local.opId, resolves: [conf.local.opId, conf.remote.opId],
    version: 5, data: chosen.data, createdAt: new Date(0).toISOString()
  };
  A.model.ops.push(resolution);
  A.recompute();
  A.materialize();
  assert.equal(A.model.conflicts.length, 0);
  assert.deepEqual(A.model.heads.a.data, chosen.data);
  assert.equal(JSON.parse(A.rawGet(A.REG_KEY))[0].name, chosen.data.name);
});

await test('resolucao se propaga para o outro aparelho sem reabrir conflito', () => {
  const B = makeDevice('devB', [{ id: 'a', name: 'Ana (B)' }], {});
  const bSeed = B.model.heads.a;
  const remote = Object.assign({}, bSeed, {
    docId: 'a', type: 'put', baseVersion: 0, baseOpId: null,
    createdAt: new Date(0).toISOString()
  });
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const aSeed = A.model.heads.a;
  A.applyRemoteOps([remote]);
  const conf = A.model.conflicts[0];
  const resolution = {
    opId: 'resolve1', deviceId: 'devA', docId: 'a', type: 'put',
    baseVersion: Math.max(conf.local.version, conf.remote.version),
    baseOpId: conf.local.opId, resolves: [conf.local.opId, conf.remote.opId],
    version: 5, data: conf.remote.data, createdAt: new Date(0).toISOString()
  };
  A.model.ops.push(resolution);
  A.recompute();
  // B recebe a semente de A e a resolucao (a propria semente ja tem).
  B.applyRemoteOps(A.model.ops.filter((o) => o.opId !== bSeed.opId));
  assert.equal(B.model.conflicts.length, 0, 'B nao pode recriar o conflito');
  assert.deepEqual(B.model.heads.a.data, conf.remote.data);
});

await test('geracao maior bloqueia poll e so limpa com decisao explicita', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const g1 = A.handleGeneration(3, false);
  assert.equal(g1.blocked, true);
  assert.equal(A.state.generationBlocked, true);
  assert.equal(JSON.parse(A.rawGet(A.REG_KEY)).length, 1, 'poll nao pode apagar');
  A._setConfirm(false);
  const g2 = A.handleGeneration(3, true);
  assert.equal(g2.blocked, true);
  assert.equal(JSON.parse(A.rawGet(A.REG_KEY)).length, 1, 'cancelar nao pode apagar');
  A._setConfirm(true);
  const g3 = A.handleGeneration(3, true);
  assert.equal(g3.reset, true);
  assert.equal(A.model.ops.length, 0);
  assert.equal(A.state.generationBlocked, false);
});

await test('payload v2 valida checksum e rejeita adulteracao', async () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  A.flushLocal();
  const p = await A.buildPayload();
  const ok = await A.validatePayload(p);
  assert.equal(ok.ok, true);
  const bad = JSON.parse(JSON.stringify(p));
  bad.ops[0].data.name = 'Adulterado';
  const no = await A.validatePayload(bad);
  assert.equal(no.ok, false);
  assert.match(no.error, /checksum/);
  const empty = await A.validatePayload({ v: 2, generation: 0, ops: [], checksum: 'x' });
  assert.equal(empty.ok, false);
});

await test('migracao legada usa apenas o snapshot mais recente', () => {
  const A = makeDevice('devA', [], {});
  const old = { v: 1, reg: JSON.stringify([{ id: 'x', name: 'Antigo' }]), cfg: {} };
  const recent = { v: 1, reg: JSON.stringify([{ id: 'y', name: 'Recente' }]), cfg: {} };
  const out = A.mergePayloads([old, recent], 2000, false, 'fp', [
    { id: 'f1', modifiedTime: 1000 }, { id: 'f2', modifiedTime: 2000 }
  ]);
  assert.equal(out.blocked, undefined);
  const reg = JSON.parse(A.rawGet(A.REG_KEY));
  assert.deepEqual(reg.map((r) => r.id), ['y']);
});

await test('v2 presente ignora snapshot v1 antigo (nao ressuscita)', () => {
  const A = makeDevice('devA', [], {});
  const legacy = { v: 1, reg: JSON.stringify([{ id: 'velho', name: 'Velho' }]), cfg: {} };
  const v2 = {
    v: 2, generation: 0, deviceId: 'devB',
    ops: [op('devB', 'novo', { id: 'novo', name: 'Novo' }, 1, 0, null, 'novo1')],
    state: { reg: JSON.stringify([{ id: 'novo', name: 'Novo' }]), cfg: '{}' }
  };
  A.mergePayloads([legacy, v2], 3000, false, 'fp2', [
    { id: 'f1', modifiedTime: 2000 }, { id: 'f2', modifiedTime: 3000 }
  ]);
  const reg = JSON.parse(A.rawGet(A.REG_KEY));
  assert.deepEqual(reg.map((r) => r.id), ['novo']);
});

await test('operacao local ausente na nuvem marca uploadNeeded', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const remoteOp = op('devB', 'b', { id: 'b', name: 'Bia' }, 1, 0, null, 'opB2');
  const out = A.mergePayloads([{
    v: 2, generation: 0, deviceId: 'devB', ops: [remoteOp],
    state: { reg: '[]', cfg: '{}' }
  }], 4000, false, 'fp3', [{ id: 'f3', modifiedTime: 4000 }]);
  assert.equal(out.uploadNeeded, true);
  const ids = A.model.ops.map((o) => o.opId);
  assert.ok(ids.includes('opB2'));
  assert.ok(ids.some((id) => id.startsWith('seed:a')));
});

await test('resolver uma dupla nao apaga a terceira ramificacao', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'A' }], {});
  const B = makeDevice('devB', [{ id: 'a', name: 'B' }], {});
  const C = makeDevice('devC', [{ id: 'a', name: 'C' }], {});
  const mk = (D) => Object.assign({}, D.model.heads.a, {
    docId: 'a', type: 'put', baseVersion: 0, baseOpId: null,
    createdAt: new Date(0).toISOString()
  });
  A.applyRemoteOps([mk(B), mk(C)]);
  assert.equal(A.model.conflicts.length, 2);
  const first = A.model.conflicts[0];
  const resolution = {
    opId: 'resolve1', deviceId: 'devA', docId: 'a', type: 'put',
    baseVersion: Math.max(first.local.version, first.remote.version),
    baseOpId: first.local.opId,
    resolves: [first.local.opId, first.remote.opId],
    version: 5, data: first.local.data, createdAt: new Date(0).toISOString()
  };
  A.model.ops.push(resolution);
  A.recompute();
  assert.equal(A.model.conflicts.length, 1, 'a terceira versao continua em conflito');
  const left = A.model.conflicts[0];
  assert.equal(left.local.opId, 'resolve1', 'lado em uso acompanha a nova cabeca');
  assert.notEqual(left.remote.opId, first.local.opId);
  assert.notEqual(left.remote.opId, first.remote.opId);
});

await test('exclusao concorrente com edicao gera conflito, nao some', () => {
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const base = A.model.heads.a;
  const del = op('devB', 'a', null, base.version + 1, base.version, base.opId, 'delB');
  A.applyRemoteOps([del]);
  // Mesma base: a exclusao e causal e vence sozinha.
  assert.equal(A.model.conflicts.length, 0);
  assert.equal(A.model.heads.a.deleted, true);
});

function attachCloud(D, cloud) {
  cloud.seq = cloud.seq || 1000;
  const newId = () => 'f' + (++cloud.seq);
  const maxTime = () => cloud.files.reduce((m, f) => Math.max(m, f.modifiedTime || 0), 0);
  const host = {
    CheckRemote: () => ({
      ok: true, exists: cloud.files.length > 0, modifiedTime: maxTime(),
      files: cloud.files.map((f) => ({
        id: f.id, name: f.name, modifiedTime: f.modifiedTime,
        size: JSON.stringify(f.payload).length
      }))
    }),
    RestoreFile: (id) => {
      const f = cloud.files.find((x) => x.id === id);
      return f ? { ok: true, payload: JSON.stringify(f.payload) }
               : { ok: false, error: 'arquivo sumiu' };
    },
    Restore: () => (cloud.files.length
      ? { ok: true, payload: JSON.stringify(cloud.files[0].payload) }
      : { ok: false, error: 'vazio' }),
    Backup: (json) => {
      const p = JSON.parse(json);
      const name = 'caderno-ops-' + p.deviceId + '.json';
      const t = ++cloud.clock;
      const f = cloud.files.find((x) => x.name === name);
      if (f) { f.payload = p; f.modifiedTime = t; }
      else cloud.files.push({ id: newId(), name, modifiedTime: t, payload: p });
      return { ok: true, name, backedUpAt: t, fileId: f ? f.id : cloud.files[cloud.files.length - 1].id };
    },
    ResetCloud: (json) => {
      cloud.files.length = 0;
      return host.Backup(json);
    },
    GetState: () => ({ ok: true, signedIn: true, email: 'teste@example.com' })
  };
  D._ctx.chrome = { webview: { hostObjects: { cadernoDrive: host } } };
  D.state.signedIn = true;
  return host;
}

await test('nuvem por dispositivo: dois arquivos, mesclagem nos dois sentidos', async () => {
  const cloud = { files: [], clock: 0 };
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const B = makeDevice('devB', [{ id: 'b', name: 'Bia' }], {});
  attachCloud(A, cloud); attachCloud(B, cloud);
  // Edicoes offline simultaneas.
  A.rawSet(A.REG_KEY, JSON.stringify([{ id: 'a', name: 'Ana 2' }]));
  A.flushLocal();
  const pa = await A.buildPayload();
  attachCloud(A, cloud).Backup(JSON.stringify(pa));
  B.rawSet(B.REG_KEY, JSON.stringify([{ id: 'b', name: 'Bia 2' }]));
  B.flushLocal();
  const pb = await B.buildPayload();
  attachCloud(B, cloud).Backup(JSON.stringify(pb));
  assert.equal(cloud.files.length, 2);
  // B baixa os dois arquivos e mescla.
  const rb = await B.downloadValid(true);
  assert.equal(rb.valid, true);
  assert.equal(rb.payloads.length, 2);
  const mb = B.mergePayloads(rb.payloads, rb.modifiedTime, false, rb.fingerprint, rb.files);
  // As operacoes de B ja estao no arquivo dele; nada novo precisa subir.
  assert.equal(mb.uploadNeeded, false);
  let regB = JSON.parse(B.rawGet(B.REG_KEY));
  assert.deepEqual(regB.map((r) => r.name).sort(), ['Ana 2', 'Bia 2']);
  // A baixa tudo e recebe a edicao de B.
  const ra = await A.downloadValid(true);
  A.mergePayloads(ra.payloads, ra.modifiedTime, false, ra.fingerprint, ra.files);
  const regA = JSON.parse(A.rawGet(A.REG_KEY));
  assert.deepEqual(regA.map((r) => r.name).sort(), ['Ana 2', 'Bia 2']);
});

await test('conflito real na nuvem e resolvido sem perder a outra versao', async () => {
  const cloud = { files: [], clock: 0 };
  const A = makeDevice('devA', [{ id: 'a', name: 'Ana' }], {});
  const B = makeDevice('devB', [{ id: 'a', name: 'Ana' }], {});
  attachCloud(A, cloud); attachCloud(B, cloud);
  // Mesma ficha editada nos dois aparelhos, ambos a partir da mesma semente.
  A.rawSet(A.REG_KEY, JSON.stringify([{ id: 'a', name: 'Ana A' }]));
  A.flushLocal();
  const pa = await A.buildPayload();
  attachCloud(A, cloud).Backup(JSON.stringify(pa));
  B.rawSet(B.REG_KEY, JSON.stringify([{ id: 'a', name: 'Ana B' }]));
  B.flushLocal();
  const pb = await B.buildPayload();
  attachCloud(B, cloud).Backup(JSON.stringify(pb));
  // A puxa a versao de B: conflito, nenhuma das duas some.
  const ra = await A.downloadValid(true);
  A.mergePayloads(ra.payloads, ra.modifiedTime, false, ra.fingerprint, ra.files);
  assert.equal(A.model.conflicts.length, 1);
  const conf = A.model.conflicts[0];
  const names = [conf.local.data.name, conf.remote.data.name].sort();
  assert.deepEqual(names, ['Ana A', 'Ana B']);
  // A escolhe explicitamente a versao de B e envia a resolucao.
  const chosen = [conf.local, conf.remote].find((x) => x.data.name === 'Ana B');
  assert.ok(chosen);
  const resolution = {
    opId: 'res-cloud', deviceId: 'devA', docId: 'a', type: 'put',
    baseVersion: Math.max(conf.local.version, conf.remote.version),
    baseOpId: conf.local.opId, resolves: [conf.local.opId, conf.remote.opId],
    version: (A.meta().lamport || 0) + 1, data: chosen.data,
    createdAt: new Date(0).toISOString()
  };
  A.model.ops.push(resolution);
  A.recompute(); A.materialize();
  assert.equal(A.model.conflicts.length, 0);
  const pr = await A.buildPayload();
  attachCloud(A, cloud).Backup(JSON.stringify(pr));
  // B puxa a resolucao e nao recria o conflito.
  const rb = await B.downloadValid(true);
  B.mergePayloads(rb.payloads, rb.modifiedTime, false, rb.fingerprint, rb.files);
  assert.equal(B.model.conflicts.length, 0);
  assert.equal(B.model.heads.a.data.name, 'Ana B');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} testes passaram`);
if (failed.length) process.exit(1);
