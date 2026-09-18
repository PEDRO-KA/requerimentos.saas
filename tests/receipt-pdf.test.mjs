import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as PDFLib from "pdf-lib";

await import("../src/receipt-pdf.js");
const logo = await readFile(new URL("../ipe-logo.png", import.meta.url));

const snapshot = {
  institution: "Instituto Politécnico de Ensino",
  protocol: "2026-1234",
  student: {
    name: "João da Silva", cpf: "12345678909", email: "joao@example.com",
    mobile: "11912345678", birth_date: "2004-07-19", sex: "male",
    course: "Ensino Médio", class: "3º A",
  },
  type: "Revisão de Nota",
  discipline: "Matemática",
  description: "Solicitação de revisão da avaliação.",
  creator: "Mariana Costa",
  opened_at: "2026-09-18T12:15:00Z",
  completed_at: "2026-09-19T15:30:00Z",
  route: [{ department: "Secretaria" }, { department: "Coordenação" }],
  observations: [{ actor: "Mariana Costa", text: "Análise interna concluída." }],
};

function tracedLib(operations) {
  return {
    ...PDFLib,
    PDFDocument: {
      create: async () => {
        const doc = await PDFLib.PDFDocument.create();
        const originalAdd = doc.addPage.bind(doc);
        doc.addPage = (...args) => {
          const page = originalAdd(...args);
          const originalText = page.drawText.bind(page);
          const originalImage = page.drawImage.bind(page);
          page.drawText = (text, options) => {
            operations.push({ kind: "text", text, y: options.y });
            return originalText(text, options);
          };
          page.drawImage = (image, options) => {
            operations.push({ kind: "image", y: options.y });
            return originalImage(image, options);
          };
          return page;
        };
        return doc;
      },
    },
  };
}

test("gera uma folha A4 com logo e protocolo nas duas vias", async () => {
  const operations = [];
  const bytes = await globalThis.ReceiptPdf.create({ snapshot, source: "completion" }, logo, tracedLib(operations));
  if (process.env.RECEIPT_PDF_SAMPLE) await writeFile(process.env.RECEIPT_PDF_SAMPLE, bytes);
  const pdf = await PDFLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const { width, height } = pdf.getPage(0).getSize();
  assert.ok(Math.abs(width - PDFLib.PageSizes.A4[0]) < 0.1);
  assert.ok(Math.abs(height - PDFLib.PageSizes.A4[1]) < 0.1);
  assert.equal(operations.filter((item) => item.kind === "image").length, 2);
  assert.equal(operations.filter((item) => item.text?.includes("Protocolo 2026-1234")).length, 2);
});

test("a via do aluno não recebe dados internos e a escola recebe assinatura", async () => {
  const operations = [];
  await globalThis.ReceiptPdf.create({ snapshot, source: "legacy" }, logo, tracedLib(operations));
  const split = PDFLib.PageSizes.A4[1] / 2;
  const school = operations.filter((item) => item.kind === "text" && item.y > split).map((item) => item.text).join(" ");
  const student = operations.filter((item) => item.kind === "text" && item.y < split).map((item) => item.text).join(" ");
  for (const item of ["123.456.789-09", "Matemática", "Secretaria", "Mariana Costa", "Análise interna", "Dados consolidados posteriormente."]) {
    assert.ok(school.includes(item), `Ausente na via da escola: ${item}`);
    assert.ok(!student.includes(item), `Dado interno vazou para a via do aluno: ${item}`);
  }
  assert.ok(student.includes("João da Silva"));
  assert.ok(student.includes("Concluído"));
});

test("data usa o fuso de São Paulo e notas extensas indicam registros omitidos", () => {
  assert.equal(globalThis.ReceiptPdf.dateTime("2026-09-18T02:30:00Z"), "17/09/2026, 23:30");
  const font = {
    widthOfTextAtSize: (text, size) => text.length * size * 0.5,
  };
  const result = globalThis.ReceiptPdf.summary(
    Array.from({ length: 12 }, (_, index) => `Observação ${index + 1}: análise documental`),
    font,
    180,
  );
  assert.match(result, /registro\(s\) no histórico digital/);
});

test("campos acadêmicos ausentes aparecem como não informados", async () => {
  const operations = [];
  await globalThis.ReceiptPdf.create({
    snapshot: { ...snapshot, discipline: null, student: { name: "Aluno Antigo" } },
    source: "legacy",
  }, logo, tracedLib(operations));
  const school = operations.filter((item) => item.kind === "text" && item.y > PDFLib.PageSizes.A4[1] / 2).map((item) => item.text);
  assert.ok(school.filter((text) => text === "Não informado").length >= 5);
  assert.ok(school.includes("Dados consolidados posteriormente."));
});
