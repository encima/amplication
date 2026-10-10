CREATE TABLE "compat_todos" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "compat_todos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid DEFAULT auth.uid() NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compat_todos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compat_todos" ADD CONSTRAINT "compat_todos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "compat_todos_select_own" ON "compat_todos" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("compat_todos"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "compat_todos_insert_own" ON "compat_todos" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("compat_todos"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "compat_todos_update_own" ON "compat_todos" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("compat_todos"."user_id" = (select auth.uid())) WITH CHECK ("compat_todos"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "compat_todos_delete_own" ON "compat_todos" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("compat_todos"."user_id" = (select auth.uid()));