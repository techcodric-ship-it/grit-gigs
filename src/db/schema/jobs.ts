import {
  pgTable,
  pgEnum,
  text,
  boolean,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const jobApplicationStatusEnum = pgEnum("job_application_status", [
  "PENDING",
  "REVIEWED",
  "ACCEPTED",
  "REJECTED",
]);

export const jobsTable = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location"),
  type: text("type").default("Full-time").notNull(),
  salaryRange: text("salary_range"),
  description: text("description").notNull(),
  skills: text("skills").array().default([]).notNull(),
  // Optional external URL where candidates can apply (e.g. LinkedIn, career page).
  link: text("link"),
  // Admin user who posted the job.
  postedById: uuid("posted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  // Admin can pause a job (hide from public listing) without deleting it.
  isActive: boolean("is_active").default(true).notNull(),
  applicationDeadline: timestamp("application_deadline"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobApplicationsTable = pgTable("job_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  applicantId: uuid("applicant_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  message: text("message"),
  status: jobApplicationStatusEnum("status").default("PENDING").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Job = typeof jobsTable.$inferSelect;
export type JobApplication = typeof jobApplicationsTable.$inferSelect;
