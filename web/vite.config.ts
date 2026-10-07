import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    // La API corre en el server (puerto 3000, solo localhost).
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
