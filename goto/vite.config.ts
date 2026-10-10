import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Vite mode selects the target project: `vite --mode multigres` loads .env.multigres.local.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
