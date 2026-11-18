import './style.css';
import { registerSW } from 'virtual:pwa-register';
import * as db from './db';
import type { Trip, TripType } from './db';
import { startCamera, stopCamera, captureGuide, cameraRunning } from './camera';
import { preloadOcr, readOdometer } from './ocr';
import { locate, type Located } from './geo';
import { buildXlsx, shareOrDownload, fmtDate, fmtTime } from './export';

// Apply app updates only when no dialog is open, so a reading being confirmed is never lost.
let needRefresh = false;
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    needRefresh = true;
    maybeUpdate();
  },
});
function maybeUpdate() {
  if (needRefresh && !document.querySelector('dialog[open]')) updateSW(true);
}
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', maybeUpdate));
navigator.storage?.persist?.();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');

type Mode = 'start' | 'end';
let mode: Mode = 'start';
let view: 'scan' | 'trips' = 'scan';

// ---------- helpers ----------

function toast(msg: string, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), ms);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const parseOdo = (s: string) => {
  const digits = s.replace(/\D/g, '');
  return digits ? Number(digits) : NaN;
};

const fmtKm = (n: number) => n.toLocaleString('sv-SE');

function setupSeg(el: HTMLElement, onChange?: (v: TripType) => void) {
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      setSeg(el, b.dataset.type as TripType);
      onChange?.(b.dataset.type as TripType);
    }),
  );
}
function setSeg(el: HTMLElement, value: TripType) {
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.type === value));
}
const getSeg = (el: HTMLElement) => (el.querySelector<HTMLButtonElement>('button.on')?.dataset.type ?? 'tjänst') as TripType;

// ---------- mode slider ----------

function setMode(m: Mode) {
  mode = m;
  const sw = $('mode');
  sw.classList.toggle('end', m === 'end');
  sw.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.mode === m)),
  );
}
$('mode').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
);

async function refreshStatus() {
  const open = await db.openTrip();
  setMode(open ? 'end' : 'start');
  $('status').textContent = open
    ? `Pågående resa sedan ${fmtTime(open.start.time)} från ${open.start.address || 'okänd adress'} (${fmtKm(open.start.odo)} km)`
    : 'Ingen pågående resa';
}

// ---------- location ----------

let loc: { at: number; promise: Promise<Located> } | null = null;

function refreshLocation(force = false): Promise<Located> {
  if (!force && loc && Date.now() - loc.at < 60_000) return loc.promise;
  const el = $('loc');
  el.textContent = 'Hämtar position…';
  const promise = locate().then((r) => {
    el.textContent = r.error
      ? `⚠️ ${r.error}`
      : `📍 ${r.place ? r.place.name + ' – ' : ''}${r.address || 'Okänd adress'}`;
    if (r.error && loc?.promise === promise) loc = null; // retry next time instead of caching the failure
    return r;
  });
  loc = { at: Date.now(), promise };
  return promise;
}

// ---------- camera ----------

async function ensureCamera() {
  if (view !== 'scan' || document.hidden || cameraRunning()) return;
  try {
    await startCamera(video);
    $('cam-retry').hidden = true;
  } catch {
    $('cam-retry').hidden = false;
  }
}
$('cam-retry').addEventListener('click', ensureCamera);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera(video);
  else if (view === 'scan') {
    ensureCamera();
    refreshLocation();
    refreshStatus();
  }
});

// ---------- tabs ----------

document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  b.addEventListener('click', () => showView(b.dataset.view as 'scan' | 'trips')),
);

function showView(v: 'scan' | 'trips') {
  view = v;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v),
  );
  $('view-scan').hidden = v !== 'scan';
  $('view-trips').hidden = v !== 'trips';
  if (v === 'scan') {
    ensureCamera();
    refreshLocation();
    refreshStatus();
  } else {
    stopCamera(video);
    renderTrips();
  }
}

// ---------- scan + confirm ----------

const confirmDlg = $<HTMLDialogElement>('confirm');
let pending: { located?: Located; open?: Trip; prevEnd?: number; addrTouched: boolean } | null = null;

$('scan').addEventListener('click', async () => {
  if (!cameraRunning() || !video.videoWidth) {
    toast('Kameran är inte igång');
    return;
  }
  const crop = captureGuide(video, $('guide'));
  const btn = $<HTMLButtonElement>('scan');
  btn.disabled = true;
  btn.textContent = 'Läser av…';
  try {
    const last = await db.lastOdo();
    const r = await readOdometer(crop, last);
    if (r.value === undefined) toast('Kunde inte läsa siffrorna – skriv in värdet');
    await openConfirm(r.value, crop.toDataURL('image/jpeg', 0.8));
  } catch (e) {
    console.error(e);
    toast('Avläsningen misslyckades – skriv in värdet');
    await openConfirm(undefined);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Skanna';
  }
});

$('manual').addEventListener('click', () => openConfirm(undefined));

async function openConfirm(value: number | undefined, img?: string) {
  const open = await db.openTrip();
  if (mode === 'end' && !open) {
    toast('Ingen pågående resa – registrera start först');
    setMode('start');
  }
  const settings = await db.getSettings();
  const trips = await db.sortedTrips();
  const prevEnd = [...trips].reverse().find((t) => t.end)?.end!.odo;

  pending = { open: mode === 'end' ? open : undefined, prevEnd, addrTouched: false };

  $('c-title').textContent = mode === 'start' ? 'Start av resa' : 'Slut på resa';
  const imgEl = $<HTMLImageElement>('c-img');
  imgEl.hidden = !img;
  if (img) imgEl.src = img;
  $<HTMLInputElement>('c-odo').value = value !== undefined ? String(value) : '';
  $('c-endfields').hidden = mode !== 'end';
  $<HTMLInputElement>('c-purpose').value = settings.lastPurpose;
  setSeg($('c-type'), settings.lastType);
  await fillPurposes();

  const addr = $<HTMLInputElement>('c-addr');
  addr.value = '';
  addr.placeholder = 'Hämtar adress…';
  $('c-place').hidden = true;
  updateConfirmChecks();

  confirmDlg.showModal();
  if (value === undefined) $<HTMLInputElement>('c-odo').focus();

  const located = await refreshLocation();
  if (!pending || !confirmDlg.open) return;
  pending.located = located;
  addr.placeholder = located.error ?? 'Skriv adress';
  if (!pending.addrTouched) addr.value = located.address;
  showPlaceBadge();
}

function showPlaceBadge() {
  const p = pending?.located?.place;
  const badge = $('c-place');
  badge.hidden = !p || $<HTMLInputElement>('c-addr').value !== p.address;
  if (p) badge.textContent = p.name;
  $('c-saveplace').hidden = !pending?.located?.lat || !!p;
}

$('c-addr').addEventListener('input', () => {
  if (pending) pending.addrTouched = true;
  showPlaceBadge();
});
$('c-odo').addEventListener('input', updateConfirmChecks);

function updateConfirmChecks() {
  const odo = parseOdo($<HTMLInputElement>('c-odo').value);
  const warn = $('c-warn');
  const msgs: string[] = [];
  const save = $<HTMLButtonElement>('c-save');
  save.disabled = false;
  if (!pending || isNaN(odo)) {
    warn.hidden = true;
    $('c-km').textContent = '';
    return;
  }
  if (mode === 'end' && pending.open) {
    const km = odo - pending.open.start.odo;
    $('c-km').textContent = `Körsträcka: ${fmtKm(km)} km (start ${fmtKm(pending.open.start.odo)})`;
    if (km < 0) {
      msgs.push('Lägre än startvärdet – kontrollera avläsningen.');
      save.disabled = true;
    } else if (km > 1500) msgs.push('Ovanligt lång resa – kontrollera avläsningen.');
  }
  if (mode === 'start' && pending.prevEnd !== undefined) {
    const gap = odo - pending.prevEnd;
    if (gap < 0) msgs.push(`Lägre än förra resans slut (${fmtKm(pending.prevEnd)}) – kontrollera avläsningen.`);
    else if (gap > 0) msgs.push(`${fmtKm(gap)} km sedan förra resans slut (${fmtKm(pending.prevEnd)}) är inte registrerade.`);
  }
  warn.textContent = msgs.join(' ');
  warn.hidden = !msgs.length;
}

$('c-saveplace').addEventListener('click', async () => {
  const l = pending?.located;
  if (!l?.lat || !l.lon) return;
  const name = prompt('Namn på platsen (t.ex. Hem, Kontoret):');
  if (!name?.trim()) return;
  const address = $<HTMLInputElement>('c-addr').value.trim();
  const place = { name: name.trim(), address, lat: l.lat, lon: l.lon };
  l.place = { ...place, id: await db.putPlace(place) };
  loc = null; // re-resolve next time so the place is used
  showPlaceBadge();
  toast(`Sparad som ”${place.name}”`);
});

$('c-cancel').addEventListener('click', () => {
  pending = null;
  confirmDlg.close();
});
setupSeg($('c-type'));

$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;
  const odo = parseOdo($<HTMLInputElement>('c-odo').value);
  if (isNaN(odo)) {
    toast('Ange mätarställning');
    return;
  }
  const point: db.Point = {
    odo,
    time: new Date().toISOString(),
    address: $<HTMLInputElement>('c-addr').value.trim(),
    lat: pending.located?.lat,
    lon: pending.located?.lon,
  };

  if (mode === 'start') {
    const open = await db.openTrip();
    if (open) {
      const ok = confirm(
        `Det finns redan en pågående resa (start ${fmtKm(open.start.odo)} km). Ta bort den och starta en ny?`,
      );
      if (!ok) return;
      await db.deleteTrip(open.id!);
    }
    const s = await db.getSettings();
    await db.putTrip({ start: point, purpose: s.lastPurpose, type: s.lastType });
    toast('Start sparad');
  } else {
    const open = pending.open;
    if (!open) return;
    const purpose = $<HTMLInputElement>('c-purpose').value.trim();
    const type = getSeg($('c-type'));
    await db.putTrip({ ...open, end: point, purpose, type });
    await db.saveSettings({ lastPurpose: purpose, lastType: type });
    toast(`Resa sparad: ${fmtKm(odo - open.start.odo)} km`);
  }
  pending = null;
  confirmDlg.close();
  await refreshStatus();
});

async function fillPurposes() {
  const trips = await db.allTrips();
  const uniq = [...new Set(trips.map((t) => t.purpose).filter(Boolean))];
  $('purposes').innerHTML = uniq.map((p) => `<option value="${esc(p)}">`).join('');
}

// ---------- trips view ----------

async function renderTrips() {
  const trips = (await db.sortedTrips()).reverse();
  $('trip-list').innerHTML = trips.length
    ? trips
        .map((t) => {
          const km = t.end ? `${fmtKm(t.end.odo - t.start.odo)} km` : '<span class="open">Pågår</span>';
          return `<li data-id="${t.id}">
            <div class="t-head"><span>${fmtDate(t.start.time)} ${fmtTime(t.start.time)}</span><span>${km}</span></div>
            <div class="t-addr">${esc(t.start.address || '–')} → ${esc(t.end?.address || '…')}</div>
            <div class="t-meta">${fmtKm(t.start.odo)}–${t.end ? fmtKm(t.end.odo) : ''} · ${t.type === 'tjänst' ? 'Tjänst' : 'Privat'}${t.purpose ? ' · ' + esc(t.purpose) : ''}</div>
          </li>`;
        })
        .join('')
    : '<li class="muted">Inga resor ännu</li>';

  const places = await db.allPlaces();
  $('place-list').innerHTML = places.length
    ? places
        .map((p) => `<li><span><b>${esc(p.name)}</b> – ${esc(p.address)}</span><button data-del="${p.id}">Ta bort</button></li>`)
        .join('')
    : '<li class="muted small">Inga favoritplatser. Spara en från bekräftelserutan efter en skanning.</li>';

  const s = await db.getSettings();
  $<HTMLInputElement>('set-regnr').value = s.regnr;
  $<HTMLInputElement>('set-driver').value = s.driver;
}

$('trip-list').addEventListener('click', async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
  if (li) openEdit(Number(li.dataset.id));
});

$('place-list').addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).dataset.del;
  if (id && confirm('Ta bort favoritplatsen?')) {
    await db.deletePlace(Number(id));
    loc = null;
    renderTrips();
  }
});

$('set-regnr').addEventListener('change', (e) =>
  db.saveSettings({ regnr: (e.target as HTMLInputElement).value.trim().toUpperCase() }),
);
$('set-driver').addEventListener('change', (e) => db.saveSettings({ driver: (e.target as HTMLInputElement).value.trim() }));

// ---------- edit trip ----------

const editDlg = $<HTMLDialogElement>('edit');
let editing: Trip | null = null;
setupSeg($('e-type'));

const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${fmtDate(iso)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const inp = (id: string) => $<HTMLInputElement>(id);

async function openEdit(id: number) {
  editing = (await db.allTrips()).find((t) => t.id === id) ?? null;
  if (!editing) return;
  inp('e-stime').value = toLocalInput(editing.start.time);
  inp('e-sodo').value = String(editing.start.odo);
  inp('e-saddr').value = editing.start.address;
  inp('e-etime').value = toLocalInput(editing.end?.time);
  inp('e-eodo').value = editing.end ? String(editing.end.odo) : '';
  inp('e-eaddr').value = editing.end?.address ?? '';
  inp('e-purpose').value = editing.purpose;
  setSeg($('e-type'), editing.type);
  $('e-warn').hidden = true;
  await fillPurposes();
  editDlg.showModal();
}

$('e-cancel').addEventListener('click', () => editDlg.close());
$('e-delete').addEventListener('click', async () => {
  if (!editing || !confirm('Ta bort resan?')) return;
  await db.deleteTrip(editing.id!);
  editDlg.close();
  renderTrips();
});

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  const warn = $('e-warn');
  const sodo = parseOdo(inp('e-sodo').value);
  const eodo = parseOdo(inp('e-eodo').value);
  const hasEnd = !isNaN(eodo);
  if (isNaN(sodo) || (hasEnd && eodo < sodo) || (hasEnd && !inp('e-etime').value)) {
    warn.textContent = 'Kontrollera mätarställningar och tider.';
    warn.hidden = false;
    return;
  }
  const trip: Trip = {
    ...editing,
    start: { ...editing.start, odo: sodo, time: new Date(inp('e-stime').value).toISOString(), address: inp('e-saddr').value.trim() },
    end: hasEnd
      ? {
          ...(editing.end ?? {}),
          odo: eodo,
          time: new Date(inp('e-etime').value).toISOString(),
          address: inp('e-eaddr').value.trim(),
        }
      : undefined,
    purpose: inp('e-purpose').value.trim(),
    type: getSeg($('e-type')),
  };
  await db.putTrip(trip);
  editDlg.close();
  renderTrips();
});

// ---------- export / backup ----------

const year = new Date().getFullYear();
inp('exp-from').value = `${year}-01-01`;
inp('exp-to').value = `${year}-12-31`;

$('export').addEventListener('click', async () => {
  const from = inp('exp-from').value;
  const to = inp('exp-to').value;
  const trips = (await db.allTrips()).filter((t) => {
    const d = fmtDate(t.start.time);
    return t.end && (!from || d >= from) && (!to || d <= to);
  });
  if (!trips.length) {
    toast('Inga avslutade resor i perioden');
    return;
  }
  await db.saveSettings({}); // wait for pending settings writes
  const settings = await db.getSettings();
  if (!settings.regnr) toast('Tips: fyll i registreringsnummer under Inställningar');
  const blob = await buildXlsx(trips, settings, from, to);
  await shareOrDownload(blob, `Korjournal_${settings.regnr || 'bil'}_${from}_${to}.xlsx`);
});

$('backup').addEventListener('click', async () => {
  const blob = new Blob([await db.exportBackup()], { type: 'application/json' });
  await shareOrDownload(blob, `korjournal-backup-${fmtDate(new Date().toISOString())}.json`);
});
$('restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file || !confirm('Ersätt alla resor och platser med innehållet i backupen?')) return;
  try {
    await db.importBackup(await file.text());
    toast('Backup inläst');
    renderTrips();
  } catch (err) {
    toast((err as Error).message);
  }
});

// ---------- start ----------

showView('scan');
preloadOcr().catch((e) => console.warn('OCR preload failed', e));
