CREATE TABLE "intake_links" (
 "id" TEXT NOT NULL PRIMARY KEY, "church_id" TEXT NOT NULL, "branch_id" TEXT NOT NULL,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('members','visitors')), "token" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "intake_links_church_id_fkey" FOREIGN KEY ("church_id") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "intake_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "intake_links_token_key" ON "intake_links"("token");
CREATE UNIQUE INDEX "intake_links_church_id_branch_id_kind_key" ON "intake_links"("church_id","branch_id","kind");
CREATE TABLE "intake_submissions" (
 "id" TEXT NOT NULL PRIMARY KEY, "church_id" TEXT NOT NULL, "branch_id" TEXT NOT NULL,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('members','visitors')), "link_id" TEXT NOT NULL,
 "data" JSONB NOT NULL, "search_text" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','accepted')),
 "destination_id" TEXT, "reviewed_by" TEXT, "reviewed_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "intake_submissions_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "intake_links"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "intake_submissions_church_id_kind_status_branch_id_created_at_idx" ON "intake_submissions"("church_id","kind","status","branch_id","created_at");

-- Public access is mediated by token validation and bot protection in the API.
ALTER TABLE "intake_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intake_submissions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "intake_links", "intake_submissions" FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "intake_links", "intake_submissions" FROM anon; END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "intake_links", "intake_submissions" FROM authenticated; END IF;
END $$;
