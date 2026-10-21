// Text direction of user data (Persian, Arabic, Hebrew, ...): the Unicode bidi "first strong character" rule (UAX #9
// P2/P3). A value is RTL when its first strong character is right-to-left; digits, punctuation, spaces and other weak
// or neutral characters are skipped, so "12 سفارش" is RTL and "Order #12 سفارش" is LTR. The scan stops at the first
// strong character (O(first strong char)), and results are cached per value for the grid's draw loop.

/** Strong right-to-left (R / AL) code point, BMP and the supplementary RTL blocks. */
function isStrongRtl(c: number): boolean {
  if (c < 0x0590) return false;
  if (c <= 0x08ff) {
    // Hebrew: points/cantillation marks (0591-05C7 except the letter-like punctuation) are NSM
    if (c <= 0x05ff) return c === 0x05be || c === 0x05c0 || c === 0x05c3 || c === 0x05c6 || (c >= 0x05d0 && c <= 0x05f4);
    if (c <= 0x06ff) {
      // Arabic: digits (AN 0660-0669, EN 06F0-06F9 Persian), number signs, and combining marks are not strong
      if (c <= 0x0605 || c === 0x0609 || c === 0x060a || c === 0x060c || c === 0x060e || c === 0x060f || (c >= 0x0610 && c <= 0x061a) || (c >= 0x064b && c <= 0x065f) || (c >= 0x0660 && c <= 0x0669)) return false;
      if (c === 0x066a || c === 0x066b || c === 0x066c || c === 0x0670 || (c >= 0x06d6 && c <= 0x06ed && c !== 0x06e5 && c !== 0x06e6)) return false;
      if (c >= 0x06f0 && c <= 0x06f9) return false;
      return true;
    }
    // Syriac, Arabic Supplement, Thaana, N'Ko, Samaritan, Mandaic, Arabic Extended-A/B: letters (marks are rare
    // as a first character and never change the paragraph direction in practice)
    if (c === 0x0711) return false;
    if (c >= 0x0730 && c <= 0x074a) return false;
    if (c >= 0x07a6 && c <= 0x07b0) return false;
    if (c >= 0x07eb && c <= 0x07f3) return false;
    if (c >= 0x08d3 && c <= 0x08ff && c !== 0x08e2) return false;
    return true;
  }
  if (c === 0x200f || c === 0x061c) return true; // RLM, ALM
  if (c >= 0xfb1d && c <= 0xfb4f) return c !== 0xfb1e && c !== 0xfb29; // Hebrew presentation forms
  if (c >= 0xfb50 && c <= 0xfdff) return c !== 0xfd3e && c !== 0xfd3f && c !== 0xfdfd; // Arabic presentation forms A
  if (c >= 0xfe70 && c <= 0xfefc) return true; // Arabic presentation forms B
  // Supplementary: Cypriot..Old Turkic, Hanifi Rohingya, Yezidi, Adlam, Arabic mathematical symbols, ...
  if (c >= 0x10800 && c <= 0x10fff) return true;
  if (c >= 0x1e800 && c <= 0x1efff) return true;
  return false;
}

/** Strong left-to-right (L) code point (letters of the LTR scripts, LRM). */
function isStrongLtr(c: number): boolean {
  if (c < 0x80) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  if (c < 0x0590) {
    if (c === 0xaa || c === 0xb5 || c === 0xba) return true;
    if (c >= 0xc0 && c <= 0x2b8) return c !== 0xd7 && c !== 0xf7;
    if (c >= 0x0370 && c <= 0x0373) return true;
    if (c >= 0x0376 && c <= 0x0482 && c !== 0x037e && c !== 0x0384 && c !== 0x0385 && c !== 0x0387) return true;
    return c >= 0x048a && c <= 0x0589; // Cyrillic (rest), Armenian
  }
  if (c <= 0x08ff) return false;
  if (c === 0x200e) return true; // LRM
  if (c >= 0x0900 && c <= 0x1fff) return true; // Indic, SE Asian, Georgian, Hangul Jamo, Latin/Greek extended, ...
  if (c >= 0x2c00 && c <= 0x2ce4) return true;
  if (c >= 0x3040 && c <= 0x9fff) return true; // kana, CJK
  if (c >= 0xa000 && c <= 0xd7ff) return true; // Yi, Hangul, ...
  if (c >= 0xf900 && c <= 0xfb17) return true;
  if ((c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a) || (c >= 0xff66 && c <= 0xffdc)) return true;
  if (c >= 0x10000 && c < 0x10800) return true;
  if (c >= 0x11000 && c < 0x1e800) return true;
  if (c >= 0x20000 && c <= 0x3ffff) return true;
  return false;
}

/** Direction of `text` by its first strong character; null when it has none (numbers, punctuation, empty). */
export function firstStrongDirection(text: string): 'rtl' | 'ltr' | null {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x41) continue; // ASCII digits, spaces, punctuation: the hot path for numbers-first values
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (isStrongLtr(c)) return 'ltr';
    if (isStrongRtl(c)) return 'rtl';
  }
  return null;
}

const MAX_CACHE = 20_000;
let cache = new Map<string, boolean>();

/**
 * True when `text` is right-to-left by the first-strong rule. Cached per value (the grid asks on every frame); a
 * value whose first character is ASCII is answered without touching the cache.
 */
export function isRtlText(text: string): boolean {
  if (!text) return false;
  const c0 = text.charCodeAt(0);
  // Fast exit: a leading ASCII letter decides at once (the common case for LTR data), without hashing the value.
  if ((c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a)) return false;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const rtl = firstStrongDirection(text) === 'rtl';
  if (cache.size >= MAX_CACHE) cache = new Map();
  cache.set(text, rtl);
  return rtl;
}

/** `dir` attribute for a value shown in the DOM: "rtl" for RTL values, else "auto" (lets the browser decide). */
export function dirFor(text: string | null | undefined): 'rtl' | 'auto' {
  return text && isRtlText(text) ? 'rtl' : 'auto';
}
