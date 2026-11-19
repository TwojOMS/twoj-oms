// Części wspólne pętli ofert ERLI i Allegro (`petla-ofert.js`, `petla-ofert-allegro.js`).
// Komunikat bramki mówi, o którą listę kont chodzi (parametr `kanal` w `bramkaZapisu`).
import { createHash, randomInt } from 'node:crypto';

const KLUCZ_ZNAKU = 'oferty.znak_instalacji';
// Bez znaków mylących na etykiecie (l/1, o/0, i).
const ALFABET_ZNAKU = 'abcdefghjkmnpqrstuvwxyz23456789';
// Pola treści — porównywane skrótem ostatnio wysłanej; reszta z odczytu kanału.
export const POLA_POZA_TRESCIA = ['price', 'stock', 'status'];

/** Znak instalacji: 6 losowych znaków, generowany raz i trwale w tabeli `ustawienia`. */
export function znakInstalacji(db, { losuj = randomInt, teraz = () => new Date() } = {}) {
  const istniejacy = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZNAKU);
  if (istniejacy) return String(istniejacy.wartosc);
  let znak = '';
  for (let i = 0; i < 6; i++) znak += ALFABET_ZNAKU[losuj(ALFABET_ZNAKU.length)];
  db.prepare('INSERT OR IGNORE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run(
    KLUCZ_ZNAKU,
    znak,
    teraz().toISOString(),
  );
  return String(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZNAKU).wartosc);
}

/** Przerwa przed próbą numer `n + 1` (ERLI nie daje Retry-After): 30 s, 1 min, 2 min… najwyżej 1 h. */
export function przerwaPonowienia(n) {
  return Math.min(30_000 * 2 ** Math.max(0, n - 1), 3_600_000);
}

export function stabilnie(w) {
  if (Array.isArray(w)) return `[${w.map(stabilnie).join(',')}]`;
  if (w && typeof w === 'object') {
    return `{${Object.keys(w)
      .sort()
      .filter((k) => w[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stabilnie(w[k])}`)
      .join(',')}}`;
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
  // Oferta obserwowana oddaje OMS-owi tylko jeden wąski zakres na raz — flaga jednego zakresu
  // nie otwiera żadnego innego (zwłaszcza PATCH treści z zakresem `null`).
  const obserwowana = oferta?.tryb === 'obserwowana';
  const samaIlosc = zakres === 'ilosc' && obserwowana && Number(oferta.ilosc_z_oms) === 1;
  const samaCena = zakres === 'cena' && obserwowana && Number(oferta.cena_z_oms) === 1;
  const samStatus = zakres === 'status' && obserwowana && Number(oferta.status_z_oms) === 1;
  if (
    !oferta ||
    oferta.kanal !== konto.klucz ||
    (oferta.tryb !== 'zarzadzana' && !samaIlosc && !samaCena && !samStatus)
  )
    return { wolno: false, powod: 'oferta nie jest zarządzana przez OMS' };
  return { wolno: true };
}

const ZAKRESY_WOO = ['cena', 'status'];

/**
 * Bramka zapisu ceny i statusu produktu Woo. Produkty Woo nie mają wiersza w rejestrze ofert, więc decyzja
 * opiera się na wierszu lustra (`produkty_sklepowe`): ten sklep, ta karta. Woo nie ma hamulca „oferty
 * wstrzymane” — zapis wyłącza klucz tylko do odczytu.
 */
export function bramkaZapisuWoo({ konto, klucze, produkt, kartaId, zakres }) {
  if (!konto || !klucze?.includes(konto.klucz)) return { wolno: false, powod: 'konto spoza listy kont Woo' };
  if (konto.tylkoOdczyt?.()) return { wolno: false, powod: 'konto w trybie tylko odczyt' };
  if (!produkt || produkt.kanal !== konto.klucz) return { wolno: false, powod: 'produkt nie należy do tego konta' };
  const karta = Number(kartaId);
  if (!Number.isSafeInteger(karta) || karta <= 0 || Number(produkt.karta_id) !== karta)
    return { wolno: false, powod: 'produkt nie jest powiązany z tą kartą' };
  if (!ZAKRESY_WOO.includes(zakres)) return { wolno: false, powod: 'zakres zapisu poza ceną i statusem' };
  // Cena znikniętego produktu trafiłaby donikąd albo do produktu odtworzonego pod tym samym id.
  if (zakres === 'cena' && produkt.zniknal_at) return { wolno: false, powod: 'produkt zniknął ze sklepu' };
  return { wolno: true };
}

/** Próg potwierdzenia ceny względem ceny w kanale. */
export function cenaWymagaPotwierdzenia(kanalGr, celGr, progBp) {
  return Number.isSafeInteger(kanalGr) && kanalGr > 0 && Math.abs(celGr - kanalGr) * 10000 > progBp * kanalGr;
}
