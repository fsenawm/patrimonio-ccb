'use strict';

/* ====== Configuração Padrão do Supabase ====== */
const DEFAULT_SUPABASE_URL = '';
const DEFAULT_SUPABASE_ANON_KEY = '';

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
  clear() { return this.req(this.tx('readwrite').clear()); },
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2500); }

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
      this.updateBadge(true, `✔ Sincronizado com Supabase em ${new Date().toLocaleTimeString('pt-BR')}`);
      return true;
    } catch (e) {
      console.warn('Erro ao salvar no Supabase:', e);
      this.updateBadge(false, `⚠️ Erro ao sincronizar com Supabase: ${e.message || 'verifique a tabela/chave'}`);
      return false;
    }
  },
  async syncAll(pushLocalFirst = false) {
    if (!this.isReady()) {
      this.updateBadge(false, 'Configure a URL e a Anon Key do seu projeto Supabase acima.');
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
      for (const r of rows) {
        const it = this.fromRow(r);
        remoteCodes.add(it.code);
        await DB.put(it);
      }
      // Envia itens locais que ainda não estavam na nuvem
      const allLocal = await DB.all();
      const missingOnCloud = allLocal.filter(i => !remoteCodes.has(i.code));
      if (missingOnCloud.length) await this.upsert(missingOnCloud);

      this.updateBadge(true, `✔ Conectado ao Supabase (${allLocal.length} itens na base).`);
      await refresh();
      return true;
    } catch (e) {
      console.warn('Erro ao buscar do Supabase:', e);
      this.updateBadge(false, `⚠️ Falha na conexão com Supabase. Verifique se a tabela patrimonio_items foi criada.`);
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
  }
};

let items = [];
let filter = 'all';
let currentCode = null;
let newItemPhotoData = null;

/* ====== Usuário ====== */
function askUser(force) {
  let n = localStorage.getItem('user');
  if (!n || force) {
    n = (prompt('Nome do responsável pelo inventário:', n || '') || '').trim() || n || 'Não informado';
    localStorage.setItem('user', n);
  }
  $('#userName').textContent = n;
  return n;
}

/* ====== Abas ====== */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab !== 'scan') stopScan();
  if (b.dataset.tab === 'list') renderList();
});

/* ====== Configuração Supabase na Aba Dados ====== */
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

/* ====== CSV ====== */
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
async function importCSV(file) {
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
  const keep = $('#keepState').checked;
  const old = new Map((await DB.all()).map(i => [i.code, i]));
  await DB.clear();
  let n = 0;
  const imported = [];
  for (const r of rows.slice(1)) {
    const code = (r[map.code] || '').trim();
    if (!code) continue;
    const extra = {};
    heads.forEach((h, i) => { if (!used.has(i) && h && (r[i] || '').trim()) extra[h] = r[i].trim(); });
    const prev = keep ? old.get(code) : null;
    const item = {
      code, desc: (r[map.desc] || '').trim() || '(sem descrição)',
      cat: (r[map.cat] || '').trim(), loc: (r[map.loc] || '').trim(), obs: (r[map.obs] || '').trim(), extra,
      photo: prev?.photo || null, checked: prev?.checked || false, at: prev?.at || null, by: prev?.by || null,
    };
    await DB.put(item);
    imported.push(item);
    n++;
  }
  if (Cloud.isReady() && imported.length) {
    await Cloud.upsert(imported);
  }
  $('#importMsg').textContent = `✔ ${n} itens importados em ${new Date().toLocaleString('pt-BR')}.`;
  localStorage.setItem('lastImport', $('#importMsg').textContent);
  await refresh();
  toast(`${n} itens importados`);
}
$('#csvFile').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ''; };

$('#btnExport').onclick = () => {
  if (!items.length) return toast('Nada para exportar');
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['codigo', 'descricao', 'categoria', 'local', 'observacao', 'situacao', 'data_hora_conferencia', 'usuario'];
  const lines = [head.join(';')].concat(items.map(i => [i.code, i.desc, i.cat, i.loc, i.obs,
    i.checked ? 'CONFERIDO' : 'PENDENTE', i.at ? new Date(i.at).toLocaleString('pt-BR') : '', i.by || ''].map(q).join(';')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `inventario_ccb_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};
$('#btnReset').onclick = async () => {
  if (confirm('Apagar TODOS os itens, fotos e conferências da base?')) {
    await DB.clear();
    await Cloud.clearRemote();
    await refresh();
    $('#result').innerHTML = '';
    toast('Dados apagados');
  }
};

/* ====== Busca / Exibição / Pergunta de Novo Item ====== */
function find(code) {
  code = code.trim();
  return items.find(i => i.code === code)
    || items.find(i => i.code.toLowerCase() === code.toLowerCase())
    || items.find(i => i.code.replace(/^0+/, '') === code.replace(/^0+/, ''));
}

function showResult(code) {
  code = String(code || '').trim();
  if (!code) return;
  const it = find(code);
  const box = $('#result');
  if (!it) {
    currentCode = null;
    box.innerHTML = `<div class="notfound">
      <b>❌ Código não cadastrado</b>
      <p class="code">${esc(code)}</p>
      <p class="ask-title">Deseja criar este item do patrimônio no momento?</p>
      <div class="row">
        <button type="button" id="btnAskNo" class="btn">Não</button>
        <button type="button" id="btnAskYes" class="btn ok primary">✔ Sim, criar item</button>
      </div>
    </div>`;
    $('#btnAskNo').onclick = () => {
      box.innerHTML = '';
      lastCode = '';
      toast('Aguardando próxima leitura de código...');
    };
    $('#btnAskYes').onclick = () => openCreateModal(code);
    navigator.vibrate?.([200, 100, 200]);
    return;
  }
  currentCode = it.code;
  const fields = [['Categoria', it.cat], ['Local', it.loc], ['Observação', it.obs], ...Object.entries(it.extra || {})].filter(f => f[1]);
  box.innerHTML = `<article class="item">
    <div class="photo" id="photoBox">${it.photo ? `<img src="${it.photo}" alt="Foto de ${esc(it.desc)}"><span class="cam">📷 Trocar foto</span>` : '<div>📷<br>Toque para tirar a foto do objeto</div>'}</div>
    <div class="body">
      <span class="badge ${it.checked ? 'ok' : 'warn'}">${it.checked ? '✔ Conferido' : 'Pendente'}</span>
      <h2>${esc(it.desc)}</h2><div class="code">${esc(it.code)}</div>
      <dl class="fields">${fields.map(f => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join('')}</dl>
      ${it.checked ? `<p class="muted">Conferido em ${new Date(it.at).toLocaleString('pt-BR')} por ${esc(it.by)}</p>` : ''}
      <div class="row"><button class="btn ${it.checked ? '' : 'ok'} primary" id="btnCheck" style="${it.checked ? '' : 'background:linear-gradient(135deg,#3ecf8e,#22a06b);color:#04210f'}">${it.checked ? '↩ Desfazer conferência' : '✔ Marcar como conferido'}</button></div>
    </div></article>`;
  $('#photoBox').onclick = () => $('#photoInput').click();
  $('#btnCheck').onclick = () => toggleCheck(it.code);
  navigator.vibrate?.(80);
}

/* ====== Tela / Modal de Cadastro de Novo Item ====== */
function openCreateModal(code) {
  stopScan();
  newItemPhotoData = null;
  $('#newCode').value = code;
  $('#newDesc').value = '';
  $('#newCat').value = '';
  $('#newLoc').value = '';
  $('#newObs').value = '';
  $('#newChecked').checked = true;
  $('#newPhotoPreview').src = '';
  $('#newPhotoPreview').classList.add('hidden');
  $('#newPhotoPlaceholder').classList.remove('hidden');
  $('#btnRemoveNewPhoto').classList.add('hidden');

  // Preenche sugestões de Categorias e Locais já existentes
  const cats = [...new Set(items.map(i => i.cat).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const locs = [...new Set(items.map(i => i.loc).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('#catList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('#locList').innerHTML = locs.map(l => `<option value="${esc(l)}">`).join('');

  $('#createModal').classList.remove('hidden');
  setTimeout(() => $('#newDesc').focus(), 100);
}

function closeCreateModal(clearPrompt = false) {
  $('#createModal').classList.add('hidden');
  newItemPhotoData = null;
  if (clearPrompt) {
    $('#result').innerHTML = '';
    lastCode = '';
  }
}

$('#btnCloseCreate').onclick = () => closeCreateModal(true);
$('#btnCancelCreate').onclick = () => closeCreateModal(true);
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

$('#createForm').onsubmit = async e => {
  e.preventDefault();
  const code = $('#newCode').value.trim();
  const desc = $('#newDesc').value.trim();
  const cat = $('#newCat').value.trim();
  const loc = $('#newLoc').value.trim();
  const obs = $('#newObs').value.trim();
  const markChecked = $('#newChecked').checked;

  if (!code || !desc) return toast('Preencha a descrição do item');

  const item = {
    code,
    desc,
    cat,
    loc,
    obs,
    extra: {},
    photo: newItemPhotoData || null,
    checked: markChecked,
    at: markChecked ? new Date().toISOString() : null,
    by: markChecked ? askUser(false) : null,
  };

  await DB.put(item);
  await Cloud.upsert([item]);
  await refresh();
  closeCreateModal(false);
  showResult(code);
  toast('Item cadastrado e salvo ✔');
};

async function toggleCheck(code) {
  const it = await DB.get(code);
  if (it.checked) { it.checked = false; it.at = null; it.by = null; }
  else { it.checked = true; it.at = new Date().toISOString(); it.by = askUser(false); }
  await DB.put(it);
  await Cloud.upsert([it]);
  await refresh();
  showResult(code);
  toast(it.checked ? 'Item conferido ✔' : 'Conferência desfeita');
}

/* ====== Foto de item existente ====== */
$('#photoInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !currentCode) return;
  const url = await shrink(f, 900);
  const it = await DB.get(currentCode);
  it.photo = url;
  await DB.put(it);
  await Cloud.upsert([it]);
  await refresh();
  showResult(currentCode);
  toast('Foto salva ✔');
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

/* ====== Lista ====== */
function renderList() {
  const q = norm($('#search').value);
  const list = items.filter(i => (filter === 'all' || (filter === 'ok') === i.checked)
    && (!q || norm(i.code + i.desc + i.loc + i.cat).includes(q)));
  $('#list').innerHTML = list.length ? list.slice(0, 300).map(i => `<li data-c="${esc(i.code)}">
    ${i.photo ? `<img class="thumb" src="${i.photo}" alt="">` : '<div class="thumb">📦</div>'}
    <div class="info"><b>${esc(i.desc)}</b><small>${esc(i.code)}${i.loc ? ' · ' + esc(i.loc) : ''}</small></div>
    <span class="badge ${i.checked ? 'ok' : 'warn'}">${i.checked ? '✔' : '…'}</span></li>`).join('')
    : '<li class="empty">Nenhum item encontrado. Leia um código para cadastrar ou importe o CSV na aba Dados.</li>';
}
$('#list').onclick = e => {
  const li = e.target.closest('li[data-c]'); if (!li) return;
  document.querySelector('[data-tab=scan]').click(); showResult(li.dataset.c); window.scrollTo(0, 0);
};
$('#search').oninput = renderList;
document.querySelectorAll('.filters .chip').forEach(c => c.onclick = () => {
  filter = c.dataset.f; document.querySelectorAll('.filters .chip').forEach(x => x.classList.toggle('sel', x === c)); renderList();
});
async function refresh() {
  items = (await DB.all()).sort((a, b) => a.desc.localeCompare(b.desc, 'pt-BR'));
  const ok = items.filter(i => i.checked).length;
  $('#stTotal').textContent = items.length; $('#stOk').textContent = ok; $('#stPend').textContent = items.length - ok;
  $('#progress').style.width = items.length ? ok / items.length * 100 + '%' : '0';
  renderList();
}

/* ====== Leitor de código de barras ====== */
let stream = null, scanning = false, zxingCtl = null, lastCode = '', lastTime = 0;
function onCode(code) {
  const now = Date.now();
  if (code === lastCode && now - lastTime < 2500) return;
  lastCode = code; lastTime = now;
  showResult(code);
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
  $('#video').srcObject = null;
  document.querySelector('.scanner').classList.remove('on');
  $('#btnScan').textContent = '📷 Ler código'; $('#btnTorch').classList.add('hidden');
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
$('#manualForm').onsubmit = e => { e.preventDefault(); const v = $('#manualCode').value.trim(); if (v) { showResult(v); $('#manualCode').value = ''; } };
$('#btnUser').onclick = () => askUser(true);

/* ====== Início ====== */
(async () => {
  await DB.open();
  initSupabaseConfig();
  await refresh();
  askUser(false);
  if (Cloud.isReady()) {
    Cloud.syncAll(false);
  } else {
    Cloud.updateBadge(false, 'Configure a URL e a Anon Key do seu projeto Supabase acima.');
  }
  $('#importMsg').textContent = localStorage.getItem('lastImport') || '';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
