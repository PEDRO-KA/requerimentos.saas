(function () {
  const cfg = window.__SUPABASE_CONFIG__ || {};
  const roles = { admin: "Administradora", coordinator: "Coordenador", attendant: "Atendente", student: "Aluno" };
  const statuses = { open: "Aberto", in_review: "Em análise", awaiting_requester: "Aguardando solicitante", forwarded: "Encaminhado", completed: "Concluído", rejected: "Indeferido", canceled: "Cancelado" };
  const badges = { open: "open", in_review: "progress", awaiting_requester: "open", forwarded: "open", completed: "done", rejected: "danger", canceled: "danger" };
  const db = { client: null, user: null, profile: null, member: null, org: null, departments: [], types: [], steps: [], profiles: [], memberships: [], requests: [], adminUsers: [], recovery: false };

  const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const when = (v) => v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(v)) : "—";
  const cpf = (v) => String(v || "").replace(/\D/g, "").slice(0, 11).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  const isAdmin = () => db.member?.role === "admin";
  const isStaff = () => ["admin", "coordinator", "attendant"].includes(db.member?.role);
  const orgId = () => db.member?.organization_id;
  const person = (id) => db.profiles.find((x) => x.id === id)?.full_name || "Não atribuído";
  const department = (id) => db.departments.find((x) => x.id === id)?.name || "Concluído";
  const requestType = (id) => db.types.find((x) => x.id === id)?.name || "Requerimento";
  const errorText = (e, fallback) => {
    const message = String(e?.message || e || "");
    if (/duplicate|unique/i.test(message)) return "Já existe um cadastro com esses dados.";
    if (/row-level security|permission|forbidden|not authorized/i.test(message)) return "Você não tem permissão para realizar esta ação.";
    return message || fallback;
  };
  const busy = (value) => document.body.classList.toggle("backend-loading", value);

  const storage = {
    getItem(key) { return localStorage.getItem(key) || sessionStorage.getItem(key); },
    setItem(key, value) {
      const persistent = localStorage.getItem("ipe-remember-login") === "1";
      (persistent ? localStorage : sessionStorage).setItem(key, value);
      (persistent ? sessionStorage : localStorage).removeItem(key);
    },
    removeItem(key) { localStorage.removeItem(key); sessionStorage.removeItem(key); },
  };

  function showLogin(message = "") {
    document.getElementById("loginScreen").style.display = "grid";
    document.getElementById("appRoot").classList.remove("logged");
    document.getElementById("loginError").textContent = message;
  }
  function showApp() {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appRoot").classList.add("logged");
  }

  async function invoke(name, payload, authenticated = true) {
    const headers = { apikey: cfg.publishableKey, "Content-Type": "application/json" };
    if (authenticated) {
      const { data } = await db.client.auth.getSession();
      if (!data.session) throw new Error("Sua sessão expirou. Entre novamente.");
      headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    const response = await fetch(`${cfg.url}/functions/v1/${name}`, { method: "POST", headers, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
    return result;
  }

  async function loadData() {
    const auth = await db.client.auth.getUser();
    if (auth.error || !auth.data.user) throw new Error("Sessão inválida.");
    db.user = auth.data.user;
    const [profile, member] = await Promise.all([
      db.client.from("profiles").select("id,full_name,is_active").eq("id", db.user.id).single(),
      db.client.from("memberships").select("organization_id,department_id,role").eq("user_id", db.user.id).single(),
    ]);
    if (profile.error || member.error || !profile.data?.is_active) throw new Error("Acesso não autorizado ou desativado.");
    db.profile = profile.data;
    db.member = member.data;
    const id = orgId();
    const results = await Promise.all([
      db.client.from("organizations").select("id,name").eq("id", id).single(),
      db.client.from("departments").select("id,name,purpose,is_active").eq("organization_id", id).order("name"),
      db.client.from("request_types").select("id,name,description,default_deadline_business_days,allow_attachments,is_active,current_workflow_version").eq("organization_id", id).order("name"),
      db.client.from("workflow_steps").select("id,request_type_id,workflow_version,position,label,department_id,is_terminal").eq("organization_id", id).order("position"),
      db.client.from("profiles").select("id,full_name,is_active").order("full_name"),
      db.client.from("memberships").select("user_id,department_id,role").eq("organization_id", id),
      db.client.from("requests").select("id,protocol,request_type_id,requester_id,description,status,current_step_id,current_department_id,assigned_to,due_at,completed_at,created_at,updated_at").eq("organization_id", id).order("created_at", { ascending: false }),
    ]);
    const failed = results.find((x) => x.error);
    if (failed) throw failed.error;
    [db.org, db.departments, db.types, db.steps, db.profiles, db.memberships, db.requests] = results.map((x) => x.data || []);
    db.adminUsers = isAdmin() ? (await invoke("admin-users", { action: "list" })).users || [] : [];
    syncLegacy();
    applyIdentity();
  }

  function syncLegacy() {
    data.credentials = {};
    data.departments = db.departments.filter((x) => x.is_active).map((x) => [x.name, x.purpose]);
    data.types = db.types.filter((x) => x.is_active).map((x) => {
      const flow = db.steps.filter((s) => s.request_type_id === x.id && s.workflow_version === x.current_workflow_version).sort((a, b) => a.position - b.position);
      return [x.name, `${flow.length} etapa(s)`, flow.map((s) => s.label).join(" → ") || "Fluxo não configurado"];
    });
    data.tickets = db.requests.map((x) => [x.protocol, requestType(x.request_type_id), department(x.current_department_id), person(x.assigned_to), person(x.requester_id), when(x.created_at), statuses[x.status] || x.status, badges[x.status] || "open"]);
  }

  function applyIdentity() {
    const box = document.querySelector(".sidebar .profile");
    if (box) {
      box.querySelector(".avatar").textContent = db.profile.full_name.split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
      box.querySelector("strong").textContent = db.profile.full_name;
      box.querySelector("small").textContent = roles[db.member.role] || db.member.role;
      if (!box.querySelector(".logout-link")) box.insertAdjacentHTML("beforeend", '<button class="logout-link" type="button" onclick="logout()">Sair da conta</button>');
    }
    document.querySelectorAll(".sidebar [data-section]").forEach((x) => { x.style.display = isAdmin() ? "" : "none"; });
    const label = [...document.querySelectorAll(".side-label")].find((x) => x.textContent.trim() === "Configurações");
    if (label) label.style.display = isAdmin() ? "" : "none";
    const dashboard = document.querySelector('[data-view="dashboard"]');
    if (dashboard) dashboard.style.display = isStaff() ? "" : "none";
  }

  async function refresh(view) {
    busy(true);
    try { await loadData(); showApp(); showView(view || (isStaff() ? "dashboard" : "portal")); }
    finally { busy(false); }
  }

  window.login = async function (event) {
    event.preventDefault();
    const identifier = document.getElementById("loginCpf").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (document.getElementById("rememberLogin").checked) localStorage.setItem("ipe-remember-login", "1");
    else localStorage.removeItem("ipe-remember-login");
    busy(true);
    try {
      const result = await invoke("login-by-identifier", { action: "login", identifier, password }, false);
      const saved = await db.client.auth.setSession(result.session);
      if (saved.error) throw saved.error;
      document.getElementById("loginPassword").value = "";
      await refresh();
      notify(`Bem-vindo(a), ${db.profile.full_name}.`);
    } catch (e) {
      await db.client.auth.signOut().catch(() => {});
      showLogin(errorText(e, "Usuário ou senha inválidos."));
    } finally { busy(false); }
  };

  window.logout = async function () { busy(true); try { await db.client.auth.signOut(); showLogin(); } finally { busy(false); } };
  window.openRegister = () => notify("O acesso é criado exclusivamente pelo administrador.");
  window.forgotPassword = function () {
    dialog("Recuperar senha", '<p>Informe seu CPF ou e-mail. A resposta é sempre genérica por segurança.</p><div class="field"><label>CPF ou e-mail</label><input id="recoveryLogin" autocomplete="username"></div><div id="recoveryError" class="text-destructive text-small"></div>', "Enviar instruções", async () => {
      const identifier = document.getElementById("recoveryLogin").value.trim();
      if (!identifier) return document.getElementById("recoveryError").textContent = "Informe seu CPF ou e-mail.";
      try { await invoke("login-by-identifier", { action: "recover", identifier }, false); closeModal(); notify("Se o cadastro estiver ativo, as instruções serão enviadas ao e-mail registrado."); }
      catch (e) { document.getElementById("recoveryError").textContent = errorText(e, "Não foi possível enviar as instruções."); }
    });
  };

  function resetPasswordDialog() {
    dialog("Definir nova senha", '<p>Use no mínimo 10 caracteres, maiúscula, minúscula e número.</p><div class="field"><label>Nova senha</label><input id="recoveryPassword" type="password"></div><div class="field"><label>Confirmar</label><input id="recoveryPasswordConfirm" type="password"></div><div id="recoveryError" class="text-destructive text-small"></div>', "Salvar senha", async () => {
      const password = document.getElementById("recoveryPassword").value;
      const confirmation = document.getElementById("recoveryPasswordConfirm").value;
      if (password !== confirmation || password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return document.getElementById("recoveryError").textContent = "As senhas devem ser iguais e atender aos requisitos.";
      const changed = await db.client.auth.updateUser({ password });
      if (changed.error) return document.getElementById("recoveryError").textContent = errorText(changed.error, "Não foi possível alterar a senha.");
      db.recovery = false; closeModal(); notify("Senha alterada com sucesso.");
    });
  }

  function activate(name) {
    document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
    document.getElementById(name)?.classList.add("active");
    document.querySelectorAll(".nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
    window.scrollTo(0, 0);
  }
  window.showView = function (name) {
    if (!db.user) return showLogin();
    if (name === "settings" && !isAdmin()) return notify("Esta área é exclusiva do administrador.");
    if (name === "dashboard" && !isStaff()) name = "portal";
    activate(name);
    if (name === "dashboard") renderDashboard();
    if (name === "requests") renderRequests();
    if (name === "portal") renderPortal();
    if (name === "settings") renderSettings();
  };
  window.openSettings = function (section) { if (!isAdmin()) return notify("Área exclusiva do administrador."); activeSettings = section; activate("settings"); renderSettings(); };
  window.setSettings = function (section) { activeSettings = section; document.querySelectorAll("[data-settings]").forEach((x) => x.classList.toggle("active", x.dataset.settings === section)); renderSettings(); };

  function renderDashboard() {
    const active = db.requests.filter((x) => !["completed", "rejected", "canceled"].includes(x.status));
    const waiting = db.requests.filter((x) => x.status === "awaiting_requester");
    const completed = db.requests.filter((x) => x.status === "completed");
    const overdue = active.filter((x) => x.due_at && new Date(x.due_at) < new Date()).length;
    document.getElementById("dashboard").innerHTML = `<div class="top"><div><div class="crumb">Visão geral / Painel</div><h1>Olá, ${esc(db.profile.full_name.split(" ")[0])}</h1></div><div class="actions"><button class="btn" onclick="showView('portal')">Meu portal</button><button class="btn primary" onclick="openModal()">+ Novo requerimento</button></div></div><div class="metrics"><div class="metric"><div class="label">Em andamento</div><div class="value">${active.length}</div><div class="trend">Dados em tempo real</div></div><div class="metric"><div class="label">Aguardando solicitante</div><div class="value">${waiting.length}</div><div class="trend">${overdue} fora do prazo</div></div><div class="metric"><div class="label">Concluídos</div><div class="value">${completed.length}</div><div class="trend">No histórico acessível</div></div><div class="metric"><div class="label">Total visível</div><div class="value">${db.requests.length}</div><div class="trend">Conforme seu perfil</div></div></div><article class="panel"><div class="panel-head"><h2>Requerimentos recentes</h2><button class="link" onclick="showView('requests')">Ver todos</button></div><table class="table"><thead><tr><th>Protocolo</th><th>Solicitante</th><th>Tipo</th><th>Status</th></tr></thead><tbody>${db.requests.slice(0, 6).map((x) => `<tr><td><strong>${esc(x.protocol)}</strong><span class="sub">${esc(when(x.created_at))}</span></td><td>${esc(person(x.requester_id))}</td><td>${esc(requestType(x.request_type_id))}</td><td><span class="badge ${badges[x.status] || "open"}">${esc(statuses[x.status] || x.status)}</span></td></tr>`).join("") || '<tr><td colspan="4" class="backend-empty">Nenhum requerimento cadastrado.</td></tr>'}</tbody></table></article>`;
  }

  window.setRequestFilter = function (key, value) { requestFilters[key] = value; renderRequests(); };
  window.renderRequests = function () {
    const f = requestFilters;
    const now = Date.now();
    const rows = db.requests.filter((x) => {
      const haystack = [x.protocol, requestType(x.request_type_id), person(x.requester_id), department(x.current_department_id), person(x.assigned_to)].join(" ").toLowerCase();
      const age = now - new Date(x.created_at).getTime();
      const period = f.period === "today" ? age < 86400000 : f.period === "30" ? age < 2592000000 : age < 604800000;
      return period && haystack.includes(f.query.toLowerCase()) && (!f.type || x.request_type_id === f.type) && (!f.department || x.current_department_id === f.department) && (!f.responsible || x.assigned_to === f.responsible) && (!f.status || x.status === f.status);
    });
    document.getElementById("requests").innerHTML = `<div class="top"><div><div class="crumb">Operação / Requerimentos</div><h1>Requerimentos</h1></div><div class="actions"><button class="btn" onclick="refreshRequests()">↻ Atualizar</button><button class="btn primary" onclick="openModal()">+ Novo requerimento</button></div></div><div class="toolbar"><input class="search" placeholder="Pesquisar por protocolo, aluno ou requerimento" value="${esc(f.query)}" oninput="setRequestFilter('query',this.value)"><div class="actions"><button class="btn ${f.period === "today" ? "primary" : ""}" onclick="setRequestFilter('period','today')">Hoje</button><button class="btn ${f.period === "7" ? "primary" : ""}" onclick="setRequestFilter('period','7')">7 dias</button><button class="btn ${f.period === "30" ? "primary" : ""}" onclick="setRequestFilter('period','30')">30 dias</button></div></div><article class="panel"><div class="panel-head"><h2>${rows.length} requerimento(s)</h2><button class="link" onclick="requestFilters={period:'7',type:'',department:'',responsible:'',status:'',query:''};renderRequests()">Limpar filtros</button></div><table class="table"><thead><tr><th>Protocolo</th><th>Tipo</th><th>Aluno</th><th>Departamento</th><th>Responsável</th><th>Status</th><th>Abertura</th><th></th></tr></thead><tbody>${rows.map((x) => `<tr><td><strong>${esc(x.protocol)}</strong></td><td>${esc(requestType(x.request_type_id))}</td><td>${esc(person(x.requester_id))}</td><td>${esc(department(x.current_department_id))}</td><td>${esc(person(x.assigned_to))}</td><td><span class="badge ${badges[x.status] || "open"}">${esc(statuses[x.status] || x.status)}</span></td><td>${esc(when(x.created_at))}</td><td><button class="link" onclick="viewTicket('${x.id}')">Visualizar</button></td></tr>`).join("") || '<tr><td colspan="8" class="backend-empty">Nenhum requerimento encontrado.</td></tr>'}</tbody></table></article>`;
  };

  function renderPortal() {
    const own = db.requests.filter((x) => x.requester_id === db.user.id);
    const active = own.filter((x) => !["completed", "rejected", "canceled"].includes(x.status));
    const waiting = own.filter((x) => x.status === "awaiting_requester");
    const completed = own.filter((x) => x.status === "completed");
    document.getElementById("portal").innerHTML = `<div class="top"><div><div class="crumb">Portal do usuário</div><h1>Meus requerimentos</h1></div><button class="btn primary" onclick="openModal()">+ Abrir requerimento</button></div><div class="metrics"><div class="metric"><div class="label">Em andamento</div><div class="value">${active.length}</div></div><div class="metric"><div class="label">Aguardando você</div><div class="value">${waiting.length}</div></div><div class="metric"><div class="label">Concluídos</div><div class="value">${completed.length}</div></div></div><article class="panel"><div class="panel-head"><h2>Andamento</h2></div><table class="table"><thead><tr><th>Protocolo</th><th>Assunto</th><th>Etapa atual</th><th>Status</th><th></th></tr></thead><tbody>${own.map((x) => `<tr><td>${esc(x.protocol)}</td><td>${esc(requestType(x.request_type_id))}</td><td>${esc(department(x.current_department_id))}</td><td><span class="badge ${badges[x.status] || "open"}">${esc(statuses[x.status] || x.status)}</span></td><td><button class="link" onclick="viewTicket('${x.id}')">Acompanhar</button></td></tr>`).join("") || '<tr><td colspan="5" class="backend-empty">Você ainda não possui requerimentos.</td></tr>'}</tbody></table></article>`;
  }

  window.refreshRequests = async function () { try { await refresh(document.querySelector(".view.active")?.id || "requests"); notify("Dados atualizados."); } catch (e) { notify(errorText(e, "Falha ao atualizar os dados.")); } };
  window.openModal = function () {
    const available = db.types.filter((x) => x.is_active && db.steps.some((s) => s.request_type_id === x.id));
    const people = isAdmin() ? db.adminUsers.filter((x) => x.is_active) : [{ id: db.user.id, full_name: db.profile.full_name }];
    dialog("Novo requerimento", `<div class="form-grid"><div class="field"><label>Tipo</label><select id="newTicketType">${available.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div><div class="field"><label>Solicitante</label><select id="newTicketRequester" ${isAdmin() ? "" : "disabled"}>${people.map((x) => `<option value="${x.id}">${esc(x.full_name)}</option>`).join("")}</select></div></div><div class="field"><label>Descrição</label><textarea id="newTicketDescription" maxlength="4000"></textarea></div><div class="field"><label>Anexos (PDF, JPG ou PNG; até 10 MB)</label><input id="newTicketFiles" type="file" accept="application/pdf,image/jpeg,image/png" multiple></div><div id="newTicketError" class="text-destructive text-small"></div>`, "Criar requerimento", createRequest);
  };

  window.createRequest = async function () {
    const typeId = document.getElementById("newTicketType")?.value;
    const requesterId = document.getElementById("newTicketRequester")?.value || db.user.id;
    const description = document.getElementById("newTicketDescription")?.value.trim();
    const files = [...(document.getElementById("newTicketFiles")?.files || [])];
    const errorNode = document.getElementById("newTicketError");
    if (!typeId || !description) return errorNode.textContent = "Selecione o tipo e informe a descrição.";
    if (files.some((f) => f.size > 10485760 || !["application/pdf", "image/jpeg", "image/png"].includes(f.type))) return errorNode.textContent = "Cada anexo deve ser PDF, JPG ou PNG e ter no máximo 10 MB.";
    busy(true);
    try {
      const created = await db.client.from("requests").insert({ organization_id: orgId(), request_type_id: typeId, requester_id: requesterId, description }).select().single();
      if (created.error) throw created.error;
      for (const file of files) {
        const path = `${orgId()}/${created.data.id}/${db.user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const uploaded = await db.client.storage.from("request-documents").upload(path, file);
        if (uploaded.error) throw uploaded.error;
        const record = await db.client.from("request_attachments").insert({ organization_id: orgId(), request_id: created.data.id, uploaded_by: db.user.id, storage_path: path, file_name: file.name, mime_type: file.type, size_bytes: file.size });
        if (record.error) { await db.client.storage.from("request-documents").remove([path]); throw record.error; }
      }
      closeModal(); await refresh("requests"); notify(`Requerimento ${created.data.protocol} criado com sucesso.`);
    } catch (e) { errorNode.textContent = errorText(e, "Não foi possível criar o requerimento."); }
    finally { busy(false); }
  };

  window.viewTicket = async function (id) {
    const item = db.requests.find((x) => x.id === id);
    if (!item) return;
    busy(true);
    try {
      const [events, files] = await Promise.all([
        db.client.from("request_events").select("id,actor_id,event_type,note,to_status,created_at").eq("request_id", id).order("created_at"),
        db.client.from("request_attachments").select("id,storage_path,file_name,mime_type,size_bytes,created_at").eq("request_id", id).order("created_at"),
      ]);
      if (events.error || files.error) throw events.error || files.error;
      const canProcess = isStaff() && !["completed", "rejected", "canceled"].includes(item.status);
      dialog(`Requerimento ${esc(item.protocol)}`, `<div class="form-grid"><div><span class="sub">Solicitante</span><strong>${esc(person(item.requester_id))}</strong></div><div><span class="sub">Tipo</span><strong>${esc(requestType(item.request_type_id))}</strong></div><div><span class="sub">Departamento</span><strong>${esc(department(item.current_department_id))}</strong></div><div><span class="sub">Abertura</span><strong>${esc(when(item.created_at))}</strong></div></div><h3 style="margin:22px 0 8px">Descrição</h3><p>${esc(item.description || "Sem descrição.")}</p><h3 style="margin:22px 0 8px">Documentos</h3><div class="file-list">${(files.data || []).map((f) => `<div class="doc"><div><strong>${esc(f.file_name)}</strong><small>${esc(f.mime_type)} · ${(f.size_bytes / 1048576).toFixed(2)} MB</small></div><button class="link" onclick="downloadAttachment('${f.storage_path.replaceAll("'", "")}')">Abrir</button></div>`).join("") || '<span class="sub">Nenhum documento anexado.</span>'}</div><h3 style="margin:22px 0 8px">Histórico</h3><div class="timeline">${(events.data || []).map((e) => `<div class="event"><div class="dot"></div><div><strong>${esc(e.note || statuses[e.to_status] || e.event_type)}</strong><small>${esc(person(e.actor_id))} · ${esc(when(e.created_at))}</small></div></div>`).join("")}</div><div class="field"><label>Observação</label><textarea id="ticketObservation" maxlength="2000"></textarea></div><div class="actions"><button class="btn" onclick="addTicketNote('${id}')">Salvar observação</button>${canProcess ? `<button class="btn" onclick="requestTicketComplement('${id}')">Solicitar complemento</button><button class="btn primary" onclick="processTicket('${id}')">Concluir e encaminhar</button>` : ""}</div>`, "Fechar", closeModal);
    } catch (e) { notify(errorText(e, "Não foi possível abrir o requerimento.")); }
    finally { busy(false); }
  };
  window.downloadAttachment = async function (path) {
    const result = await db.client.storage.from("request-documents").createSignedUrl(path, 60);
    if (result.error || !result.data?.signedUrl) return notify("Não foi possível abrir o documento.");
    window.open(result.data.signedUrl, "_blank", "noopener,noreferrer");
  };
  window.addTicketNote = async function (id) {
    const note = document.getElementById("ticketObservation")?.value.trim();
    if (!note) return notify("Escreva uma observação.");
    const result = await db.client.rpc("add_request_note", { target_request_id: id, note_text: note });
    if (result.error) return notify(errorText(result.error, "Não foi possível salvar."));
    closeModal(); await refresh("requests"); notify("Observação salva.");
  };
  window.processTicket = async function (id) {
    const observation = document.getElementById("ticketObservation")?.value.trim() || "";
    const result = await db.client.rpc("advance_request", { target_request_id: id, observation });
    if (result.error) return notify(errorText(result.error, "Não foi possível encaminhar."));
    closeModal(); await refresh("requests"); notify("Etapa concluída e fluxo atualizado.");
  };
  window.requestTicketComplement = function (id) {
    dialog("Solicitar complemento", '<div class="field"><label>Orientação</label><textarea id="complementMessage" maxlength="2000"></textarea></div><div id="complementError" class="text-destructive text-small"></div>', "Enviar", async () => {
      const message = document.getElementById("complementMessage").value.trim();
      if (message.length < 3) return document.getElementById("complementError").textContent = "Informe a orientação.";
      const result = await db.client.rpc("request_complement", { target_request_id: id, message });
      if (result.error) return document.getElementById("complementError").textContent = errorText(result.error, "Não foi possível enviar.");
      closeModal(); await refresh("requests"); notify("Complemento solicitado.");
    });
  };

  window.renderSettings = function () {
    if (!isAdmin()) return;
    if (activeSettings === "users") return renderStaff();
    if (activeSettings === "departments") return renderDepartments();
    return renderRequirements();
  };
  function settingsHeader(title, action) {
    document.getElementById("settingsTitle").textContent = title;
    document.getElementById("settingsAction").textContent = action;
  }
  function roleOptions(selected) { return Object.entries(roles).map(([v, l]) => `<option value="${v}" ${selected === v ? "selected" : ""}>${l}</option>`).join(""); }
  function departmentOptions(selected) { return `<option value="">Sem departamento</option>${db.departments.filter((x) => x.is_active).map((x) => `<option value="${x.id}" ${selected === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}`; }

  window.renderStaff = function () {
    settingsHeader("Usuários", "+ Cadastrar usuário");
    document.getElementById("settingsContent").innerHTML = `<article class="panel"><div class="panel-head"><div><h2>Credenciais autorizadas</h2><span class="sub">Somente usuários desta lista podem entrar.</span></div></div><table class="table"><thead><tr><th>Nome</th><th>Perfil</th><th>Departamento</th><th>CPF</th><th>E-mail</th><th>Status</th><th></th></tr></thead><tbody>${db.adminUsers.map((u) => `<tr class="${u.is_active ? "" : "user-inactive"}"><td><strong>${esc(u.full_name)}</strong></td><td>${esc(roles[u.role] || u.role)}</td><td>${esc(u.department_name || "Sem departamento")}</td><td>${esc(cpf(u.cpf_digits))}</td><td>${esc(u.email)}</td><td><span class="status-dot ${u.is_active ? "" : "inactive"}"></span>${u.is_active ? "Ativo" : "Desativado"}</td><td><button class="link" onclick="editUser('${u.id}')">Editar</button> &nbsp; <button class="link" onclick="toggleUserAccess('${u.id}',${u.is_active})">${u.is_active ? "Desativar" : "Ativar"}</button></td></tr>`).join("")}</tbody></table></article>`;
  };

  function userForm(u) {
    const p = u ? "edit" : "";
    return `<div class="form-grid"><div class="field"><label>Nome completo</label><input id="${p}UserName" value="${esc(u?.full_name || "")}"></div><div class="field"><label>Perfil</label><select id="${p}UserRole">${roleOptions(u?.role || "attendant")}</select></div></div><div class="field"><label>Departamento</label><select id="${p}UserDept">${departmentOptions(u?.department_id)}</select></div><div class="field"><label>CPF (login)</label><input id="${p}UserCpf" value="${esc(cpf(u?.cpf_digits || ""))}"></div><div class="form-grid"><div class="field"><label>E-mail</label><input id="${p}UserEmail" type="email" value="${esc(u?.email || "")}"></div><div class="field"><label>Confirmar e-mail</label><input id="${p}UserEmailConfirm" type="email" value="${esc(u?.email || "")}"></div></div><div class="field"><label>${u ? "Nova senha (opcional)" : "Senha inicial"}</label><input id="${p}UserPassword" type="password" autocomplete="new-password" placeholder="10 caracteres, maiúscula, minúscula e número"></div><div id="${u ? "userFormError" : "newUserError"}" class="text-destructive text-small"></div>`;
  }
  function readUser(prefix) {
    const fullName = document.getElementById(`${prefix}UserName`)?.value.trim();
    const role = document.getElementById(`${prefix}UserRole`)?.value;
    const departmentId = document.getElementById(`${prefix}UserDept`)?.value || null;
    const cpfValue = document.getElementById(`${prefix}UserCpf`)?.value.trim();
    const email = document.getElementById(`${prefix}UserEmail`)?.value.trim().toLowerCase();
    const confirmation = document.getElementById(`${prefix}UserEmailConfirm`)?.value.trim().toLowerCase();
    const password = document.getElementById(`${prefix}UserPassword`)?.value || "";
    if (!fullName || !cpfValue || !email) return { error: "Preencha nome, CPF e e-mail." };
    if (email !== confirmation) return { error: "Os e-mails informados não são iguais." };
    return { fullName, role, departmentId, cpf: cpfValue, email, password };
  }

  window.settingsAdd = function () {
    if (activeSettings === "users") return dialog("Cadastrar usuário", userForm(null), "Criar credencial", saveNewUser);
    if (activeSettings === "departments") return dialog("Novo departamento", '<div class="field"><label>Nome</label><input id="newDepartmentName"></div><div class="field"><label>Responsabilidade</label><input id="newDepartmentPurpose"></div><div id="departmentError" class="text-destructive text-small"></div>', "Criar departamento", saveNewDepartment);
    dialog("Novo tipo", `<div class="field"><label>Nome</label><input id="requirementName"></div><div class="field"><label>Descrição</label><input id="requirementDescription"></div><div class="form-grid"><div class="field"><label>Primeiro departamento</label><select id="requirementDepartment">${departmentOptions("")}</select></div><div class="field"><label>Prazo (dias úteis)</label><input id="requirementDeadline" type="number" min="0" max="365" value="5"></div></div><div id="requirementError" class="text-destructive text-small"></div>`, "Criar tipo", saveNewType);
  };
  window.saveNewUser = async function () {
    const payload = readUser(""); const node = document.getElementById("newUserError");
    if (payload.error) return node.textContent = payload.error;
    try { await invoke("admin-users", { action: "create", ...payload }); closeModal(); activeSettings = "users"; await refresh("settings"); notify("Credencial criada e liberada."); }
    catch (e) { node.textContent = errorText(e, "Não foi possível criar o usuário."); }
  };
  window.editUser = function (id) { const u = db.adminUsers.find((x) => x.id === id); if (u) dialog("Editar usuário", userForm(u), "Salvar", () => saveUser(id)); };
  window.saveUser = async function (id) {
    const payload = readUser("edit"); const node = document.getElementById("userFormError");
    if (payload.error) return node.textContent = payload.error;
    try { await invoke("admin-users", { action: "update", userId: id, ...payload }); closeModal(); activeSettings = "users"; await refresh("settings"); notify("Usuário atualizado."); }
    catch (e) { node.textContent = errorText(e, "Não foi possível atualizar."); }
  };
  window.toggleUserAccess = function (id, active) {
    const u = db.adminUsers.find((x) => x.id === id);
    dialog(`${active ? "Desativar" : "Ativar"} acesso`, `<p>Confirmar alteração para <strong>${esc(u?.full_name)}</strong>?</p>`, active ? "Desativar" : "Ativar", async () => {
      try { await invoke("admin-users", { action: active ? "deactivate" : "activate", userId: id }); closeModal(); activeSettings = "users"; await refresh("settings"); notify(active ? "Acesso desativado." : "Acesso ativado."); }
      catch (e) { notify(errorText(e, "Não foi possível alterar o acesso.")); }
    }, active);
  };
  window.confirmDeleteUser = function (value) { const u = typeof value === "number" ? db.adminUsers[value] : db.adminUsers.find((x) => x.id === value); if (u) toggleUserAccess(u.id, u.is_active); };

  function renderDepartments() {
    settingsHeader("Departamentos", "+ Novo departamento");
    document.getElementById("settingsContent").innerHTML = `<article class="panel"><div class="panel-head"><h2>Departamentos cadastrados</h2></div><table class="table"><thead><tr><th>Departamento</th><th>Integrantes</th><th>Responsabilidade</th><th>Status</th><th></th></tr></thead><tbody>${db.departments.map((d) => `<tr class="${d.is_active ? "" : "user-inactive"}"><td><strong>${esc(d.name)}</strong></td><td>${db.memberships.filter((m) => m.department_id === d.id).length}</td><td>${esc(d.purpose)}</td><td>${d.is_active ? "Ativo" : "Inativo"}</td><td><button class="link" onclick="editDepartment('${d.id}')">Editar</button></td></tr>`).join("")}</tbody></table></article>`;
  }
  window.saveNewDepartment = async function () {
    const name = document.getElementById("newDepartmentName").value.trim();
    const purpose = document.getElementById("newDepartmentPurpose").value.trim();
    if (!name) return document.getElementById("departmentError").textContent = "Informe o nome.";
    const result = await db.client.from("departments").insert({ organization_id: orgId(), name, purpose });
    if (result.error) return document.getElementById("departmentError").textContent = errorText(result.error, "Não foi possível criar.");
    closeModal(); activeSettings = "departments"; await refresh("settings"); notify("Departamento criado.");
  };
  window.editDepartment = function (id) {
    const d = db.departments.find((x) => x.id === id); if (!d) return;
    dialog("Editar departamento", `<div class="field"><label>Nome</label><input id="departmentName" value="${esc(d.name)}"></div><div class="field"><label>Responsabilidade</label><input id="departmentPurpose" value="${esc(d.purpose)}"></div><div class="field"><label>Status</label><select id="departmentActive"><option value="true" ${d.is_active ? "selected" : ""}>Ativo</option><option value="false" ${!d.is_active ? "selected" : ""}>Inativo</option></select></div><div id="departmentError" class="text-destructive text-small"></div>`, "Salvar", async () => {
      const values = { name: document.getElementById("departmentName").value.trim(), purpose: document.getElementById("departmentPurpose").value.trim(), is_active: document.getElementById("departmentActive").value === "true" };
      const result = await db.client.from("departments").update(values).eq("id", id);
      if (result.error) return document.getElementById("departmentError").textContent = errorText(result.error, "Não foi possível atualizar.");
      closeModal(); activeSettings = "departments"; await refresh("settings"); notify("Departamento atualizado.");
    });
  };

  window.renderRequirements = function () {
    settingsHeader("Tipos de Requerimentos", "+ Novo tipo");
    document.getElementById("settingsContent").innerHTML = `<article class="panel"><div class="panel-head"><h2>Tipos e fluxos</h2></div><table class="table"><thead><tr><th>Requerimento</th><th>Prazo</th><th>Fluxo</th><th>Status</th><th></th></tr></thead><tbody>${db.types.map((t) => { const flow = db.steps.filter((s) => s.request_type_id === t.id && s.workflow_version === t.current_workflow_version).sort((a, b) => a.position - b.position); return `<tr class="${t.is_active ? "" : "user-inactive"}"><td><strong>${esc(t.name)}</strong><span class="sub">${esc(t.description)}</span></td><td>${t.default_deadline_business_days} dias úteis</td><td>${esc(flow.map((s) => s.label).join(" → ") || "Não configurado")}</td><td>${t.is_active ? "Ativo" : "Inativo"}</td><td><button class="link" onclick="flowEditor('${t.id}')">Editar etapa</button> &nbsp; <button class="link" onclick="editRequirementType('${t.id}')">Editar</button></td></tr>`; }).join("")}</tbody></table></article>`;
  };
  window.saveNewType = async function () {
    const name = document.getElementById("requirementName").value.trim();
    const description = document.getElementById("requirementDescription").value.trim();
    const departmentId = document.getElementById("requirementDepartment").value;
    const deadline = Number(document.getElementById("requirementDeadline").value);
    const node = document.getElementById("requirementError");
    if (!name || !departmentId || !Number.isInteger(deadline) || deadline < 0 || deadline > 365) return node.textContent = "Informe nome, departamento e prazo válido.";
    const created = await db.client.from("request_types").insert({ organization_id: orgId(), name, description, default_deadline_business_days: deadline }).select().single();
    if (created.error) return node.textContent = errorText(created.error, "Não foi possível criar o tipo.");
    const d = db.departments.find((x) => x.id === departmentId);
    const flow = await db.client.from("workflow_steps").insert([
      { organization_id: orgId(), request_type_id: created.data.id, position: 1, label: d.name, department_id: d.id, is_terminal: false },
      { organization_id: orgId(), request_type_id: created.data.id, position: 2, label: "Conclusão", department_id: null, is_terminal: true },
    ]);
    if (flow.error) return node.textContent = errorText(flow.error, "O tipo foi criado; configure o fluxo.");
    closeModal(); activeSettings = "types"; await refresh("settings"); notify("Tipo e fluxo inicial criados.");
  };
  window.editRequirementType = function (id) {
    const t = db.types.find((x) => x.id === id); if (!t) return;
    dialog("Editar tipo", `<div class="field"><label>Nome</label><input id="requirementName" value="${esc(t.name)}"></div><div class="field"><label>Descrição</label><input id="requirementDescription" value="${esc(t.description)}"></div><div class="form-grid"><div class="field"><label>Prazo</label><input id="requirementDeadline" type="number" min="0" max="365" value="${t.default_deadline_business_days}"></div><div class="field"><label>Status</label><select id="requirementActive"><option value="true" ${t.is_active ? "selected" : ""}>Ativo</option><option value="false" ${!t.is_active ? "selected" : ""}>Inativo</option></select></div></div><div id="requirementError" class="text-destructive text-small"></div>`, "Salvar", async () => {
      const values = { name: document.getElementById("requirementName").value.trim(), description: document.getElementById("requirementDescription").value.trim(), default_deadline_business_days: Number(document.getElementById("requirementDeadline").value), is_active: document.getElementById("requirementActive").value === "true" };
      const result = await db.client.from("request_types").update(values).eq("id", id);
      if (result.error) return document.getElementById("requirementError").textContent = errorText(result.error, "Não foi possível atualizar.");
      closeModal(); activeSettings = "types"; await refresh("settings"); notify("Tipo atualizado.");
    });
  };
  let workflowDraft = null;
  function workflowDepartmentOptions(selected) {
    return db.departments.filter((x) => x.is_active).map((x) => `<option value="${x.id}" ${selected === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  }
  function renderWorkflowEditor() {
    const t = db.types.find((x) => x.id === workflowDraft?.requestTypeId);
    if (!t || !workflowDraft) return;
    const rows = workflowDraft.departmentIds.map((departmentId, index) => `<div class="workflow-step-row"><span class="workflow-order">${index + 1}</span><div class="field"><label for="workflowDepartment${index}">Departamento responsável</label><select id="workflowDepartment${index}" onchange="updateWorkflowDepartment(${index},this.value)">${workflowDepartmentOptions(departmentId)}</select></div><div class="workflow-step-actions"><button type="button" class="btn" onclick="moveWorkflowStep(${index},-1)" ${index === 0 ? "disabled" : ""} aria-label="Mover etapa ${index + 1} para cima" title="Mover para cima">↑</button><button type="button" class="btn" onclick="moveWorkflowStep(${index},1)" ${index === workflowDraft.departmentIds.length - 1 ? "disabled" : ""} aria-label="Mover etapa ${index + 1} para baixo" title="Mover para baixo">↓</button><button type="button" class="link workflow-remove" onclick="removeWorkflowStep(${index})" ${workflowDraft.departmentIds.length === 1 ? "disabled" : ""}>Remover</button></div></div>`).join("");
    const addDisabled = db.departments.every((x) => !x.is_active) || workflowDraft.departmentIds.length >= 20;
    dialog(`Editar etapas: ${esc(t.name)}`, `<p class="workflow-help">A nova ordem será usada somente em novos requerimentos. Processos existentes manterão o fluxo original.</p><div class="workflow-editor">${rows}<div class="workflow-step-row workflow-terminal"><span class="workflow-order">${workflowDraft.departmentIds.length + 1}</span><div><strong>Conclusão</strong><span class="sub">Etapa final fixa</span></div></div></div><button type="button" class="btn" onclick="addWorkflowStep()" ${addDisabled ? "disabled" : ""}>+ Adicionar etapa</button><div id="flowError" class="text-destructive text-small"></div>`, "Salvar etapas", saveWorkflowSteps);
  }
  window.flowEditor = function (id) {
    const t = db.types.find((x) => x.id === id);
    if (!t) return;
    const flow = db.steps.filter((x) => x.request_type_id === id && x.workflow_version === t.current_workflow_version && !x.is_terminal).sort((a, b) => a.position - b.position);
    workflowDraft = { requestTypeId: id, version: t.current_workflow_version, departmentIds: flow.map((x) => x.department_id) };
    renderWorkflowEditor();
  };
  window.updateWorkflowDepartment = function (index, departmentId) {
    if (workflowDraft?.departmentIds[index] !== undefined) workflowDraft.departmentIds[index] = departmentId;
  };
  window.moveWorkflowStep = function (index, direction) {
    const target = index + direction;
    if (!workflowDraft || target < 0 || target >= workflowDraft.departmentIds.length) return;
    [workflowDraft.departmentIds[index], workflowDraft.departmentIds[target]] = [workflowDraft.departmentIds[target], workflowDraft.departmentIds[index]];
    renderWorkflowEditor();
  };
  window.addWorkflowStep = function () {
    const firstDepartment = db.departments.find((x) => x.is_active);
    if (!workflowDraft || !firstDepartment || workflowDraft.departmentIds.length >= 20) return;
    workflowDraft.departmentIds.push(firstDepartment.id);
    renderWorkflowEditor();
  };
  window.removeWorkflowStep = function (index) {
    if (!workflowDraft || workflowDraft.departmentIds.length <= 1) return;
    workflowDraft.departmentIds.splice(index, 1);
    renderWorkflowEditor();
  };
  async function saveWorkflowSteps() {
    const node = document.getElementById("flowError");
    if (!workflowDraft || workflowDraft.departmentIds.length < 1) return node.textContent = "Mantenha pelo menos uma etapa departamental.";
    const invalid = workflowDraft.departmentIds.some((id) => !db.departments.some((d) => d.id === id && d.is_active));
    if (invalid) return node.textContent = "Selecione somente departamentos ativos.";
    const result = await db.client.rpc("save_workflow_steps", {
      target_request_type_id: workflowDraft.requestTypeId,
      expected_workflow_version: workflowDraft.version,
      ordered_department_ids: workflowDraft.departmentIds,
    });
    if (result.error) return node.textContent = errorText(result.error, "Não foi possível salvar o fluxo.");
    closeModal(); activeSettings = "types"; workflowDraft = null; await refresh("settings"); notify("Etapas atualizadas para novos requerimentos.");
  }

  async function initialize() {
    data.credentials = {};
    if (!cfg.url || !cfg.publishableKey || !window.supabase?.createClient) {
      const card = document.querySelector(".login-card");
      card?.insertAdjacentHTML("beforeend", '<div class="backend-status">A integração com o Supabase precisa ser vinculada pela CLI.</div>');
      const button = card?.querySelector('button[type="submit"]'); if (button) button.disabled = true;
      return showLogin("Configuração do banco pendente.");
    }
    db.client = window.supabase.createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage } });
    db.recovery = /type=recovery/.test(location.hash + location.search);
    db.client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") { db.recovery = true; setTimeout(resetPasswordDialog, 0); }
      if (event === "SIGNED_OUT") showLogin();
    });
    const session = await db.client.auth.getSession();
    if (!session.data.session) return showLogin();
    try { await refresh(); if (db.recovery) setTimeout(resetPasswordDialog, 0); }
    catch (e) { await db.client.auth.signOut(); showLogin(errorText(e, "Seu acesso não está autorizado.")); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize); else initialize();
})();
