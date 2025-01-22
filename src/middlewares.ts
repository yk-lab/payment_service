import { Auth, WorkersKVStoreSingle } from "firebase-auth-cloudflare-workers";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { Variables } from "./type";

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
// コンシューマーCORS設定
export const consumerCors = (methods: string[]) =>
  cors({
    origin: "*",
    allowMethods: methods,
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Content-Length",
      "referer",
      "User-Agent",
      "sec-ch-ua",
      "sec-ch-ua-*",
    ],
    credentials: true,
  });

// APIキー認証
export const checkApiKey = createMiddleware(async (c, next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
});

// コンシューマーAPIキー認証
export const checkConsumerApiKey = createMiddleware(async (c, next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.CONSUMER_API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
});

// 管理者APIキー認証
export const checkAdminApiKey = createMiddleware(async (c, next) => {
  const apiKey = c.req.header("X-API-KEY") || "";
  const serverKey = c.env.ADMIN_API_KEY || "";

  // 定数時間比較関数で照合
  if (!safeCompare(apiKey, serverKey)) {
    return c.text("Unauthorized", 401);
  }

  // 認証成功なら次の処理へ
  await next();
});

// Firebase JWT 認証
export const verifyFirebaseJWT = createMiddleware<{ Variables: Variables }>(
  async (c: Context, next) => {
    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return new Response(null, {
        status: 400,
      });
    }
    const jwt = authorization.replace(/Bearer\s+/i, "");
    const auth = Auth.getOrInitialize(
      c.env.FIREBASE_PROJECT_ID,
      WorkersKVStoreSingle.getOrInitialize(
        c.env.FIREBASE_PUBLIC_JWK_CACHE_KEY,
        c.env.FIREBASE_PUBLIC_JWK_CACHE_KV,
      ),
    );

    // Firebase トークンを取得
    const firebaseIdToken = await auth.verifyIdToken(jwt);
    c.set("firebaseIdToken", firebaseIdToken);

    // 認証成功なら次の処理へ
    await next();
  },
);
