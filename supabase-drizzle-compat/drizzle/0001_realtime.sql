-- Expose compat_todos to Supabase Realtime postgres_changes.
ALTER PUBLICATION supabase_realtime ADD TABLE "compat_todos";--> statement-breakpoint
ALTER TABLE "compat_todos" REPLICA IDENTITY FULL;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "compat_todos" TO authenticated;
