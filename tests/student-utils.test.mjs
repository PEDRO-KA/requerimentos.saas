import test from "node:test";
import assert from "node:assert/strict";
import "../src/student-utils.js";

const utils = globalThis.StudentUtils;

test("formata CPF progressivamente e remove caracteres inválidos", () => {
  assert.equal(utils.formatCpf("52998224725"), "529.982.247-25");
  assert.equal(utils.formatCpf("529.98a"), "529.98");
  assert.equal(utils.cpfDigits("529.982.247-25"), "52998224725");
});

test("valida dígitos verificadores e rejeita sequências repetidas", () => {
  assert.equal(utils.isValidCpf("529.982.247-25"), true);
  assert.equal(utils.isValidCpf("529.982.247-24"), false);
  assert.equal(utils.isValidCpf("111.111.111-11"), false);
});

test("normaliza celular brasileiro e aceita prefixo +55", () => {
  assert.equal(utils.mobileDigits("+55 (11) 98765-4321"), "11987654321");
  assert.equal(utils.formatMobile("11987654321"), "(11) 98765-4321");
  assert.equal(utils.isValidMobile("(11) 98765-4321"), true);
  assert.equal(utils.isValidMobile("(01) 98765-4321"), false);
  assert.equal(utils.isValidMobile("(11) 88765-4321"), false);
});

test("normaliza busca com acentos", () => {
  assert.equal(utils.normalizeSearch("  João Ávila "), "joao avila");
});

test("valida e-mail e impede nascimento futuro ou data impossível", () => {
  assert.equal(utils.isValidEmail("aluno@example.com"), true);
  assert.equal(utils.isValidEmail("aluno@"), false);
  assert.equal(utils.isValidBirthDate("2005-03-18", new Date("2026-09-08T12:00:00")), true);
  assert.equal(utils.isValidBirthDate("2027-01-01", new Date("2026-09-08T12:00:00")), false);
  assert.equal(utils.isValidBirthDate("2020-02-31", new Date("2026-09-08T12:00:00")), false);
});
