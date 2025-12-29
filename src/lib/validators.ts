// Lightweight validators for email and phone (no external deps)
export function isLikelyEmail(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  // Pragmatic, permissive regex that covers most real emails (not full RFC 5322)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return emailRegex.test(t);
}

export function isLikelyPhone(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  // Allow digits, common separators and extensions
  if (!/^[0-9()+\-\s\.extEXT]+$/.test(t)) return false;
  const digits = (t.replace(/\D/g, '') || '').length;
  // Most phone numbers have at least 7 digits and up to 15 digits internationally
  return digits >= 7 && digits <= 15;
}