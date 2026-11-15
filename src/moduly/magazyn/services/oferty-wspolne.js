// PRZ-160 E3.08a (D29) — części wspólne pętli ofert ERLI i Allegro, przeniesione z `petla-ofert.js`
// bez zmiany zachowania. Jedyna różnica: komunikat bramki mówi, o którą listę kont chodzi.
import { createHash, randomInt } from 'node:crypto';

const KLUCZ_ZNAKU = 'oferty.znak_instalacji';
// Bez znaków mylących na etykiecie (l/1, o/0, i).
const ALFABET_ZNAKU = 'abcdefghjkmnpqrstuvwxyz23456789';
// Pola treści — porównywane skrótem ostatnio wysłanej (decyzja 7); reszta z odczytu kanału.
export const POLA_POZA_TRESCIA = ['price', 'stock', 'status'];

/** Znak instalacji (D10): 6 losowych znaków, generowany raz i trwale w tabeli `ustawienia`. */
export function znakInstalacji(db, { losuj = randomInt, teraz = () => new Date() } = {}) {
  const istniejacy = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZNAKU);
  if (istniejacy) return String(istniejacy.wartosc);
  let znak = '';
  for (let i = 0; i < 6; i++) znak += ALFABET_ZNAKU[losuj(ALFABET_ZNAKU.length)];
  db.prepare('INSERT OR IGNORE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)')
    .run(KLUCZ_ZNAKU, znak, teraz().toISOString());
  return String(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZNAKU).wartosc);
}

/** Przerwa przed próbą numer `n + 1` (ERLI nie daje Retry-After): 30 s, 1 min, 2 min… najwyżej 1 h. */
export function przerwaPonowienia(n) {
  return Math.min(30_000 * 2 ** Math.max(0, n - 1), 3_600_000);
}

export function stabilnie(w) {
  if (Array.isArray(w)) return `[${w.map(stabilnie).join(',')}]`;
  if (w && typeof w === 'object') {
    return `{${Object.keys(w).sort().filter(k => w[k] !== undefined).map(k => `${JSON.stringify(k)}:${stabilnie(w[k])}`).join(',')}}`;
  }
  return JSON.stringify(w);
}

/** Skrót treści (bez ceny, ilości i statusu, które porównujemy z odczytem). */
export function skrotTresci(cialo) {
  const tresc = Object.fromEntries(Object.entries(cialo).filter(([k]) => !POLA_POZA_TRESCIA.includes(k)));
  return createHash('sha256').update(stabilnie(tresc)).digest('hex');
}

/** Jedyna decyzja „czy wolno pisać do kanału” — sprawdzana przed KAŻDYM zapisem. */
export function bramkaZapisu({ konto, ustawienia, oferta, klucze, kanal = 'ERLI', zakres = null }) {
  if (!konto || !klucze.includes(konto.klucz)) return { wolno: false, powod: `konto spoza listy kont ${kanal}` };
  if (!ustawienia?.czynne) return { wolno: false, powod: 'oferty wstrzymane' };
  if (konto.tylkoOdczyt?.()) return { wolno: false, powod: 'konto w trybie tylko odczyt' };
  const samaIlosc = zakres === 'ilosc' && oferta?.tryb === 'obserwowana' && Number(oferta.ilosc_z_oms) === 1;
  if (!oferta || oferta.kanal !== konto.klucz || (oferta.tryb !== 'zarzadzana' && !samaIlosc)) return { wolno: false, powod: 'oferta nie jest zarządzana przez OMS' };
  return { wolno: true };
}

/** Próg potwierdzenia ceny (D13a) względem ceny w kanale. */
export function cenaWymagaPotwierdzenia(kanalGr, celGr, progBp) {
  return Number.isSafeInteger(kanalGr) && kanalGr > 0 && Math.abs(celGr - kanalGr) * 10000 > progBp * kanalGr;
}
