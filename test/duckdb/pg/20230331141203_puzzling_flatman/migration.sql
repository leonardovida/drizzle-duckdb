CREATE TABLE IF NOT EXISTS "duckdb_cols" (
	"id" integer PRIMARY KEY NOT NULL,
	-- "map_string" MAP (STRING, STRING) NOT NULL,
  "struct_string" STRUCT (name STRING, age INTEGER) NOT NULL,
);
