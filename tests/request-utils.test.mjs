import test from "node:test";
import assert from "node:assert/strict";

await import("../src/request-utils.js");

const { canActOnRequest, canAddRequestContent, hasAdvancedRequest, canRequestComplement, requestScope, matchesPeriod, matchesDate } = globalThis.RequestUtils;
const active = { status: "forwarded", current_department_id: "destination", requester_id: "creator" };

test("setor atual atua e setores anteriores somente acompanham", () => {
  assert.equal(canActOnRequest(active, { role: "attendant", department_id: "destination" }), true);
  assert.equal(canActOnRequest(active, { role: "attendant", department_id: "origin" }), false);
  assert.equal(requestScope(active, { role: "attendant", department_id: "destination" }), "queue");
  assert.equal(requestScope(active, { role: "attendant", department_id: "origin" }), "tracking");
});

test("administrador atua globalmente e encerrados ficam em concluídos", () => {
  assert.equal(canActOnRequest(active, { role: "admin", department_id: null }), true);
  assert.equal(requestScope(active, { role: "admin", department_id: null }), "queue");
  assert.equal(requestScope({ ...active, status: "completed" }, { role: "admin" }), "completed");
  assert.equal(canActOnRequest({ ...active, status: "completed" }, { role: "admin" }), false);
});

test("acesso histórico não concede escrita e portal preserva o próprio requerimento", () => {
  assert.equal(canAddRequestContent(active, { role: "attendant", department_id: "origin" }, "creator"), false);
  assert.equal(canAddRequestContent(active, { role: "student", department_id: null }, "creator"), true);
});

test("cada colaborador encaminha apenas uma vez e depois só solicita complemento", () => {
  const events = [
    { actor_id: "other", event_type: "forwarded", to_status: "forwarded" },
    { actor_id: "staff", event_type: "forwarded", to_status: "forwarded" },
  ];
  assert.equal(hasAdvancedRequest(events, "staff"), true);
  assert.equal(hasAdvancedRequest(events, "other"), true);
  assert.equal(hasAdvancedRequest(events, "newcomer"), false);
  assert.equal(hasAdvancedRequest([{ actor_id: "staff", event_type: "status_changed", to_status: "completed" }], "staff"), true);
  assert.equal(hasAdvancedRequest([{ actor_id: "staff", event_type: "created", to_status: "open" }], "staff"), false);
  assert.equal(canRequestComplement(active, { role: "attendant", department_id: "origin" }, true), true);
  assert.equal(canRequestComplement(active, { role: "attendant", department_id: "origin" }, false), false);
  assert.equal(canRequestComplement(active, { role: "admin" }, true), true);
  assert.equal(canRequestComplement({ ...active, status: "completed" }, { role: "attendant", department_id: "origin" }, true), false);
});

test("período todos não oculta processos ativos antigos", () => {
  const fortyDaysAgo = Date.now() - 40 * 86400000;
  assert.equal(matchesPeriod(fortyDaysAgo, "all"), true);
  assert.equal(matchesPeriod(fortyDaysAgo, "30"), false);
});

test("atalhos usam dias de calendário em vez de janelas móveis", () => {
  const now = new Date(2026, 8, 16, 8, 0).getTime();
  assert.equal(matchesPeriod(new Date(2026, 8, 15, 22, 30), "today", now), false);
  assert.equal(matchesPeriod(new Date(2026, 8, 16, 0, 0), "today", now), true);
  assert.equal(matchesPeriod(new Date(2026, 8, 10, 0, 0), "7", now), true);
  assert.equal(matchesPeriod(new Date(2026, 8, 9, 23, 59), "7", now), false);
  assert.equal(matchesPeriod(new Date(2026, 7, 18, 0, 0), "30", now), true);
  assert.equal(matchesPeriod(new Date(2026, 7, 17, 23, 59), "30", now), false);
});

test("busca por data compara o dia local completo", () => {
  const openedAt = new Date(2026, 8, 15, 22, 18);
  assert.equal(matchesDate(openedAt, "2026-09-15"), true);
  assert.equal(matchesDate(openedAt, "2026-09-16"), false);
  assert.equal(matchesDate(openedAt, ""), true);
  assert.equal(matchesDate(openedAt, "15/09/2026"), false);
});
