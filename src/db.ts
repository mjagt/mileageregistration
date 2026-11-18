// Small promise wrapper around IndexedDB. All data stays on the device.

export type TripType = 'tjänst' | 'privat';

export interface Point {
  odo: number;
  time: string; // ISO timestamp
  address: string;
  lat?: number;
  lon?: number;
}

export interface Trip {
  id?: number;
  start: Point;
  end?: Point; // undefined while the trip is in progress
  purpose: string; // ärende / besökt företag eller person
  type: TripType;
}

export interface Place {
  id?: number;
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface Settings {
  regnr: string;
  driver: string;
  lastPurpose: string;
  lastType: TripType;
}

const DEFAULT_SETTINGS: Settings = { regnr: '', driver: '', lastPurpose: '', lastType: 'tjänst' };

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('korjournal', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('places', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Trips
export const allTrips = () => run<Trip[]>('trips', 'readonly', (s) => s.getAll());
export const putTrip = (t: Trip) => run<number>('trips', 'readwrite', (s) => s.put(t));
export const deleteTrip = (id: number) => run<void>('trips', 'readwrite', (s) => s.delete(id));

/** Trips sorted by start time, oldest first. */
export async function sortedTrips(): Promise<Trip[]> {
  const trips = await allTrips();
  return trips.sort((a, b) => a.start.time.localeCompare(b.start.time));
}

export async function openTrip(): Promise<Trip | undefined> {
  const trips = await sortedTrips();
  return trips.reverse().find((t) => !t.end);
}

/** Highest odometer reading registered so far (used to sanity-check OCR). */
export async function lastOdo(): Promise<number | undefined> {
  const trips = await sortedTrips();
  const last = trips[trips.length - 1];
  return last ? (last.end?.odo ?? last.start.odo) : undefined;
}

// Places
export const allPlaces = () => run<Place[]>('places', 'readonly', (s) => s.getAll());
export const putPlace = (p: Place) => run<number>('places', 'readwrite', (s) => s.put(p));
export const deletePlace = (id: number) => run<void>('places', 'readwrite', (s) => s.delete(id));

// Settings
export async function getSettings(): Promise<Settings> {
  const s = await run<Partial<Settings> | undefined>('meta', 'readonly', (st) => st.get('settings'));
  return { ...DEFAULT_SETTINGS, ...s };
}
// Settings writes are read-modify-write, so serialize them to avoid one change overwriting another.
let settingsQueue: Promise<unknown> = Promise.resolve();
export function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = settingsQueue.then(async () => {
    const s = { ...(await getSettings()), ...patch };
    await run('meta', 'readwrite', (st) => st.put(s, 'settings'));
  });
  settingsQueue = next.catch(() => {});
  return next;
}

// Backup / restore
export async function exportBackup(): Promise<string> {
  return JSON.stringify(
    { version: 1, trips: await allTrips(), places: await allPlaces(), settings: await getSettings() },
    null,
    2,
  );
}

export async function importBackup(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (!Array.isArray(data.trips) || !Array.isArray(data.places)) throw new Error('Ogiltig backupfil');
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['trips', 'places', 'meta'], 'readwrite');
    tx.objectStore('trips').clear();
    tx.objectStore('places').clear();
    for (const t of data.trips) tx.objectStore('trips').put(t);
    for (const p of data.places) tx.objectStore('places').put(p);
    if (data.settings) tx.objectStore('meta').put(data.settings, 'settings');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
