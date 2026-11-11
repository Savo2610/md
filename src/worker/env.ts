import type { Doc } from './doc';
import type { Registry } from './registry';
import type { Account } from './account';

export interface Env {
  DOC: DurableObjectNamespace<Doc>;
  REGISTRY: DurableObjectNamespace<Registry>;
  ACCOUNT: DurableObjectNamespace<Account>;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  CREATE_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
  TURNSTILE_SITEKEY?: string;
  /** OAuth-Client (Google Cloud Console), öffentlich. */
  GOOGLE_CLIENT_ID?: string;
  /** Nur lokal: "1" meldet auf localhost ohne Google als Testkonto an. */
  DEV_LOGIN?: string;
  // Secrets
  TOTP_SECRET?: string;
  SESSION_SECRET?: string;
  API_KEY?: string;
  TURNSTILE_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google-Konto (E-Mail), das ohne 2FA-Code auf /admin darf. */
  ADMIN_EMAIL?: string;
}

export const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('main'));
export const docStub = (env: Env, id: string) => env.DOC.get(env.DOC.idFromName(id));
export const accountStub = (env: Env, sub: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(`g:${sub}`));
