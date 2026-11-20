import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isWatch = process.argv.includes('--watch');

function syncStaticAssets() {
  fs.mkdirSync(path.resolve('dist'), { recursive: true });
  fs.copyFileSync(
    path.resolve('src/webview/styles.css'),
    path.resolve('dist/webview.css'),
  );

  const kokoroWorkerSrc = path.resolve('src/voice/kokoro_worker.py');
  if (fs.existsSync(kokoroWorkerSrc)) {
    fs.copyFileSync(kokoroWorkerSrc, path.resolve('dist/kokoro_worker.py'));
    fs.mkdirSync(path.resolve('agent-plugin/mcp'), { recursive: true });
    fs.copyFileSync(kokoroWorkerSrc, path.resolve('agent-plugin/mcp/kokoro_worker.py'));
  }

  const setupKokoroSrc = path.resolve('scripts/setup-kokoro.mjs');
  if (fs.existsSync(setupKokoroSrc)) {
    fs.copyFileSync(setupKokoroSrc, path.resolve('dist/setup-kokoro.mjs'));
  }

  const builtMcp = path.resolve('dist/mcp-server.js');
  if (fs.existsSync(builtMcp)) {
    fs.mkdirSync(path.resolve('agent-plugin/mcp'), { recursive: true });
    fs.copyFileSync(builtMcp, path.resolve('agent-plugin/mcp/mcp-server.js'));
  }
}

const assetSyncPlugin = {
  name: 'sync-mindstream-assets',
  setup(build) {
    build.onEnd(() => {
      syncStaticAssets();
    });
  },
};

async function run() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    outfile: 'dist/webview.js',
    sourcemap: true,
    logLevel: 'info',
    plugins: [assetSyncPlugin],
  });

  const mcpCtx = await esbuild.context({
    entryPoints: ['src/mcp/mcpServer.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/mcp-server.js',
    sourcemap: true,
    logLevel: 'info',
    plugins: [assetSyncPlugin],
  });

  if (isWatch) {
    syncStaticAssets();
    fs.watch(path.resolve('src/webview/styles.css'), () => {
      try {
        syncStaticAssets();
        console.log('[MindStream] Synced updated webview.css');
      } catch (err) {
        console.error('[MindStream] Failed syncing assets:', err);
      }
    });
    await Promise.all([extensionCtx.watch(), webviewCtx.watch(), mcpCtx.watch()]);
    console.log('[MindStream] Watching extension, webview, and MCP server bundles...');
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild(), mcpCtx.rebuild()]);
    syncStaticAssets();
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      mcpCtx.dispose(),
    ]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
