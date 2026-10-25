import { OUTBOUND_TIMEOUT_MS } from '../lib/security.js';
import { DomainError } from '../lib/errors.js';

export type LogisticsQuote = { quote_id: string; zone: string; fee_kobo: number; service: string; eta_text: string; expires_at: string };
export type Delivery = {
  id: string;
  tracking_ref: string;
  order_ref: string;
  zone: string;
  status: string;
  eta_text: string;
  history: { status: string; at: string }[];
  updated_at: string;
};

export interface LogisticsClient {
  quote(zone: string): Promise<LogisticsQuote>;
  book(input: { quote_id: string; order_ref: string; recipient_name?: string; address?: string }): Promise<Delivery>;
  get(id: string): Promise<Delivery>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createLogisticsClient(opts: { baseUrl: string; apiKey: string; fetch?: FetchLike }): LogisticsClient {
  const apiKey = opts.apiKey;
  const f = opts.fetch ?? fetch;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (e) {
      throw new DomainError('logistics_unavailable', 'The delivery service could not be reached.', {}, { cause: String(e) });
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // fall through: an empty or non-JSON body is treated as a failure below
    }
    if (res.status === 422 && json?.error === 'unsupported_zone') {
      throw new DomainError('unsupported_zone', `We don't deliver to "${json.zone}" yet.`, { supported_zones: json.supported_zones });
    }
    if (!res.ok || !json) {
      throw new DomainError(
        'logistics_unavailable',
        'The delivery service returned an error.',
        { status: res.status },
        { body: json ?? text.slice(0, 200) },
      );
    }
    return json as T;
  }
  return {
    quote: (zone) => call('POST', '/delivery/quote', { zone }),
    book: (input) => call('POST', '/deliveries', input),
    get: (id) => call('GET', `/deliveries/${encodeURIComponent(id)}`),
  };
}
