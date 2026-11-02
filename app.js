'use strict';
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

let items = [];
let filter = 'all';
let currentCode = null;

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
  for (const r of rows.slice(1)) {
    const code = (r[map.code] || '').trim();
    if (!code) continue;
    const extra = {};
    heads.forEach((h, i) => { if (!used.has(i) && h && (r[i] || '').trim()) extra[h] = r[i].trim(); });
    const prev = keep ? old.get(code) : null;
    await DB.put({
      code, desc: (r[map.desc] || '').trim() || '(sem descrição)',
      cat: (r[map.cat] || '').trim(), loc: (r[map.loc] || '').trim(), obs: (r[map.obs] || '').trim(), extra,
      photo: prev?.photo || null, checked: prev?.checked || false, at: prev?.at || null, by: prev?.by || null,
    });
    n++;
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
  if (confirm('Apagar TODOS os itens, fotos e conferências deste aparelho?')) { await DB.clear(); await refresh(); $('#result').innerHTML = ''; toast('Dados apagados'); }
};

/* ====== Busca / exibição ====== */
function find(code) {
  code = code.trim();
  return items.find(i => i.code === code)
    || items.find(i => i.code.toLowerCase() === code.toLowerCase())
    || items.find(i => i.code.replace(/^0+/, '') === code.replace(/^0+/, ''));
}
function showResult(code) {
  const it = find(code);
  const box = $('#result');
  if (!it) {
    currentCode = null;
    box.innerHTML = `<div class="notfound"><b>❌ Código não cadastrado</b><p class="code">${esc(code)}</p><p class="muted">Este código não consta na base importada.</p></div>`;
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
async function toggleCheck(code) {
  const it = await DB.get(code);
  if (it.checked) { it.checked = false; it.at = null; it.by = null; }
  else { it.checked = true; it.at = new Date().toISOString(); it.by = askUser(false); }
  await DB.put(it); await refresh(); showResult(code);
  toast(it.checked ? 'Item conferido ✔' : 'Conferência desfeita');
}

/* ====== Foto ====== */
$('#photoInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !currentCode) return;
  const url = await shrink(f, 900);
  const it = await DB.get(currentCode);
  it.photo = url; await DB.put(it); await refresh(); showResult(currentCode);
  toast('Foto salva');
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
    : '<li class="empty">Nenhum item encontrado. Importe o CSV na aba Dados.</li>';
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
  await DB.open(); await refresh(); askUser(false);
  $('#importMsg').textContent = localStorage.getItem('lastImport') || '';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
