import { sql } from "drizzle-orm";
import { index, int, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  price: int("price").notNull(),
  createdAt: int("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: int("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const orders = sqliteTable("orders", {
  id: int("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  totalAmount: int("total_amount").notNull(),
  status: text("status", {
    enum: ["pending", "completed", "cancelled"],
  }).default("pending"),
  createdAt: int("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: int("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const orderDetails = sqliteTable(
  "order_details",
  {
    id: int("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    orderId: int("order_id")
      .notNull()
      .references(() => orders.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    name: text("name").notNull(),
    price: int("price").notNull(),
    quantity: int("quantity").notNull(),
    createdAt: int("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: int("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    uniqueOrderProduct: unique().on(table.orderId, table.productId),
  }),
);

export const payments = sqliteTable("payments", {
  id: int("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  orderId: int("order_id")
    .notNull()
    .references(() => orders.id),
  userId: int("user_id").references(() => users.id),
  transactionId: text("transaction_id").notNull().unique(),
  amount: int("amount").notNull(),
  method: text("method", {
    enum: ["cash", "prepaid"],
  }).notNull(),
  status: text("status", { enum: ["pending", "completed", "failed"] }).default(
    "pending",
  ),
  paidAt: int("paid_at", { mode: "timestamp" }),
  refundAt: int("refund_at", { mode: "timestamp" }),
  createdAt: int("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: int("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const users = sqliteTable("users", {
  id: int("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  uid: text("uid").notNull().unique(),
  balance: int("balance").notNull().default(0),
  createdAt: int("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: int("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const transactionHistory = sqliteTable(
  "transaction_history",
  {
    id: int("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    transactionId: text("transaction_id"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    amount: int("amount").notNull(),
    transactionType: text("transaction_type", {
      enum: ["charge", "payment", "refund"],
    }).notNull(),
    createdAt: int("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    transactionIdIdx: index("transaction_id_idx").on(table.transactionId),
  }),
);
