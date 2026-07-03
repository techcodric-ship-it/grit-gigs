import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';

// Client review — seller rates the buyer after a completed order
export const clientReviewsTable = pgTable('client_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().unique(),     // one rating per order
  reviewerId: uuid('reviewer_id').notNull(),        // seller (who writes the review)
  revieweeId: uuid('reviewee_id').notNull(),        // buyer (who is being rated)
  rating: integer('rating').notNull(),              // 1–5
  reviewText: text('review_text').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
