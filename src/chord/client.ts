// The backend's own Chord API calls: delivering messages into conversations and finding threads.
import { OUTBOUND_TIMEOUT_MS } from '../lib/security.js';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChordClient {
  /** Queue a MESSAGE into an existing Chord thread. Chord requires a future time and fires on a sweep. */
  scheduleMessage(input: { conversationId: string; body: string; at: Date }): Promise<{ taskId: string }>;
  /** NOT_FOUND when Chord no longer has the task; null on a transient error (try later). */
  getTask(taskId: string): Promise<{ status: string; last_error: string | null } | null>;
  cancelTask(taskId: string): Promise<void>;
  /** Most recent thread with this teammate whose channel participant is `participant`; null if none. Throws on API errors. */
  findThread(participant: string): Promise<string | null>;
}

export function createChordClient(opts: {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  teammateId: string;
  fetch?: FetchLike;
}): ChordClient {
  const f = opts.fetch ?? fetch;
  async function call(method: string, path: string, body?: unknown) {
    const res = await f(`${opts.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok)
      throw Object.assign(new Error(`Chord ${method} ${path} → ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`), {
        status: res.status,
      });
    return json;
  }
  return {
    async scheduleMessage({ conversationId, body, at }) {
      const json = await call('POST', '/v1/scheduled-tasks', {
        task_type: 'MESSAGE',
        scheduled_at: at.toISOString(),
        workspace_id: opts.workspaceId,
        teammate_id: opts.teammateId,
        payload: { platform: 'DIRECT_LINE', conversation_id: conversationId, body },
      });
      if (!json?.id) throw new Error('Chord created no task id for the scheduled message');
      return { taskId: json.id };
    },
    async getTask(taskId) {
      try {
        const json = await call('GET', `/v1/scheduled-tasks/${taskId}`);
        return { status: json.status, last_error: json.last_error ?? null };
      } catch (e: any) {
        return e?.status === 404 ? { status: 'NOT_FOUND', last_error: 'task not found' } : null;
      }
    },
    async cancelTask(taskId) {
      await call('DELETE', `/v1/scheduled-tasks/${taskId}`).catch(() => undefined); // already fired or gone
    },
    async findThread(participant) {
      // Filter to our teammate server-side rather than paging through the whole workspace.
      const q = new URLSearchParams({ workspace_id: opts.workspaceId, agent_id: opts.teammateId, limit: '200' });
      const json = await call('GET', `/v1/threads?${q}`);
      const threads: any[] = json?.threads ?? (Array.isArray(json) ? json : []);
      const match = threads
        .filter((t) => t.teammate_id === opts.teammateId && t.channel_participant_id === participant)
        .sort((a, b) => Number(b.last_activity_at ?? b.updated_at ?? 0) - Number(a.last_activity_at ?? a.updated_at ?? 0));
      return match[0]?.id ?? null;
    },
  };
}
