import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

async function copyDirRecursive(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const srcPluginDir = path.join(repoRoot, 'agent-plugin');
  const mcpBundle = path.join(srcPluginDir, 'mcp', 'mcp-server.js');

  try {
    await fs.access(mcpBundle);
  } catch {
    console.error('[MindStream] Error: agent-plugin/mcp/mcp-server.js not found. Run `npm run build` first.');
    process.exit(1);
  }

  const destPluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'mindstream');
  await copyDirRecursive(srcPluginDir, destPluginDir);

  console.log(`[MindStream] Installed global Antigravity plugin to:\n  ${destPluginDir}`);
  console.log('\n[MindStream] Installed files:');
  console.log('  - plugin.json');
  console.log('  - mcp_config.json (registers stdio MCP server `mindstream-driver`)');
  console.log('  - mcp/mcp-server.js');
  console.log('  - mcp/kokoro_worker.py (local Kokoro-82M FR/EN voice worker)');
  console.log('  - rules/AGENTS.md (always-on `/MindStream` trigger)');
  console.log('  - skills/mindstream/SKILL.md');
  console.log('  - assets/logo.svg');
  console.log('\n[MindStream] Optional VS Code Copilot MCP snippet (.vscode/mcp.json):');
  console.log(
    JSON.stringify(
      {
        servers: {
          'mindstream-driver': {
            type: 'stdio',
            command: 'node',
            args: [path.join(destPluginDir, 'mcp', 'mcp-server.js')],
          },
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[MindStream] Failed installing plugin:', err);
  process.exit(1);
});
