import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import {createRequire} from 'module';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

const require = createRequire(import.meta.url);

function pdfjsWorkerPlugin(): Plugin {
  const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');

  return {
    name: 'pdfjs-worker-static',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reqPath = (req.url || '').split('?')[0];
        if (reqPath === '/pdf.worker.min.mjs' || reqPath.endsWith('/pdf.worker.min.mjs')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(workerPath).pipe(res);
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'pdf.worker.min.mjs',
        source: fs.readFileSync(workerPath),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    base: process.env.ELECTRON_BUILD === 'true' ? './' : '/',
    plugins: [react(), tailwindcss(), pdfjsWorkerPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
