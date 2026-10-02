import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: { charts: ['recharts'], react: ['react', 'react-dom', 'react-router-dom'] } } } },
  server: {
    port: 5173,
    proxy: {
      '^/api/': api,
      '^/v1/': api,
      '^/dev/': api, // trailing slash matters: '/developer' is a SPA route
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
