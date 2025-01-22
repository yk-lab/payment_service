import type { FirebaseIdToken } from "firebase-auth-cloudflare-workers";

type Bindings = {
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
  CONSUMER_API_KEY: string;
  ITEM_API_URL: string;
  CONSUMER_SITE_BASE_URL: string;
  RESEND_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_PUBLIC_JWK_CACHE_KEY: string;
  FIREBASE_PUBLIC_JWK_CACHE_KV: KVNamespace;
  FIREBASE_AUTH_EMULATOR_HOST: string;
};

type Variables = {
  firebaseIdToken: FirebaseIdToken | undefined;
};
