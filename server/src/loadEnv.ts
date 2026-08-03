/**
 * Must be imported first from `index.ts` so `.env` is applied before other modules load.
 * (Otherwise `dotenv.config()` at the bottom of `index.ts` runs after imports are evaluated.)
 */
import path from "node:path";
import dotenv from "dotenv";
import { projectRoot } from "./paths.js";

const envPath = path.join(projectRoot(), ".env");
const result = dotenv.config({ path: envPath });
if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
  console.warn("[enpply] dotenv:", result.error.message);
}
