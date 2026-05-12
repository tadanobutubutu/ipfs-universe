import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    {
      name: 'ncli-bridge',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith('/api/notion')) {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const type = url.searchParams.get('type');
            const query = url.searchParams.get('query') || '';
            const title = url.searchParams.get('title') || 'New Page';
            const content = url.searchParams.get('content') || '';
            const parentId = url.searchParams.get('parentId') || '35ea55d22f6f8113ba21fe4ae9afc623';

            try {
              let command = '';
              if (type === 'search') {
                command = `ncli search "${query}" --json`;
              } else if (type === 'create') {
                command = `ncli page create --title "${title}" --parent ${parentId} --json`;
              } else if (type === 'comment') {
                command = `ncli comment create ${parentId} "${content}" --json`;
              }

              if (command) {
                console.log(`Executing ncli command: ${command}`);
                const { stdout, stderr } = await execPromise(command);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, output: JSON.parse(stdout), error: stderr }));
              } else {
                res.writeHead(400);
                res.end('Invalid action type');
              }
            } catch (error: any) {
              console.error(`ncli bridge error: ${error.message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: error.message }));
            }
            return;
          }
          next();
        });
      }
    }
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext'
  }
});

