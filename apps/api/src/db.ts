import { Pool } from "pg";
import { DATABASE_URL } from "./config.js";

export const pool = new Pool({ connectionString: DATABASE_URL });
