import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ command, isPreview }) => ({
  // Relative base so the app works under any GitHub Pages repo path.
  base: './',
  plugins: [
    // Self-signed HTTPS in dev so the camera and GPS work when testing from a phone on the LAN.
    ...(command === 'serve' && !isPreview ? [basicSsl()] : []),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Körjournal',
        short_name: 'Körjournal',
        lang: 'sv',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#1f4e79',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        globIgnores: ['tesseract/**'],
        runtimeCaching: [
          {
            // OCR engine files (large), cached on first use.
            urlPattern: ({ url }) => url.pathname.includes('/tesseract/'),
            handler: 'CacheFirst',
            options: { cacheName: 'tesseract', expiration: { maxEntries: 10 } },
          },
          {
            // OCR language data from the CDN.
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net',
            handler: 'CacheFirst',
            options: { cacheName: 'tesseract-data', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
}));
