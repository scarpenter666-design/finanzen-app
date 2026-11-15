/* ============================================================
   app.js – "Meine Finanzen".
   Einnahmen, Ausgaben, Fixposten, Kategorien, Monatsübersicht.
   Baut auf dem zimmermannki-pwa-template auf. Alle Daten liegen
   verschlüsselt im Speicher (storage.encryption: 'pin').

   Einträge im Speicher (Key "meine-finanzen.<name>"):
     entries       Liste aller Einträge und Fixposten-Vorlagen
     income_cats   Einnahmen-Kategorien
     expense_cats  Ausgaben-Kategorien
     month         zuletzt gewählter Monat "JJJJ-MM"

   Ein Eintrag: { id, name, amount, type: 'income'|'expense', category,
                  fixed, fixedRef, month, date }
   - fixed: true     = Vorlage eines Fixpostens (month ist null)
   - fixedRef: <id>  = Monatskopie eines Fixpostens
   ============================================================ */
import { openStore, StorageError } from './core/storage.js';
import { createBackup, BackupError, legacyPrefixAdapter } from './core/backup.js';
import { initUpdates, getVersion } from './core/update-banner.js';
import { initInstall, isStandalone } from './core/install.js';
import { toast } from './core/notice.js';

const config = self.APP_CONFIG;
const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ── 0. Verschlüsselung ──────────────────────────────────────
let vault = null;
let codec;
let cryptoModule = null;
let lockModule = null;
if (config.storage.encryption === 'pin') {
  cryptoModule = await import('./core/crypto.js');
  lockModule = await import('./core/lock-screen.js');
  vault = await cryptoModule.openVault();
  codec = await lockModule.unlockApp({ vault });
  cryptoModule.startAutoLock({ minutes: config.storage.autoLockMinutes, onLock: () => location.reload() });
}

// ── 1. Speicher und Backup ──────────────────────────────────
const store = await openStore({ codec });

// Alte Backup-Dateien der bisherigen App (Keys "fin_…") bleiben einspielbar.
// Der alte PIN und die Sperrzähler werden dabei NICHT übernommen.
const backup = createBackup({
  store,
  adapters: [legacyPrefixAdapter({ prefix: 'fin_', ignore: ['fin_pin', 'fin_pin_attempts', 'fin_pin_lock_until'] })]
});

const DEFAULT_INCOME_CATS = ['Gehalt / Lohn', 'Bundeswehr', 'Sonstiges'];
const DEFAULT_EXPENSE_CATS = [
  'Wohnen & Nebenkosten', 'Lebensmittel', 'Freizeit & Unterhaltung',
  'Gesundheit', 'Versicherungen', 'Unterhalt', 'KI-Apps',
  'Shoppen', 'Spenden', 'Fahrkosten'
];
const COLORS = ['#6ee7b7', '#f87171', '#fbbf24', '#60a5fa', '#c084fc', '#fb923c', '#34d399', '#f472b6', '#a78bfa', '#38bdf8'];

const monthOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const thisMonth = () => monthOf(new Date());

let entries = await store.get('entries', []);
let incomeCats = await store.get('income_cats', DEFAULT_INCOME_CATS);
let expenseCats = await store.get('expense_cats', DEFAULT_EXPENSE_CATS);
let currentMonth = await store.get('month', thisMonth());
if (!/^\d{4}-\d{2}$/.test(String(currentMonth))) currentMonth = thisMonth();

async function save(name, value) {
  try {
    await store.set(name, value);
    return true;
  } catch (error) {
    toast(error instanceof StorageError ? error.message : 'Speichern fehlgeschlagen.', 6000);
    return false;
  }
}

// ── 2. Rechnen ──────────────────────────────────────────────
const sameId = (a, b) => String(a) === String(b);
const sum = list => list.reduce((total, entry) => total + entry.amount, 0);
const fmt = value => value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const newId = () => crypto.randomUUID();

/** Legt für einen Monat die Kopien aller Fixposten an. Gibt true zurück, wenn etwas dazukam. */
function applyFixedToMonth(month) {
  let changed = false;
  for (const fixed of entries.filter(entry => entry.fixed)) {
    if (fixed.date && month < fixed.date.slice(0, 7)) continue;      // erst ab dem Startmonat
    if (entries.some(entry => entry.month === month && sameId(entry.fixedRef, fixed.id))) continue;
    let date = null;
    if (fixed.date) {
      const [year, monthNumber] = month.split('-').map(Number);
      const lastDay = new Date(year, monthNumber, 0).getDate();     // letzter Tag des Monats
      const day = Math.min(Number(fixed.date.split('-')[2]), lastDay);
      date = `${month}-${String(day).padStart(2, '0')}`;
    }
    entries.push({
      id: newId(), name: fixed.name, amount: fixed.amount, type: fixed.type,
      category: fixed.category, fixed: false, fixedRef: fixed.id, month, date
    });
    changed = true;
  }
  return changed;
}

/** Füllt alle Monate vom ersten Fixposten bis zum gewählten Monat. */
function ensureMonthsPopulated() {
  const starts = entries.filter(entry => entry.fixed && entry.date).map(entry => entry.date.slice(0, 7)).sort();
  let changed = applyFixedToMonth(currentMonth);
  if (!starts.length) return changed;
  let [year, month] = starts[0].split('-').map(Number);
  const [endYear, endMonth] = currentMonth.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    if (applyFixedToMonth(`${year}-${String(month).padStart(2, '0')}`)) changed = true;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return changed;
}

const monthEntries = (month = currentMonth) => entries.filter(entry => !entry.fixed && entry.month === month);
const totalIncome = () => sum(monthEntries().filter(entry => entry.type === 'income'));
const totalExpense = () => sum(monthEntries().filter(entry => entry.type === 'expense'));

/** Saldo aller Monate vor dem gewählten Monat. */
function carryOver() {
  return entries
    .filter(entry => !entry.fixed && entry.month && entry.month < currentMonth)
    .reduce((total, entry) => total + (entry.type === 'income' ? entry.amount : -entry.amount), 0);
}

// ── 3. Anzeige ──────────────────────────────────────────────
function buildMonthOptions() {
  const select = $('monthSelect');
  select.replaceChildren();
  const now = new Date();
  const months = [];
  for (let offset = -3; offset <= 2; offset++) months.push(monthOf(new Date(now.getFullYear(), now.getMonth() + offset, 1)));
  if (!months.includes(currentMonth)) months.push(currentMonth);
  for (const value of months.sort()) {
    const [year, month] = value.split('-').map(Number);
    const option = el('option', null, new Date(year, month - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
    option.value = value;
    option.selected = value === currentMonth;
    select.appendChild(option);
  }
}

function renderHeader() {
  const income = totalIncome();
  const expense = totalExpense();
  const carry = carryOver();
  const available = income - expense + carry;
  $('hdrIncome').textContent = fmt(income);
  $('hdrExpense').textContent = fmt(expense);
  $('hdrBalance').textContent = fmt(available);
  $('hdrBalanceCard').classList.toggle('is-negative', available < 0);
  const row = $('carryRow');
  row.hidden = carry === 0;
  row.textContent = carry === 0 ? '' : `Übertrag aus Vormonaten: ${carry > 0 ? '+' : ''}${fmt(carry)}`;
}

let donut = null;
function renderOverview() {
  const income = totalIncome();
  const expense = totalExpense();
  const rows = $('summaryRows');
  rows.replaceChildren();
  for (const [label, value, className] of [
    ['Gesamteinnahmen', income, 'is-income'],
    ['Gesamtausgaben', expense, 'is-expense'],
    ['Verfügbar (ohne Übertrag)', income - expense, income - expense >= 0 ? '' : 'is-expense']
  ]) {
    rows.append(el('dt', null, label), el('dd', className, fmt(value)));
  }

  const expenses = monthEntries().filter(entry => entry.type === 'expense');
  const totals = [];
  const known = new Set(expenseCats);
  for (const category of expenseCats) {
    const total = sum(expenses.filter(entry => entry.category === category));
    if (total > 0) totals.push([category, total]);
  }
  const other = sum(expenses.filter(entry => !known.has(entry.category)));   // gelöschte Kategorien
  if (other > 0) totals.push(['Ohne Kategorie', other]);

  const total = totals.reduce((all, [, value]) => all + value, 0);
  $('donutTotal').textContent = fmt(total);

  if (donut) { donut.destroy(); donut = null; }
  const legend = $('chartLegend');
  legend.replaceChildren();
  if (!totals.length) {
    legend.append(el('li', 'muted', 'Noch keine Ausgaben in diesem Monat.'));
    return;
  }
  const colors = totals.map((_, index) => COLORS[index % COLORS.length]);
  donut = new Chart($('donutChart'), {
    type: 'doughnut',
    data: { labels: totals.map(([name]) => name), datasets: [{ data: totals.map(([, value]) => value), backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
    options: {
      responsive: false,
      cutout: '72%',
      animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => `${item.label}: ${fmt(item.raw)}` } } }
    }
  });
  totals.forEach(([name, value], index) => {
    const item = el('li');
    const dot = el('span', 'legend__dot');
    dot.style.background = colors[index];              // per JavaScript gesetzt, von der CSP erlaubt
    item.append(dot, el('span', null, name), el('span', 'legend__pct', `${Math.round(value / total * 100)} %`));
    legend.append(item);
  });
}

function entryRow(entry, { sign, amountClass, meta, removeAttr }) {
  const row = el('div', 'entry');
  const info = el('div', 'entry__info');
  info.append(el('div', 'entry__name', entry.name));       // textContent: Eingaben werden nie als HTML gelesen
  if (meta) info.append(el('div', 'entry__meta', meta));
  const right = el('div', 'entry__right');
  right.append(el('div', `entry__amount ${amountClass}`, sign + fmt(entry.amount)));
  const remove = el('button', 'icon-btn', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', `${entry.name} löschen`);
  remove.dataset[removeAttr] = String(entry.id);
  right.append(remove);
  row.append(info, right);
  return row;
}

function renderEntryList(type, target, categories, emptyText) {
  const isIncome = type === 'income';
  const box = $(target);
  box.replaceChildren();
  // Wie in der alten App: Hier stehen nur einmalige Einträge. Fixposten stehen unter "Fix".
  const items = monthEntries()
    .filter(entry => entry.type === type && !entry.fixedRef)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!items.length) { box.append(el('div', 'empty', emptyText)); return; }

  const groups = categories.map(category => [category, items.filter(entry => entry.category === category)]);
  const rest = items.filter(entry => !categories.includes(entry.category));
  if (rest.length) groups.push(['Ohne Kategorie', rest]);

  for (const [category, list] of groups) {
    if (!list.length) continue;
    const group = el('div', 'group');
    const head = el('div', 'group__head');
    head.append(el('span', null, category), el('span', `group__total ${isIncome ? 'is-income' : 'is-expense'}`, fmt(sum(list))));
    group.append(head);
    for (const entry of list) {
      group.append(entryRow(entry, {
        sign: isIncome ? '+' : '−',
        amountClass: isIncome ? 'is-income' : 'is-expense',
        meta: fmtDate(entry.date),
        removeAttr: 'removeEntry'
      }));
    }
    box.append(group);
  }
}

function renderFixedList() {
  const box = $('fixedList');
  box.replaceChildren();
  const fixed = entries.filter(entry => entry.fixed);
  if (!fixed.length) { box.append(el('div', 'empty', 'Noch keine Fixposten erfasst.')); return; }
  for (const [type, title] of [['income', 'Fixeinnahmen'], ['expense', 'Fixausgaben']]) {
    const list = fixed.filter(entry => entry.type === type);
    if (!list.length) continue;
    const isIncome = type === 'income';
    const group = el('div', 'group');
    const head = el('div', 'group__head');
    head.append(el('span', null, title), el('span', `group__total ${isIncome ? 'is-income' : 'is-expense'}`, fmt(sum(list))));
    group.append(head);
    for (const entry of list) {
      const day = entry.date ? ` · jeden ${Number(entry.date.split('-')[2])}.` : '';
      group.append(entryRow(entry, {
        sign: isIncome ? '+' : '−',
        amountClass: isIncome ? 'is-income' : 'is-expense',
        meta: entry.category + day,
        removeAttr: 'removeFixed'
      }));
    }
    box.append(group);
  }
}

function renderCategoryList(target, categories, defaults, type) {
  const list = $(target);
  list.replaceChildren();
  for (const category of categories) {
    const item = el('li', 'list__item');
    const name = el('span', 'list__text', category);
    const isDefault = defaults.includes(category);
    if (isDefault) name.append(el('span', 'tag', 'Standard'));
    const remove = el('button', 'icon-btn', '✕');
    remove.type = 'button';
    remove.disabled = isDefault;
    remove.setAttribute('aria-label', `Kategorie ${category} löschen`);
    remove.dataset.removeCat = category;
    remove.dataset.catType = type;
    item.append(name, remove);
    list.append(item);
  }
}

const STATUS_TEXT = {
  ok: 'in Ordnung', fresh: 'neu angelegt', legacy: 'alte Daten übernommen', migrated: 'auf neue Datenversion umgestellt',
  newer: 'Daten sind neuer als die App (nur lesen)', locked: 'gesperrt', 'migration-failed': 'Umstellung fehlgeschlagen (nur lesen)'
};
const formatStamp = iso => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

async function renderSettings() {
  const updates = await updatesReady;
  const meta = store.getMeta();
  $('factVersion').textContent = getVersion();
  $('factSw').textContent = updates.supported ? 'aktiv' : 'nicht verfügbar';
  $('factInstalled').textContent = isStandalone() ? 'ja' : 'nein, läuft im Browser';
  $('factStatus').textContent = STATUS_TEXT[store.status] || store.status;
  $('backupInfo').textContent = meta.lastBackupAt ? `Letztes Backup: ${formatStamp(meta.lastBackupAt)}` : 'Noch kein Backup erstellt.';
  $('undoRow').hidden = !(await store.restorePointInfo());
  $('securityCard').hidden = !vault;
  const problem = $('problemInfo');
  problem.hidden = store.problems.length === 0;
  if (store.problems.length) problem.textContent = `Hinweis: ${store.problems.length} Problem(e) beim Lesen der Daten. Die Originale wurden gesichert und nicht überschrieben.`;
}

function render() {
  renderHeader();
  renderOverview();
  renderEntryList('income', 'incomeList', incomeCats, 'Noch keine einmaligen Einnahmen in diesem Monat.');
  renderEntryList('expense', 'expenseList', expenseCats, 'Noch keine einmaligen Ausgaben in diesem Monat.');
  renderFixedList();
  renderCategoryList('expenseCatList', expenseCats, DEFAULT_EXPENSE_CATS, 'expense');
  renderCategoryList('incomeCatList', incomeCats, DEFAULT_INCOME_CATS, 'income');
}

function showView(name) {
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
  for (const button of document.querySelectorAll('[data-nav]')) {
    if (button.dataset.nav === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (name === 'more') renderSettings();
}

function confirmDialog({ title, text, yes = 'OK', danger = false }) {
  return new Promise(resolve => {
    const dialog = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yes;
    $('confirmYes').className = danger ? 'btn btn--danger' : 'btn';
    const finish = answer => {
      $('confirmYes').removeEventListener('click', onYes);
      $('confirmNo').removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onNo);
      dialog.close();
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    $('confirmYes').addEventListener('click', onYes);
    $('confirmNo').addEventListener('click', onNo);
    dialog.addEventListener('cancel', onNo);
    dialog.showModal();
  });
}

// ── 4. Start ────────────────────────────────────────────────
document.title = config.name;
$('appTitle').textContent = config.name;

if (!store.readOnly && ensureMonthsPopulated()) await save('entries', entries);
buildMonthOptions();
render();

// Ohne await: Die Bedienung soll sofort funktionieren.
const updatesReady = initUpdates({ canUpdateNow: () => !$('entryDialog').open });
initInstall({ button: $('installBtn'), store });
backup.remindIfDue({ onBackupRequested: exportBackup });
renderSettings();

// ── 5. Bedienung ────────────────────────────────────────────
document.querySelector('.app__nav').addEventListener('click', event => {
  const button = event.target.closest('[data-nav]');
  if (button) showView(button.dataset.nav);
});

$('monthSelect').addEventListener('change', async event => {
  currentMonth = event.target.value;
  const added = ensureMonthsPopulated();
  await save('month', currentMonth);
  if (added) await save('entries', entries);
  render();
});

// Neuer Eintrag
let entryType = 'income';
function setEntryType(type) {
  entryType = type;
  $('toggleIncome').setAttribute('aria-pressed', String(type === 'income'));
  $('toggleExpense').setAttribute('aria-pressed', String(type === 'expense'));
  const select = $('entryCategory');
  select.replaceChildren();
  for (const category of type === 'income' ? incomeCats : expenseCats) {
    const option = el('option', null, category);
    option.value = category;
    select.append(option);
  }
}

$('fabBtn').addEventListener('click', () => {
  $('entryForm').reset();
  $('entryError').textContent = '';
  const now = new Date();
  $('entryDate').value = `${monthOf(now)}-${String(now.getDate()).padStart(2, '0')}`;
  setEntryType('income');
  $('entryDialog').showModal();
  $('entryName').focus();
});
$('toggleIncome').addEventListener('click', () => setEntryType('income'));
$('toggleExpense').addEventListener('click', () => setEntryType('expense'));
$('entryCancel').addEventListener('click', () => $('entryDialog').close());

$('entryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('entryName').value.trim();
  const amount = Number($('entryAmount').value.trim().replace(/\./g, '').replace(',', '.'));   // "1.234,56" -> 1234.56
  const plain = Number($('entryAmount').value.trim().replace(',', '.'));                          // "1234.56" oder "12,5"
  const value = /,/.test($('entryAmount').value) ? amount : plain;
  if (!name) { $('entryError').textContent = 'Bitte eine Bezeichnung eingeben.'; return; }
  if (!Number.isFinite(value) || value <= 0) { $('entryError').textContent = 'Bitte einen gültigen Betrag eingeben, z. B. 12,50.'; return; }

  const rounded = Math.round(value * 100) / 100;
  const base = { id: newId(), name, amount: rounded, type: entryType, category: $('entryCategory').value, date: $('entryDate').value || null };
  const next = [...entries];
  if ($('entryFixed').checked) {
    next.push({ ...base, fixed: true, fixedRef: null, month: null });
    next.push({ ...base, id: newId(), fixed: false, fixedRef: base.id, month: currentMonth });
  } else {
    next.push({ ...base, fixed: false, fixedRef: null, month: currentMonth });
  }
  if (await save('entries', next)) {
    entries = next;
    $('entryDialog').close();
    render();
  }
});

// Löschen in den Listen
$('incomeList').addEventListener('click', onRemoveEntry);
$('expenseList').addEventListener('click', onRemoveEntry);
async function onRemoveEntry(event) {
  const id = event.target.dataset.removeEntry;
  if (!id) return;
  const next = entries.filter(entry => !sameId(entry.id, id));
  if (await save('entries', next)) { entries = next; render(); }
}

$('fixedList').addEventListener('click', async event => {
  const id = event.target.dataset.removeFixed;
  if (!id) return;
  const ok = await confirmDialog({
    title: 'Fixposten löschen?',
    text: 'Er wird nicht mehr automatisch übernommen. Auch seine Einträge in allen Monaten werden entfernt.',
    yes: 'Löschen', danger: true
  });
  if (!ok) return;
  const next = entries.filter(entry => !sameId(entry.id, id) && !sameId(entry.fixedRef, id));
  if (await save('entries', next)) { entries = next; render(); }
});

// Kategorien
async function addCategory(type, inputId) {
  const name = $(inputId).value.trim();
  if (!name) return;
  const list = type === 'expense' ? expenseCats : incomeCats;
  if (list.includes(name)) { toast('Diese Kategorie gibt es schon.'); return; }
  const next = [...list, name];
  if (!(await save(type === 'expense' ? 'expense_cats' : 'income_cats', next))) return;
  if (type === 'expense') expenseCats = next; else incomeCats = next;
  $(inputId).value = '';
  render();
}
$('expenseCatForm').addEventListener('submit', event => { event.preventDefault(); addCategory('expense', 'newExpenseCat'); });
$('incomeCatForm').addEventListener('submit', event => { event.preventDefault(); addCategory('income', 'newIncomeCat'); });

async function onRemoveCategory(event) {
  const name = event.target.dataset.removeCat;
  if (!name) return;
  const type = event.target.dataset.catType;
  if (entries.some(entry => entry.category === name)) {
    const ok = await confirmDialog({
      title: 'Kategorie löschen?',
      text: `„${name}“ wird noch verwendet. Die Einträge bleiben und erscheinen danach unter „Ohne Kategorie“.`,
      yes: 'Löschen', danger: true
    });
    if (!ok) return;
  }
  const next = (type === 'expense' ? expenseCats : incomeCats).filter(category => category !== name);
  if (!(await save(type === 'expense' ? 'expense_cats' : 'income_cats', next))) return;
  if (type === 'expense') expenseCats = next; else incomeCats = next;
  render();
}
$('expenseCatList').addEventListener('click', onRemoveCategory);
$('incomeCatList').addEventListener('click', onRemoveCategory);

// Backup
async function exportBackup() {
  let options = {};
  if (vault) {
    const password = await lockModule.askSecret({
      title: 'Backup-Passwort',
      text: 'Die Backup-Datei wird verschlüsselt. Dieses Passwort brauchst du, um sie später wieder einzuspielen. Schreib es dir auf.',
      confirm: true,
      okLabel: 'Backup erstellen'
    });
    if (password === null) return { cancelled: true };
    options = { codec: cryptoModule.backupCodec(password) };
  }
  const result = await backup.download(options);
  if (!result.cancelled) toast('Backup erstellt: ' + result.filename);
  renderSettings();
  return result;
}
$('exportBtn').addEventListener('click', exportBackup);
$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    let options = {};
    let check;
    try {
      check = await backup.inspect(text);
    } catch (problem) {
      if (!(problem instanceof BackupError) || problem.code !== 'codec') throw problem;
      const password = await lockModule.askSecret({ title: 'Backup-Passwort', text: 'Diese Backup-Datei ist verschlüsselt.', okLabel: 'Öffnen' });
      if (password === null) return;
      options = { codec: cryptoModule.backupCodec(password) };
      check = await backup.inspect(text, options);
    }
    const ok = await confirmDialog({
      title: 'Backup einspielen?',
      text: `${check.source} vom ${formatStamp(check.exported)}, ${check.entries} Einträge. Deine aktuellen Daten werden ersetzt. Der jetzige Stand wird vorher gesichert und lässt sich zurückholen.`,
      yes: 'Einspielen'
    });
    if (!ok) return;
    await backup.importText(text, options);
    location.reload();
  } catch (error) {
    const known = error instanceof BackupError || error instanceof StorageError;
    toast(known ? error.message : 'Import fehlgeschlagen.', 6000);
  }
});

$('undoBtn').addEventListener('click', async () => {
  const ok = await confirmDialog({ title: 'Rückgängig machen?', text: 'Der Stand vor dem letzten Import oder Löschen wird wiederhergestellt.', yes: 'Zurückholen' });
  if (!ok) return;
  await store.undoRestore();
  location.reload();
});

// Sicherheit
$('lockBtn').addEventListener('click', () => location.reload());
$('changeSecretBtn').addEventListener('click', async () => {
  const oldSecret = await lockModule.askSecret({ title: 'Bisheriges Passwort', okLabel: 'Weiter' });
  if (oldSecret === null) return;
  const newSecret = await lockModule.askSecret({
    title: 'Neues Passwort',
    text: 'Mindestens 8 Zeichen. Ein PIN aus mindestens 6 Ziffern geht auch, schützt aber schwächer.',
    confirm: true, okLabel: 'Ändern'
  });
  if (newSecret === null) return;
  try {
    await vault.changeSecret(oldSecret, newSecret);
    toast('Geändert. Ab jetzt gilt das neue Passwort.');
  } catch (problem) {
    toast((problem && problem.message) || 'Ändern fehlgeschlagen.', 6000);
  }
});

// App
$('checkUpdateBtn').addEventListener('click', async () => {
  const updates = await updatesReady;
  if (!updates.supported) { toast('Offline-Modus ist hier nicht verfügbar.'); return; }
  if (!(await updates.checkNow())) toast('Du hast die aktuelle Version.');
});

$('resetBtn').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Alle Daten löschen?',
    text: 'Gelöscht werden nur die Daten dieser App. Das Passwort bleibt. Der jetzige Stand lässt sich einmal zurückholen.',
    yes: 'Löschen', danger: true
  });
  if (!ok) return;
  await store.reset();
  location.reload();
});
