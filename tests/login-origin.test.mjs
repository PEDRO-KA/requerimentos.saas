import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const login = await readFile(new URL("../supabase/functions/login-by-identifier/index.ts", import.meta.url), "utf8");
const http = await readFile(new URL("../supabase/functions/_shared/http.ts", import.meta.url), "utf8");
const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");

test("recuperação retorna à origem autorizada e preserva fallback do site atual", () => {
  assert.ok(login.indexOf("if (!isAllowedOrigin(request))") < login.indexOf("request.headers.get(\"origin\") || appUrl"));
  assert.match(login, /redirectTo: request\.headers\.get\("origin"\) \|\| appUrl/);
  assert.match(login, /Deno\.env\.get\("APP_URL"\)[\s\S]*ipe-gestao-academica\.spedrohenrique303\.chatgpt\.site/);
  assert.match(http, /return !origin \|\| allowedOrigins\(\)\.has\(origin\)/);
  assert.match(http, /"https:\/\/protto-ipe\.vercel\.app"/);
  assert.match(config, /additional_redirect_urls = \[[^\]]*"https:\/\/protto-ipe\.vercel\.app"/);
  assert.doesNotMatch(http, /\*\.vercel\.app/);
});
