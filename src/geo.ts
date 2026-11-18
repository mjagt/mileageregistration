// Position + address lookup. Uses Nominatim (OpenStreetMap): free, good Swedish address coverage.
import { allPlaces, type Place } from './db';

export interface Located {
  lat?: number;
  lon?: number;
  address: string;
  place?: Place; // set when the position matched a saved place
  error?: string;
}

const PLACE_RADIUS_M = 150;

export function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Positionering stöds inte'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 30000,
    });
  });
}

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function nearestPlace(lat: number, lon: number): Promise<Place | undefined> {
  let best: Place | undefined;
  let bestD = Infinity;
  for (const p of await allPlaces()) {
    const d = distanceM(lat, lon, p.lat, p.lon);
    if (d < bestD) [best, bestD] = [p, d];
  }
  return bestD <= PLACE_RADIUS_M ? best : undefined;
}

interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  footway?: string;
  house_number?: string;
  postcode?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  suburb?: string;
  municipality?: string;
}

function formatAddress(a: NominatimAddress, fallback: string): string {
  const street = a.road ?? a.pedestrian ?? a.footway;
  const line1 = street ? [street, a.house_number].filter(Boolean).join(' ') : '';
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.municipality;
  const line2 = [a.postcode, city].filter(Boolean).join(' ');
  return [line1, line2].filter(Boolean).join(', ') || fallback;
}

let lastCall = 0;

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  // Nominatim usage policy: max 1 request per second.
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18` +
    `&accept-language=sv&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Adressuppslag misslyckades (${res.status})`);
  const data = await res.json();
  return formatAddress(data.address ?? {}, data.display_name ?? '');
}

/** Gets the current position and resolves it to a saved place or a street address. Never throws. */
export async function locate(): Promise<Located> {
  let pos: GeolocationPosition;
  try {
    pos = await getPosition();
  } catch (e) {
    const err = e as GeolocationPositionError;
    const msg = err.code === 1 ? 'Platsåtkomst nekad' : 'Kunde inte hämta position';
    return { address: '', error: msg };
  }
  const { latitude: lat, longitude: lon } = pos.coords;
  const place = await nearestPlace(lat, lon);
  if (place) return { lat, lon, address: place.address, place };
  try {
    return { lat, lon, address: await reverseGeocode(lat, lon) };
  } catch {
    return { lat, lon, address: '', error: 'Kunde inte slå upp adress (ingen uppkoppling?)' };
  }
}
