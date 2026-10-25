// Thin Paystack client (test mode). It reports exactly what Paystack said; the decision about
// whether an order is paid is made in merchant/orders.ts against our own expected values.
import { OUTBOUND_TIMEOUT_MS } from '../lib/security.js';
import { DomainError } from '../lib/errors.js';

export type PaystackTransaction = {
  status: string; // success | failed | abandoned | ongoing | pending | reversed | ...
  reference: string;
  amount: number; // kobo
  currency: string;
  gateway_response?: string;
  metadata?: any;
};

export interface PaystackClient {
  initialize(input: {
    email: string;
    amount_kobo: bigint;
    reference: string;
    order_ref: string;
    callback_url?: string;
  }): Promise<{ authorization_url: string; reference: string }>;
  /** Returns null when Paystack has no transaction with that reference (customer never opened the link). */
  verify(reference: string): Promise<PaystackTransaction | null>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createPaystackClient(opts: { secretKey: string; baseUrl: string; fetch?: FetchLike }): PaystackClient {
  if (!opts.secretKey.startsWith('sk_test_')) {
    throw new Error('Refusing to start: PAYSTACK_SECRET_KEY must be a test key (sk_test_…)');
  }
  const base = opts.baseUrl;
  const f = opts.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown, retries = 0): Promise<{ res: Response; json: any }> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.secretKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (e) {
      if (retries > 0) return retry();
      throw new DomainError(
        'payment_provider_unavailable',
        'Paystack could not be reached. Try again shortly.',
        { retryable: true },
        { cause: String(e) },
      );
    }
    if ((res.status >= 500 || res.status === 429) && retries > 0) return retry();
    const json: any = await res.json().catch(() => null);
    return { res, json };
    async function retry() {
      await new Promise((r) => setTimeout(r, 400));
      return call(method, path, body, retries - 1);
    }
  }

  return {
    async initialize({ email, amount_kobo, reference, order_ref, callback_url }) {
      const { res, json } = await call('POST', '/transaction/initialize', {
        email,
        amount: amount_kobo.toString(),
        currency: 'NGN',
        reference,
        callback_url,
        metadata: { order_ref },
      });
      if (!res.ok || !json?.status || !json.data?.authorization_url) {
        throw new DomainError(
          'payment_init_failed',
          'Paystack did not create a checkout link.',
          { http_status: res.status },
          { message: json?.message ?? null },
        );
      }
      return { authorization_url: json.data.authorization_url, reference: json.data.reference };
    },

    async verify(reference) {
      const { res, json } = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`, undefined, 2); // reads are safe to retry
      if (res.status === 404 || (res.status === 400 && /not found/i.test(json?.message ?? ''))) return null;
      if (!res.ok || !json?.status || !json.data) {
        throw new DomainError(
          'payment_verify_failed',
          'Paystack verification did not return a result. Try again shortly.',
          { http_status: res.status, retryable: res.status >= 500 || res.status === 429 },
          { message: json?.message ?? null },
        );
      }
      const d = json.data;
      return {
        status: d.status,
        reference: d.reference,
        amount: Number(d.amount),
        currency: d.currency,
        gateway_response: d.gateway_response,
        metadata: d.metadata,
      };
    },
  };
}
