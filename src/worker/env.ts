import type { Doc } from './doc';
import type { Registry } from './registry';

export interface Env {
  DOC: DurableObjectNamespace<Doc>;
  REGISTRY: DurableObjectNamespace<Registry>;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  CREATE_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
  TURNSTILE_SITEKEY?: string;
  // Secrets
  TOTP_SECRET?: string;
  SESSION_SECRET?: string;
  API_KEY?: string;
  TURNSTILE_SECRET?: string;
}

export const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('main'));
export const docStub = (env: Env, id: string) => env.DOC.get(env.DOC.idFromName(id));
