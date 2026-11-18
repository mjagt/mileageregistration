// Körjournal export to .xlsx in the layout Skatteverket asks for:
// regnr, period, odometer at period start/end, and per trip: date, start/end odometer,
// km, start/end address, ärende/besökt, tjänst/privat.
import type { Settings, Trip } from './db';

const pad = (n: number) => String(n).padStart(2, '0');
export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export async function buildXlsx(trips: Trip[], settings: Settings, from: string, to: string): Promise<Blob> {
  const XLSX = await import('xlsx');
  const done = trips.filter((t) => t.end).sort((a, b) => a.start.time.localeCompare(b.start.time));
  const km = (t: Trip) => t.end!.odo - t.start.odo;
  const sum = (type: string) => done.filter((t) => t.type === type).reduce((s, t) => s + km(t), 0);

  const rows: (string | number)[][] = [
    ['Körjournal'],
    ['Registreringsnummer', settings.regnr],
    ['Förare', settings.driver],
    ['Period', `${from} – ${to}`],
    ['Mätarställning vid periodens början', done[0]?.start.odo ?? ''],
    ['Mätarställning vid periodens slut', done[done.length - 1]?.end!.odo ?? ''],
    [],
    [
      'Datum',
      'Starttid',
      'Sluttid',
      'Mätarställning start',
      'Mätarställning slut',
      'Antal km',
      'Startadress',
      'Slutadress',
      'Ärende / besökt företag eller person',
      'Tjänst/Privat',
    ],
    ...done.map((t) => [
      fmtDate(t.start.time),
      fmtTime(t.start.time),
      fmtTime(t.end!.time),
      t.start.odo,
      t.end!.odo,
      km(t),
      t.start.address,
      t.end!.address,
      t.purpose,
      t.type === 'tjänst' ? 'Tjänst' : 'Privat',
    ]),
    [],
    ['Summa tjänsteresor (km)', '', '', '', '', sum('tjänst')],
    ['Summa privatresor (km)', '', '', '', '', sum('privat')],
    ['Totalt (km)', '', '', '', '', sum('tjänst') + sum('privat')],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [12, 9, 9, 12, 12, 9, 34, 34, 36, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Körjournal');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Opens the share sheet (iOS/Android) or falls back to a regular download. */
export async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
