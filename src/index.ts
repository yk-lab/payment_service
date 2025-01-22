import { zValidator } from "@hono/zod-validator";
import type { SQL } from "drizzle-orm";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { chunk } from "es-toolkit/array";
import { Hono } from "hono";

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { ofetch } from "ofetch";
import {
  orderDetails,
  orders,
  payments,
  products,
  transactionHistory,
  users,
} from "./db/schema";
import type { Item } from "./item-api-schema";
import {
  checkAdminApiKey,
  checkApiKey,
  consumerCors,
  verifyFirebaseJWT,
} from "./middlewares";
import {
  adminPrepaidChargeApiRequestSchema,
  createTransactionApiRequestSchema,
} from "./schemas";
import type { Bindings, Variables } from "./type";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
// POST /api/orders/ 注文情報登録
app.post(
  "/api/orders/",
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
      transactionId: payment.transactionId,
      amount: payment.amount,
      method: payment.method,
      status: payment.status,
      payUrl,
    });
  },
);

// -- プリペイド課金 --
// PUT /api/admin/prepaid/charge/ プリペイドチャージ
app.put(
  "/api/admin/prepaid/charge/",
  // 管理者APIキー認証
  checkAdminApiKey,
  // リクエストボディのバリデーション
  zValidator("json", adminPrepaidChargeApiRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
  }),
  async (c) => {
    // データベース接続
    const db = drizzle(c.env.DB);

    // InsertSchema を作成
    const transactionHistoryInsertSchema =
      createInsertSchema(transactionHistory);
    const userSelectSchema = createSelectSchema(users);

    // トランザクションIDを生成
    const transactionId = crypto.randomUUID();

    // リクエストデータの取得
    const requestData = c.req.valid("json");

    // ユーザー情報を取得
    const user = await db
      .select()
      .from(users)
      .where(eq(users.uid, requestData.uid))
      .get();
    if (user === undefined) {
      return c.json({ error: "User not found" }, 404);
    }
    const userParsed = userSelectSchema.parse(user);

    // ユーザーの残高を更新
    const newBalance = userParsed.balance + requestData.amount;
    await db
      .update(users)
      .set({ balance: newBalance })
      .where(eq(users.id, user.id));

    // トランザクション履歴を登録
    await db.insert(transactionHistory).values(
      transactionHistoryInsertSchema.parse({
        transactionId,
        userId: user.id,
        amount: requestData.amount,
        transactionType: "charge",
      }) as {
        transactionId: string;
        userId: number;
        amount: number;
        transactionType: "charge";
      },
    );

    // JSON形式でレスポンス
    return c.json({
      transactionId,
      userId: userParsed.id,
      uid: userParsed.uid,
      amount: requestData.amount,
      balance: newBalance,
    });
  },
);

// GET /api/payments/:transactionId/ 決済情報取得
app.get(
  "/api/payments/:transactionId/",
  // APIキー認証
  checkApiKey,
  async (c) => {
    // データベース接続
    const db = drizzle(c.env.DB);

    // SelectSchema を作成
    const paymentSelectSchema = createSelectSchema(payments);

    // パスパラメータの取得
    const transactionId = c.req.param("transactionId");

    // 決済情報を取得
    const payment = paymentSelectSchema.parse(
      await db.select().from(payments).get({ transactionId }),
    );

    // JSON形式でレスポンス
    return c.json({
      transactionId: payment.transactionId,
      amount: payment.amount,
      method: payment.method,
      status: payment.status,
    });
  },
);

app.use("/api/profile/", consumerCors(["GET"]));

// GET /api/profile/ ユーザー情報取得
app.get(
  "/api/profile/",
  // Firebase JWT 認証
  verifyFirebaseJWT,
  async (c) => {
    // Firebase JWT からユーザーIDを取得
    const uid = c.var.firebaseIdToken?.uid;
    if (uid === undefined) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // データベース接続
    const db = drizzle(c.env.DB);

    // SelectSchema を作成
    const userSelectSchema = createSelectSchema(users);
    const userInsertSchema = createInsertSchema(users);

    // ユーザー情報を取得
    let _user = await db.select().from(users).where(eq(users.uid, uid)).get();
    if (_user === undefined) {
      // ユーザーが存在しない場合は新規作成
      _user = (
        await db
          .insert(users)
          .values(
            userInsertSchema.parse({ uid, balance: 0 }) as {
              uid: string;
              balance: number;
            },
          )
          .returning()
      )[0];
    }
    const user = userSelectSchema.parse(_user);

    // JSON形式でレスポンス
    return c.json({
      id: user.id,
      uid: user.uid,
      balance: user.balance,
    });
  },
);

app.use("/api/prepaid/pay/:transactionId/", consumerCors(["GET", "POST"]));

// GET /api/prepaid/pay/:transactionId/ 決済情報取得
app.get(
  "/api/prepaid/pay/:transactionId/",
  // Firebase JWT 認証
  verifyFirebaseJWT,
  async (c) => {
    // Firebase JWT からユーザーIDを取得
    const uid = c.var.firebaseIdToken?.uid;
    if (uid === undefined) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // データベース接続
    const db = drizzle(c.env.DB);

    // SelectSchema を作成
    const paymentSelectSchema = createSelectSchema(payments);

    // パスパラメータの取得
    const transactionId = c.req.param("transactionId");

    // 決済情報を取得
    const paymentData = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.transactionId, transactionId),
          eq(payments.method, "prepaid"),
        ),
      )
      .get();
    if (paymentData === undefined) {
      return c.json({ error: "Payment not found" }, 404);
    }
    const payment = paymentSelectSchema.parse(paymentData);

    // JSON形式でレスポンス
    return c.json({
      transactionId: payment.transactionId,
      amount: payment.amount,
      status: payment.status,
    });
  },
);

// POST /api/prepaid/pay/:transactionId/ 決済処理
app.post(
  "/api/prepaid/pay/:transactionId/",
  // Firebase JWT 認証
  verifyFirebaseJWT,
  async (c) => {
    // Firebase JWT からユーザーIDを取得
    const uid = c.var.firebaseIdToken?.uid;
    if (uid === undefined) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // データベース接続
    const db = drizzle(c.env.DB);

    // Schema を作成
    const paymentSelectSchema = createSelectSchema(payments);
    const userSelectSchema = createSelectSchema(users);
    const transactionHistoryInsertSchema =
      createInsertSchema(transactionHistory);

    // パスパラメータの取得
    const transactionId = c.req.param("transactionId");

    // 決済情報を取得
    const paymentData = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.transactionId, transactionId),
          eq(payments.method, "prepaid"),
        ),
      )
      .get();
    if (paymentData === undefined) {
      return c.json({ error: "Payment not found" }, 404);
    }
    const payment = paymentSelectSchema.parse(paymentData) as {
      transactionId: string;
      amount: number;
      status: "pending" | "completed" | "failed";
    };

    // 決済情報のステータスが pending でない場合はエラー
    if (payment.status !== "pending") {
      return c.json({ error: "Payment is not pending" }, 400);
    }

    // ユーザー情報を取得
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.uid, uid))
      .get();
    if (userData === undefined) {
      return c.json({ error: "User not found" }, 404);
    }
    const user = userSelectSchema.parse(userData);

    // ユーザーの残高を更新
    const newBalance = user.balance - payment.amount;
    if (newBalance < 0) {
      return c.json({ error: "Insufficient balance" }, 400);
    }
    await db
      .update(users)
      .set({ balance: newBalance })
      .where(eq(users.uid, uid));

    // 決済情報のステータスを completed に更新
    await db
      .update(payments)
      .set({ status: "completed", paidAt: new Date() })
      .where(eq(payments.transactionId, transactionId))
      .returning();

    const updatedPayment = paymentSelectSchema.parse(
      await db
        .select()
        .from(payments)
        .where(eq(payments.transactionId, transactionId))
        .get(),
    );

    // 取引履歴を登録
    await db.insert(transactionHistory).values(
      transactionHistoryInsertSchema.parse({
        transactionId,
        userId: user.id,
        amount: payment.amount,
        transactionType: "payment",
      }) as {
        transactionId: string;
        userId: number;
        amount: number;
        transactionType: "payment";
      },
    );

    // JSON形式でレスポンス
    return c.json({
      transactionId: updatedPayment.transactionId,
      amount: updatedPayment.amount,
      method: updatedPayment.method,
      status: updatedPayment.status,
    });
  },
);

export default app;
