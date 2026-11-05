'use strict';

/* ====== Configuração Padrão do Supabase ====== */
const DEFAULT_SUPABASE_URL = 'https://vjdcsautoooubtjdhswk.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_fmDYGqwIa1IY_B-iNZ4XAQ_QUP1BNmb';
const META_ROW_CODE = '__INV_META__';

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
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

let items = [];
let reconcileFilter = 'pend';
let currentCode = null;
let newItemPhotoData = null;
let editingMasterMode = false;
let wasScanningBeforePopup = false;
let targetSearchCode = null;

/* ====== Sessão de Inventário & Usuário ====== */
function getDefaultSessionCode() {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `INV-${ym}-01`;
}

function getSessionCode() {
  let s = localStorage.getItem('inv_session_code');
  if (!s) {
    s = getDefaultSessionCode();
    localStorage.setItem('inv_session_code', s);
  }
  return s;
}

function setSessionCode(code) {
  code = (code || '').trim().toUpperCase() || getDefaultSessionCode();
  localStorage.setItem('inv_session_code', code);
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

function updateSessionUI() {
  const s = getSessionCode();
  const u = getUser() || 'Identificar';
  if ($('#sessionCodeLabel')) $('#sessionCodeLabel').textContent = s;
  if ($('#scanSessionTitle')) $('#scanSessionTitle').textContent = s;
  if ($('#recSessionCode')) $('#recSessionCode').textContent = s;
  if ($('#userName')) $('#userName').textContent = u;
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
      if (rows && rows[0] && rows[0].code !== META_ROW_CODE) {
        const it = this.fromRow(rows[0]);
        await DB.put(it);
        return it;
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
      console.warn('Erro ao remover item no Supabase:', e);
    }
  },
  async saveActiveSessionMeta(sessionCode, startedBy) {
    if (!this.isReady()) return;
    const metaRow = {
      code: META_ROW_CODE,
      desc: 'META_SESSAO_INVENTARIO',
      cat: '',
      loc: '',
      obs: '',
      extra: { sessionCode, startedBy, updatedAt: new Date().toISOString() },
      photo: null,
      checked: false,
      at: new Date().toISOString(),
      by: startedBy || null,
    };
    await this.upsert([metaRow]);
  },
  async syncAll(pushLocalFirst = false) {
    if (!this.isReady()) {
      this.updateBadge(false, 'Configure a URL e a Anon Key do Supabase.');
      return false;
    }
    try {
      if (pushLocalFirst) {
        const localItems = (await DB.all()).filter(i => i.code !== META_ROW_CODE);
        if (localItems.length) await this.upsert(localItems);
      }
      const res = await fetch(`${this.url}/rest/v1/patrimonio_items?select=*`, {
        headers: this.headers(),
      });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      const remoteCodes = new Set();
      for (const r of rows) {
        if (r.code === META_ROW_CODE) {
          if (r.extra?.sessionCode && !localStorage.getItem('inv_session_manual')) {
            setSessionCode(r.extra.sessionCode);
          }
          continue;
        }
        const it = this.fromRow(r);
        remoteCodes.add(it.code);
        await DB.put(it);
      }
      const allLocal = (await DB.all()).filter(i => i.code !== META_ROW_CODE);
      const missingOnCloud = allLocal.filter(i => !remoteCodes.has(i.code));
      if (missingOnCloud.length) await this.upsert(missingOnCloud);

      this.updateBadge(true, `✔ Conectado ao Supabase (${allLocal.length} itens na base).`);
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
    renderReconcile();
  }
  if (tabName === 'master') {
    renderMaster();
  }
}

document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => switchTab(b.dataset.tab);
});

$('#btnGoReconcile')?.addEventListener('click', () => switchTab('reconcile'));

/* ====== Modal de Sessão / Código do Inventário ====== */
function openSessionModal(forceUser = false) {
  stopScan();
  $('#sessionUserInput').value = getUser() || '';
  $('#sessionCodeInput').value = getSessionCode();
  $('#sessionResetChecks').checked = false;
  $('#btnCancelSession').classList.toggle('hidden', forceUser && !getUser());
  $('#btnCloseSessionModal').classList.toggle('hidden', forceUser && !getUser());
  $('#sessionModal').classList.remove('hidden');
  setTimeout(() => {
    if (!getUser()) $('#sessionUserInput').focus();
    else $('#sessionCodeInput').focus();
  }, 80);
}

function closeSessionModal() {
  $('#sessionModal').classList.add('hidden');
}

$('#btnGenerateSessionCode')?.addEventListener('click', () => {
  const d = new Date();
  const rand = String(Math.floor(100 + Math.random() * 900));
  const code = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${rand}`;
  $('#sessionCodeInput').value = code;
});

$('#btnSessionBanner')?.addEventListener('click', () => openSessionModal(false));
$('#btnOpenSessionModal')?.addEventListener('click', () => openSessionModal(false));
$('#btnManageSession')?.addEventListener('click', () => openSessionModal(false));
$('#btnUser')?.addEventListener('click', () => openSessionModal(false));
$('#btnCloseSessionModal')?.addEventListener('click', closeSessionModal);
$('#btnCancelSession')?.addEventListener('click', closeSessionModal);

$('#sessionForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const u = setUser($('#sessionUserInput').value);
  const c = setSessionCode($('#sessionCodeInput').value);
  localStorage.setItem('inv_session_manual', '1');
  const resetChecks = $('#sessionResetChecks').checked;

  closeSessionModal();
  if (resetChecks) {
    await resetOnlyCounts(c, u, false);
  } else {
    await Cloud.saveActiveSessionMeta(c, u);
    await Cloud.syncAll(false);
    toast(`Sessão ativa: ${c} (${u})`);
  }
});

async function resetOnlyCounts(newSessionCode, userName, askConfirm = true) {
  if (askConfirm && !confirm('Deseja desmarcar todas as conferências atuais para iniciar uma nova contagem mantendo todos os Dados Mestre?')) {
    return;
  }
  const all = (await DB.all()).filter(i => i.code !== META_ROW_CODE);
  const updated = [];
  for (const it of all) {
    it.checked = false;
    it.at = null;
    it.by = null;
    if (it.extra) {
      delete it.extra._inv_session;
      delete it.extra._count_method;
    }
    await DB.put(it);
    updated.push(it);
  }
  if (updated.length) await Cloud.upsert(updated);
  if (newSessionCode) await Cloud.saveActiveSessionMeta(newSessionCode, userName || getUser());
  await refresh();
  $('#result').innerHTML = '';
  toast(`Nova contagem iniciada (${getSessionCode()})!`);
}

$('#btnResetCounts')?.addEventListener('click', () => resetOnlyCounts(getSessionCode(), getUser(), true));

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
  // Antes de comparar, sincroniza com Supabase para ter todas as contagens de todos os usuários
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

  if (!isReconcileCompare && !keep) {
    await DB.clear();
  }

  let n = 0;
  let foundCount = 0;
  let missingCount = 0;
  const imported = [];

  for (const r of rows.slice(1)) {
    const code = (r[map.code] || '').trim();
    if (!code || code === META_ROW_CODE) continue;
    const extra = {};
    heads.forEach((h, i) => { if (!used.has(i) && h && (r[i] || '').trim()) extra[h] = r[i].trim(); });
    const prev = keep ? old.get(code) : null;
    const mergedExtra = { ...(prev?.extra || {}), ...extra, _in_csv: true };

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

  await refresh();

  if (isReconcileCompare) {
    const msg = `✔ CSV comparado (${n} itens no CSV): ${foundCount} encontrados e ${missingCount} NÃO encontrados.`;
    if ($('#compareMsg')) $('#compareMsg').textContent = msg;
    reconcileFilter = missingCount > 0 ? 'pend' : 'all';
    document.querySelectorAll('[data-rf]').forEach(b => b.classList.toggle('sel', b.dataset.rf === reconcileFilter));
    renderReconcile();
    toast(`${missingCount} itens não encontrados`);
  } else {
    $('#importMsg').textContent = `✔ ${n} itens importados nos Dados Mestre em ${new Date().toLocaleString('pt-BR')}.`;
    localStorage.setItem('lastImport', $('#importMsg').textContent);
    toast(`${n} itens importados`);
  }
}

$('#csvFile').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0], false); e.target.value = ''; };
$('#compareCsvFile').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0], true); e.target.value = ''; };
$('#btnCompareMaster')?.addEventListener('click', async () => {
  toast('Atualizando conciliação com Supabase...');
  await Cloud.syncAll(false);
  renderReconcile();
  toast('Conciliação atualizada ✔');
});

/* ====== Exportação CSV Completo ====== */
$('#btnExport').onclick = () => {
  if (!items.length) return toast('Nada para exportar');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['codigo_inventario', 'codigo', 'descricao', 'categoria', 'local', 'estado', 'observacao', 'situacao', 'metodo_conferencia', 'data_hora_conferencia', 'usuario'];
  const invCode = getSessionCode();
  const lines = [head.join(';')].concat(items.map(i => [
    i.extra?._inv_session || invCode,
    i.code,
    i.desc,
    i.cat,
    i.loc,
    i.extra?._state || 'Bom',
    i.obs,
    i.checked ? 'ENCONTRADO' : 'NAO_ENCONTRADO',
    i.checked ? (i.extra?._count_method || 'Leitura Código') : 'Pendente',
    i.at ? new Date(i.at).toLocaleString('pt-BR') : '',
    i.by || '',
  ].map(q).join(';')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `inventario_ccb_${invCode}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$('#btnReset').onclick = async () => {
  if (confirm('ATENÇÃO: Apagar TODOS os Dados Mestre, fotos e conferências do banco?')) {
    await DB.clear();
    await Cloud.clearRemote();
    await refresh();
    $('#result').innerHTML = '';
    toast('Todos os dados foram apagados');
  }
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

  // Garante que o usuário já informou o nome
  if (!getUser()) {
    openSessionModal(true);
    return;
  }

  // 1. Consulta o Supabase em tempo real para saber se outro usuário contou ou cadastrou este código
  let it = findLocal(code);
  if (Cloud.isReady()) {
    const remoteIt = await Cloud.fetchOne(it ? it.code : code);
    if (remoteIt) {
      it = remoteIt;
      await refresh();
    }
  }

  // 2. Se o código NÃO EXISTE na base mestre -> Abre Pop-up Centralizado no meio da tela!
  if (!it) {
    currentCode = null;
    openAskCreatePopup(code);
    navigator.vibrate?.([200, 100, 200]);
    return;
  }

  // Se estava procurando fisicamente um item específico da tela de conciliação
  if (targetSearchCode && it.code !== targetSearchCode) {
    toast(`⚠️ Código lido (${it.code}) é diferente do item procurado (${targetSearchCode})`);
  } else if (targetSearchCode && it.code === targetSearchCode) {
    clearTargetSearch();
  }

  // 3. Se o item JÁ FOI CONTADO -> Avisa em Pop-up que outro usuário (ou você) já contou!
  if (it.checked) {
    renderItemCard(it);
    openAlreadyCountedPopup(it);
    navigator.vibrate?.([150, 80, 150, 80, 150]);
    return;
  }

  // 4. Item existe e ainda não foi contado -> Registra contagem imediatamente pelo usuário atual!
  const user = getUser() || 'Contador';
  const invSession = getSessionCode();
  it.checked = true;
  it.at = new Date().toISOString();
  it.by = user;
  it.extra = {
    ...(it.extra || {}),
    _inv_session: invSession,
    _count_method: 'Leitura Código de Barras',
  };

  await DB.put(it);
  await Cloud.upsert([it]);
  await refresh();
  renderItemCard(it);
  navigator.vibrate?.(90);
  toast(`✔ Contado: ${it.desc}`);
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

// Se marcar que NÃO: não faz nada e espera a próxima leitura de código de barras
$('#btnPopupAskNo')?.addEventListener('click', () => {
  pendingNewBarcode = '';
  closeAskCreatePopup(true);
  toast('Aguardando próxima leitura de código...');
});

// Se responder que SIM: abre a tela com o código de barras cadastrado solicitando os dados faltantes + foto opcional
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
  const sess = it.extra?._inv_session || getSessionCode();
  const method = it.extra?._count_method || 'Leitura de código';

  $('#alreadyCountedInfo').innerHTML = `
    <div><b>Contado por:</b> ${esc(who)} ${countedByOther ? '<span class="badge warn">Outro contador</span>' : '<span class="badge ok">Você</span>'}</div>
    <div><b>Data/Hora:</b> ${esc(when)}</div>
    <div><b>Inventário:</b> ${esc(sess)}</div>
    <div><b>Método:</b> ${esc(method)}</div>
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
  const fields = [
    ['Categoria', it.cat],
    ['Local', it.loc],
    ['Conservação', state],
    ['Observação', it.obs],
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
      ${it.checked ? `<p class="muted">✔ Contado no inventário <b>${esc(invSess)}</b> em ${new Date(it.at).toLocaleString('pt-BR')} por <b>${esc(it.by)}</b>${method ? ` (${esc(method)})` : ''}</p>` : ''}
      <div class="row wrap-row">
        <button class="btn ${it.checked ? '' : 'ok primary'}" id="btnCheck">${it.checked ? '↩ Desfazer contagem' : '✔ Confirmar contagem'}</button>
        <button class="btn" id="btnEditItemCard">✏️ Editar Dados Mestre</button>
      </div>
    </div></article>`;

  $('#photoBox').onclick = () => $('#photoInput').click();
  $('#btnCheck').onclick = () => toggleCheck(it.code);
  $('#btnEditItemCard').onclick = () => openCreateModal(it.code, it, false);
}

/* ====== Tela de Cadastro / Edição de Item (Dados Mestre + Novos Itens) ====== */
function openCreateModal(code = '', existingItem = null, createdFromScan = false) {
  stopScan();
  editingMasterMode = Boolean(existingItem);
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
  $('#newChecked').checked = existingItem ? Boolean(existingItem.checked) : true;
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
  const invSession = getSessionCode();

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
      ...(markChecked ? {
        _inv_session: invSession,
        _count_method: prev?.extra?._count_method || (createdFromScan ? 'Cadastrado durante leitura' : 'Cadastro Mestre'),
      } : {}),
    },
    photo: newItemPhotoData || null,
    checked: markChecked,
    at: markChecked ? (prev?.at || new Date().toISOString()) : null,
    by: markChecked ? (prev?.by || user) : null,
  };

  await DB.put(item);
  await Cloud.upsert([item]);
  await refresh();
  closeCreateModal();
  renderItemCard(item);
  toast('Item salvo no Supabase ✔');
};

async function toggleCheck(code) {
  const it = await DB.get(code);
  if (!it) return;
  if (it.checked) {
    it.checked = false;
    it.at = null;
    it.by = null;
  } else {
    it.checked = true;
    it.at = new Date().toISOString();
    it.by = getUser() || setUser('Contador');
    it.extra = {
      ...(it.extra || {}),
      _inv_session: getSessionCode(),
      _count_method: 'Conferência Manual',
    };
  }
  await DB.put(it);
  await Cloud.upsert([it]);
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
  it.photo = url;
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

/* ====== ABA 2: CONCILIAÇÃO (COMPARAR CSV, WHATSAPP, PROCURAR FISICAMENTE OU ACEITAR COMO ENCONTRADO) ====== */
function renderReconcile() {
  const q = norm($('#searchReconcile')?.value || '');
  const list = items.filter(i => {
    if (reconcileFilter === 'pend' && i.checked) return false;
    if (reconcileFilter === 'ok' && !i.checked) return false;
    if (!q) return true;
    return norm(i.code + i.desc + i.loc + i.cat).includes(q);
  });

  const ul = $('#reconcileList');
  if (!ul) return;

  if (!items.length) {
    ul.innerHTML = '<li class="empty">Nenhum item na base ainda. Carregue o CSV acima para comparar ou cadastre itens pelo leitor.</li>';
    return;
  }
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${reconcileFilter === 'pend' ? '🎉 Parabéns! Todos os itens foram encontrados!' : 'Nenhum item para este filtro.'}</li>`;
    return;
  }

  ul.innerHTML = list.slice(0, 300).map(i => {
    const method = i.extra?._count_method || '';
    const statusText = i.checked
      ? `✔ Encontrado por ${esc(i.by || '—')} (${esc(method || 'Leitura')})`
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

// Procurar item fisicamente e ler código de barras
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

// Apenas afirmar que o item existe e aceitar como encontrado
async function acceptMissingItemAsFound(code) {
  const it = await DB.get(code);
  if (!it) return;
  const user = getUser() || setUser('Contador');
  const invSession = getSessionCode();

  it.checked = true;
  it.at = new Date().toISOString();
  it.by = user;
  it.extra = {
    ...(it.extra || {}),
    _inv_session: invSession,
    _count_method: 'Afirmado que existe (Aceito manualmente)',
  };

  await DB.put(it);
  await Cloud.upsert([it]);
  await refresh();
  toast(`✔ "${it.desc}" aceito como encontrado!`);
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
  const missing = items.filter(i => !i.checked);
  const found = items.filter(i => i.checked);
  const nowStr = new Date().toLocaleString('pt-BR');

  const lines = [
    `*RELATÓRIO DE INVENTÁRIO CCB - ${invCode}*`,
    `Data: ${nowStr}`,
    `Total na Base: ${items.length} | Encontrados: ${found.length} | *Não Encontrados: ${missing.length}*`,
    `----------------------------------------`,
  ];

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

  // Tenta compartilhar o arquivo + texto nativamente no celular (Web Share API para WhatsApp)
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

  // Fallback direto para WhatsApp com a lista completa formatada
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(waUrl, '_blank');
});

/* ====== ABA 3: DADOS MESTRE (GESTÃO DE BENS) ====== */
function renderMaster() {
  if ($('#masterCount')) $('#masterCount').textContent = items.length;

  // Atualiza filtros de categoria e local mantendo seleção
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
    return norm(i.code + i.desc + i.loc + i.cat + i.obs).includes(q);
  });

  const ul = $('#masterList');
  if (!ul) return;

  ul.innerHTML = list.length ? list.slice(0, 300).map(i => `<li data-mc="${esc(i.code)}">
    <div class="list-main">
      ${i.photo ? `<img class="thumb" src="${i.photo}" alt="">` : '<div class="thumb">🏛️</div>'}
      <div class="info">
        <b>${esc(i.desc)}</b>
        <small>${esc(i.code)}${i.cat ? ' · 🏷️ ' + esc(i.cat) : ''}${i.loc ? ' · 📍 ' + esc(i.loc) : ''}</small>
        <small>Estado: ${esc(i.extra?._state || 'Bom')}${i.obs ? ' · ' + esc(i.obs) : ''}</small>
      </div>
      <span class="chip">✏️ Editar</span>
    </div>
  </li>`).join('') : '<li class="empty">Nenhum bem encontrado nos Dados Mestre.</li>';
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

/* ====== Atualização Geral de Indicadores ====== */
async function refresh() {
  items = (await DB.all())
    .filter(i => i.code !== META_ROW_CODE)
    .sort((a, b) => a.desc.localeCompare(b.desc, 'pt-BR'));

  const ok = items.filter(i => i.checked).length;
  const createdSpot = items.filter(i => i.extra?._created_on_spot).length;
  if ($('#stTotal')) $('#stTotal').textContent = items.length;
  if ($('#stOk')) $('#stOk').textContent = ok;
  if ($('#stPend')) $('#stPend').textContent = items.length - ok;
  if ($('#stNew')) $('#stNew').textContent = createdSpot;
  if ($('#progress')) $('#progress').style.width = items.length ? (ok / items.length * 100) + '%' : '0';

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
  updateSessionUI();
  await refresh();

  if (Cloud.isReady()) {
    await Cloud.syncAll(false);
    // Sincronização periódica automática para múltiplos usuários contarem juntos
    setInterval(() => {
      if (document.visibilityState === 'visible') Cloud.syncAll(false);
    }, 10000);
  }

  // Se o usuário ainda não definiu seu nome/código de inventário neste aparelho, abre o pop-up inicial
  if (!getUser()) {
    openSessionModal(true);
  }

  if ($('#importMsg')) $('#importMsg').textContent = localStorage.getItem('lastImport') || '';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
