import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  decodeRequestCreationSnapshot,
  encodeRequestCreationSnapshot,
  isLegacyRequestCreationRetry,
  legacyRequestCreationMessage,
  requestCreationDetails,
  requestCreationMessage,
  requestCreationSender,
  retryableResendError,
  validRecipient,
} from "../supabase/functions/_shared/request-creation-email.mjs";
import { requestCreationInlineImages } from "../supabase/functions/dispatch-request-creation-emails/assets.mjs";

const delivery = {
  request_protocol: "#2026-0042",
  opened_at: "2026-09-29T17:40:00.000Z",
  request_type_name: "Assunto reservado",
  description: "Descrição confidencial",
  cpf_digits: "12345678909",
};

test("a confirmação personalizada usa o modelo IPE sem incluir dados internos", () => {
  const message = requestCreationMessage(delivery, {
    studentName: "João da Silva", requestType: "Histórico Escolar",
  });
  assert.equal(requestCreationSender, "Protto by IPE <nao-responder@estudeipe.com.br>");
  assert.match(message.subject, /#2026-0042/);
  assert.match(message.text, /29\/09\/2026.*14:40/);
  assert.match(message.html, /lang="pt-BR" dir="ltr"/);
  assert.match(message.html, /<h1/);
  assert.match(message.html, /Olá, João da Silva!/);
  assert.match(message.html, /Tipo de requerimento/);
  assert.match(message.html, /Histórico Escolar/);
  assert.match(message.text, /Aluno: João da Silva/);
  assert.match(message.text, /Instituto Politécnico de Ensino/);
  assert.doesNotMatch(message.text, /Campos/);
  assert.match(message.html, /src="cid:ipe-email-logo"/);
  assert.match(message.html, /src="cid:ipe-email-footer"/);
  assert.match(message.html, /alt="Instituto Politécnico de Ensino"/);
  assert.match(message.html, /alt="" role="presentation"/);
  assert.match(message.html, /<table lang="pt-BR" dir="ltr" role="presentation"/);
  assert.doesNotMatch(message.html, /<a\b/);
  for (const secret of [delivery.request_type_name, delivery.description, delivery.cpf_digits]) {
    assert.ok(!`${message.subject}${message.text}${message.html}`.includes(secret));
  }
  assert.match(message.text, /Não responda a este e-mail/);
});

test("sem personalização segura, o e-mail continua confirmando protocolo e data", () => {
  const message = requestCreationMessage(delivery);
  assert.match(message.text, /Olá!/);
  assert.match(message.text, /Protocolo: #2026-0042/);
  assert.doesNotMatch(message.text, /Aluno:|Tipo de requerimento:/);
  assert.doesNotMatch(message.html, /<script|Assunto reservado|Descrição confidencial/);
});

test("protocolo, nome e tipo são escapados no HTML e limpos no texto", () => {
  const message = requestCreationMessage(
    { ...delivery, request_protocol: "<script>alert(1)</script>" },
    { studentName: "<b>Ana</b>\nSilva", requestType: "<img src=x onerror=alert(1)>" },
  );
  assert.ok(!message.html.includes("<script>"));
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.html, /&lt;b&gt;Ana&lt;\/b&gt; Silva/);
  assert.match(message.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(message.text, /Aluno: <b>Ana<\/b> Silva/);
  assert.doesNotMatch(message.text, /Aluno:.*\nSilva/);
});

function fakeAdmin(rows, errors = {}) {
  const filters = [];
  return {
    filters,
    from(table) {
      return {
        select(columns) { filters.push([table, "select", columns]); return this; },
        eq(column, value) { filters.push([table, column, value]); return this; },
        async maybeSingle() { return { data: rows[table] || null, error: errors[table] || null }; },
      };
    },
  };
}

test("personalização consulta aluno e tipo somente na instituição do requerimento", async () => {
  const admin = fakeAdmin({
    request_creation_email_jobs: {
      organization_id: "org-ipe", request_id: "request-1", student_id: "student-1",
      recipient_email: "aluno@exemplo.com.br",
    },
    requests: { organization_id: "org-ipe", student_id: "student-1", request_type_id: "type-1", protocol: "#2026-0042" },
    students: { full_name: "João da Silva", email: "ALUNO@EXEMPLO.COM.BR" },
    request_types: { name: "Histórico Escolar" },
  });
  const details = await requestCreationDetails(admin, {
    ...delivery, delivery_id: "delivery-1", target_request_id: "request-1", recipient_email: "aluno@exemplo.com.br",
  });
  assert.deepEqual(details, { studentName: "João da Silva", requestType: "Histórico Escolar" });
  assert.ok(admin.filters.some(([table, column, value]) =>
    table === "requests" && column === "organization_id" && value === "org-ipe"));
  assert.ok(admin.filters.some(([table, column, value]) =>
    table === "students" && column === "organization_id" && value === "org-ipe"));
  assert.ok(admin.filters.some(([table, column, value]) =>
    table === "request_types" && column === "organization_id" && value === "org-ipe"));
});

test("e-mail alterado, protocolo divergente e falha de leitura não expõem dados", async () => {
  const rows = {
    request_creation_email_jobs: {
      organization_id: "org-ipe", request_id: "request-1", student_id: "student-1",
      recipient_email: "antigo@exemplo.com.br",
    },
    requests: { organization_id: "org-ipe", student_id: "student-1", request_type_id: "type-1", protocol: "#2026-0042" },
    students: { full_name: "João da Silva", email: "novo@exemplo.com.br" },
    request_types: { name: "Histórico Escolar" },
  };
  const queued = { ...delivery, delivery_id: "delivery-1", target_request_id: "request-1", recipient_email: "antigo@exemplo.com.br" };
  assert.deepEqual(await requestCreationDetails(fakeAdmin(rows), queued), {});
  assert.deepEqual(await requestCreationDetails(fakeAdmin({ ...rows, requests: { ...rows.requests, protocol: "outro" } }), queued), {});
  assert.deepEqual(await requestCreationDetails(fakeAdmin({
    ...rows, requests: { ...rows.requests, student_id: "student-2" },
  }), queued), {});
  assert.deepEqual(await requestCreationDetails(fakeAdmin(rows, { students: new Error("unavailable") }), queued), {});
});

test("tentativas antigas preservam o corpo anterior; novas tentativas mantêm o novo", () => {
  const old = legacyRequestCreationMessage(delivery);
  assert.match(old.html, /protto <span/);
  assert.doesNotMatch(old.html, /cid:ipe-email-logo/);
  assert.equal(isLegacyRequestCreationRetry({ delivery_attempt_count: 2 }, null), true);
  assert.equal(isLegacyRequestCreationRetry({ delivery_attempt_count: 2 }, "template_v2:{}"), false);
  assert.equal(isLegacyRequestCreationRetry({ delivery_attempt_count: 1 }, null), false);
});

test("o snapshot conserva o mesmo corpo após alterações cadastrais", () => {
  const firstDetails = { studentName: "Ana Silva", requestType: "Revisão de Nota" };
  const snapshot = encodeRequestCreationSnapshot(firstDetails);
  assert.match(snapshot, /^template_v2:/);
  firstDetails.studentName = "Outro Nome";
  firstDetails.requestType = "Outro Tipo";
  const first = requestCreationMessage(delivery, decodeRequestCreationSnapshot(snapshot));
  const retry = requestCreationMessage(delivery, decodeRequestCreationSnapshot(snapshot));
  assert.deepEqual(retry, first);
  assert.match(retry.text, /Ana Silva/);
  assert.doesNotMatch(retry.text, /Outro Nome|Outro Tipo/);
  assert.equal(decodeRequestCreationSnapshot("provider-email-id"), null);
  assert.equal(decodeRequestCreationSnapshot("template_v2:{"), null);
});

test("imagens inline estão otimizadas e correspondem aos arquivos versionados", async () => {
  assert.equal(requestCreationInlineImages.length, 2);
  for (const asset of requestCreationInlineImages) {
    const bytes = Buffer.from(asset.content, "base64");
    const file = await readFile(new URL(`../supabase/functions/dispatch-request-creation-emails/assets/${asset.filename}`, import.meta.url));
    assert.ok(bytes.equals(file));
    assert.ok(bytes.length < 200_000);
    assert.match(asset.content_id, /^ipe-email-(logo|footer)$/);
  }
});

test("endereços inválidos falham sem impedir a criação do requerimento", () => {
  assert.equal(validRecipient("aluno@exemplo.com.br"), true);
  for (const email of ["", "sem-arroba", "aluno@", "aluno @exemplo.com", null]) {
    assert.equal(validRecipient(email), false);
  }
});

test("somente falhas transitórias são repetidas", () => {
  assert.equal(retryableResendError(429), true);
  assert.equal(retryableResendError(503), true);
  assert.equal(retryableResendError(409, "concurrent_idempotent_requests"), true);
  assert.equal(retryableResendError(409, "invalid_idempotent_request"), false);
  assert.equal(retryableResendError(422), false);
});

test("a fila nasce com o requerimento e não envia para histórico anterior", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260929204746_request_creation_email.sql", import.meta.url), "utf8");
  const expiryMigration = await readFile(new URL("../supabase/migrations/20260929204907_request_creation_email_claim_expiry.sql", import.meta.url), "utf8");
  const dispatcher = await readFile(new URL("../supabase/functions/dispatch-request-creation-emails/index.ts", import.meta.url), "utf8");
  assert.match(migration, /after insert on public\.requests/);
  assert.match(migration, /if new\.student_id is null then return new/);
  assert.match(migration, /request_id uuid not null unique/);
  assert.doesNotMatch(migration, /insert into public\.request_creation_email_jobs[\s\S]*?from public\.requests/);
  assert.match(migration, /for update of queued skip locked/);
  assert.match(migration, /23 hours/);
  assert.match(migration, /private\.purge_request_creation_email_jobs\(\)/);
  assert.match(migration, /delete from public\.request_creation_email_jobs as delivery\s+where delivery\.created_at < now\(\) - interval '30 days'/);
  assert.match(migration, /request-creation-email-purge-daily/);
  assert.match(expiryMigration, /queued\.created_at > now\(\) - interval '30 days'/);
  assert.match(dispatcher, /Idempotency-Key.*request-created-/);
  assert.match(dispatcher, /x-email-dispatch-secret/);
  assert.match(dispatcher, /requestCreationDetails\(admin, delivery\)/);
  assert.match(dispatcher, /provider_message_id: encodeRequestCreationSnapshot\(details\)/);
  assert.match(dispatcher, /decodeRequestCreationSnapshot\(queued\.data\.provider_message_id\)/);
  assert.match(dispatcher, /email_recipient_changed/);
  assert.match(dispatcher, /attachments: requestCreationInlineImages/);
  assert.match(dispatcher, /legacyRequestCreationMessage\(delivery\)/);
  assert.doesNotMatch(dispatcher, /publicClient\(|auth\.getUser\(/);
});
