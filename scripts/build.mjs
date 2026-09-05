import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const localEnv = path.join(root, ".env.local");

if (existsSync(localEnv)) {
  const text = await readFile(localEnv, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const url = process.env.SUPABASE_URL || "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
if (publishableKey.startsWith("sb_secret_") || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Uma chave secreta foi fornecida ao build. Somente a chave publicável pode entrar no frontend.");
}
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) throw new Error("SUPABASE_URL inválida.");

let source = await readFile(path.join(root, "gestao-academica.html"), "utf8");
const publicConfig = JSON.stringify({ url, publishableKey }).replaceAll("<", "\\u003c");
source = source.replace("</head>", '  <link rel="stylesheet" href="./backend.css">\n</head>');
source = source.replace("</body>", `  <script>window.__SUPABASE_CONFIG__=${publicConfig};</script>\n  <script src="./supabase.js"></script>\n  <script src="./supabase-app.js"></script>\n</body>`);

const dist = path.join(root, "dist");
const supabaseBundle = await readFile(
  path.join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js"),
  "utf8",
);
await mkdir(dist, { recursive: true });
await Promise.all([
  writeFile(path.join(dist, "index.html"), source, "utf8"),
  copyFile(path.join(root, "src", "backend.css"), path.join(dist, "backend.css")),
  copyFile(path.join(root, "src", "supabase-app.js"), path.join(dist, "supabase-app.js")),
  writeFile(path.join(dist, "supabase.js"), `${supabaseBundle.trimEnd()}\n`, "utf8"),
  copyFile(path.join(root, "ObtemLogos 02.jpg"), path.join(dist, "ObtemLogos 02.jpg")),
]);
console.log(`Build concluído${url && publishableKey ? " com Supabase configurado" : " em modo pendente"}.`);
