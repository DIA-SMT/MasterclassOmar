import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const page = (name) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  server: { host: true },
  build: {
    rollupOptions: {
      input: { main: page('index'), pantalla: page('pantalla'), admin: page('admin') },
    },
  },
});
