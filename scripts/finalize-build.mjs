import { chmodSync, existsSync, copyFileSync } from "node:fs";
for (const path of ["dist/cli/main.js", "dist/server/main.js"])
  if (existsSync(path)) chmodSync(path, 0o755);
if (existsSync("src/recorder/schema.sql"))
  copyFileSync("src/recorder/schema.sql", "dist/recorder/schema.sql");
