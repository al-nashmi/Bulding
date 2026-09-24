'use strict';

/* ================= Storage (IndexedDB) ================= */
const DB_NAME = 'building-tracker';
const STORES = ['accounts', 'parties', 'contracts', 'txns', 'files', 'meta'];
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (os) => os.getAll());
const put = (s, v) => tx(s, 'readwrite', (os) => os.put(v));
const del = (s, id) => tx(s, 'readwrite', (os) => os.delete(id));
const clear = (s) => tx(s, 'readwrite', (os) => os.clear());

/* ================= State ================= */
const DEFAULT_CATEGORIES = [
  'حفر وردم', 'عظم (خرسانة وحديد)', 'بلوك', 'كهرباء', 'سباكة', 'لياسة', 'عزل',
  'بلاط ورخام', 'دهان', 'جبس', 'ألمنيوم وزجاج', 'أبواب ونجارة', 'تكييف',
  'مواد بناء', 'رسوم وتصاريح', 'عمالة', 'نقل', 'أخرى',
];
const state = {
  accounts: [], parties: [], contracts: [], txns: [], files: [],
  settings: { id: 'settings', currency: 'ر.س', categories: DEFAULT_CATEGORIES },
};
const ui = { view: 'dash', detail: null, filters: {} };

async function load() {
  for (const s of ['accounts', 'parties', 'contracts', 'txns', 'files']) state[s] = await getAll(s);
  const meta = await getAll('meta');
  const settings = meta.find((m) => m.id === 'settings');
  if (settings) state.settings = settings;
  if (!state.accounts.length) {
    for (const a of [{ id: 'bank', name: 'البنك' }, { id: 'cash', name: 'الكاش' }]) {
      await put('accounts', a); state.accounts.push(a);
    }
  }
}
async function save(store, rec) {
  await put(store, rec);
  const arr = state[store];
  const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
}
async function remove(store, id) {
  await del(store, id);
  state[store] = state[store].filter((x) => x.id !== id);
}

/* ================= Helpers ================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،\s]/g, '')); return isFinite(n) ? n : 0; };
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + state.settings.currency;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const byId = (store, id) => state[store].find((x) => x.id === id);
const accName = (id) => byId('accounts', id)?.name || '—';
const partyName = (id) => byId('parties', id)?.name || '';
const TYPE_LABEL = { in: 'وارد', transfer: 'تحويل', out: 'صرف' };
const PARTY_TYPES = ['مقاول', 'مورد مواد', 'عامل / فني', 'مكتب هندسي', 'جهة حكومية', 'أخرى'];
const sortTx = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.created || 0) - (a.created || 0);

function balances() {
  const bal = Object.fromEntries(state.accounts.map((a) => [a.id, 0]));
  for (const t of state.txns) {
    if (t.type === 'in') bal[t.to] = (bal[t.to] || 0) + t.amount;
    else if (t.type === 'transfer') { bal[t.from] = (bal[t.from] || 0) - t.amount; bal[t.to] = (bal[t.to] || 0) + t.amount; }
    else if (t.type === 'out') bal[t.from] = (bal[t.from] || 0) - t.amount;
  }
  return bal;
}
const contractTotal = (c) => c.amount + sum(c.additions || [], (a) => a.amount);
const contractPayments = (c) => state.txns.filter((t) => t.type === 'out' && t.contractId === c.id);
const contractPaid = (c) => sum(contractPayments(c), (t) => t.amount);
const filesOf = (type, id) => state.files.filter((f) => f.ownerType === type && f.ownerId === id);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2200);
}

const urlCache = new Map();
function fileURL(f) {
  if (!urlCache.has(f.id)) urlCache.set(f.id, URL.createObjectURL(f.blob));
  return urlCache.get(f.id);
}

/* Shrinks large phone photos so storage and backups stay manageable. */
async function prepareFile(file) {
  if (!/^image\/(jpeg|png|webp|heic)/.test(file.type) || file.size < 700 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
async function attachFiles(ownerType, ownerId, fileList) {
  for (const raw of fileList) {
    const f = await prepareFile(raw);
    await save('files', { id: uid(), ownerType, ownerId, name: f.name, type: f.type, size: f.size, blob: f, created: Date.now() });
  }
}
async function removeFilesOf(ownerType, ownerId) {
  for (const f of filesOf(ownerType, ownerId)) await remove('files', f.id);
}

function filesHTML(files, removable = false) {
  if (!files.length) return '';
  return `<div class="files">${files.map((f) => `
    <span class="file">📎 <a href="${fileURL(f)}" target="_blank" rel="noopener">${esc(f.name)}</a>
    ${removable ? `<button type="button" data-rmfile="${f.id}" title="حذف">✕</button>` : ''}</span>`).join('')}</div>`;
}

/* ================= Forms ================= */
const modal = document.getElementById('modal');
const modalForm = document.getElementById('modalForm');

function openForm({ title, fields, files, onSave, onDelete }) {
  const pendingRemovals = new Set();
  const fieldHTML = (f) => {
    const v = f.value ?? '';
    let input;
    if (f.type === 'select') {
      input = `<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map((o) =>
        `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea name="${f.name}">${esc(v)}</textarea>`;
    } else {
      const t = f.type === 'number' ? 'text' : (f.type || 'text');
      const extra = f.type === 'number' ? 'inputmode="decimal"' : '';
      input = `<input name="${f.name}" type="${t}" ${extra} value="${esc(v)}" ${f.required ? 'required' : ''} ${f.list ? `list="${f.name}-list"` : ''}>`;
      if (f.list) input += `<datalist id="${f.name}-list">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
    }
    return `<div class="field" data-field="${f.name}"><label>${esc(f.label)}</label>${input}</div>`;
  };
  const rows = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.half && fields[i + 1]?.half) { rows.push(`<div class="two">${fieldHTML(f)}${fieldHTML(fields[i + 1])}</div>`); i++; }
    else rows.push(fieldHTML(f));
  }
  modalForm.innerHTML = `
    <h3>${esc(title)}</h3>
    ${rows.join('')}
    ${files ? `<div class="field"><label>الفواتير والمرفقات (صور أو PDF)</label>
      <input type="file" name="__files" multiple accept="image/*,application/pdf">
      <div id="existingFiles">${filesHTML(files, true)}</div></div>` : ''}
    <div class="actions">
      <button class="btn primary" value="save">حفظ</button>
      <button class="btn" value="cancel" formnovalidate>إلغاء</button>
      <span class="spacer"></span>
      ${onDelete ? '<button class="btn danger" value="delete" formnovalidate>حذف</button>' : ''}
    </div>`;
  modalForm.querySelectorAll('[data-rmfile]').forEach((b) => b.addEventListener('click', () => {
    pendingRemovals.add(b.dataset.rmfile); b.parentElement.remove();
  }));
  for (const f of fields) if (f.onChange) {
    modalForm.elements[f.name].addEventListener('change', () => f.onChange(modalForm.elements));
  }
  modalForm.onsubmit = async (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    e.preventDefault();
    try {
      if (action === 'delete') {
        if (!confirm('متأكد من الحذف؟')) return;
        const ok = await onDelete();
        if (ok === false) return;
      } else {
        const data = {};
        for (const f of fields) {
          const raw = modalForm.elements[f.name].value.trim();
          data[f.name] = f.type === 'number' ? num(raw) : raw;
          if (f.type === 'number' && f.required && !(data[f.name] > 0)) { alert(`أدخل ${f.label} بشكل صحيح`); return; }
        }
        const ownerRef = await onSave(data);
        if (ownerRef === false) return;
        for (const id of pendingRemovals) await remove('files', id);
        const picked = modalForm.elements.__files?.files;
        if (ownerRef && picked?.length) await attachFiles(ownerRef.type, ownerRef.id, picked);
      }
      modal.close();
      render();
      toast('تم الحفظ');
    } catch (err) { console.error(err); alert('حدث خطأ: ' + err.message); }
  };
  modal.showModal();
}

const accountOptions = () => state.accounts.map((a) => ({ v: a.id, t: a.name }));
const categoryOptions = (withEmpty = true) => [...(withEmpty ? [{ v: '', t: '— بدون —' }] : []), ...state.settings.categories.map((c) => ({ v: c, t: c }))];
const partyOptions = (withEmpty = true) => [...(withEmpty ? [{ v: '', t: '— بدون —' }] : []), ...state.parties.map((p) => ({ v: p.id, t: p.name }))];
const contractOptions = () => [{ v: '', t: '— بدون عقد (مصروف مباشر) —' },
  ...state.contracts.map((c) => ({ v: c.id, t: `${c.title} — ${partyName(c.partyId)}` }))];

function formTxn(type, existing = {}, preset = {}) {
  const t = { ...preset, ...existing };
  const isNew = !existing.id;
  const common = [
    { name: 'date', label: 'التاريخ', type: 'date', value: t.date || today(), required: true, half: true },
    { name: 'amount', label: 'المبلغ', type: 'number', value: t.amount || '', required: true, half: true },
  ];
  let fields, title;
  if (type === 'in') {
    title = 'استلام مبلغ من الوالد';
    fields = [...common,
      { name: 'to', label: 'استلمته في', type: 'select', options: accountOptions(), value: t.to || 'bank', half: true },
      { name: 'ref', label: 'رقم الحوالة / المرجع', value: t.ref, half: true },
      { name: 'source', label: 'المُرسل', value: t.source ?? 'الوالد' },
      { name: 'note', label: 'ملاحظات', type: 'textarea', value: t.note }];
  } else if (type === 'transfer') {
    title = 'تحويل بين الحسابات';
    fields = [...common,
      { name: 'from', label: 'من', type: 'select', options: accountOptions(), value: t.from || 'bank', half: true },
      { name: 'to', label: 'إلى', type: 'select', options: accountOptions(), value: t.to || 'cash', half: true },
      { name: 'note', label: 'ملاحظات', type: 'textarea', value: t.note }];
  } else {
    title = 'دفعة / مصروف';
    fields = [...common,
      { name: 'contractId', label: 'على عقد', type: 'select', options: contractOptions(), value: t.contractId || '',
        onChange: (els) => {
          const c = byId('contracts', els.contractId.value);
          if (c) { els.partyId.value = c.partyId || ''; els.category.value = c.category || ''; }
        } },
      { name: 'partyId', label: 'المستلم (مقاول/مورد)', type: 'select', options: partyOptions(), value: t.partyId || '', half: true },
      { name: 'category', label: 'البند', type: 'select', options: categoryOptions(), value: t.category || '', half: true },
      { name: 'from', label: 'دفعت من', type: 'select', options: accountOptions(), value: t.from || 'bank', half: true },
      { name: 'ref', label: 'رقم الفاتورة / الإيصال', value: t.ref, half: true },
      { name: 'desc', label: 'الوصف', value: t.desc, list: [...new Set(state.txns.map((x) => x.desc).filter(Boolean))].slice(0, 50) },
      { name: 'note', label: 'ملاحظات', type: 'textarea', value: t.note }];
  }
  openForm({
    title: (isNew ? '' : 'تعديل: ') + title,
    fields,
    files: isNew ? [] : filesOf('txn', existing.id),
    onSave: async (d) => {
      if (type === 'transfer' && d.from === d.to) { alert('اختر حسابين مختلفين'); return false; }
      const rec = { ...existing, ...d, type, id: existing.id || uid(), created: existing.created || Date.now() };
      await save('txns', rec);
      return { type: 'txn', id: rec.id };
    },
    onDelete: isNew ? null : async () => { await removeFilesOf('txn', existing.id); await remove('txns', existing.id); },
  });
}

function formParty(existing = {}) {
  const isNew = !existing.id;
  openForm({
    title: isNew ? 'مقاول / مورد جديد' : 'تعديل: ' + existing.name,
    fields: [
      { name: 'name', label: 'الاسم', value: existing.name, required: true },
      { name: 'kind', label: 'النوع', type: 'select', options: PARTY_TYPES.map((x) => ({ v: x, t: x })), value: existing.kind || 'مقاول', half: true },
      { name: 'phone', label: 'الجوال', type: 'tel', value: existing.phone, half: true },
      { name: 'iban', label: 'الآيبان / الحساب البنكي', value: existing.iban },
      { name: 'note', label: 'ملاحظات', type: 'textarea', value: existing.note }],
    onSave: async (d) => { await save('parties', { ...existing, ...d, id: existing.id || uid() }); },
    onDelete: isNew ? null : async () => {
      const used = state.contracts.some((c) => c.partyId === existing.id) || state.txns.some((t) => t.partyId === existing.id);
      if (used) { alert('لا يمكن الحذف: عليه عقود أو دفعات مسجلة'); return false; }
      await remove('parties', existing.id);
      ui.detail = null;
    },
  });
}

function formContract(existing = {}, preset = {}) {
  const c = { ...preset, ...existing };
  const isNew = !existing.id;
  openForm({
    title: isNew ? 'عقد جديد' : 'تعديل العقد',
    fields: [
      { name: 'title', label: 'عنوان العقد / البند', value: c.title, required: true },
      { name: 'partyId', label: 'المقاول / المورد', type: 'select', options: partyOptions(false), value: c.partyId, required: true, half: true },
      { name: 'category', label: 'البند', type: 'select', options: categoryOptions(), value: c.category || '', half: true },
      { name: 'date', label: 'تاريخ العقد', type: 'date', value: c.date || today(), half: true },
      { name: 'amount', label: 'قيمة العقد الأصلية', type: 'number', value: c.amount || '', required: true, half: true },
      { name: 'scope', label: 'نطاق العمل / ما يشمله العقد', type: 'textarea', value: c.scope },
      { name: 'note', label: 'ملاحظات', type: 'textarea', value: c.note }],
    files: isNew ? [] : filesOf('contract', existing.id),
    onSave: async (d) => {
      if (!state.parties.length) { alert('أضف المقاول أو المورد أولاً'); return false; }
      const rec = { additions: [], ...existing, ...d, id: existing.id || uid() };
      await save('contracts', rec);
      if (isNew) { ui.view = 'contracts'; ui.detail = { type: 'contract', id: rec.id }; }
      return { type: 'contract', id: rec.id };
    },
    onDelete: isNew ? null : async () => {
      if (contractPayments(existing).length) { alert('لا يمكن حذف عقد عليه دفعات. احذف الدفعات أو انقلها أولاً.'); return false; }
      for (const a of existing.additions || []) await removeFilesOf('addition', a.id);
      await removeFilesOf('contract', existing.id);
      await remove('contracts', existing.id);
      ui.detail = null;
    },
  });
}

function formAddition(contract, existing = {}) {
  const isNew = !existing.id;
  openForm({
    title: (isNew ? 'إضافة زيادة / أعمال إضافية' : 'تعديل الزيادة') + ' — ' + contract.title,
    fields: [
      { name: 'date', label: 'التاريخ', type: 'date', value: existing.date || today(), half: true },
      { name: 'amount', label: 'المبلغ الإضافي', type: 'number', value: existing.amount || '', required: true, half: true },
      { name: 'desc', label: 'وصف الأعمال / الخدمات الإضافية', value: existing.desc, required: true }],
    files: isNew ? [] : filesOf('addition', existing.id),
    onSave: async (d) => {
      const rec = { ...existing, ...d, id: existing.id || uid() };
      const additions = (contract.additions || []).filter((a) => a.id !== rec.id).concat(rec);
      await save('contracts', { ...contract, additions });
      return { type: 'addition', id: rec.id };
    },
    onDelete: isNew ? null : async () => {
      await removeFilesOf('addition', existing.id);
      await save('contracts', { ...contract, additions: contract.additions.filter((a) => a.id !== existing.id) });
    },
  });
}

/* ================= Views ================= */
const app = document.getElementById('app');

function txnRow(t) {
  let title, meta, sign, cls;
  if (t.type === 'in') { title = `من ${t.source || 'الوالد'}`; meta = `إلى ${accName(t.to)}`; sign = '+'; cls = 'pos'; }
  else if (t.type === 'transfer') { title = `${accName(t.from)} ← ${accName(t.to)}`; meta = 'تحويل داخلي'; sign = ''; cls = ''; }
  else {
    const c = byId('contracts', t.contractId);
    title = t.desc || c?.title || t.category || 'مصروف';
    meta = [partyName(t.partyId), c && t.desc ? c.title : '', t.category, `من ${accName(t.from)}`].filter(Boolean).join(' · ');
    sign = '−'; cls = 'neg';
  }
  const nf = filesOf('txn', t.id).length;
  return `<div class="row" data-txn="${t.id}">
    <span class="badge ${t.type}">${TYPE_LABEL[t.type]}</span>
    <div class="main"><div class="title">${esc(title)}</div>
      <div class="meta">${esc(t.date)} · ${esc(meta)}${t.ref ? ' · #' + esc(t.ref) : ''}${nf ? ` · <span class="clip">📎${nf}</span>` : ''}</div></div>
    <div class="amt ${cls}">${sign}${fmt(t.amount)}</div></div>`;
}

function contractRow(c) {
  const total = contractTotal(c), paid = contractPaid(c), pct = total ? Math.min(100, (paid / total) * 100) : 0;
  const rem = total - paid;
  return `<div class="row" data-contract="${c.id}"><div class="main">
      <div class="title">${esc(c.title)}</div>
      <div class="meta">${esc(partyName(c.partyId))}${c.category ? ' · ' + esc(c.category) : ''}${c.additions?.length ? ` · ${c.additions.length} زيادة` : ''}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="meta">مدفوع ${fmt(paid)} من ${fmt(total)}</div></div>
    <div class="amt ${rem > 0 ? 'neg' : rem < 0 ? 'pos' : ''}">${rem < 0 ? 'زيادة ' + fmt(-rem) : 'باقي ' + fmt(rem)}</div></div>`;
}

function stat(label, value, cls = '', sub = '') {
  return `<div class="card stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function viewDash() {
  const bal = balances();
  const received = sum(state.txns.filter((t) => t.type === 'in'), (t) => t.amount);
  const spent = sum(state.txns.filter((t) => t.type === 'out'), (t) => t.amount);
  const balance = received - spent;
  const committed = sum(state.contracts, contractTotal);
  const paidOnContracts = sum(state.contracts, contractPaid);
  const remaining = sum(state.contracts, (c) => Math.max(0, contractTotal(c) - contractPaid(c)));
  const additions = sum(state.contracts, (c) => sum(c.additions || [], (a) => a.amount));

  const byCat = {};
  for (const t of state.txns) if (t.type === 'out') byCat[t.category || 'غير مصنف'] = (byCat[t.category || 'غير مصنف'] || 0) + t.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const open = state.contracts.filter((c) => contractTotal(c) - contractPaid(c) > 0.009)
    .sort((a, b) => (contractTotal(b) - contractPaid(b)) - (contractTotal(a) - contractPaid(a)));

  return `
    <h2>الملخص</h2>
    <div class="grid">
      ${stat('إجمالي المستلم من الوالد', fmt(received), 'pos')}
      ${stat('إجمالي المصروف', fmt(spent), 'neg')}
      ${stat('الرصيد المتبقي معي', fmt(balance), balance < 0 ? 'neg' : '')}
      ${state.accounts.map((a) => stat('رصيد ' + esc(a.name), fmt(bal[a.id] || 0), (bal[a.id] || 0) < 0 ? 'neg' : '')).join('')}
    </div>
    <h2>العقود والالتزامات</h2>
    <div class="grid">
      ${stat('إجمالي قيم العقود', fmt(committed), '', additions ? `منها زيادات ${fmt(additions)}` : '')}
      ${stat('المدفوع على العقود', fmt(paidOnContracts))}
      ${stat('المتبقي للمقاولين والموردين', fmt(remaining), remaining ? 'neg' : '')}
      ${stat('الرصيد بعد سداد الالتزامات', fmt(balance - remaining), balance - remaining < 0 ? 'neg' : 'pos', balance - remaining < 0 ? 'تحتاج تمويل إضافي' : '')}
    </div>
    ${cats.length ? `<h2>الصرف حسب البند</h2><div class="card table-wrap"><table>
      <tr><th>البند</th><th>المبلغ</th><th>النسبة</th></tr>
      ${cats.map(([c, v]) => `<tr><td>${esc(c)}</td><td>${fmt(v)}</td><td>${spent ? ((v / spent) * 100).toFixed(1) : 0}%</td></tr>`).join('')}
    </table></div>` : ''}
    ${open.length ? `<h2>عقود عليها مبالغ متبقية</h2><div class="list">${open.map(contractRow).join('')}</div>` : ''}
    <h2>آخر الحركات</h2>
    ${state.txns.length ? `<div class="list">${[...state.txns].sort(sortTx).slice(0, 8).map(txnRow).join('')}</div>`
      : '<div class="empty">ما فيه حركات بعد. ابدأ بزر ＋ وسجّل أول حوالة من الوالد.</div>'}`;
}

function filteredTxns() {
  const f = ui.filters;
  const q = (f.q || '').trim();
  return state.txns.filter((t) =>
    (!f.type || t.type === f.type) &&
    (!f.acc || t.from === f.acc || t.to === f.acc) &&
    (!f.party || t.partyId === f.party) &&
    (!f.cat || t.category === f.cat) &&
    (!f.month || (t.date || '').startsWith(f.month)) &&
    (!q || [t.desc, t.note, t.ref, t.source, t.category, partyName(t.partyId), byId('contracts', t.contractId)?.title].join(' ').includes(q))
  ).sort(sortTx);
}

function viewTxns() {
  const f = ui.filters;
  const list = filteredTxns();
  const tin = sum(list.filter((t) => t.type === 'in'), (t) => t.amount);
  const tout = sum(list.filter((t) => t.type === 'out'), (t) => t.amount);
  const sel = (name, opts) => `<select data-filter="${name}">${opts.map((o) => `<option value="${esc(o.v)}" ${f[name] === o.v ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
  return `
    <div class="toolbar">
      <input data-filter="q" placeholder="بحث..." value="${esc(f.q || '')}">
      ${sel('type', [{ v: '', t: 'كل الأنواع' }, { v: 'in', t: 'وارد' }, { v: 'out', t: 'صرف' }, { v: 'transfer', t: 'تحويل' }])}
      ${sel('acc', [{ v: '', t: 'كل الحسابات' }, ...accountOptions()])}
      ${sel('party', [{ v: '', t: 'كل الجهات' }, ...partyOptions(false)])}
      ${sel('cat', [{ v: '', t: 'كل البنود' }, ...categoryOptions(false)])}
      <input data-filter="month" type="month" value="${esc(f.month || '')}">
      <button class="btn sm" id="clearFilters">مسح</button>
      <button class="btn sm" id="exportCsv">تصدير Excel (CSV)</button>
    </div>
    <div class="grid" style="margin-bottom:12px">
      ${stat('عدد الحركات', list.length)}${stat('الوارد', fmt(tin), 'pos')}${stat('المصروف', fmt(tout), 'neg')}
    </div>
    ${list.length ? `<div class="list">${list.map(txnRow).join('')}</div>` : '<div class="empty">لا توجد حركات</div>'}`;
}

function viewContracts() {
  if (ui.detail?.type === 'contract') return viewContractDetail(byId('contracts', ui.detail.id));
  return `<div class="toolbar"><button class="btn primary" data-add="contract">＋ عقد جديد</button></div>
    ${state.contracts.length ? `<div class="list">${[...state.contracts].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(contractRow).join('')}</div>`
      : '<div class="empty">سجّل عقودك مع المقاولين والموردين هنا، وبعدها اربط كل دفعة بعقدها.</div>'}`;
}

function viewContractDetail(c) {
  if (!c) { ui.detail = null; return viewContracts(); }
  const total = contractTotal(c), paid = contractPaid(c);
  const pays = contractPayments(c).sort(sortTx);
  return `
    <button class="back" data-back>→ رجوع للعقود</button>
    <div class="detail-head">
      <div><h2 style="margin:0">${esc(c.title)}</h2>
        <div class="meta">${esc(partyName(c.partyId))}${c.category ? ' · ' + esc(c.category) : ''} · ${esc(c.date || '')}</div></div>
      <div class="toolbar" style="margin:0">
        <button class="btn primary" data-pay="${c.id}">＋ دفعة</button>
        <button class="btn" data-addition="${c.id}">＋ زيادة</button>
        <button class="btn" data-edit-contract="${c.id}">تعديل</button>
      </div>
    </div>
    <div class="grid" style="margin-top:12px">
      ${stat('قيمة العقد الأصلية', fmt(c.amount))}
      ${stat('الزيادات', fmt(total - c.amount))}
      ${stat('الإجمالي', fmt(total))}
      ${stat('المدفوع', fmt(paid), 'pos')}
      ${stat(total - paid < 0 ? 'مدفوع زيادة' : 'المتبقي', fmt(Math.abs(total - paid)), total - paid > 0 ? 'neg' : '')}
    </div>
    ${c.scope ? `<h2>نطاق العمل</h2><div class="card" style="white-space:pre-wrap">${esc(c.scope)}</div>` : ''}
    ${c.note ? `<h2>ملاحظات</h2><div class="card" style="white-space:pre-wrap">${esc(c.note)}</div>` : ''}
    <h2>مرفقات العقد</h2>
    ${filesHTML(filesOf('contract', c.id)) || '<div class="meta">لا يوجد — أضفها من "تعديل"</div>'}
    <h2>الزيادات والأعمال الإضافية</h2>
    ${c.additions?.length ? `<div class="list">${[...c.additions].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map((a) => `
      <div class="row" data-edit-addition="${a.id}"><div class="main"><div class="title">${esc(a.desc)}</div>
      <div class="meta">${esc(a.date)}${filesOf('addition', a.id).length ? ' · 📎' + filesOf('addition', a.id).length : ''}</div></div>
      <div class="amt">+${fmt(a.amount)}</div></div>`).join('')}</div>` : '<div class="meta">لا توجد زيادات</div>'}
    <h2>الدفعات (${pays.length})</h2>
    ${pays.length ? `<div class="list">${pays.map(txnRow).join('')}</div>` : '<div class="meta">لا توجد دفعات</div>'}`;
}

function viewParties() {
  if (ui.detail?.type === 'party') return viewPartyDetail(byId('parties', ui.detail.id));
  const rows = state.parties.map((p) => {
    const cs = state.contracts.filter((c) => c.partyId === p.id);
    const paid = sum(state.txns.filter((t) => t.type === 'out' && t.partyId === p.id), (t) => t.amount);
    const rem = sum(cs, (c) => contractTotal(c) - contractPaid(c));
    return `<div class="row" data-party="${p.id}"><div class="main"><div class="title">${esc(p.name)}</div>
      <div class="meta">${esc(p.kind || '')}${p.phone ? ' · ' + esc(p.phone) : ''} · ${cs.length} عقد · مدفوع ${fmt(paid)}</div></div>
      <div class="amt ${rem > 0 ? 'neg' : ''}">${rem > 0 ? 'باقي ' + fmt(rem) : ''}</div></div>`;
  });
  return `<div class="toolbar"><button class="btn primary" data-add="party">＋ إضافة</button></div>
    ${rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="empty">أضف المقاولين والموردين اللي تتعامل معهم</div>'}`;
}

function viewPartyDetail(p) {
  if (!p) { ui.detail = null; return viewParties(); }
  const cs = state.contracts.filter((c) => c.partyId === p.id);
  const pays = state.txns.filter((t) => t.type === 'out' && t.partyId === p.id).sort(sortTx);
  const total = sum(cs, contractTotal), paid = sum(pays, (t) => t.amount);
  return `
    <button class="back" data-back>→ رجوع</button>
    <div class="detail-head">
      <div><h2 style="margin:0">${esc(p.name)}</h2>
      <div class="meta">${esc(p.kind || '')}${p.phone ? ` · <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}${p.iban ? ' · ' + esc(p.iban) : ''}</div></div>
      <div class="toolbar" style="margin:0">
        <button class="btn primary" data-add-contract-for="${p.id}">＋ عقد</button>
        <button class="btn" data-pay-party="${p.id}">＋ دفعة</button>
        <button class="btn" data-edit-party="${p.id}">تعديل</button>
      </div>
    </div>
    ${p.note ? `<div class="card" style="margin-top:10px;white-space:pre-wrap">${esc(p.note)}</div>` : ''}
    <div class="grid" style="margin-top:12px">
      ${stat('إجمالي العقود', fmt(total))}${stat('إجمالي المدفوع له', fmt(paid), 'pos')}
      ${stat('المتبقي على العقود', fmt(sum(cs, (c) => contractTotal(c) - contractPaid(c))), 'neg')}
    </div>
    <h2>العقود</h2>
    ${cs.length ? `<div class="list">${cs.map(contractRow).join('')}</div>` : '<div class="meta">لا توجد عقود</div>'}
    <h2>كل الدفعات</h2>
    ${pays.length ? `<div class="list">${pays.map(txnRow).join('')}</div>` : '<div class="meta">لا توجد دفعات</div>'}`;
}

function fileOwnerLabel(f) {
  if (f.ownerType === 'txn') {
    const t = byId('txns', f.ownerId);
    return t ? `${TYPE_LABEL[t.type]} ${fmt(t.amount)} · ${t.date}` : '';
  }
  if (f.ownerType === 'contract') return 'عقد: ' + (byId('contracts', f.ownerId)?.title || '');
  const c = state.contracts.find((c) => c.additions?.some((a) => a.id === f.ownerId));
  return c ? 'زيادة على: ' + c.title : '';
}

function viewFiles() {
  const q = (ui.filters.fq || '').trim();
  const files = [...state.files].sort((a, b) => b.created - a.created)
    .filter((f) => !q || (f.name + ' ' + fileOwnerLabel(f)).includes(q));
  return `<div class="toolbar"><input data-filter="fq" placeholder="بحث في الفواتير..." value="${esc(q)}"></div>
    ${files.length ? `<div class="thumbs">${files.map((f) => {
      const img = f.type?.startsWith('image/');
      return `<a class="thumb" href="${fileURL(f)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">
        <div class="img" ${img ? `style="background-image:url('${fileURL(f)}')"` : ''}>${img ? '' : '📄'}</div>
        <div class="cap"><div>${esc(fileOwnerLabel(f))}</div><div class="meta">${esc(f.name)}</div></div></a>`;
    }).join('')}</div>` : '<div class="empty">لا توجد فواتير. أرفقها عند تسجيل أي دفعة أو عقد.</div>'}`;
}

function viewSettings() {
  const s = state.settings;
  const totalSize = sum(state.files, (f) => f.size);
  return `
    <h2>الحسابات</h2>
    <div class="card">
      ${state.accounts.map((a) => `<div class="toolbar"><input data-acc="${a.id}" value="${esc(a.name)}"></div>`).join('')}
      <button class="btn sm" id="addAccount">＋ حساب آخر (مثلاً بنك ثاني)</button>
    </div>
    <h2>البنود</h2>
    <div class="card">
      <div class="field"><label>كل بند في سطر</label><textarea id="cats" rows="8">${esc(s.categories.join('\n'))}</textarea></div>
      <div class="field"><label>العملة</label><input id="currency" value="${esc(s.currency)}"></div>
      <button class="btn primary sm" id="saveSettings">حفظ</button>
    </div>
    <h2>النسخ الاحتياطي</h2>
    <div class="card">
      <p style="margin-top:0">البيانات والفواتير محفوظة في هذا المتصفح على هذا الجهاز فقط. خذ نسخة احتياطية بشكل دوري واحفظها في مكان آمن (Google Drive مثلاً) — لو مسحت بيانات المتصفح تضيع.</p>
      <p class="meta">${state.txns.length} حركة · ${state.contracts.length} عقد · ${state.files.length} مرفق (${(totalSize / 1048576).toFixed(1)} ميجا)</p>
      <div class="toolbar">
        <button class="btn primary" id="backup">تنزيل نسخة احتياطية كاملة</button>
        <label class="btn">استرجاع نسخة<input type="file" id="restore" accept=".json,application/json" hidden></label>
        <button class="btn" id="exportCsv">تصدير الحركات Excel (CSV)</button>
      </div>
      <p class="meta" id="persistStatus"></p>
    </div>
    <h2>منطقة الخطر</h2>
    <div class="card"><button class="btn danger" id="wipe">مسح كل البيانات</button></div>`;
}

/* ================= Backup / Export ================= */
const blobToDataURL = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function backup() {
  toast('جاري تجهيز النسخة...');
  const files = [];
  for (const f of state.files) { const { blob, ...m } = f; files.push({ ...m, data: await blobToDataURL(blob) }); }
  const data = { app: 'building-tracker', version: 1, exported: new Date().toISOString(),
    settings: state.settings, accounts: state.accounts, parties: state.parties, contracts: state.contracts, txns: state.txns, files };
  download(`نسخة-مصاريف-البناء-${today()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('الملف غير صالح'); return; }
  if (data.app !== 'building-tracker') { alert('هذا ليس ملف نسخة احتياطية من هذا الموقع'); return; }
  if (!confirm('الاسترجاع سيستبدل كل البيانات الحالية بالنسخة. متابعة؟')) return;
  for (const s of STORES) await clear(s);
  urlCache.clear();
  await put('meta', { ...data.settings, id: 'settings' });
  for (const s of ['accounts', 'parties', 'contracts', 'txns']) for (const r of data[s] || []) await put(s, r);
  for (const f of data.files || []) {
    const { data: d, ...m } = f;
    await put('files', { ...m, blob: await (await fetch(d)).blob() });
  }
  await load();
  render();
  toast('تم الاسترجاع');
}

function exportCsv() {
  const rows = [['التاريخ', 'النوع', 'المبلغ', 'من', 'إلى', 'الجهة', 'العقد', 'البند', 'الوصف', 'المرجع', 'ملاحظات', 'مرفقات']];
  for (const t of [...state.txns].sort(sortTx)) {
    rows.push([t.date, TYPE_LABEL[t.type], t.type === 'out' ? -t.amount : t.amount,
      t.type === 'in' ? (t.source || '') : accName(t.from), t.type === 'out' ? '' : accName(t.to),
      partyName(t.partyId), byId('contracts', t.contractId)?.title || '', t.category || '', t.desc || '', t.ref || '', t.note || '',
      filesOf('txn', t.id).length]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`حركات-البناء-${today()}.csv`, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
}

/* ================= Render & events ================= */
function render() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
  const views = { dash: viewDash, txns: viewTxns, contracts: viewContracts, parties: viewParties, files: viewFiles, settings: viewSettings };
  app.innerHTML = views[ui.view]();
  if (ui.view === 'settings' && navigator.storage?.persisted) {
    navigator.storage.persisted().then((p) => {
      const el = document.getElementById('persistStatus');
      if (el) el.textContent = p ? '✓ المتصفح يحمي البيانات من المسح التلقائي' : 'تنبيه: المتصفح لم يمنح تخزيناً دائماً — النسخ الاحتياطي مهم.';
    });
  }
}

function go(view) { ui.view = view; ui.detail = null; render(); window.scrollTo(0, 0); }

document.getElementById('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.view); });

const fabMenu = document.getElementById('fabMenu');
document.getElementById('fabBtn').addEventListener('click', () => (fabMenu.hidden = !fabMenu.hidden));
function handleAdd(kind) {
  fabMenu.hidden = true;
  if (kind === 'party') formParty();
  else if (kind === 'contract') {
    if (!state.parties.length) { alert('أضف المقاول أو المورد أولاً'); formParty(); return; }
    formContract();
  } else formTxn(kind);
}
fabMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) handleAdd(b.dataset.add); });

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-txn],[data-contract],[data-party],[data-back],[data-pay],[data-addition],[data-edit-contract],[data-edit-addition],[data-add],[data-edit-party],[data-pay-party],[data-add-contract-for],button');
  if (!el || e.target.closest('a')) return;
  const d = el.dataset;
  if (d.txn) { const t = byId('txns', d.txn); formTxn(t.type, t); }
  else if (d.contract) { ui.view = 'contracts'; ui.detail = { type: 'contract', id: d.contract }; render(); window.scrollTo(0, 0); }
  else if (d.party) { ui.detail = { type: 'party', id: d.party }; render(); window.scrollTo(0, 0); }
  else if ('back' in d) { ui.detail = null; render(); }
  else if (d.pay) formTxn('out', {}, { contractId: d.pay, partyId: byId('contracts', d.pay).partyId, category: byId('contracts', d.pay).category });
  else if (d.addition) formAddition(byId('contracts', d.addition));
  else if (d.editContract) formContract(byId('contracts', d.editContract));
  else if (d.editAddition) { const c = byId('contracts', ui.detail.id); formAddition(c, c.additions.find((a) => a.id === d.editAddition)); }
  else if (d.add) handleAdd(d.add);
  else if (d.editParty) formParty(byId('parties', d.editParty));
  else if (d.payParty) formTxn('out', {}, { partyId: d.payParty });
  else if (d.addContractFor) formContract({}, { partyId: d.addContractFor });
  else if (el.id === 'clearFilters') { ui.filters = {}; render(); }
  else if (el.id === 'exportCsv') exportCsv();
  else if (el.id === 'backup') backup();
  else if (el.id === 'addAccount') {
    const name = prompt('اسم الحساب'); if (!name) return;
    save('accounts', { id: uid(), name }).then(render);
  } else if (el.id === 'saveSettings') {
    const cats = document.getElementById('cats').value.split('\n').map((x) => x.trim()).filter(Boolean);
    state.settings = { ...state.settings, categories: cats, currency: document.getElementById('currency').value.trim() || 'ر.س' };
    put('meta', state.settings).then(() => { render(); toast('تم الحفظ'); });
  } else if (el.id === 'wipe') {
    if (!confirm('سيتم مسح كل شيء نهائياً. هل أخذت نسخة احتياطية؟')) return;
    if (prompt('اكتب: مسح') !== 'مسح') return;
    Promise.all(STORES.map(clear)).then(() => location.reload());
  }
});

app.addEventListener('input', (e) => {
  const f = e.target.dataset.filter;
  if (f) {
    ui.filters[f] = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const again = app.querySelector(`[data-filter="${f}"]`);
    if (again && e.target.tagName === 'INPUT' && again.type !== 'month') { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
  }
});
app.addEventListener('change', (e) => {
  if (e.target.dataset.acc) {
    const a = byId('accounts', e.target.dataset.acc);
    const name = e.target.value.trim();
    if (name) save('accounts', { ...a, name }).then(() => toast('تم الحفظ'));
  } else if (e.target.id === 'restore' && e.target.files[0]) restore(e.target.files[0]);
});

/* ================= Boot ================= */
(async () => {
  try {
    db = await openDB();
    await load();
    navigator.storage?.persist?.();
    render();
  } catch (err) {
    app.innerHTML = `<div class="empty">تعذر فتح قاعدة البيانات في هذا المتصفح: ${esc(err.message)}</div>`;
  }
})();
