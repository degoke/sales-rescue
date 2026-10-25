import type { Sql } from './db/client.js';
import type { LogisticsClient } from './logistics/client.js';
import type { PaystackClient } from './payments/paystack.js';
import type { ChordClient } from './chord/client.js';

/** Everything the domain needs from the outside world, injected so tests can fake time and providers. */
export interface Deps {
  sql: Sql;
  now: () => Date;
  logistics: LogisticsClient;
  paystack: PaystackClient | null; // null until PAYSTACK_SECRET_KEY is configured
  chord: ChordClient | null; // null in tests / when Chord isn't configured: notifications stay pull-only
  publicBaseUrl: string;
}
