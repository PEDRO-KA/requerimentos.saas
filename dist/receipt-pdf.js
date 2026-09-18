(function (root) {
  const timeZone = "America/Sao_Paulo";
  const sexLabels = {
    female: "Feminino",
    male: "Masculino",
    other: "Outro",
    prefer_not_to_say: "Prefere não informar",
  };

  function value(input) {
    const text = String(input ?? "").trim();
    return text || "Não informado";
  }

  function dateTime(input) {
    if (!input || Number.isNaN(new Date(input).getTime())) return "Não informado";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(input));
  }

  function birthDate(input) {
    const match = String(input || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "Não informado";
  }

  function formatCpf(input) {
    const digits = String(input || "").replace(/\D/g, "");
    return digits.length === 11
      ? digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
      : "Não informado";
  }

  function formatMobile(input) {
    const digits = String(input || "").replace(/\D/g, "");
    return digits.length === 11
      ? digits.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3")
      : "Não informado";
  }

  function safeText(input, font) {
    const text = String(input ?? "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[–—−]/g, "-")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/→/g, ">");
    return Array.from(text, (character) => {
      try { font.widthOfTextAtSize(character, 8); return character; }
      catch { return "?"; }
    }).join("");
  }

  function wrap(text, font, size, width) {
    const lines = [];
    let current = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      for (const character of word) {
        if (font.widthOfTextAtSize(current + character, size) > width && current) {
          lines.push(current);
          current = "";
        }
        current += character;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  function fittedLines(input, font, width, maxLines = 2) {
    const text = safeText(value(input), font);
    let size = 8.6;
    let lines = wrap(text, font, size, width);
    while (lines.length > maxLines && size > 6.6) {
      size -= 0.4;
      lines = wrap(text, font, size, width);
    }
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (font.widthOfTextAtSize(`${last}...`, size) > width && last) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}...`;
    }
    return { lines, size };
  }

  function summary(entries, font, width, emptyLabel = "Nenhuma observação registrada.") {
    if (!entries.length) return emptyLabel;
    let included = [];
    for (const entry of entries) {
      const candidate = [...included, entry].join(" | ");
      if (wrap(safeText(candidate, font), font, 7.8, width).length > 2) break;
      included.push(entry);
    }
    while (included.length) {
      const omitted = entries.length - included.length;
      const suffix = omitted ? ` | +${omitted} registro(s) no histórico digital` : "";
      const candidate = `${included.join(" | ")}${suffix}`;
      if (wrap(safeText(candidate, font), font, 7.8, width).length <= 2) return candidate;
      included = included.slice(0, -1);
    }
    const suffix = entries.length > 1
      ? `... +${entries.length - 1} registro(s) no histórico digital`
      : "... continuação no histórico digital";
    let excerpt = safeText(entries[0], font);
    while (excerpt && wrap(`${excerpt}${suffix}`, font, 7.8, width).length > 2) {
      excerpt = excerpt.slice(0, -1);
    }
    return excerpt ? `${excerpt}${suffix}` : `${entries.length} registro(s) no histórico digital.`;
  }

  async function create(receipt, logoBytes, pdfLib) {
    if (!receipt?.snapshot || !pdfLib?.PDFDocument) throw new Error("Dados do comprovante indisponíveis.");
    const snapshot = receipt.snapshot;
    const student = snapshot.student || {};
    const pdf = await pdfLib.PDFDocument.create();
    const page = pdf.addPage(pdfLib.PageSizes.A4);
    const { width, height } = page.getSize();
    const regular = await pdf.embedFont(pdfLib.StandardFonts.Helvetica);
    const bold = await pdf.embedFont(pdfLib.StandardFonts.HelveticaBold);
    const logo = await pdf.embedPng(logoBytes);
    const navy = pdfLib.rgb(0.12, 0.24, 0.40);
    const gray = pdfLib.rgb(0.38, 0.44, 0.51);
    const pale = pdfLib.rgb(0.85, 0.88, 0.91);
    const black = pdfLib.rgb(0.10, 0.16, 0.24);
    const x = 36;
    const contentWidth = width - 72;
    const split = height / 2;
    const protocol = safeText(value(snapshot.protocol), bold);

    function text(input, tx, ty, size = 9, font = regular, color = black) {
      page.drawText(safeText(input, font), { x: tx, y: ty, size, font, color });
    }

    function header(bottom, copyLabel) {
      page.drawImage(logo, { x, y: bottom + 349, width: 96, height: 56 });
      text("COMPROVANTE DE REQUERIMENTO", x + 112, bottom + 388, 12, bold, navy);
      text(copyLabel, x + 112, bottom + 372, 9, bold, gray);
      text(`Protocolo ${protocol}`, x + 112, bottom + 355, 9, bold, navy);
      page.drawLine({ start: { x, y: bottom + 341 }, end: { x: width - x, y: bottom + 341 }, thickness: 0.7, color: pale });
    }

    function field(label, input, fx, fy, fieldWidth) {
      text(label.toUpperCase(), fx, fy, 7, bold, gray);
      const fitted = fittedLines(input, regular, fieldWidth - 4);
      fitted.lines.forEach((line, index) => text(line, fx, fy - 11 - index * 8, fitted.size));
    }

    function row(y, fields) {
      fields.forEach(({ label, input, left, fieldWidth }) => field(label, input, x + left, y, fieldWidth));
      return y - 24;
    }

    function block(label, input, y) {
      text(label.toUpperCase(), x, y, 7, bold, gray);
      const fitted = fittedLines(input, regular, contentWidth, 2);
      fitted.lines.forEach((line, index) => text(line, x, y - 12 - index * 9, fitted.size));
    }

    // Via interna: somente os dados congelados no encerramento são usados.
    header(split, "VIA DA ESCOLA");
    let y = split + 330;
    y = row(y, [{ label: "Aluno", input: student.name, left: 0, fieldWidth: contentWidth }]);
    y = row(y, [
      { label: "CPF", input: formatCpf(student.cpf), left: 0, fieldWidth: 170 },
      { label: "Nascimento", input: birthDate(student.birth_date), left: 177, fieldWidth: 150 },
      { label: "Sexo", input: sexLabels[student.sex] || "Não informado", left: 340, fieldWidth: 180 },
    ]);
    y = row(y, [{ label: "E-mail", input: student.email, left: 0, fieldWidth: contentWidth }]);
    y = row(y, [
      { label: "Celular", input: formatMobile(student.mobile), left: 0, fieldWidth: 180 },
      { label: "Curso", input: student.course, left: 190, fieldWidth: 330 },
    ]);
    y = row(y, [
      { label: "Turma", input: student.class, left: 0, fieldWidth: 255 },
      { label: "Disciplina", input: snapshot.discipline, left: 265, fieldWidth: 255 },
    ]);
    y = row(y, [{ label: "Tipo de requerimento", input: snapshot.type, left: 0, fieldWidth: contentWidth }]);
    y = row(y, [
      { label: "Abertura", input: dateTime(snapshot.opened_at), left: 0, fieldWidth: 255 },
      { label: "Conclusão", input: dateTime(snapshot.completed_at), left: 265, fieldWidth: 255 },
    ]);
    y = row(y, [{ label: "Criado por", input: snapshot.creator, left: 0, fieldWidth: contentWidth }]);
    block("Descrição (resumo; texto integral no sistema)", snapshot.description, y - 1);
    const route = (snapshot.route || []).map((entry) => value(entry.department));
    block("Tramitação", summary(route, regular, contentWidth, "Nenhuma passagem registrada."), y - 35);
    const observations = (snapshot.observations || []).map((entry) => `${value(entry.actor)}: ${value(entry.text)}`);
    block("Observações", summary(observations, regular, contentWidth), y - 69);

    text("ASSINATURA DO ALUNO", 200, split + 36, 6.8, bold, gray);
    page.drawLine({ start: { x: 200, y: split + 28 }, end: { x: width - x, y: split + 28 }, thickness: 0.7, color: gray });
    const signatureName = fittedLines(student.name, regular, width - x - 200, 2);
    signatureName.lines.forEach((line, index) => text(line, 200, split + 17 - index * 8, signatureName.size, regular, gray));
    if (receipt.source === "legacy") text("Dados consolidados posteriormente.", x, split + 7, 6.7, regular, gray);

    // A segunda via não recebe o percurso, observações nem colaboradores.
    header(0, "VIA DO ALUNO");
    field("Aluno", student.name, x, 325, contentWidth);
    field("Tipo de requerimento", snapshot.type, x, 289, contentWidth);
    field("Abertura", dateTime(snapshot.opened_at), x, 253, 245);
    field("Conclusão", dateTime(snapshot.completed_at), x + 265, 253, 255);
    field("Situação", "Concluído", x, 217, contentWidth);
    text("Este comprovante confirma a conclusão do requerimento indicado acima.", x, 177, 9);
    text("Guarde esta via para consulta do protocolo junto à instituição.", x, 163, 9);

    page.drawLine({
      start: { x, y: split }, end: { x: width - x, y: split },
      thickness: 0.7, color: gray, dashArray: [4, 4],
    });
    pdf.setTitle(`Requerimento ${protocol}`);
    pdf.setSubject("Comprovante em duas vias");
    return pdf.save();
  }

  root.ReceiptPdf = { create, dateTime, summary };
})(globalThis);
