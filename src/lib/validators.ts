// Lightweight validators for email and phone (no external deps)
export function isLikelyEmail(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  // Pragmatic, permissive regex that covers most real emails (not full RFC 5322)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return emailRegex.test(t);
}

export function isLikelyPhone(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  // Allow digits, common separators and extensions
  if (!/^[0-9()+\-\s\.extEXT]+$/.test(t)) return false;
  const digits = (t.replace(/\D/g, '') || '').length;
  // Most phone numbers have at least 7 digits and up to 15 digits internationally
  return digits >= 7 && digits <= 15;
}

// New: detect birthdate-ish strings (MM/DD/YYYY, YYYY-MM-DD, Month D, YYYY, etc.)
export function isLikelyBirthdate(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  // Common patterns: 05/12/2008, 5/12/08, 2008-05-12, May 12, 2008, 12 May 2008
  const patterns = [
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/, // 05/12/2008 or 5-12-08
    /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/, // 2008-05-12
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s*\d{4})?\b/i // May 12, 2008
  ];
  return patterns.some(rx => rx.test(t));
}

// ExtID heuristics: numeric or alphanumeric possibly prefixed with '#', shorter token, often near beginning
export function isLikelyExtID(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  // Remove common labels like 'ID:' or 'ID' prefix
  const t2 = t.replace(/^ID[:\s]*#/i, '').replace(/^#/, '');
  // Typical extids are shortish (1-12 chars) and mostly alnum with -/_/.
  if (!/^[A-Za-z0-9\-\_\#]{1,20}$/.test(t2)) return false;
  // If it is purely digits and length looks like a 10 or 11 digit phone, consider it ambiguous (likely phone elsewhere)
  const digits = (t2.replace(/\D/g, '') || '').length;
  if (digits >= 10 && digits <= 11 && t2.length === digits) return false;
  return true;
}

// Full name heuristic: two or three capitalized words or 'Last, First' forms
export function isLikelyName(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (/^[A-ZÁÉÍÓÚÜÑÉÈÊÇÂÎÔÛÜŒ]+,\s*[A-Z]+/i.test(t)) return true; // Last, First
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 1 && parts.length <= 4 && parts.every(p => /^[A-ZÁÉÍÓÚÜÑÉÈÊÇÂÎÔÛÜŒ][a-z\-'áéíóúüñéèêçâîôûüœ]+$/.test(p))) return true;
  return false;
}

// Preferred name detection: quoted or parenthesized nickname/preferred name
export function isLikelyPreferredName(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (/\".+\"/.test(t) || /\(.+\)/.test(t)) return true;
  // Also common when a separate small token is present in a 'Preferred Name' column
  if (/^[A-Za-z\-']{1,20}$/.test(t) && t.length <= 16) return true;
  return false;
}
// Lexical/Gazetteer helper: check if text contains a month name
export function containsMonth(s: string | undefined): boolean {
  if (!s) return false;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const lowerText = s.toLowerCase();
  return months.some(month => lowerText.includes(month));
}

// Lexical/Gazetteer helper: check if text contains day suffix (1st, 2nd, 3rd, etc.)
export function containsDaySuffix(s: string | undefined): boolean {
  if (!s) return false;
  return /\b\d{1,2}(?:st|nd|rd|th)\b/i.test(s);
}

// Lexical/Gazetteer helper: check if text is a common first name
export function isCommonFirstName(s: string | undefined): boolean {
  if (!s) return false;
  const text = s.trim();
  
  // Top 100 most common first names (abbreviated list for demonstration)
  const commonNames = new Set([
    'james', 'mary', 'john', 'patricia', 'robert', 'jennifer', 'michael', 'linda',
    'william', 'barbara', 'david', 'elizabeth', 'richard', 'susan', 'joseph', 'jessica',
    'thomas', 'sarah', 'charles', 'karen', 'christopher', 'nancy', 'daniel', 'lisa',
    'matthew', 'betty', 'anthony', 'margaret', 'mark', 'sandra', 'donald', 'ashley',
    'steven', 'dorothy', 'paul', 'kimberly', 'andrew', 'emily', 'joshua', 'donna',
    'kenneth', 'michelle', 'kevin', 'carol', 'brian', 'amanda', 'george', 'melissa',
    'edward', 'deborah', 'ronald', 'stephanie', 'timothy', 'rebecca', 'jason', 'sharon',
    'jeffrey', 'laura', 'ryan', 'cynthia', 'jacob', 'kathleen', 'gary', 'amy',
    'nicholas', 'shirley', 'eric', 'angela', 'jonathan', 'helen', 'stephen', 'anna',
    'larry', 'brenda', 'justin', 'pamela', 'scott', 'nicole', 'brandon', 'emma',
    'benjamin', 'samantha', 'samuel', 'katherine', 'frank', 'christine', 'gregory', 'debra',
    'alexander', 'rachel', 'raymond', 'catherine', 'patrick', 'carolyn', 'jack', 'janet',
    'dennis', 'ruth', 'jerry', 'maria', 'tyler', 'heather', 'aaron', 'diane',
    // Modern popular names
    'noah', 'liam', 'oliver', 'elijah', 'william', 'james', 'benjamin', 'lucas',
    'henry', 'alexander', 'mason', 'michael', 'ethan', 'daniel', 'jacob', 'logan',
    'jackson', 'levi', 'sebastian', 'mateo', 'jack', 'owen', 'theodore', 'aiden',
    'olivia', 'emma', 'ava', 'sophia', 'isabella', 'charlotte', 'amelia', 'mia',
    'harper', 'evelyn', 'abigail', 'emily', 'ella', 'elizabeth', 'camila', 'luna',
    'sofia', 'avery', 'mila', 'aria', 'scarlett', 'penelope', 'layla', 'chloe'
  ]);
  
  return commonNames.has(text.toLowerCase());
}