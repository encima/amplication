// Drizzle mirror of the GoTo tables (source of truth: supabase/migrations).
import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'extensions.citext' });

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  username: citext('username'),
  displayName: text('display_name'),
  avatarPath: text('avatar_path'),
  isAnonymous: boolean('is_anonymous').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const links = pgTable('links', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  ownerId: uuid('owner_id').notNull().default(sql`auth.uid()`),
  slug: citext('slug').notNull(),
  url: text('url').notNull(),
  title: text('title'),
  isPublic: boolean('is_public').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  iconPath: text('icon_path'),
  clickCount: bigint('click_count', { mode: 'number' }).notNull().default(0),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastStatus: integer('last_status'),
  lastCheckRequestId: bigint('last_check_request_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clicks = pgTable('clicks', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  linkId: bigint('link_id', { mode: 'number' }).notNull(),
  clickedAt: timestamp('clicked_at', { withTimezone: true }).notNull().defaultNow(),
  referrer: text('referrer'),
  userAgent: text('user_agent'),
});

export const linkStatsDaily = pgTable('link_stats_daily', {
  linkId: bigint('link_id', { mode: 'number' }).notNull(),
  day: date('day').notNull(),
  clicks: bigint('clicks', { mode: 'number' }).notNull(),
});
