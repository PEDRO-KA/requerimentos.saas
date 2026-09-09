(function (root) {
  const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

  function cpfDigits(value) {
    return digitsOnly(value).slice(0, 11);
  }

  function formatCpf(value) {
    const digits = cpfDigits(value);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  function isValidCpf(value) {
    const digits = cpfDigits(value);
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    const calculate = (length) => {
      let total = 0;
      for (let index = 0; index < length; index += 1) total += Number(digits[index]) * (length + 1 - index);
      const candidate = 11 - (total % 11);
      return candidate >= 10 ? 0 : candidate;
    };
    return calculate(9) === Number(digits[9]) && calculate(10) === Number(digits[10]);
  }

  function mobileDigits(value) {
    let digits = digitsOnly(value);
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
    return digits.slice(0, 11);
  }

  function formatMobile(value) {
    const digits = mobileDigits(value);
    if (!digits) return "";
    if (digits.length <= 2) return `(${digits}`;
    if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  function isValidMobile(value) {
    return /^[1-9][0-9]9[0-9]{8}$/.test(mobileDigits(value));
  }

  function normalizeSearch(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function isValidBirthDate(value, today = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;
    const [year, month, day] = value.split("-").map(Number);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return false;
    const limit = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return date <= limit;
  }

  root.StudentUtils = { cpfDigits, formatCpf, isValidCpf, mobileDigits, formatMobile, isValidMobile, normalizeSearch, isValidEmail, isValidBirthDate };
})(globalThis);
