import { zValidator } from "@hono/zod-validator";
import type { SQL } from "drizzle-orm";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { chunk } from "es-toolkit/array";
import { Hono } from "hono";

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { ofetch } from "ofetch";
import { orderDetails, orders, payments, products } from "./db/schema";
import type { Item } from "./item-api-schema";
import { checkApiKey } from "./middlewares";
import { createTransactionApiRequestSchema } from "./schemas";

// Hono 用の型定義。Bindings に API_KEY 等を定義しておく
type Bindings = {
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
  CONSUMER_API_KEY: string;
  ITEM_API_URL: string;
  CONSUMER_SITE_BASE_URL: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_PUBLIC_JWK_CACHE_KEY: string;
  FIREBASE_PUBLIC_JWK_CACHE_KV: KVNamespace;
  FIREBASE_AUTH_EMULATOR_HOST: string;
};

const app = new Hono<{ Bindings: Bindings }>();

class UnknownProductError extends Error {
  constructor() {
    super("Unknown product");
    this.name = "UnknownProductError";
  }
}

// --- ユーティリティ関数 ---
// 重複時の更新カラムを生成
const buildConflictUpdateColumns = <
  T extends SQLiteTable,
  Q extends keyof T["_"]["columns"],
>(
  table: T,
  columns: Q[],
) => {
  const cls = getTableColumns(table);
  return columns.reduce(
    (acc, column) => {
      const colName = cls[column].name;
      acc[column] = sql.raw(`excluded.${colName}`);
      return acc;
    },
    {} as Record<Q, SQL>,
  );
};

// --- エンドポイント ---
app.post(
  "/api/transactions/",
  // APIキー認証
  checkApiKey,
  // リクエストボディのバリデーション
  zValidator("json", createTransactionApiRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
  }),
  async (c) => {
    // データベース接続
    const db = drizzle(c.env.DB);

    // InsertSchema を作成
    const productInsertSchema = createInsertSchema(products);
    const orderInsertSchema = createInsertSchema(orders);
    const orderSelectSchema = createSelectSchema(orders);
    const orderDetailInsertSchema = createInsertSchema(orderDetails);
    const paymentInsertSchema = createInsertSchema(payments);
    const paymentSelectSchema = createSelectSchema(payments);

    // 商品情報を取得
    const itemData = await ofetch<Item[]>(c.env.ITEM_API_URL, {
      responseType: "json",
    });

    // 商品情報をDBに登録
    const chunkedItemsParsed = chunk(
      itemData.map((item) =>
        productInsertSchema.parse({
          id: item.jan_code,
          name: item.name,
          price: item.price,
        }),
      ) as { id: string; name: string; price: number }[],
      10,
    );
    for (const itemsParsed of chunkedItemsParsed) {
      await db
        .insert(products)
        .values(itemsParsed)
        .onConflictDoUpdate({
          target: products.id,
          set: buildConflictUpdateColumns(products, ["name", "price"]),
        });
    }

    // リクエストデータの取得
    const requestData = c.req.valid("json");

    // 金額の計算
    try {
      const totalAmount = requestData.details.reduce((acc, detail) => {
        const item = itemData.find(
          (item) =>
            item.jan_code === detail.productId && item.price === detail.price,
        );
        if (item === undefined) {
          throw new UnknownProductError();
        }
        return acc + item.price * detail.quantity;
      }, 0);
      if (totalAmount !== requestData.totalAmount) {
        return c.json({ error: "Invalid totalAmount" }, 400);
      }
    } catch (e) {
      if (e instanceof UnknownProductError) {
        return c.json({ error: "Unknown product" }, 400);
      }
      throw e;
    }

    // トランザクションIDを生成
    const txnId = crypto.randomUUID();

    // トランザクション処理
    // DBのトランザクションは使用しない（D1未対応のため）
    // https://github.com/cloudflare/workers-sdk/issues/2733

    // Insert into orders table
    const order = orderSelectSchema.parse(
      (
        await db
          .insert(orders)
          .values(
            orderInsertSchema.parse({
              totalAmount: requestData.totalAmount,
              status: "pending",
            }) as { totalAmount: number; status: "pending" },
          )
          .returning()
      )[0],
    );

    // Insert into orderDetails table
    const chunkedDetailsParsed = chunk(
      requestData.details.map(
        (detail) =>
          orderDetailInsertSchema.parse({
            orderId: order.id,
            productId: detail.productId,
            name: detail.name,
            price: detail.price,
            quantity: detail.quantity,
          }) as {
            orderId: number;
            productId: string;
            name: string;
            price: number;
            quantity: number;
          },
      ),
      10,
    );
    for (const detailsParsed of chunkedDetailsParsed) {
      await db.insert(orderDetails).values(detailsParsed);
    }

    // Insert into payments table
    const payment = paymentSelectSchema.parse(
      (
        await db
          .insert(payments)
          .values(
            paymentInsertSchema.parse({
              orderId: order.id,
              transactionId: txnId,
              amount: requestData.totalAmount,
              method: requestData.paymentMethod,
              status:
                requestData.paymentMethod === "cash" ||
                requestData.totalAmount === 0
                  ? "completed"
                  : "pending",
            }) as {
              orderId: number;
              transactionId: string;
              amount: number;
              method: "cash" | "prepaid";
              status: "pending" | "completed";
            },
          )
          .returning()
      )[0],
    );

    if (payment.status === "completed") {
      // すぐに決済が完了している場合は、orderのstatusをcompletedに更新
      await db
        .update(orders)
        .set({ status: "completed" })
        .where(eq(orders.id, order.id));
    }

    // 決済URLを生成
    const payUrl =
      payment.status === "pending"
        ? `${c.env.CONSUMER_SITE_BASE_URL}/pay?txnId=${txnId}`
        : null;

    // JSON形式でレスポンス
    return c.json({
      transactionId: txnId,
      paymentMethod: payment.method,
      paymentStatus: payment.status,
      payUrl,
    });
  },
);

export default app;
