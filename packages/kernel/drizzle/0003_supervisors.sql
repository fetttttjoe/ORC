CREATE TABLE "supervisors" (
	"project_id" text NOT NULL,
	"executor_id" text NOT NULL,
	"pid" integer NOT NULL,
	"host" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervisors_project_id_executor_id_pk" PRIMARY KEY("project_id","executor_id")
);