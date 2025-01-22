import { Auth, WorkersKVStoreSingle } from "firebase-auth-cloudflare-workers";
import type { Context, Next } from "hono";

// --- ユーティリティ関数 ---
// 定数時間比較関数
const safeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

// --- ミドルウェア ---
// APIキー認証
export const checkApiKey = async (c: Context, next: Next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
};

// コンシューマーAPIキー認証
export const checkConsumerApiKey = async (c: Context, next: Next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.CONSUMER_API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
};

// 管理者APIキー認証
export const checkAdminApiKey = async (c: Context, next: Next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.ADMIN_API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
};

// Firebase JWT 認証
export const verifyFirebaseJWT = async (c: Context, next: Next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization) {
    return new Response(null, {
      status: 400,
    });
  }
  const jwt = authorization.replace(/Bearer\s+/i, "");
  const auth = Auth.getOrInitialize(
    c.env.PROJECT_ID,
    WorkersKVStoreSingle.getOrInitialize(
      c.env.PUBLIC_JWK_CACHE_KEY,
      c.env.PUBLIC_JWK_CACHE_KV,
    ),
  );

  // Firebase トークンを取得
  const firebaseToken = await auth.verifyIdToken(jwt, c.env);
  c.set("firebaseToken", firebaseToken);

  // 認証成功なら次の処理へ
  next();
};
