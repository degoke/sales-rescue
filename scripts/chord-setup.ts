// Creates or updates the Sales Rescue teammate on Chord. Safe to re-run: it reuses what exists,
// republishes the skill only when skills/sales-rescue changed, and writes ids to .chord-state.json.
//   pnpm chord:setup            create/update + activate the production teammate
//   pnpm chord:setup --dev      a separate dev teammate and MCP server (state in .chord-state.dev.json)
//   pnpm chord:setup --pause    pause the teammate (stops replying); add --dev for the dev one
//   pnpm chord:setup --move     allow the production MCP server to point at a new URL
import { loadEnv } from '../src/config.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// CHORD_TEAMMATE_ID isn't required here: this script is what creates the teammate.
const env = loadEnv(['CHORD_BASE_URL', 'CHORD_API_KEY', 'CHORD_WORKSPACE_ID', 'PUBLIC_BASE_URL', 'MCP_TOKEN']);
const BASE = env.CHORD_BASE_URL;
const KEY = env.CHORD_API_KEY;
const PUBLIC = env.PUBLIC_BASE_URL;
const MCP_TOKEN = env.MCP_TOKEN;
const DEV = process.argv.includes('--dev');
// The dev instance has its own state, MCP server, teammate and creation key, so it never reuses or
// changes anything that belongs to the production teammate.
const INSTANCE = DEV
  ? { state: '.chord-state.dev.json', name: 'sales-rescue-dev', label: 'Flavorburst · Sales Rescue (dev)', lastName: 'Sales Rescue Dev' }
  : // Production was recreated as "flavorburst-sales-rescue": the WhatsApp simulator keeps a teammate's
    // name from when it first saw it, so the original teammate (created as a bag shop) kept its old name.
    { state: '.chord-state.json', name: 'flavorburst-sales-rescue', label: 'Flavorburst · Sales Rescue', lastName: 'Sales Rescue' };
const STATE = INSTANCE.state;
const LOG_DIR = 'docs/setup-log';
const SKILL_DIR = 'skills/sales-rescue';

type State = {
  workspaceId?: string;
  mcpServerId?: string;
  mcpUrl?: string;
  teammateId?: string;
  teammateEmail?: string;
  skillId?: string;
  skillHash?: string;
};
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
mkdirSync(LOG_DIR, { recursive: true });

async function chord(method: string, path: string, body?: unknown, { allowFail = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  const redacted = JSON.parse(
    JSON.stringify(body ?? null, (k, v) => (k === 'auth_token' ? '<redacted>' : k === 'files' ? `<${(v as any[]).length} files>` : v)),
  );
  writeFileSync(
    `${LOG_DIR}/${Date.now()}-${method}-${path.replace(/[^a-z0-9]+/gi, '_').slice(0, 70)}.json`,
    JSON.stringify({ method, path, status: res.status, request: redacted, response: json }, null, 2),
  );
  console.log(`${res.ok ? '✔' : '✘'} ${method} ${path} → ${res.status}`);
  if (!res.ok && !allowFail) {
    console.log(JSON.stringify(json, null, 2).slice(0, 2000));
    throw new Error(`${method} ${path} failed (${res.status})`);
  }
  return { ok: res.ok, status: res.status, json };
}

function skillFiles() {
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(SKILL_DIR, full), content: readFileSync(full, 'utf8') });
    }
  };
  walk(SKILL_DIR);
  return out;
}

if (process.argv.includes('--pause')) {
  await chord('POST', `/v1/teammates/${state.teammateId}/lifecycle`, { action: 'pause' });
  process.exit(0);
}

// 1. Workspace (from the environment)
const ws = env.CHORD_WORKSPACE_ID;
state.workspaceId = ws;
save();

// 2. MCP server: register disabled first. Chord's empty teammate assignment means "all servers"
//    (it fails open), so the teammate gets an explicit list before the server is enabled.
// The production teammate must not move to another URL by accident (for example the tunnel URL in .env).
if (!DEV && state.mcpUrl && state.mcpUrl !== `${PUBLIC}/mcp` && !process.argv.includes('--move')) {
  console.error(
    `The production MCP server points at ${state.mcpUrl}, not ${PUBLIC}/mcp. Use --dev for local testing, or --move to change it.`,
  );
  process.exit(1);
}
const mcpBody = { name: INSTANCE.name, url: `${PUBLIC}/mcp`, transport: 'streamable_http', auth_type: 'bearer', auth_token: MCP_TOKEN };
if (!state.mcpServerId) {
  // Recover from a lost state file instead of registering a duplicate server.
  const list = (await chord('GET', `/v1/workspaces/${ws}/mcp-servers`)).json;
  const servers: any[] = Array.isArray(list) ? list : (list?.servers ?? list?.mcp_servers ?? []);
  state.mcpServerId = servers.find((m) => m.name === mcpBody.name)?.id;
  if (state.mcpServerId) save();
}
if (state.mcpServerId) {
  await chord('PUT', `/v1/workspaces/${ws}/mcp-servers/${state.mcpServerId}`, mcpBody);
} else {
  const { json } = await chord('POST', `/v1/workspaces/${ws}/mcp-servers`, { ...mcpBody, enabled: false });
  state.mcpServerId = json.id;
}
state.mcpUrl = mcpBody.url;
save();

// 3. Teammate (created paused; idempotent via creation_request_id)
const NAMES = { first_name: 'Flavorburst', last_name: INSTANCE.lastName, display_name: INSTANCE.label };
if (!state.teammateId) {
  const all: any[] = (await chord('GET', '/v1/teammates')).json;
  const domain = all.find((t) => t.email?.includes('@'))?.email.split('@')[1] ?? 'example.com';
  const email = `${INSTANCE.name}@${domain}`;
  const existing = all.find((t) => t.email === email);
  if (existing) {
    state.teammateId = existing.id;
    state.teammateEmail = email;
    save();
  }
}
if (!state.teammateId) {
  const email =
    state.teammateEmail ??
    `${INSTANCE.name}@${(await chord('GET', '/v1/teammates')).json.find((t: any) => t.email?.includes('@'))?.email.split('@')[1] ?? 'example.com'}`;
  const { json } = await chord('POST', '/v1/teammates', {
    email,
    ...NAMES,
    role: 'sales',
    autonomy: 'collaborative',
    workspace_id: ws,
    mcp_server_ids: [state.mcpServerId],
    escalation_policy: 'escalate_to_human',
    start_paused: true,
    creation_request_id: `${INSTANCE.name}-v1`,
  });
  state.teammateId = json.id;
  state.teammateEmail = email;
  save();
}
const tm = state.teammateId;
// Keep the name in step with the business (the teammate predates the switch to Flavorburst).
await chord('PUT', `/v1/teammates/${tm}`, NAMES, { allowFail: true });
// Always (re)assert the explicit server list: an empty one would mean "all servers".
await chord('PUT', `/v1/teammates/${tm}`, { set_mcp_server_ids: [state.mcpServerId] });

// 4. No Chord connector tools (catalogue etc.): only our MCP tools.
await chord('PUT', `/v1/teammates/${tm}/tools`, { enabled_tool_types: [], unscoped: false });

// 5. Skill: API-created teammates start with skills disabled, so migrate first.
const skills = await chord('GET', `/v1/teammates/${tm}/skills`);
if (!skills.json.enabled) await chord('POST', `/v1/teammates/${tm}/skills/migrate`, {});
const files = skillFiles();
const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
const pkg = { name: 'sales-rescue', entrypoint: 'SKILL.md', files };
if (!state.skillId) {
  state.skillId = (await chord('GET', `/v1/teammates/${tm}/skills`)).json.skills?.find((s: any) => s.name === pkg.name)?.id;
  if (state.skillId) save();
}
if (!state.skillId) {
  const { json } = await chord('POST', `/v1/teammates/${tm}/skills`, { ...pkg, idempotency_key: `${INSTANCE.name}-create-${hash}` });
  state.skillId = json.id ?? json.skill?.id;
  save();
} else if (state.skillHash !== hash) {
  const cur = (await chord('GET', `/v1/teammates/${tm}/skills`)).json.skills.find((s: any) => s.id === state.skillId);
  await chord('PUT', `/v1/teammates/${tm}/skills/${state.skillId}/draft`, {
    ...pkg,
    expected_version: cur.version,
    idempotency_key: `${INSTANCE.name}-draft-${hash}-v${cur.version}`,
  });
}
if (state.skillHash !== hash) {
  const cur = (await chord('GET', `/v1/teammates/${tm}/skills`)).json.skills.find((s: any) => s.id === state.skillId);
  await chord('POST', `/v1/teammates/${tm}/skills/${state.skillId}/publish`, {
    expected_version: cur.version,
    summary: `skills/sales-rescue @ ${hash}`,
    idempotency_key: `${INSTANCE.name}-publish-${hash}-v${cur.version}`,
  });
  state.skillHash = hash;
  save();
}

// 6. Enable the server, then prove Chord can reach it and see the tools.
await chord('PUT', `/v1/workspaces/${ws}/mcp-servers/${state.mcpServerId}`, { enabled: true });
const health = await chord('POST', `/v1/workspaces/${ws}/mcp-servers/${state.mcpServerId}/health`, undefined, { allowFail: true });
const tools = await chord('POST', `/v1/workspaces/${ws}/mcp-servers/${state.mcpServerId}/tools`, undefined, { allowFail: true });

// 7. Activate only a teammate whose tools actually work.
const toolCount = Array.isArray(tools.json) ? tools.json.length : 0;
if (health.json?.status !== 'ok' || toolCount === 0) {
  console.error(
    `MCP server not healthy (status=${health.json?.status}, tools=${toolCount}). Is \`pnpm start\` running and PUBLIC_BASE_URL reachable? Not activating.`,
  );
  process.exit(1);
}
await chord('POST', `/v1/teammates/${tm}/lifecycle`, { action: 'activate' }, { allowFail: true });
const t = (await chord('GET', `/v1/teammates/${tm}`)).json;
const s = (await chord('GET', `/v1/teammates/${tm}/skills`)).json.skills.find((x: any) => x.id === state.skillId);

console.log(`
teammate   ${tm}  (${t.display_name}, ${t.lifecycle_state})
workspace  ${ws}
mcp        ${state.mcpServerId}  health=${health.json?.status} tools=${Array.isArray(tools.json) ? tools.json.length : '?'}
skill      ${state.skillId}  published v${s?.published_version} (${files.length} files, hash ${hash})
scope      mcp=${JSON.stringify(t.mcp_server_ids)} connector_tools_scoped=${t.connector_tools_scoped}
${DEV ? `Run the local service with CHORD_TEAMMATE_ID=${tm} so messages go through this dev teammate.` : 'Restart the server so it picks up the teammate id for message delivery.'}`);
if (t.lifecycle_state !== 'TEAMMATE_ACTIVE') {
  console.error(`Teammate is ${t.lifecycle_state}, not active. Activation may need a workspace admin.`);
  process.exit(1);
}
