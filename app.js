'use strict';

/* ====== Configuração Padrão do Supabase ====== */
const DEFAULT_SUPABASE_URL = 'https://vjdcsautoooubtjdhswk.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_fmDYGqwIa1IY_B-iNZ4XAQ_QUP1BNmb';
const META_ROW_CODE = '__INV_META__';
const HIST_PREFIX = '__INV_HIST__';

function isSystemRow(code) {
  return code === META_ROW_CODE || String(code).startsWith(HIST_PREFIX);
}

/* ====== Banco local (IndexedDB) ====== */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('patrimonio-ccb', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'code' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return this.db.transaction('items', mode).objectStore('items'); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all() { return this.req(this.tx('readonly').getAll()); },
  get(code) { return this.req(this.tx('readonly').get(code)); },
  put(item) { return this.req(this.tx('readwrite').put(item)); },
  del(code) { return this.req(this.tx('readwrite').delete(code)); },
  clear() { return this.req(this.tx('readwrite').clear()); },
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

let items = [];
let histories = []; // Lista de sessões de inventário (abertas e encerradas)
let reconcileFilter = 'pend';
let currentCode = null;
let newItemPhotoData = null;
let wasScanningBeforePopup = false;
let targetSearchCode = null;
let pendingDeleteSessionCode = null;
let pendingReopenSessionCode = null;
let syncBusy = false;

/* ====== Detecção e Gestão do Nome do Dispositivo ====== */
function detectDefaultDevice() {
  const ua = navigator.userAgent || '';
  let os = 'Dispositivo';
  if (/android/i.test(ua)) {
    const m = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/i);
    os = m && m[1] ? `Android (${m[1].trim()})` : 'Android';
  } else if (/iPhone/i.test(ua)) {
    os = 'iPhone (iOS)';
  } else if (/iPad/i.test(ua)) {
    os = 'iPad (iPadOS)';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows PC';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    os = 'Mac';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux PC';
  }

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';

  return browser ? `${os} · ${browser}` : os;
}

// Tenta refinar o modelo do aparelho via Client Hints (Android Chrome moderno)
if (navigator.userAgentData?.getHighEntropyValues) {
  navigator.userAgentData.getHighEntropyValues(['model', 'platform']).then(info => {
    if (info?.model && !localStorage.getItem('device_manual')) {
      const label = `${info.platform || 'Android'} (${info.model})`;
      localStorage.setItem('device_name', label);
    }
  }).catch(() => {});
}

function getDevice() {
  let d = (localStorage.getItem('device_name') || '').trim();
  if (!d) {
    d = detectDefaultDevice();
    localStorage.setItem('device_name', d);
  }
  return d;
}

function setDevice(devName) {
  const clean = (devName || '').trim() || detectDefaultDevice();
  localStorage.setItem('device_name', clean);
  localStorage.setItem('device_manual', '1');
  return clean;
}

/* ====== Sessão de Inventário Única, Usuário & Histórico ====== */
function getDefaultSessionCode() {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = String(Math.floor(10 + Math.random() * 90));
  return `INV-${ym}-${rand}`;
}

function findGlobalOpenInventory() {
  return histories.find(h => h.status !== 'ENCERRADO') || null;
}

function getSessionCode() {
  const openInv = findGlobalOpenInventory();
  if (openInv) {
    // Regra: todos os usuários trabalham obrigatoriamente no único inventário aberto!
    if (localStorage.getItem('inv_session_code') !== openInv.sessionCode) {
      localStorage.setItem('inv_session_code', openInv.sessionCode);
    }
    return openInv.sessionCode;
  }
  return (localStorage.getItem('inv_session_code') || '').trim();
}

function setSessionCode(code) {
  code = (code || '').trim().toUpperCase();
  if (code) {
    localStorage.setItem('inv_session_code', code);
  } else {
    localStorage.removeItem('inv_session_code');
  }
  updateSessionUI();
  return code;
}

function getUser() {
  return (localStorage.getItem('user') || '').trim();
}

function setUser(name) {
  const clean = (name || '').trim() || 'Contador';
  localStorage.setItem('user', clean);
  if ($('#userName')) $('#userName').textContent = clean;
  return clean;
}

function getActiveHistoryObj() {
  const code = getSessionCode();
  return histories.find(h => h.sessionCode === code) || null;
}

function isCurrentSessionClosed() {
  const h = getActiveHistoryObj();
  return h?.status === 'ENCERRADO';
}

function updateSessionUI() {
  const s = getSessionCode();
  const hasSession = Boolean(s);
  const u = getUser() || 'Identificar';
  const closed = hasSession && isCurrentSessionClosed();
  const activeHist = getActiveHistoryObj();

  if ($('#sessionCodeLabel')) $('#sessionCodeLabel').textContent = s || 'Sem inventário';
  if ($('#scanSessionTitle')) $('#scanSessionTitle').textContent = s || 'Nenhum inventário ativo';
  if ($('#recSessionCode')) $('#recSessionCode').textContent = s || '—';
  if ($('#userName')) $('#userName').textContent = u;

  const badge = $('#sessionStatusBadge');
  if (badge) {
    if (!hasSession) {
      badge.textContent = 'INATIVO';
      badge.className = 'badge warn';
    } else {
      badge.textContent = closed ? 'ENCERRADO' : 'ABERTO';
      badge.className = `badge ${closed ? 'bad' : 'ok'}`;
    }
  }
  if ($('#scanSessionStatusText')) {
    if (!hasSession) {
      $('#scanSessionStatusText').textContent = 'Abra um inventário para iniciar';
    } else if (closed) {
      $('#scanSessionStatusText').textContent = 'Encerrado no histórico';
    } else {
      const opener = activeHist?.startedBy ? ` · Aberto por ${activeHist.startedBy}` : '';
      $('#scanSessionStatusText').textContent = `Em contagem${opener}`;
    }
  }

  $('#closedSessionBanner')?.classList.toggle('hidden', !closed);
  $('#btnOpenCloseInvModal')?.classList.toggle('hidden', !hasSession || closed);
  $('#btnReopenActiveInv')?.classList.toggle('hidden', !hasSession || !closed);
  $('#btnOpenDeleteInvModal')?.classList.toggle('hidden', !hasSession);
}

function buildSnapshotFromItems(itemList) {
  const snap = {};
  for (const it of itemList) {
    if (it.checked) {
      snap[it.code] = {
        checked: true,
        desc: it.desc || '',
        cat: it.cat || '',
        loc: it.loc || '',
        at: it.at || new Date().toISOString(),
        by: it.by || getUser() || 'Contador',
        device: it.extra?._count_device || getDevice(),
        method: it.extra?._count_method || 'Leitura Código',
      };
    }
  }
  return snap;
}

async function saveSessionToHistory({
  sessionCode,
  status,
  password,
  startedBy,
  startedDevice,
  startedAt,
  closedBy,
  closedDevice,
  closedAt,
  reopenedBy,
  reopenedDevice,
  reopenedAt,
}) {
  if (!sessionCode) return null;
  const rowCode = HIST_PREFIX + sessionCode;
  const existingRow = await DB.get(rowCode);
  const prevExtra = existingRow?.extra || {};
  const allMaster = (await DB.all()).filter(i => !isSystemRow(i.code));
  const snapshot = buildSnapshotFromItems(allMaster);
  const countedCount = Object.keys(snapshot).length;

  const extraData = {
    sessionCode,
    status: status || prevExtra.status || 'ABERTO',
    password: password !== undefined ? password : (prevExtra.password || ''),
    startedBy: startedBy || prevExtra.startedBy || getUser() || 'Contador',
    startedDevice: startedDevice || prevExtra.startedDevice || getDevice(),
    startedAt: startedAt || prevExtra.startedAt || new Date().toISOString(),
    closedBy: closedBy !== undefined ? closedBy : (prevExtra.closedBy || null),
    closedDevice: closedDevice !== undefined ? closedDevice : (prevExtra.closedDevice || null),
    closedAt: closedAt !== undefined ? closedAt : (prevExtra.closedAt || null),
    reopenedBy: reopenedBy !== undefined ? reopenedBy : (prevExtra.reopenedBy || null),
    reopenedDevice: reopenedDevice !== undefined ? reopenedDevice : (prevExtra.reopenedDevice || null),
    reopenedAt: reopenedAt !== undefined ? reopenedAt : (prevExtra.reopenedAt || null),
    updatedAt: new Date().toISOString(),
    totalMaster: allMaster.length,
    totalCounted: countedCount,
    snapshot,
  };

  const histRow = {
    code: rowCode,
    desc: `HIST_INVENTARIO_${sessionCode}`,
    cat: extraData.status,
    loc: extraData.startedDevice || '',
    obs: '',
    extra: extraData,
    photo: null,
    checked: extraData.status === 'ENCERRADO',
    at: extraData.updatedAt,
    by: extraData.startedBy,
  };

  await DB.put(histRow);
  await Cloud.upsert([histRow]);
  return extraData;
}

/* ====== Integração com Supabase (REST API) ====== */
const Cloud = {
  get url() { return (localStorage.getItem('sb_url') || DEFAULT_SUPABASE_URL || '').trim().replace(/\/+$/, ''); },
  get key() { return (localStorage.getItem('sb_key') || DEFAULT_SUPABASE_ANON_KEY || '').trim(); },
  isReady() { return Boolean(this.url && this.key); },
  headers(extra = {}) {
    return {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  },
  toRow(it) {
    return {
      code: it.code,
      desc_item: it.desc || '(sem descrição)',
      cat: it.cat || '',
      loc: it.loc || '',
      obs: it.obs || '',
      extra: it.extra || {},
      photo: it.photo || null,
      checked: Boolean(it.checked),
      at: it.at || null,
      by_user: it.by || null,
      updated_at: new Date().toISOString(),
    };
  },
  fromRow(r) {
    return {
      code: String(r.code),
      desc: r.desc_item || '(sem descrição)',
      cat: r.cat || '',
      loc: r.loc || '',
      obs: r.obs || '',
      extra: r.extra || {},
      photo: r.photo || null,
      checked: Boolean(r.checked),
      at: r.at || null,
      by: r.by_user || null,
    };
  },
  updateBadge(online, msg) {
    const b = $('#cloudBadge');
    if (!b) return;
    if (online) {
      b.textContent = '☁️ Supabase';
      b.classList.add('online');
    } else {
      b.textContent = this.isReady() ? '⚠️ Offline' : '📴 Local';
      b.classList.remove('online');
    }
    if (msg && $('#sbStatus')) $('#sbStatus').textContent = msg;
  },
  async fetchOne(code) {
    if (!this.isReady() || !code) return null;
    try {
      const q = encodeURIComponent(code);
      const res = await fetch(`${this.url}/rest/v1/patrimonio_items?code=eq.${q}&select=*`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      if (rows && rows[0]) {
        const it = this.fromRow(rows[0]);
        await DB.put(it);
        return isSystemRow(it.code) ? null : it;
      }
      return null;
    } catch {
      return null;
    }
  },
  async upsert(itemList) {
    if (!this.isReady() || !itemList.length) return false;
    try {
      const payload = itemList.map(i => this.toRow(i));
      const res = await fetch(`${this.url}/rest/v1/patrimonio_items?on_conflict=code`, {
        method: 'POST',
        headers: this.headers({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      this.updateBadge(true, `✔ Sincronizado com Supabase às ${new Date().toLocaleTimeString('pt-BR')}`);
      return true;
    } catch (e) {
      console.warn('Erro ao salvar no Supabase:', e);
      this.updateBadge(false, `⚠️ Erro ao sincronizar: ${e.message || 'verifique a conexão'}`);
      return false;
    }
  },
  async deleteOne(code) {
    if (!this.isReady() || !code) return;
    try {
      const q = encodeURIComponent(code);
      await fetch(`${this.url}/rest/v1/patrimonio_items?code=eq.${q}`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    } catch (e) {
      console.warn('Erro ao remover no Supabase:', e);
    }
  },
  async saveActiveSessionMeta(sessionCode, startedBy, password, status = 'ABERTO', startedDevice = '') {
    const metaRow = {
      code: META_ROW_CODE,
      desc: 'META_SESSAO_INVENTARIO',
      cat: status,
      loc: startedDevice || getDevice(),
      obs: '',
      extra: {
        sessionCode,
        startedBy,
        startedDevice: startedDevice || getDevice(),
        password,
        status,
        updatedAt: new Date().toISOString(),
      },
      photo: null,
      checked: false,
      at: new Date().toISOString(),
      by: startedBy || null,
    };
    await DB.put(metaRow);
    if (this.isReady()) await this.upsert([metaRow]);
  },
  async syncAll(pushLocalFirst = false) {
    if (syncBusy && !pushLocalFirst) return false;
    if (!this.isReady()) {
      this.updateBadge(false, 'Configure a URL e a Anon Key do Supabase.');
      return false;
    }
    try {
      if (pushLocalFirst) {
        const localItems = await DB.all();
        if (localItems.length) await this.upsert(localItems);
      }
      const res = await fetch(`${this.url}/rest/v1/patrimonio_items?select=*`, {
        headers: this.headers(),
      });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      const remoteCodes = new Set();
      let remoteOpenSession = null;

      for (const r of rows) {
        const it = this.fromRow(r);
        remoteCodes.add(it.code);
        await DB.put(it);
        if (String(r.code).startsWith(HIST_PREFIX) && r.extra?.status !== 'ENCERRADO' && r.extra?.sessionCode) {
          remoteOpenSession = r.extra.sessionCode;
        }
      }

      const allLocal = await DB.all();
      if (pushLocalFirst) {
        const missingOnCloud = allLocal.filter(i => !remoteCodes.has(i.code));
        if (missingOnCloud.length) await this.upsert(missingOnCloud);
      } else {
        for (const locIt of allLocal) {
          if (isSystemRow(locIt.code) && !remoteCodes.has(locIt.code)) {
            await DB.del(locIt.code);
            if (locIt.code === HIST_PREFIX + localStorage.getItem('inv_session_code')) {
              localStorage.removeItem('inv_session_code');
              localStorage.removeItem('inv_session_manual');
            }
          }
        }
      }

      // Se existe um inventário aberto na nuvem, vincula todos os usuários a ele automaticamente
      if (remoteOpenSession) {
        localStorage.setItem('inv_session_code', remoteOpenSession);
      }

      const finalLocal = await DB.all();
      const masterCount = finalLocal.filter(i => !isSystemRow(i.code)).length;
      this.updateBadge(true, `✔ Conectado ao Supabase (${masterCount} bens na base).`);
      await refresh();
      return true;
    } catch (e) {
      console.warn('Erro ao buscar do Supabase:', e);
      this.updateBadge(false, '⚠️ Sem conexão com o Supabase no momento (usando cache local).');
      return false;
    }
  },
  async clearRemote() {
    if (!this.isReady()) return;
    try {
      await fetch(`${this.url}/rest/v1/patrimonio_items?code=not.is.null`, {
        method: 'DELETE',
        headers: this.headers(),
      });
    } catch (e) {
      console.warn('Erro ao limpar Supabase:', e);
    }
  },
};

/* ====== Abas ====== */
function switchTab(tabName) {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === tabName));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tabName));
  if (tabName !== 'scan') stopScan();
  if (tabName === 'reconcile') {
    Cloud.syncAll(false);
    renderHistory();
    renderReconcile();
  }
  if (tabName === 'master') {
    renderMaster();
  }
}

document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => switchTab(b.dataset.tab);
});

/* ====== Modal de Abertura de Novo Inventário ou Entrada no Único Inventário Aberto ====== */
async function openSessionModal(forceUser = false) {
  stopScan();
  if (Cloud.isReady()) {
    await Cloud.syncAll(false);
  }

  const openInv = findGlobalOpenInventory();
  $('#sessionUserInput').value = getUser() || '';
  $('#sessionDeviceInput').value = getDevice();
  $('#sessionPassInput').value = '';

  const codeInput = $('#sessionCodeInput');
  const notice = $('#singleOpenNotice');
  const passGroup = $('#newInvPassGroup');
  const genBtn = $('#btnGenerateSessionCode');

  if (openInv) {
    // JÁ EXISTE UM INVENTÁRIO ABERTO: Todos os usuários trabalham obrigatoriamente nele!
    $('#sessionModalTitle').textContent = '👥 Inventário em Andamento';
    notice.classList.remove('hidden');
    notice.innerHTML = `
      <div><b>🔒 Inventário Único Ativo:</b> <code>${esc(openInv.sessionCode)}</code></div>
      <div><b>Aberto por:</b> ${esc(openInv.startedBy || '—')} (${esc(openInv.startedDevice || '—')})</div>
      <div><b>Data/Hora:</b> ${openInv.startedAt ? new Date(openInv.startedAt).toLocaleString('pt-BR') : '—'}</div>
      <div class="muted" style="margin-top:4px">Não é permitido abrir outro inventário enquanto este estiver aberto. Confirme seu nome e dispositivo para contar neste inventário:</div>
    `;
    codeInput.value = openInv.sessionCode;
    codeInput.setAttribute('readonly', 'readonly');
    codeInput.classList.add('readonly-input');
    genBtn.classList.add('hidden');
    passGroup.classList.add('hidden');
    $('#sessionPassInput').removeAttribute('required');
    $('#btnSubmitSession').textContent = '👥 Entrar e Contar neste Inventário';
  } else {
    // NENHUM INVENTÁRIO ABERTO: Permite abrir um novo definindo código e senha
    $('#sessionModalTitle').textContent = '➕ Abrir Novo Inventário';
    notice.classList.add('hidden');
    codeInput.value = getDefaultSessionCode();
    codeInput.removeAttribute('readonly');
    codeInput.classList.remove('readonly-input');
    genBtn.classList.remove('hidden');
    passGroup.classList.remove('hidden');
    $('#sessionPassInput').setAttribute('required', 'required');
    $('#btnSubmitSession').textContent = '✔ Abrir Inventário com Senha';
  }

  $('#btnCancelSession').classList.toggle('hidden', forceUser && !getUser());
  $('#btnCloseSessionModal').classList.toggle('hidden', forceUser && !getUser());
  $('#sessionModal').classList.remove('hidden');

  setTimeout(() => {
    if (!getUser()) $('#sessionUserInput').focus();
    else if (!openInv) $('#sessionPassInput').focus();
  }, 80);
}

function closeSessionModal() {
  $('#sessionModal').classList.add('hidden');
}

$('#btnGenerateSessionCode')?.addEventListener('click', () => {
  if (findGlobalOpenInventory()) {
    return toast('⚠️ Já existe um inventário aberto! Encerre-o antes de gerar outro.');
  }
  const d = new Date();
  const rand = String(Math.floor(100 + Math.random() * 900));
  const code = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${rand}`;
  $('#sessionCodeInput').value = code;
});

$('#btnSessionBanner')?.addEventListener('click', () => openSessionModal(false));
$('#btnOpenSessionModal')?.addEventListener('click', () => openSessionModal(false));
$('#btnManageSession')?.addEventListener('click', () => openSessionModal(false));
$('#btnNewInvFromHist')?.addEventListener('click', () => {
  const openInv = findGlobalOpenInventory();
  if (openInv) {
    toast(`⚠️ O inventário ${openInv.sessionCode} já está aberto por ${openInv.startedBy}. Encerre-o primeiro!`);
  }
  openSessionModal(false);
});
$('#btnUser')?.addEventListener('click', () => openSessionModal(false));
$('#btnCloseSessionModal')?.addEventListener('click', closeSessionModal);
$('#btnCancelSession')?.addEventListener('click', closeSessionModal);

$('#sessionForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const u = setUser($('#sessionUserInput').value);
  const dev = setDevice($('#sessionDeviceInput').value);

  // Sincroniza antes de confirmar para garantir que ninguém abriu outro inventário no mesmo instante
  if (Cloud.isReady()) await Cloud.syncAll(false);
  const openInv = findGlobalOpenInventory();

  if (openInv) {
    // Conecta o usuário ao único inventário aberto
    setSessionCode(openInv.sessionCode);
    await refresh();
    closeSessionModal();
    toast(`👥 Conectado ao inventário ${openInv.sessionCode} (${u} · ${dev})`);
    return;
  }

  // Abrindo novo inventário (quando não há nenhum aberto)
  const c = ($('#sessionCodeInput').value || '').trim().toUpperCase();
  if (!c) return toast('Informe o código do inventário');
  if (histories.some(h => h.sessionCode === c)) {
    return toast(`⚠️ O código ${c} já existe no histórico. Escolha outro código ou reabra-o no Histórico.`);
  }

  const pass = ($('#sessionPassInput').value || '').trim();
  if (!pass) return toast('🔒 Defina uma senha de abertura para o novo inventário!');

  setSessionCode(c);
  localStorage.setItem('inv_session_manual', '1');

  // Inicia contagem limpa para o novo inventário mantendo Dados Mestre
  await clearCurrentItemChecksOnly();

  const nowIso = new Date().toISOString();
  await Cloud.saveActiveSessionMeta(c, u, pass, 'ABERTO', dev);
  await saveSessionToHistory({
    sessionCode: c,
    status: 'ABERTO',
    password: pass,
    startedBy: u,
    startedDevice: dev,
    startedAt: nowIso,
    closedBy: null,
    closedDevice: null,
    closedAt: null,
  });
  await refresh();
  closeSessionModal();
  toast(`✔ Inventário ${c} aberto por ${u} (${dev})!`);
});

async function clearCurrentItemChecksOnly() {
  const all = (await DB.all()).filter(i => !isSystemRow(i.code));
  const updated = [];
  for (const it of all) {
    if (it.checked || it.at || it.by) {
      it.checked = false;
      it.at = null;
      it.by = null;
      if (it.extra) {
        delete it.extra._inv_session;
        delete it.extra._count_method;
        delete it.extra._count_device;
      }
      await DB.put(it);
      updated.push(it);
    }
  }
  if (updated.length) await Cloud.upsert(updated);
  $('#result').innerHTML = '';
}

async function restoreSnapshotToItems(snapshot, sessionCode) {
  const all = (await DB.all()).filter(i => !isSystemRow(i.code));
  const updated = [];
  for (const it of all) {
    const s = snapshot ? snapshot[it.code] : null;
    if (s && s.checked) {
      it.checked = true;
      it.at = s.at;
      it.by = s.by;
      it.extra = {
        ...(it.extra || {}),
        _inv_session: sessionCode,
        _count_method: s.method || 'Leitura Código',
        _count_device: s.device || '—',
      };
    } else {
      it.checked = false;
      it.at = null;
      it.by = null;
      if (it.extra) {
        delete it.extra._inv_session;
        delete it.extra._count_method;
        delete it.extra._count_device;
      }
    }
    await DB.put(it);
    updated.push(it);
  }
  if (updated.length) await Cloud.upsert(updated);
}

/* ====== Validação da Senha de Abertura do Inventário ====== */
async function getSessionPassword(sessionCode) {
  if (Cloud.isReady()) {
    await Cloud.fetchOne(HIST_PREFIX + sessionCode);
    await Cloud.fetchOne(META_ROW_CODE);
  }
  const histRow = await DB.get(HIST_PREFIX + sessionCode);
  if (histRow?.extra?.password) return String(histRow.extra.password).trim();
  const metaRow = await DB.get(META_ROW_CODE);
  if (metaRow?.extra?.sessionCode === sessionCode && metaRow?.extra?.password) {
    return String(metaRow.extra.password).trim();
  }
  return '';
}

/* ====== Modal 4: ENCERRAR INVENTÁRIO (Com Senha de Abertura, Comparação Opcional, Salva no Histórico) ====== */
function openCloseInvModal() {
  stopScan();
  const s = getSessionCode();
  if (!s) return toast('Nenhum inventário aberto no momento.');
  $('#closeInvCodeLabel').textContent = s;
  $('#closeInvPassInput').value = '';
  $('#closeInvGoCompare').checked = false;
  $('#closeInvModal').classList.remove('hidden');
  setTimeout(() => $('#closeInvPassInput').focus(), 80);
}

function closeCloseInvModal() {
  $('#closeInvModal').classList.add('hidden');
}

$('#btnOpenCloseInvModal')?.addEventListener('click', openCloseInvModal);
$('#btnCloseFromData')?.addEventListener('click', openCloseInvModal);
$('#btnCancelCloseInv')?.addEventListener('click', closeCloseInvModal);

$('#closeInvForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const s = getSessionCode();
  const typedPass = ($('#closeInvPassInput').value || '').trim();
  const savedPass = await getSessionPassword(s);

  if (savedPass && typedPass !== savedPass) {
    navigator.vibrate?.([200, 100, 200]);
    return toast('❌ Senha incorreta! Informe a senha definida na abertura do inventário.');
  }

  const goCompare = $('#closeInvGoCompare').checked;
  const user = getUser() || 'Contador';
  const dev = getDevice();

  await saveSessionToHistory({
    sessionCode: s,
    status: 'ENCERRADO',
    password: savedPass || typedPass,
    closedBy: user,
    closedDevice: dev,
    closedAt: new Date().toISOString(),
  });
  await Cloud.saveActiveSessionMeta(s, user, savedPass || typedPass, 'ENCERRADO', dev);
  await refresh();
  closeCloseInvModal();

  toast(`🔒 Inventário ${s} encerrado e salvo no histórico!`);
  if (goCompare) {
    switchTab('reconcile');
  }
});

/* ====== Modal 6: Reabrir Contagem do Histórico (Exige Senha + Bloqueia se já houver outro aberto) ====== */
async function openReopenInvModal(sessionCode) {
  stopScan();
  if (Cloud.isReady()) await Cloud.syncAll(false);

  const target = (sessionCode || getSessionCode() || '').trim();
  if (!target) return toast('Nenhum inventário selecionado para reabrir.');

  // Regra: Não permite reabrir se já houver outro inventário aberto!
  const openInv = findGlobalOpenInventory();
  if (openInv && openInv.sessionCode !== target) {
    navigator.vibrate?.([200, 100, 200]);
    return toast(`⚠️ O inventário ${openInv.sessionCode} está ABERTO! Encerre-o antes de reabrir o ${target}.`);
  }

  pendingReopenSessionCode = target;
  $('#reopenInvCodeLabel').textContent = pendingReopenSessionCode;
  $('#reopenInvPassInput').value = '';
  $('#reopenInvModal').classList.remove('hidden');
  setTimeout(() => $('#reopenInvPassInput').focus(), 80);
}

function closeReopenInvModal() {
  $('#reopenInvModal').classList.add('hidden');
  pendingReopenSessionCode = null;
}

$('#btnCancelReopenInv')?.addEventListener('click', closeReopenInvModal);

$('#reopenInvForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const targetCode = (pendingReopenSessionCode || getSessionCode() || '').trim();
  if (!targetCode) return closeReopenInvModal();

  const openInv = findGlobalOpenInventory();
  if (openInv && openInv.sessionCode !== targetCode) {
    closeReopenInvModal();
    return toast(`⚠️ Já existe o inventário ${openInv.sessionCode} aberto!`);
  }

  const typedPass = ($('#reopenInvPassInput').value || '').trim();
  const savedPass = await getSessionPassword(targetCode);

  if (savedPass && typedPass !== savedPass) {
    navigator.vibrate?.([200, 100, 200]);
    return toast('❌ Senha incorreta! Só é permitido reabrir com a senha de abertura.');
  }

  closeReopenInvModal();
  await executeReopenInventorySession(targetCode, savedPass || typedPass);
});

async function executeReopenInventorySession(sessionCode, validPass) {
  const histRow = await DB.get(HIST_PREFIX + sessionCode);
  const snap = histRow?.extra?.snapshot || null;
  const pass = validPass || histRow?.extra?.password || '';
  const user = getUser() || 'Contador';
  const dev = getDevice();

  setSessionCode(sessionCode);
  localStorage.setItem('inv_session_manual', '1');

  if (snap) {
    await restoreSnapshotToItems(snap, sessionCode);
  }

  await saveSessionToHistory({
    sessionCode,
    status: 'ABERTO',
    password: pass,
    closedBy: null,
    closedDevice: null,
    closedAt: null,
    reopenedBy: user,
    reopenedDevice: dev,
    reopenedAt: new Date().toISOString(),
  });
  await Cloud.saveActiveSessionMeta(sessionCode, user, pass, 'ABERTO', dev);
  await refresh();
  toast(`🔓 Inventário ${sessionCode} reaberto por ${user}!`);
  switchTab('scan');
}

$('#btnReopenActiveInv')?.addEventListener('click', () => openReopenInvModal(getSessionCode()));
$('#btnBannerReopen')?.addEventListener('click', () => openReopenInvModal(getSessionCode()));

/* ====== Modal 5: ELIMINAR CONTAGEM TODA (Exige Senha de Abertura) ====== */
function openDeleteInvModal(sessionCode) {
  stopScan();
  const target = (sessionCode || getSessionCode() || '').trim();
  if (!target) return toast('Nenhum inventário ativo para eliminar.');
  pendingDeleteSessionCode = target;
  $('#deleteInvCodeLabel').textContent = pendingDeleteSessionCode;
  $('#deleteInvPassInput').value = '';
  $('#deleteInvModal').classList.remove('hidden');
  setTimeout(() => $('#deleteInvPassInput').focus(), 80);
}

function closeDeleteInvModal() {
  $('#deleteInvModal').classList.add('hidden');
  pendingDeleteSessionCode = null;
}

$('#btnOpenDeleteInvModal')?.addEventListener('click', () => openDeleteInvModal(getSessionCode()));
$('#btnDeleteFromData')?.addEventListener('click', () => openDeleteInvModal(getSessionCode()));
$('#btnCancelDeleteInv')?.addEventListener('click', closeDeleteInvModal);

$('#deleteInvForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const targetCode = (pendingDeleteSessionCode || getSessionCode() || '').trim();
  if (!targetCode) return closeDeleteInvModal();

  const typedPass = ($('#deleteInvPassInput').value || '').trim();
  const savedPass = await getSessionPassword(targetCode);

  if (savedPass && typedPass !== savedPass) {
    navigator.vibrate?.([200, 100, 200]);
    return toast('❌ Senha incorreta! Só é permitido eliminar com a senha de abertura.');
  }

  syncBusy = true;
  try {
    const activeBefore = getSessionCode();

    const all = (await DB.all()).filter(i => !isSystemRow(i.code));
    const updated = [];
    for (const it of all) {
      if (targetCode === activeBefore || it.extra?._inv_session === targetCode || it.checked) {
        it.checked = false;
        it.at = null;
        it.by = null;
        if (it.extra) {
          delete it.extra._inv_session;
          delete it.extra._count_method;
          delete it.extra._count_device;
        }
        await DB.put(it);
        updated.push(it);
      }
    }
    if (updated.length) await Cloud.upsert(updated);

    const histKey = HIST_PREFIX + targetCode;
    await DB.del(histKey);
    await Cloud.deleteOne(histKey);

    const metaRow = await DB.get(META_ROW_CODE);
    if (targetCode === activeBefore || metaRow?.extra?.sessionCode === targetCode) {
      await DB.del(META_ROW_CODE);
      await Cloud.deleteOne(META_ROW_CODE);
      localStorage.removeItem('inv_session_code');
      localStorage.removeItem('inv_session_manual');
    }

    await refresh();

    if (targetCode === activeBefore) {
      const nextOpen = findGlobalOpenInventory();
      if (nextOpen) {
        setSessionCode(nextOpen.sessionCode);
      } else {
        setSessionCode('');
      }
      $('#result').innerHTML = '';
    }

    updateSessionUI();
    renderHistory();
    renderReconcile();
    closeDeleteInvModal();
    toast(`🗑️ Inventário ${targetCode} eliminado completamente!`);
  } finally {
    syncBusy = false;
  }
});

/* ====== Renderização do Histórico de Inventários + Detalhes de Auditoria ====== */
function renderHistory() {
  const ul = $('#historyList');
  if (!ul) return;

  if (!histories.length) {
    ul.innerHTML = '<li class="empty">Nenhum histórico de inventário registrado ainda.</li>';
    return;
  }

  const activeCode = getSessionCode();
  ul.innerHTML = histories.map(h => {
    const isCurrent = h.sessionCode === activeCode;
    const isClosed = h.status === 'ENCERRADO';
    const openInfo = `🟢 <b>Aberto por:</b> ${esc(h.startedBy || '—')} · 📱 ${esc(h.startedDevice || '—')} · 🕒 ${h.startedAt ? new Date(h.startedAt).toLocaleString('pt-BR') : '—'}`;
    const closeInfo = isClosed && h.closedAt
      ? `<small>🔴 <b>Encerrado por:</b> ${esc(h.closedBy || '—')} · 📱 ${esc(h.closedDevice || '—')} · 🕒 ${new Date(h.closedAt).toLocaleString('pt-BR')}</small>`
      : '';
    const reopenInfo = h.reopenedAt
      ? `<small>🔓 <b>Reaberto por:</b> ${esc(h.reopenedBy || '—')} · 📱 ${esc(h.reopenedDevice || '—')} · 🕒 ${new Date(h.reopenedAt).toLocaleString('pt-BR')}</small>`
      : '';

    const countedNum = h.totalCounted ?? Object.keys(h.snapshot || {}).length;

    return `<li>
      <div class="list-main" data-hist-detail="${esc(h.sessionCode)}">
        <div class="thumb">${isClosed ? '🔒' : '📋'}</div>
        <div class="info">
          <b>${esc(h.sessionCode)} ${isCurrent ? '<span class="badge gold">Ativo</span>' : ''}</b>
          <small>${openInfo}</small>
          ${reopenInfo}
          ${closeInfo}
          <small>📊 Contados: <b>${countedNum}</b> de ${h.totalMaster ?? items.length} bens</small>
        </div>
        <span class="badge ${isClosed ? 'bad' : 'ok'}">${isClosed ? 'ENCERRADO' : 'ABERTO'}</span>
      </div>
      <div class="item-actions">
        <button type="button" class="btn" data-hist-detail="${esc(h.sessionCode)}">📋 Ver Contadores (${countedNum})</button>
        ${isClosed
          ? `<button type="button" class="btn ok" data-hist-reopen="${esc(h.sessionCode)}">🔓 Reabrir</button>`
          : ''
        }
        <button type="button" class="btn danger" data-hist-delete="${esc(h.sessionCode)}">🗑️ Eliminar</button>
      </div>
    </li>`;
  }).join('');
}

function openHistoryDetailModal(sessionCode) {
  const h = histories.find(x => x.sessionCode === sessionCode);
  if (!h) return;

  $('#histDetailTitle').textContent = `📜 Auditoria: ${h.sessionCode}`;
  const isClosed = h.status === 'ENCERRADO';
  $('#histDetailMeta').innerHTML = `
    <div><b>Status:</b> <span class="badge ${isClosed ? 'bad' : 'ok'}">${isClosed ? 'ENCERRADO' : 'ABERTO'}</span></div>
    <div><b>Aberto por:</b> ${esc(h.startedBy || '—')} · 📱 ${esc(h.startedDevice || '—')}</div>
    <div><b>Data/Hora Abertura:</b> ${h.startedAt ? new Date(h.startedAt).toLocaleString('pt-BR') : '—'}</div>
    ${h.reopenedAt ? `<div><b>Última Reabertura:</b> ${esc(h.reopenedBy || '—')} (${esc(h.reopenedDevice || '—')}) em ${new Date(h.reopenedAt).toLocaleString('pt-BR')}</div>` : ''}
    ${isClosed && h.closedAt ? `<div><b>Encerrado por:</b> ${esc(h.closedBy || '—')} (${esc(h.closedDevice || '—')}) em ${new Date(h.closedAt).toLocaleString('pt-BR')}</div>` : ''}
  `;

  const snap = h.snapshot || {};
  const entries = Object.entries(snap).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
  const ul = $('#histDetailItems');

  if (!entries.length) {
    ul.innerHTML = '<li class="empty">Nenhum item foi contado neste inventário ainda.</li>';
  } else {
    ul.innerHTML = entries.map(([code, info]) => {
      const masterIt = findLocal(code);
      const desc = info.desc || masterIt?.desc || '(Item)';
      const loc = info.loc || masterIt?.loc || '';
      const when = info.at ? new Date(info.at).toLocaleString('pt-BR') : '—';
      return `<li>
        <div class="info">
          <b>${esc(desc)} <span class="code">${esc(code)}</span></b>
          ${loc ? `<small>📍 Local: ${esc(loc)}</small>` : ''}
          <small>👤 <b>Contado por:</b> ${esc(info.by || '—')} · 📱 <b>Dispositivo:</b> ${esc(info.device || '—')}</small>
          <small>🕒 <b>Data/Hora:</b> ${esc(when)} · 🏷️ ${esc(info.method || 'Leitura')}</small>
        </div>
      </li>`;
    }).join('');
  }

  $('#histDetailModal').classList.remove('hidden');
}

function closeHistoryDetailModal() {
  $('#histDetailModal').classList.add('hidden');
}

$('#btnCloseHistDetail')?.addEventListener('click', closeHistoryDetailModal);
$('#btnOkHistDetail')?.addEventListener('click', closeHistoryDetailModal);

$('#historyList')?.addEventListener('click', e => {
  const reopenBtn = e.target.closest('[data-hist-reopen]');
  if (reopenBtn) {
    openReopenInvModal(reopenBtn.dataset.histReopen);
    return;
  }
  const delBtn = e.target.closest('[data-hist-delete]');
  if (delBtn) {
    openDeleteInvModal(delBtn.dataset.histDelete);
    return;
  }
  const detailBtn = e.target.closest('[data-hist-detail]');
  if (detailBtn) {
    openHistoryDetailModal(detailBtn.dataset.histDetail);
  }
});

/* ====== Configuração Supabase na Aba Ajustes ====== */
function initSupabaseConfig() {
  const params = new URLSearchParams(location.search);
  if (params.get('sb_url')) localStorage.setItem('sb_url', params.get('sb_url').trim());
  if (params.get('sb_key')) localStorage.setItem('sb_key', params.get('sb_key').trim());

  if ($('#sbUrl')) $('#sbUrl').value = Cloud.url;
  if ($('#sbKey')) $('#sbKey').value = Cloud.key;

  $('#btnSaveSb')?.addEventListener('click', async () => {
    const u = $('#sbUrl').value.trim();
    const k = $('#sbKey').value.trim();
    localStorage.setItem('sb_url', u);
    localStorage.setItem('sb_key', k);
    if (!u || !k) {
      Cloud.updateBadge(false, 'Credenciais removidas. Funcionando apenas no banco local.');
      return toast('Modo local ativado');
    }
    toast('Conectando ao Supabase...');
    const ok = await Cloud.syncAll(true);
    toast(ok ? 'Supabase conectado e sincronizado ✔' : 'Erro ao conectar ao Supabase');
  });

  $('#btnSyncSb')?.addEventListener('click', async () => {
    if (!Cloud.isReady()) return toast('Informe a URL e a Anon Key primeiro');
    toast('Sincronizando com Supabase...');
    const ok = await Cloud.syncAll(true);
    toast(ok ? 'Base sincronizada ✔' : 'Falha ao sincronizar');
  });
}

/* ====== Leitura e Importação de CSV (Dados Mestre e Conciliação) ====== */
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const ALIAS = {
  code: ['codigo', 'codigodebarras', 'codbarras', 'barras', 'cod', 'etiqueta', 'tombo', 'patrimonio', 'id'],
  desc: ['descricao', 'nome', 'item', 'objeto', 'bem', 'produto'],
  cat: ['categoria', 'tipo', 'grupo', 'classe'],
  loc: ['local', 'localizacao', 'setor', 'sala', 'ambiente', 'dependencia'],
  obs: ['observacao', 'observacoes', 'obs', 'detalhes'],
};

async function importCSV(file, isReconcileCompare = false) {
  if (Cloud.isReady()) await Cloud.syncAll(false);

  const rows = parseCSV(decode(await file.arrayBuffer()));
  if (rows.length < 2) return toast('CSV vazio ou inválido');
  const heads = rows[0].map(h => h.trim());
  const map = {};
  heads.forEach((h, i) => {
    const n = norm(h);
    for (const k in ALIAS) if (map[k] === undefined && ALIAS[k].includes(n)) map[k] = i;
  });
  if (map.code === undefined) map.code = 0;
  if (map.desc === undefined) map.desc = map.code === 0 ? 1 : 0;
  const used = new Set(Object.values(map));
  const keep = isReconcileCompare ? true : $('#keepState').checked;
  const old = new Map((await DB.all()).map(i => [i.code, i]));

  let n = 0;
  let foundCount = 0;
  let missingCount = 0;
  const imported = [];
  const user = getUser() || 'Importação CSV';
  const dev = getDevice();
  const nowIso = new Date().toISOString();

  for (const r of rows.slice(1)) {
    const code = (r[map.code] || '').trim();
    if (!code || isSystemRow(code)) continue;
    const extra = {};
    heads.forEach((h, i) => { if (!used.has(i) && h && (r[i] || '').trim()) extra[h] = r[i].trim(); });
    const prev = keep ? old.get(code) : null;
    const mergedExtra = {
      ...(prev?.extra || {}),
      ...extra,
      _in_csv: true,
      _created_by: prev?.extra?._created_by || user,
      _created_device: prev?.extra?._created_device || dev,
      _created_at: prev?.extra?._created_at || nowIso,
      _updated_by: user,
      _updated_device: dev,
      _updated_at: nowIso,
    };

    const item = {
      code,
      desc: (r[map.desc] || '').trim() || prev?.desc || '(sem descrição)',
      cat: (r[map.cat] || '').trim() || prev?.cat || '',
      loc: (r[map.loc] || '').trim() || prev?.loc || '',
      obs: (r[map.obs] || '').trim() || prev?.obs || '',
      extra: mergedExtra,
      photo: prev?.photo || null,
      checked: prev?.checked || false,
      at: prev?.at || null,
      by: prev?.by || null,
    };
    if (item.checked) foundCount++;
    else missingCount++;

    await DB.put(item);
    imported.push(item);
    n++;
  }

  if (Cloud.isReady() && imported.length) {
    await Cloud.upsert(imported);
  }

  await saveSessionToHistory({ sessionCode: getSessionCode() });
  await refresh();

  if (isReconcileCompare) {
    const msg = `✔ CSV comparado (${n} itens no CSV): ${foundCount} encontrados e ${missingCount} NÃO encontrados.`;
    if ($('#compareMsg')) $('#compareMsg').textContent = msg;
    reconcileFilter = missingCount > 0 ? 'pend' : 'all';
    document.querySelectorAll('[data-rf]').forEach(b => b.classList.toggle('sel', b.dataset.rf === reconcileFilter));
    renderReconcile();
    toast(`${missingCount} itens não encontrados`);
  } else {
    $('#importMsg').textContent = `✔ ${n} itens importados por ${user} (${dev}) em ${new Date().toLocaleString('pt-BR')}.`;
    localStorage.setItem('lastImport', $('#importMsg').textContent);
    toast(`${n} itens importados`);
  }
}

$('#csvFile').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0], false); e.target.value = ''; };
$('#compareCsvFile').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0], true); e.target.value = ''; };
$('#btnCompareMaster')?.addEventListener('click', async () => {
  toast('Atualizando dados com Supabase...');
  await Cloud.syncAll(false);
  renderHistory();
  renderReconcile();
  toast('Dados atualizados ✔');
});

/* ====== Exportação CSV Completo com Auditoria de Usuário e Dispositivo ====== */
$('#btnExport').onclick = () => {
  if (!items.length) return toast('Nada para exportar');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = [
    'codigo_inventario',
    'aberto_por',
    'dispositivo_abertura',
    'codigo',
    'descricao',
    'categoria',
    'local',
    'estado',
    'observacao',
    'situacao',
    'metodo_conferencia',
    'contado_por',
    'dispositivo_contagem',
    'data_hora_conferencia',
    'cadastrado_por',
    'dispositivo_cadastro',
    'data_hora_cadastro',
  ];
  const invCode = getSessionCode();
  const activeHist = getActiveHistoryObj();
  const lines = [head.join(';')].concat(items.map(i => [
    i.extra?._inv_session || invCode,
    activeHist?.startedBy || '',
    activeHist?.startedDevice || '',
    i.code,
    i.desc,
    i.cat,
    i.loc,
    i.extra?._state || 'Bom',
    i.obs,
    i.checked ? 'ENCONTRADO' : 'NAO_ENCONTRADO',
    i.checked ? (i.extra?._count_method || 'Leitura Código') : 'Pendente',
    i.by || '',
    i.extra?._count_device || '',
    i.at ? new Date(i.at).toLocaleString('pt-BR') : '',
    i.extra?._created_by || '',
    i.extra?._created_device || '',
    i.extra?._created_at ? new Date(i.extra._created_at).toLocaleString('pt-BR') : '',
  ].map(q).join(';')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `inventario_ccb_${invCode || 'base'}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$('#btnReset').onclick = async () => {
  const s = getSessionCode();
  const savedPass = await getSessionPassword(s);
  if (savedPass) {
    const typed = prompt(`Digite a senha de abertura do inventário (${s}) para apagar toda a base:`);
    if (typed === null) return;
    if (typed.trim() !== savedPass) return toast('❌ Senha incorreta! Operação cancelada.');
  } else if (!confirm('ATENÇÃO: Apagar TODOS os Dados Mestre, fotos e históricos do banco?')) {
    return;
  }
  await DB.clear();
  await Cloud.clearRemote();
  localStorage.removeItem('inv_session_code');
  localStorage.removeItem('inv_session_manual');
  await refresh();
  $('#result').innerHTML = '';
  toast('Todos os dados foram apagados');
};

/* ====== Busca e Contagem com Pop-ups Centralizados ====== */
function findLocal(code) {
  code = String(code || '').trim();
  return items.find(i => i.code === code)
    || items.find(i => i.code.toLowerCase() === code.toLowerCase())
    || items.find(i => i.code.replace(/^0+/, '') === code.replace(/^0+/, ''));
}

async function handleScanOrSearch(rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return;

  if (!getUser() || !getSessionCode()) {
    openSessionModal(true);
    return;
  }

  if (isCurrentSessionClosed()) {
    stopScan();
    toast('🔒 Inventário encerrado! Informe a senha de abertura para reabri-lo.');
    openReopenInvModal(getSessionCode());
    return;
  }

  let it = findLocal(code);
  if (Cloud.isReady()) {
    const remoteIt = await Cloud.fetchOne(it ? it.code : code);
    if (remoteIt) {
      it = remoteIt;
      await refresh();
    }
  }

  // Se o código NÃO EXISTE na base mestre -> Abre Pop-up Centralizado no meio da tela!
  if (!it) {
    currentCode = null;
    openAskCreatePopup(code);
    navigator.vibrate?.([200, 100, 200]);
    return;
  }

  if (targetSearchCode && it.code !== targetSearchCode) {
    toast(`⚠️ Código lido (${it.code}) é diferente do item procurado (${targetSearchCode})`);
  } else if (targetSearchCode && it.code === targetSearchCode) {
    clearTargetSearch();
  }

  // Se o item JÁ FOI CONTADO -> Avisa em Pop-up quem contou, qual dispositivo e data/hora!
  if (it.checked) {
    renderItemCard(it);
    openAlreadyCountedPopup(it);
    navigator.vibrate?.([150, 80, 150, 80, 150]);
    return;
  }

  // Item existe e ainda não foi contado -> Registra contagem imediatamente com Usuário + Dispositivo + Data/Hora!
  const user = getUser() || 'Contador';
  const dev = getDevice();
  const invSession = getSessionCode();
  it.checked = true;
  it.at = new Date().toISOString();
  it.by = user;
  it.extra = {
    ...(it.extra || {}),
    _inv_session: invSession,
    _count_method: 'Leitura Código de Barras',
    _count_device: dev,
  };

  await DB.put(it);
  await Cloud.upsert([it]);
  await saveSessionToHistory({ sessionCode: invSession });
  await refresh();
  renderItemCard(it);
  navigator.vibrate?.(90);
  toast(`✔ Contado por ${user}: ${it.desc}`);
}

/* ====== Pop-up 1: Perguntar se deseja criar item não existente ====== */
let pendingNewBarcode = '';

function openAskCreatePopup(code) {
  wasScanningBeforePopup = scanning;
  if (scanning) stopScan();
  pendingNewBarcode = code;
  $('#askCreateCode').textContent = code;
  $('#askCreateModal').classList.remove('hidden');
}

function closeAskCreatePopup(resumeCamera = false) {
  $('#askCreateModal').classList.add('hidden');
  const shouldResume = resumeCamera && wasScanningBeforePopup;
  wasScanningBeforePopup = false;
  lastCode = '';
  if (shouldResume) {
    startScan();
  }
}

$('#btnPopupAskNo')?.addEventListener('click', () => {
  pendingNewBarcode = '';
  closeAskCreatePopup(true);
  toast('Aguardando próxima leitura de código...');
});

$('#btnPopupAskYes')?.addEventListener('click', () => {
  const codeToCreate = pendingNewBarcode;
  pendingNewBarcode = '';
  closeAskCreatePopup(false);
  openCreateModal(codeToCreate, null, true);
});

/* ====== Pop-up 2: Aviso de Item Já Contado por Outro Usuário ====== */
function openAlreadyCountedPopup(it) {
  wasScanningBeforePopup = scanning;
  if (scanning) stopScan();

  const currentUser = getUser();
  const countedByOther = it.by && currentUser && it.by.toLowerCase() !== currentUser.toLowerCase();
  $('#alreadyCountedTitle').textContent = countedByOther
    ? '⚠️ Outro usuário já contou!'
    : '⚠️ Item já foi contado!';
  $('#alreadyCountedDesc').textContent = it.desc;
  $('#alreadyCountedCode').textContent = it.code;

  const when = it.at ? new Date(it.at).toLocaleString('pt-BR') : 'horário não registrado';
  const who = it.by || 'Outro usuário';
  const dev = it.extra?._count_device || 'Não informado';
  const sess = it.extra?._inv_session || getSessionCode();
  const method = it.extra?._count_method || 'Leitura de código';

  $('#alreadyCountedInfo').innerHTML = `
    <div><b>👤 Contado por:</b> ${esc(who)} ${countedByOther ? '<span class="badge warn">Outro contador</span>' : '<span class="badge ok">Você</span>'}</div>
    <div><b>📱 Dispositivo:</b> ${esc(dev)}</div>
    <div><b>🕒 Data/Hora:</b> ${esc(when)}</div>
    <div><b>🏷️ Inventário:</b> ${esc(sess)}</div>
    <div><b>📌 Método:</b> ${esc(method)}</div>
  `;
  $('#alreadyCountedModal').classList.remove('hidden');
}

$('#btnCloseAlreadyModal')?.addEventListener('click', () => {
  $('#alreadyCountedModal').classList.add('hidden');
  lastCode = '';
  if (wasScanningBeforePopup) {
    wasScanningBeforePopup = false;
    startScan();
  }
});

/* ====== Renderização do Cartão do Item na Aba Leitor ====== */
function renderItemCard(it) {
  currentCode = it.code;
  const box = $('#result');
  const state = it.extra?._state || 'Bom';
  const invSess = it.extra?._inv_session || getSessionCode();
  const method = it.extra?._count_method || '';
  const countDev = it.extra?._count_device || '';
  const createdBy = it.extra?._created_by || '';
  const createdDev = it.extra?._created_device || '';
  const createdAt = it.extra?._created_at ? new Date(it.extra._created_at).toLocaleString('pt-BR') : '';

  const fields = [
    ['Categoria', it.cat],
    ['Local', it.loc],
    ['Conservação', state],
    ['Observação', it.obs],
    ['Cadastrado por', createdBy ? `${createdBy}${createdDev ? ` (${createdDev})` : ''}${createdAt ? ` em ${createdAt}` : ''}` : ''],
  ].filter(f => f[1]);

  box.innerHTML = `<article class="item">
    <div class="photo" id="photoBox">${it.photo ? `<img src="${it.photo}" alt="Foto de ${esc(it.desc)}"><span class="cam">📷 Trocar foto</span>` : '<div>📷<br>Toque para anexar foto do item (opcional)</div>'}</div>
    <div class="body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px">
        <span class="badge ${it.checked ? 'ok' : 'warn'}">${it.checked ? '✔ Contado / Encontrado' : '⏳ Pendente'}</span>
        ${it.extra?._created_on_spot ? '<span class="badge gold">➕ Cadastrado no inventário</span>' : ''}
      </div>
      <h2>${esc(it.desc)}</h2>
      <div class="code">${esc(it.code)}</div>
      <dl class="fields">${fields.map(f => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join('')}</dl>
      ${it.checked ? `<p class="muted">✔ Contado no inventário <b>${esc(invSess)}</b> em <b>${new Date(it.at).toLocaleString('pt-BR')}</b> por <b>${esc(it.by)}</b>${countDev ? ` · 📱 <b>${esc(countDev)}</b>` : ''}${method ? ` (${esc(method)})` : ''}</p>` : ''}
      <div class="row wrap-row">
        <button class="btn ${it.checked ? '' : 'ok primary'}" id="btnCheck">${it.checked ? '↩ Desfazer contagem' : '✔ Confirmar contagem'}</button>
        <button class="btn" id="btnEditItemCard">✏️ Editar Dados Mestre</button>
      </div>
    </div></article>`;

  $('#photoBox').onclick = () => $('#photoInput').click();
  $('#btnCheck').onclick = () => toggleCheck(it.code);
  $('#btnEditItemCard').onclick = () => openCreateModal(it.code, it, false);
}

/* ====== Tela de Cadastro / Edição de Item (Dados Mestre + Novos Itens com Auditoria) ====== */
function openCreateModal(code = '', existingItem = null, createdFromScan = false) {
  stopScan();
  newItemPhotoData = existingItem?.photo || null;

  $('#createTitle').textContent = existingItem
    ? '✏️ Editar Dados Mestre do Bem'
    : '➕ Cadastrar Item no Patrimônio';

  const codeInput = $('#newCode');
  codeInput.value = existingItem ? existingItem.code : (code || '');
  if (existingItem || code) {
    codeInput.setAttribute('readonly', 'readonly');
    codeInput.classList.add('readonly-input');
  } else {
    codeInput.removeAttribute('readonly');
    codeInput.classList.remove('readonly-input');
  }

  $('#newDesc').value = existingItem?.desc || '';
  $('#newCat').value = existingItem?.cat || '';
  $('#newLoc').value = existingItem?.loc || '';
  $('#newState').value = existingItem?.extra?._state || 'Bom';
  $('#newObs').value = existingItem?.obs || '';
  $('#newChecked').checked = existingItem ? Boolean(existingItem.checked) : (!isCurrentSessionClosed() && Boolean(getSessionCode()));
  $('#createForm').dataset.createdFromScan = createdFromScan ? '1' : '';

  if (newItemPhotoData) {
    $('#newPhotoPreview').src = newItemPhotoData;
    $('#newPhotoPreview').classList.remove('hidden');
    $('#newPhotoPlaceholder').classList.add('hidden');
    $('#btnRemoveNewPhoto').classList.remove('hidden');
  } else {
    $('#newPhotoPreview').src = '';
    $('#newPhotoPreview').classList.add('hidden');
    $('#newPhotoPlaceholder').classList.remove('hidden');
    $('#btnRemoveNewPhoto').classList.add('hidden');
  }

  $('#btnDeleteMasterItem').classList.toggle('hidden', !existingItem);

  const cats = [...new Set(items.map(i => i.cat).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const locs = [...new Set(items.map(i => i.loc).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('#catList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('#locList').innerHTML = locs.map(l => `<option value="${esc(l)}">`).join('');

  $('#createModal').classList.remove('hidden');
  setTimeout(() => {
    if (!codeInput.value) codeInput.focus();
    else $('#newDesc').focus();
  }, 100);
}

function closeCreateModal() {
  $('#createModal').classList.add('hidden');
  newItemPhotoData = null;
  lastCode = '';
}

$('#btnCloseCreate').onclick = closeCreateModal;
$('#btnCancelCreate').onclick = closeCreateModal;
$('#newPhotoBox').onclick = () => $('#newPhotoInput').click();

$('#newPhotoInput').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  newItemPhotoData = await shrink(f, 900);
  $('#newPhotoPreview').src = newItemPhotoData;
  $('#newPhotoPreview').classList.remove('hidden');
  $('#newPhotoPlaceholder').classList.add('hidden');
  $('#btnRemoveNewPhoto').classList.remove('hidden');
};

$('#btnRemoveNewPhoto').onclick = () => {
  newItemPhotoData = null;
  $('#newPhotoPreview').src = '';
  $('#newPhotoPreview').classList.add('hidden');
  $('#newPhotoPlaceholder').classList.remove('hidden');
  $('#btnRemoveNewPhoto').classList.add('hidden');
};

$('#btnDeleteMasterItem').onclick = async () => {
  const code = $('#newCode').value.trim();
  if (!code) return;
  if (!confirm(`Deseja excluir permanentemente o item ${code} dos Dados Mestre?`)) return;
  await DB.del(code);
  await Cloud.deleteOne(code);
  await refresh();
  closeCreateModal();
  if (currentCode === code) $('#result').innerHTML = '';
  toast('Item excluído dos Dados Mestre');
};

$('#createForm').onsubmit = async e => {
  e.preventDefault();
  const code = $('#newCode').value.trim();
  const desc = $('#newDesc').value.trim();
  const cat = $('#newCat').value.trim();
  const loc = $('#newLoc').value.trim();
  const state = $('#newState').value;
  const obs = $('#newObs').value.trim();
  const markChecked = $('#newChecked').checked;
  const createdFromScan = $('#createForm').dataset.createdFromScan === '1';

  if (!code || !desc) return toast('Preencha o código e a descrição do item');

  const prev = await DB.get(code);
  const user = getUser() || setUser('Contador');
  const dev = getDevice();
  const invSession = getSessionCode();
  const nowIso = new Date().toISOString();

  const item = {
    code,
    desc,
    cat,
    loc,
    obs,
    extra: {
      ...(prev?.extra || {}),
      _state: state,
      _created_on_spot: prev ? prev.extra?._created_on_spot : createdFromScan,
      _created_by: prev?.extra?._created_by || user,
      _created_device: prev?.extra?._created_device || dev,
      _created_at: prev?.extra?._created_at || nowIso,
      _updated_by: user,
      _updated_device: dev,
      _updated_at: nowIso,
      ...(markChecked ? {
        _inv_session: invSession,
        _count_method: prev?.extra?._count_method || (createdFromScan ? 'Cadastrado durante leitura' : 'Cadastro Mestre'),
        _count_device: prev?.extra?._count_device || dev,
      } : {}),
    },
    photo: newItemPhotoData || null,
    checked: markChecked,
    at: markChecked ? (prev?.at || nowIso) : null,
    by: markChecked ? (prev?.by || user) : null,
  };

  await DB.put(item);
  await Cloud.upsert([item]);
  await saveSessionToHistory({ sessionCode: invSession });
  await refresh();
  closeCreateModal();
  renderItemCard(item);
  toast(`✔ Salvo por ${user} (${dev})`);
};

async function toggleCheck(code) {
  if (isCurrentSessionClosed()) {
    return toast('🔒 Inventário encerrado! Reabra a contagem para alterar.');
  }
  const it = await DB.get(code);
  if (!it) return;
  const user = getUser() || setUser('Contador');
  const dev = getDevice();

  if (it.checked) {
    it.checked = false;
    it.at = null;
    it.by = null;
    if (it.extra) {
      delete it.extra._inv_session;
      delete it.extra._count_method;
      delete it.extra._count_device;
    }
  } else {
    it.checked = true;
    it.at = new Date().toISOString();
    it.by = user;
    it.extra = {
      ...(it.extra || {}),
      _inv_session: getSessionCode(),
      _count_method: 'Conferência Manual',
      _count_device: dev,
    };
  }
  await DB.put(it);
  await Cloud.upsert([it]);
  await saveSessionToHistory({ sessionCode: getSessionCode() });
  await refresh();
  renderItemCard(it);
  toast(it.checked ? 'Item conferido ✔' : 'Conferência desfeita');
}

/* ====== Foto rápida na tela do leitor ====== */
$('#photoInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !currentCode) return;
  const url = await shrink(f, 900);
  const it = await DB.get(currentCode);
  const user = getUser() || 'Contador';
  const dev = getDevice();
  it.photo = url;
  it.extra = {
    ...(it.extra || {}),
    _updated_by: user,
    _updated_device: dev,
    _updated_at: new Date().toISOString(),
  };
  await DB.put(it);
  await Cloud.upsert([it]);
  await refresh();
  renderItemCard(it);
  toast('Foto salva no Supabase ✔');
};

function shrink(file, max) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src); res(c.toDataURL('image/jpeg', .8));
    };
    img.src = URL.createObjectURL(file);
  });
}

/* ====== ABA 2: CONCILIAÇÃO (COMPARAR CSV OPCIONAL, WHATSAPP, PROCURAR OU ACEITAR COMO ENCONTRADO) ====== */
function renderReconcile() {
  const q = norm($('#searchReconcile')?.value || '');
  const list = items.filter(i => {
    if (reconcileFilter === 'pend' && i.checked) return false;
    if (reconcileFilter === 'ok' && !i.checked) return false;
    if (!q) return true;
    return norm(i.code + i.desc + i.loc + i.cat + (i.by || '')).includes(q);
  });

  const ul = $('#reconcileList');
  if (!ul) return;

  if (!items.length) {
    ul.innerHTML = '<li class="empty">Nenhum item na base ainda. Carregue o CSV acima para comparar ou cadastre itens pelo leitor.</li>';
    return;
  }
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${reconcileFilter === 'pend' ? '🎉 Todos os itens foram encontrados!' : 'Nenhum item para este filtro.'}</li>`;
    return;
  }

  ul.innerHTML = list.slice(0, 300).map(i => {
    const method = i.extra?._count_method || 'Leitura';
    const dev = i.extra?._count_device || '';
    const when = i.at ? new Date(i.at).toLocaleString('pt-BR') : '';
    const statusText = i.checked
      ? `✔ Contado por <b>${esc(i.by || '—')}</b>${dev ? ` · 📱 ${esc(dev)}` : ''}${when ? ` · 🕒 ${esc(when)}` : ''} (${esc(method)})`
      : '❌ Não encontrado na contagem';

    return `<li data-rc="${esc(i.code)}">
      <div class="list-main" data-open="${esc(i.code)}">
        ${i.photo ? `<img class="thumb" src="${i.photo}" alt="">` : `<div class="thumb">${i.checked ? '✅' : '📦'}</div>`}
        <div class="info">
          <b>${esc(i.desc)}</b>
          <small>${esc(i.code)}${i.loc ? ' · 📍 ' + esc(i.loc) : ''}${i.cat ? ' · ' + esc(i.cat) : ''}</small>
          <small style="color:${i.checked ? 'var(--ok)' : 'var(--bad)'}">${statusText}</small>
        </div>
        <span class="badge ${i.checked ? 'ok' : 'bad'}">${i.checked ? '✔' : 'Faltante'}</span>
      </div>
      ${!i.checked ? `<div class="item-actions">
        <button type="button" class="btn" data-find-scan="${esc(i.code)}">📷 Procurar e Ler</button>
        <button type="button" class="btn ok" data-accept-found="${esc(i.code)}">✋ Afirmar que Existe (Aceitar)</button>
      </div>` : ''}
    </li>`;
  }).join('');
}

$('#reconcileList')?.addEventListener('click', async e => {
  const findBtn = e.target.closest('[data-find-scan]');
  if (findBtn) {
    const code = findBtn.dataset.findScan;
    startTargetSearch(code);
    return;
  }

  const acceptBtn = e.target.closest('[data-accept-found]');
  if (acceptBtn) {
    const code = acceptBtn.dataset.acceptFound;
    await acceptMissingItemAsFound(code);
    return;
  }

  const openEl = e.target.closest('[data-open]');
  if (openEl) {
    const it = findLocal(openEl.dataset.open);
    if (it) {
      switchTab('scan');
      renderItemCard(it);
      window.scrollTo(0, 0);
    }
  }
});

function startTargetSearch(code) {
  const it = findLocal(code);
  if (!it) return;
  targetSearchCode = it.code;
  $('#targetScanDesc').textContent = `${it.desc} (${it.loc || 'Sem local'})`;
  $('#targetScanCode').textContent = it.code;
  $('#targetScanBanner').classList.remove('hidden');
  switchTab('scan');
  window.scrollTo(0, 0);
  startScan();
  toast(`Procurando item ${it.code}. Aponte a câmera para o código!`);
}

function clearTargetSearch() {
  targetSearchCode = null;
  $('#targetScanBanner')?.classList.add('hidden');
}

$('#btnCancelTargetScan')?.addEventListener('click', clearTargetSearch);

async function acceptMissingItemAsFound(code) {
  if (!getUser() || !getSessionCode()) {
    openSessionModal(true);
    return;
  }
  if (isCurrentSessionClosed()) {
    toast('🔒 Inventário encerrado! Informe a senha de abertura para reabri-lo primeiro.');
    openReopenInvModal(getSessionCode());
    return;
  }
  const it = await DB.get(code);
  if (!it) return;
  const user = getUser() || setUser('Contador');
  const dev = getDevice();
  const invSession = getSessionCode();

  it.checked = true;
  it.at = new Date().toISOString();
  it.by = user;
  it.extra = {
    ...(it.extra || {}),
    _inv_session: invSession,
    _count_method: 'Afirmado que existe (Aceito manualmente)',
    _count_device: dev,
  };

  await DB.put(it);
  await Cloud.upsert([it]);
  await saveSessionToHistory({ sessionCode: invSession });
  await refresh();
  toast(`✔ "${it.desc}" aceito por ${user} (${dev})!`);
}

$('#searchReconcile')?.addEventListener('input', renderReconcile);
document.querySelectorAll('[data-rf]').forEach(c => c.onclick = () => {
  reconcileFilter = c.dataset.rf;
  document.querySelectorAll('[data-rf]').forEach(x => x.classList.toggle('sel', x === c));
  renderReconcile();
});

/* ====== Geração de Relatório / Arquivo de Não Encontrados para WhatsApp ====== */
function buildMissingReportText() {
  const invCode = getSessionCode();
  const activeHist = getActiveHistoryObj();
  const missing = items.filter(i => !i.checked);
  const found = items.filter(i => i.checked);
  const nowStr = new Date().toLocaleString('pt-BR');

  const lines = [
    `*RELATÓRIO DE INVENTÁRIO CCB - ${invCode}*`,
    activeHist?.startedBy ? `Aberto por: ${activeHist.startedBy} (${activeHist.startedDevice || '—'})` : '',
    `Gerado por: ${getUser() || '—'} (${getDevice()}) em ${nowStr}`,
    `Total na Base: ${items.length} | Encontrados: ${found.length} | *Não Encontrados: ${missing.length}*`,
    `----------------------------------------`,
  ].filter(Boolean);

  if (!missing.length) {
    lines.push(`✅ Todos os ${items.length} itens da base foram encontrados!`);
  } else {
    lines.push(`*LISTA DE ITENS NÃO ENCONTRADOS (${missing.length}):*`);
    missing.forEach((m, idx) => {
      lines.push(`${idx + 1}. *${m.code}* - ${m.desc}${m.loc ? ` (${m.loc})` : ''}${m.cat ? ` [${m.cat}]` : ''}`);
    });
  }
  return lines.join('\n');
}

function buildMissingCSVBlob() {
  const missing = items.filter(i => !i.checked);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['codigo_inventario', 'codigo', 'descricao', 'categoria', 'local', 'observacao', 'situacao'];
  const invCode = getSessionCode();
  const rows = [head.join(';')].concat(missing.map(i => [
    invCode, i.code, i.desc, i.cat, i.loc, i.obs, 'NAO_ENCONTRADO'
  ].map(q).join(';')));
  return new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

$('#btnDownloadMissing')?.addEventListener('click', () => {
  const missing = items.filter(i => !i.checked);
  if (!missing.length) return toast('Não há itens pendentes! Todos foram encontrados.');
  const invCode = getSessionCode();
  const blob = buildMissingCSVBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nao_encontrados_${invCode}.csv`;
  a.click();
  toast('Arquivo de itens não encontrados gerado ✔');
});

$('#btnShareWhatsapp')?.addEventListener('click', async () => {
  if (!items.length) return toast('Carregue a base ou cadastre itens primeiro.');
  const text = buildMissingReportText();
  const invCode = getSessionCode();
  const missing = items.filter(i => !i.checked);

  if (navigator.canShare && missing.length > 0) {
    try {
      const csvFile = new File([buildMissingCSVBlob()], `nao_encontrados_${invCode}.csv`, { type: 'text/csv' });
      if (navigator.canShare({ files: [csvFile] })) {
        await navigator.share({
          title: `Itens Não Encontrados - ${invCode}`,
          text,
          files: [csvFile],
        });
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(waUrl, '_blank');
});

/* ====== ABA 3: DADOS MESTRE (GESTÃO DE BENS COM AUDITORIA DE USUÁRIO E DISPOSITIVO) ====== */
function renderMaster() {
  if ($('#masterCount')) $('#masterCount').textContent = items.length;

  const catSel = $('#filterMasterCat');
  const locSel = $('#filterMasterLoc');
  if (catSel && locSel) {
    const curCat = catSel.value;
    const curLoc = locSel.value;
    const cats = [...new Set(items.map(i => i.cat).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const locs = [...new Set(items.map(i => i.loc).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    catSel.innerHTML = '<option value="">Todas as categorias</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    locSel.innerHTML = '<option value="">Todos os locais</option>' + locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    catSel.value = curCat;
    locSel.value = curLoc;
  }

  const q = norm($('#searchMaster')?.value || '');
  const fCat = catSel?.value || '';
  const fLoc = locSel?.value || '';

  const list = items.filter(i => {
    if (fCat && i.cat !== fCat) return false;
    if (fLoc && i.loc !== fLoc) return false;
    if (!q) return true;
    return norm(i.code + i.desc + i.loc + i.cat + i.obs + (i.extra?._created_by || '')).includes(q);
  });

  const ul = $('#masterList');
  if (!ul) return;

  ul.innerHTML = list.length ? list.slice(0, 300).map(i => {
    const cBy = i.extra?._created_by || '';
    const cDev = i.extra?._created_device || '';
    const cAt = i.extra?._created_at ? new Date(i.extra._created_at).toLocaleString('pt-BR') : '';
    return `<li data-mc="${esc(i.code)}">
      <div class="list-main">
        ${i.photo ? `<img class="thumb" src="${i.photo}" alt="">` : '<div class="thumb">🏛️</div>'}
        <div class="info">
          <b>${esc(i.desc)}</b>
          <small>${esc(i.code)}${i.cat ? ' · 🏷️ ' + esc(i.cat) : ''}${i.loc ? ' · 📍 ' + esc(i.loc) : ''}</small>
          <small>Estado: ${esc(i.extra?._state || 'Bom')}${i.obs ? ' · ' + esc(i.obs) : ''}</small>
          ${cBy ? `<small>👤 Cad.: ${esc(cBy)}${cDev ? ` · 📱 ${esc(cDev)}` : ''}${cAt ? ` · ${esc(cAt)}` : ''}</small>` : ''}
        </div>
        <span class="chip">✏️ Editar</span>
      </div>
    </li>`;
  }).join('') : '<li class="empty">Nenhum bem encontrado nos Dados Mestre.</li>';
}

$('#masterList')?.addEventListener('click', e => {
  const li = e.target.closest('li[data-mc]');
  if (!li) return;
  const it = findLocal(li.dataset.mc);
  if (it) openCreateModal(it.code, it, false);
});

$('#btnNewMasterItem')?.addEventListener('click', () => openCreateModal('', null, false));
$('#searchMaster')?.addEventListener('input', renderMaster);
$('#filterMasterCat')?.addEventListener('change', renderMaster);
$('#filterMasterLoc')?.addEventListener('change', renderMaster);

/* ====== Atualização Geral de Indicadores e Históricos ====== */
async function refresh() {
  const allRows = await DB.all();
  items = allRows
    .filter(i => !isSystemRow(i.code))
    .sort((a, b) => a.desc.localeCompare(b.desc, 'pt-BR'));

  histories = allRows
    .filter(i => String(i.code).startsWith(HIST_PREFIX) && i.extra?.sessionCode)
    .map(i => i.extra)
    .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));

  // Garante que todos trabalhem no único inventário aberto caso exista um
  const openInv = findGlobalOpenInventory();
  if (openInv && localStorage.getItem('inv_session_code') !== openInv.sessionCode) {
    localStorage.setItem('inv_session_code', openInv.sessionCode);
  }

  const ok = items.filter(i => i.checked).length;
  const createdSpot = items.filter(i => i.extra?._created_on_spot).length;
  if ($('#stTotal')) $('#stTotal').textContent = items.length;
  if ($('#stOk')) $('#stOk').textContent = ok;
  if ($('#stPend')) $('#stPend').textContent = items.length - ok;
  if ($('#stNew')) $('#stNew').textContent = createdSpot;
  if ($('#progress')) $('#progress').style.width = items.length ? (ok / items.length * 100) + '%' : '0';

  updateSessionUI();
  renderHistory();
  renderReconcile();
  renderMaster();
}

/* ====== Leitor de código de barras (Câmera + ZXing fallback) ====== */
let stream = null, scanning = false, zxingCtl = null, lastCode = '', lastTime = 0;
function onCode(code) {
  const now = Date.now();
  if (code === lastCode && now - lastTime < 2800) return;
  lastCode = code;
  lastTime = now;
  handleScanOrSearch(code);
}
async function startScan() {
  if (!getUser() || !getSessionCode()) {
    openSessionModal(true);
    return;
  }
  if (isCurrentSessionClosed()) {
    toast('🔒 Inventário encerrado! Reabra com a senha para usar o leitor.');
    openReopenInvModal(getSessionCode());
    return;
  }
  const sc = document.querySelector('.scanner'), video = $('#video');
  try {
    if ('BarcodeDetector' in window) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
      video.srcObject = stream; await video.play();
      const det = new BarcodeDetector();
      scanning = true;
      const loop = async () => {
        if (!scanning) return;
        try { const r = await det.detect(video); if (r[0]) onCode(r[0].rawValue); } catch { }
        setTimeout(loop, 200);
      };
      loop();
    } else {
      await loadZXing();
      const reader = new ZXingBrowser.BrowserMultiFormatReader();
      scanning = true;
      zxingCtl = await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) onCode(r.getText()); });
      stream = video.srcObject;
    }
    sc.classList.add('on'); $('#btnScan').textContent = '⏹ Parar'; setupTorch();
  } catch (e) {
    scanning = false;
    toast('Não foi possível abrir a câmera. Use o campo manual.');
  }
}
function loadZXing() {
  return new Promise((res, rej) => {
    if (window.ZXingBrowser) return res();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function stopScan() {
  scanning = false; zxingCtl?.stop(); zxingCtl = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if ($('#video')) $('#video').srcObject = null;
  document.querySelector('.scanner')?.classList.remove('on');
  if ($('#btnScan')) $('#btnScan').textContent = '📷 Ler código';
  $('#btnTorch')?.classList.add('hidden');
}
function setupTorch() {
  const t = stream?.getVideoTracks()[0];
  if (t?.getCapabilities?.().torch) {
    $('#btnTorch').classList.remove('hidden');
    let on = false;
    $('#btnTorch').onclick = () => { on = !on; t.applyConstraints({ advanced: [{ torch: on }] }); };
  }
}
$('#btnScan').onclick = () => scanning ? stopScan() : startScan();
$('#manualForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#manualCode').value.trim();
  if (v) {
    handleScanOrSearch(v);
    $('#manualCode').value = '';
  }
};

/* ====== Inicialização e Sincronização Multi-usuário ====== */
(async () => {
  await DB.open();
  initSupabaseConfig();
  await refresh();

  if (Cloud.isReady()) {
    await Cloud.syncAll(false);
    setInterval(() => {
      if (document.visibilityState === 'visible') Cloud.syncAll(false);
    }, 8000);
  }

  // Se o usuário ainda não se identificou ou não há inventário ativo, abre o modal inicial
  if (!getUser() || !getSessionCode() || !histories.some(h => h.sessionCode === getSessionCode())) {
    openSessionModal(true);
  }

  if ($('#importMsg')) $('#importMsg').textContent = localStorage.getItem('lastImport') || '';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
