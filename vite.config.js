import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Phones only allow camera access on HTTPS pages, so the dev server uses a
// self-signed certificate. Set HTTP=1 to turn it off (e.g. for localhost-only use).
export default defineConfig({
  base: './',
  plugins: process.env.HTTP ? [] : [basicSsl()],
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
