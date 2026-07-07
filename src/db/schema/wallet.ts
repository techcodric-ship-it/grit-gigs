import {
  pgTable,
  pgEnum,
  text,
  varchar,
  real,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const transactionTypeEnum = pgEnum("transaction_type", [
  "CREDIT_PURCHASE",
  "CREDIT_WITHDRAWAL",
  "SUBSCRIPTION",
  "SERVICE_PAYMENT",
  "SERVICE_EARNING",
  "COMMISSION",
  "REFUND",
]);

export const txnStatusEnum = pgEnum("txn_status", [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "REFUNDED",
]);

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

export const freelanceWalletsTable = pgTable("freelance_wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  balance: real("balance").default(0).notNull(),
  totalEarned: real("total_earned").default(0).notNull(),
  totalSpent: real("total_spent").default(0).notNull(),
  totalWithdrawn: real("total_withdrawn").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const withdrawalRequestsTable = pgTable("withdrawal_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletId: uuid("wallet_id")
    .notNull()
    .references(() => freelanceWalletsTable.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  amount: real("amount").notNull(),
  bankName: text("bank_name"),
  accountNumber: text("account_number"),
  ifscCode: text("ifsc_code"),
  accountName: text("account_name"),
  upiId: text("upi_id"),
  gatewayTxnId: text("gateway_txn_id"),
  status: withdrawalStatusEnum("status").default("PENDING").notNull(),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const transactionsTable = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id),
  type: transactionTypeEnum("type").notNull(),
  amount: real("amount").notNull(),
  currency: varchar("currency", { length: 10 }).default("INR").notNull(),
  status: txnStatusEnum("status").default("PENDING").notNull(),
  paymentMethod: varchar("payment_method", { length: 50 }),
  gatewayTxnId: text("gateway_txn_id"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FreelanceWallet = typeof freelanceWalletsTable.$inferSelect;
export type Transaction = typeof transactionsTable.$inferSelect;
