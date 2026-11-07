// Preferencja przeglądarki, tak jak motyw. Rozwinięcie w Ustawieniach jest lokalne.
export function menuZwinieteZNaglowka(cookie) {
  return String(cookie ?? '').split(';').some(wpis => wpis.trim() === 'oms_menu=zwiniete');
}

export function ciasteczkoMenu(zwiniete) {
  return `oms_menu=${zwiniete ? 'zwiniete' : 'rozwiniete'}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}
