/**
 * Static JSON file input (assignment §5, method 1).
 *
 *   npm run ingest:file -- ../samples/sample-batch.json [--url http://localhost:4000]
 *
 * Reads a JSON file containing one event or an array of events and submits it to the
 * running backend's POST /monitor endpoint, so file input goes through exactly the same
 * validation, detection, persistence and alerting path as HTTP input.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface CliArgs {
  file: string;
  url: string;
}

function parseArgs(argv: string[]): CliArgs {
  let file: string | undefined;
  let url = process.env.MONITOR_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') url = argv[++i] ?? url;
    else if (arg && !arg.startsWith('--')) file = arg;
  }
  if (!file) {
    console.error('Usage: npm run ingest:file -- <path/to/events.json> [--url http://localhost:4000]');
    process.exit(2);
  }
  return { file, url: url.replace(/\/$/, '') };
}

async function main(): Promise<void> {
  const { file, url } = parseArgs(process.argv.slice(2));
  // npm runs workspace scripts from backend/, so resolve relative paths from the caller's directory.
  const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);

  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    console.error(`Could not read JSON from ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const response = await fetch(`${url}/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Monitor-Source': 'file' },
    body: JSON.stringify(payload),
  }).catch((error: unknown) => {
    console.error(`Could not reach ${url}/monitor — is the backend running? (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  });

  const body = (await response.json().catch(() => null)) as { summary?: unknown; error?: unknown; results?: unknown } | null;
  console.log(`POST ${url}/monitor -> HTTP ${response.status}`);
  console.log(JSON.stringify(body?.summary ?? body?.error ?? body, null, 2));
  if (Array.isArray(body?.results)) {
    for (const r of body.results as Array<{ index: number; status: string; api_name?: string; anomalies?: Array<{ type: string; severity: string }>; errors?: unknown }>) {
      const detail = r.status === 'accepted'
        ? (r.anomalies?.length ? r.anomalies.map((a) => `${a.type}(${a.severity})`).join(', ') : 'healthy')
        : JSON.stringify(r.errors ?? r);
      console.log(`  [${r.index}] ${r.status.padEnd(8)} ${r.api_name ?? ''} ${detail}`);
    }
  }
  process.exit(response.ok ? 0 : 1);
}

void main();
