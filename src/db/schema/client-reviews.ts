import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { usersTable } from './users';
import { ordersTable } from './orders';

// Client review — seller rates the buyer after a completed order
export const clientReviewsTable = pgTable('client_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').unique().references(() => ordersTable.id, { onDelete: 'set null' }),
  reviewerId: uuid('reviewer_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  revieweeId: uuid('reviewee_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  reviewText: text('review_text').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
