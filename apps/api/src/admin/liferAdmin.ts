// Server admin commands, run from a shell inside the Lifer container:
//
//   lifer-admin reset-password     set a new password for this server's account
//   lifer-admin list-users         show the account(s) on this server
//
// The only way back in after a forgotten password; container access proves you run the server.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pool, withTransaction } from "../db.js";
import { hashPassword } from "../auth/password.js";

const MIN_PASSWORD_LENGTH = 8;

// One reader for the whole run: a second reader on piped input would wait forever.
let muted = false;
const hiddenOutput = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
let reader: ReturnType<typeof createInterface> | null = null;
const lines: string[] = [];
const waiting: Array<(line: string) => void> = [];
function nextLine(): Promise<string> {
  if (!reader) {
    reader = createInterface({ input: process.stdin, output: hiddenOutput, terminal: process.stdin.isTTY });
    reader.on("line", (line) => {
      const w = waiting.shift();
      if (w) w(line);
      else lines.push(line);
    });
    reader.on("close", () => {
      for (const w of waiting.splice(0)) w("");
    });
  }
  const ready = lines.shift();
  return ready !== undefined ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
}

/** Reads a line without echoing it (on a terminal). Piped input works too, for scripting. */
async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  muted = true;
  const answer = await nextLine();
  muted = false;
  process.stdout.write("\n");
  return answer;
}

async function listUsers(): Promise<void> {
  const res = await pool.query<{ email: string; created_at: Date }>(`SELECT email, created_at FROM users ORDER BY created_at`);
  if (res.rows.length === 0) {
    console.log("No account yet. Open Lifer in a browser to create one.");
    return;
  }
  for (const u of res.rows) console.log(`${u.email}  (created ${u.created_at.toISOString().slice(0, 10)})`);
}

async function resetPassword(emailArg: string | undefined): Promise<number> {
  const res = await pool.query<{ id: string; email: string }>(`SELECT id, email FROM users ORDER BY created_at`);
  if (res.rows.length === 0) {
    console.log("No account yet. Open Lifer in a browser to create one.");
    return 1;
  }
  let user = res.rows[0];
  if (emailArg) {
    const match = res.rows.find((u) => u.email === emailArg.trim().toLowerCase());
    if (!match) {
      console.error(`No account with the email ${emailArg}. Run "lifer-admin list-users" to see it.`);
      return 1;
    }
    user = match;
  } else if (res.rows.length > 1) {
    console.error(`This server has ${res.rows.length} accounts. Say which: lifer-admin reset-password you@example.com`);
    return 1;
  }

  console.log(`Setting a new password for ${user.email}.`);
  const password = await askHidden("New password: ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
    return 1;
  }
  const again = await askHidden("Type it again: ");
  if (again !== password) {
    console.error("The two didn't match. Nothing was changed.");
    return 1;
  }
  const hash = await hashPassword(password);
  await withTransaction(async (client) => {
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
    // Whoever was signed in has to sign in again.
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
  });
  console.log(`Done. Sign in as ${user.email} with the new password. Every device that was signed in has been signed out.`);
  return 0;
}

const HELP = `Lifer server admin commands:

  lifer-admin reset-password [email]   set a new password for this server's account
  lifer-admin list-users               show the account(s) on this server
`;

async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);
  switch (command) {
    case "reset-password":
      return resetPassword(arg);
    case "list-users":
      await listUsers();
      return 0;
    default:
      console.log(HELP);
      return command && command !== "help" && command !== "--help" ? 1 : 0;
  }
}

main()
  .then(async (code) => {
    reader?.close();
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Failed:", (err as Error).message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
