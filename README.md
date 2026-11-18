# Körjournal

PWA for registering trips: scan the odometer with the camera, check the address, save.
Exports a körjournal in `.xlsx` format based on Skatteverket's requirements. All data stays on the phone (IndexedDB).

## Development

```bash
npm install
npm run dev        # https://<your-pc-ip>:5173 – open on the phone on the same Wi-Fi (accept the certificate warning)
npm run build      # production build in dist/
npm run preview    # serve the build at http://localhost:4173
```

The camera and GPS need HTTPS (or localhost). That's why the dev server uses a self-signed certificate.

## Publish to GitHub Pages

1. Create a repo on GitHub (it can be private if your plan supports Pages for private repos; otherwise public).
2. Push this folder to the `main` branch.
3. In the repo: **Settings → Pages → Source: GitHub Actions**.
4. The workflow `.github/workflows/deploy.yml` builds and publishes on every push to `main`.
   The app ends up at `https://<username>.github.io/<repo>/`.

## Install on the phone

- **iPhone (Safari):** open the address → Share → *Add to Home Screen*.
- **Android (Chrome):** open the address → menu → *Install app*.

Allow the camera and location the first time.

## Usage

1. **Registrera**: the slider shows Start/Slut automatically (Slut when a trip is in progress).
2. Line up the box with the odometer → **Skanna**.
3. Check the reading and the address (edit if needed) → **Spara**.
   For Slut, the distance is calculated, and Ärende and Tjänst/Privat are prefilled from the previous trip.
4. **Resor**: list (tap to edit or delete), Excel export for a period, reg. number/driver, favourite places, backup.

**Favourite places:** tap "☆ Spara som favoritplats" in the confirmation sheet. Positions within 150 m then get that address straight away.

**Backup:** the data only lives on the phone. Use *Spara backup* now and then (saves a JSON file via the Share sheet).

## Technology

- Vite + TypeScript, `vite-plugin-pwa` (offline)
- OCR: Tesseract.js on the device (digits only). The engine is served from the app's own origin; the language data is fetched once from jsDelivr and cached.
- Addresses: Nominatim / OpenStreetMap (free, max 1 request/s)
- Excel: SheetJS
