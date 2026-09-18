(function (root) {
  const closedStatuses = new Set(["completed", "rejected", "canceled"]);
  const staffRoles = new Set(["admin", "coordinator", "attendant"]);

  function isClosed(status) {
    return closedStatuses.has(status);
  }

  function canActOnRequest(request, member) {
    if (!request || !member || isClosed(request.status)) return false;
    if (member.role === "admin") return true;
    return staffRoles.has(member.role)
      && Boolean(member.department_id)
      && request.current_department_id === member.department_id;
  }

  function canAddRequestContent(request, member, userId) {
    return canActOnRequest(request, member);
  }

  function hasAdvancedRequest(events, userId) {
    return Boolean(userId) && (events || []).some((event) =>
      event.actor_id === userId
      && (event.event_type === "forwarded" || event.to_status === "completed"));
  }

  function canRequestComplement(request, member, hasAdvanced) {
    if (!request || !member || isClosed(request.status)) return false;
    return canActOnRequest(request, member)
      || (hasAdvanced && staffRoles.has(member.role));
  }

  function requestScope(request, member) {
    if (isClosed(request?.status)) return "completed";
    if (member?.role === "admin") return "queue";
    if (member?.department_id && request?.current_department_id === member.department_id) return "queue";
    return "tracking";
  }

  function matchesPeriod(createdAt, period, now = Date.now()) {
    if (!period || period === "all") return true;
    const created = new Date(createdAt);
    const current = new Date(now);
    if (!Number.isFinite(created.getTime()) || !Number.isFinite(current.getTime())) return false;
    const start = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const days = period === "today" ? 1 : Number(period);
    if (![1, 7, 30].includes(days)) return true;
    start.setDate(start.getDate() - (days - 1));
    return created >= start && created < end;
  }

  function matchesDate(createdAt, dateValue) {
    if (!dateValue) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return false;
    const created = new Date(createdAt);
    if (!Number.isFinite(created.getTime())) return false;
    const key = [
      created.getFullYear(),
      String(created.getMonth() + 1).padStart(2, "0"),
      String(created.getDate()).padStart(2, "0"),
    ].join("-");
    return key === dateValue;
  }

  root.RequestUtils = {
    isClosed,
    canActOnRequest,
    canAddRequestContent,
    hasAdvancedRequest,
    canRequestComplement,
    requestScope,
    matchesPeriod,
    matchesDate,
  };
})(globalThis);
