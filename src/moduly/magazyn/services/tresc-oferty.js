import { produktErliZKarty } from '../../../domena/erli-produkt.js';
import { iloscDlaKanalu } from '../../../domena/ilosc-kanalu.js';
import { wyjatekCennika } from '../../../oms/db/cenniki-kart.ts';
import { cenyReczneKarty } from '../../../oms/db/ceny-kanalow.js';

const ROZSZERZENIE_TYPU = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Ilość oferty zarządzanej z migawki stanów (D47); bez migawki (pętla do E4.07) — dzisiejsza stała. */
export function iloscOferty(migawka, kartaId, ustawienia) {
  if (!migawka) return undefined;
  return iloscDlaKanalu({
    migawka,
    kartaId: Number(kartaId),
    tryb: 'zarzadzana',
    bufor: ustawienia.buforSzt ?? 0,
    stalaIlosc: ustawienia.stalaIlosc ?? null,
  });
}

/** Jeden odczyt danych i jedno wyliczenie dla podglądu oraz pętli. `opcje.migawka` — jedna na żądanie (E4.06). */
export function trescOferty(db, kartaId, ustawienia, adresPublicznyZdjec = '', opcje = {}) {
  const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(kartaId);
  if (!karta) return { karta: null, bledy: ['Karta produktu nie istnieje.'], ostrzezenia: [], cialo: null };
  let opis = null;
  try {
    opis = karta.opis_sekcje_json ? JSON.parse(karta.opis_sekcje_json) : null;
  } catch {
    opis = { sekcje: 'niepoprawny JSON' };
  }
  const zdjecia = db
    .prepare('SELECT adres_zrodlowy, sha256, typ, ai FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id')
    .all(kartaId)
    .map((z) => ({ ...z, rozszerzenie: ROZSZERZENIE_TYPU[z.typ] }));
  const allegro = db
    .prepare("SELECT kategoria_id FROM karty_dane_kanalu WHERE karta_id = ? AND typ_kanalu = 'allegro'")
    .get(kartaId);
  const ilosc = iloscOferty(opcje.migawka, kartaId, ustawienia);
  // Wyjątek cennika dostaw z karty na koncie tych ustawień (bez klucza konta — bez wyjątku).
  const wyjatek =
    typeof ustawienia?.klucz === 'string' && ustawienia.klucz
      ? wyjatekCennika(db, { kartaId, konto: ustawienia.klucz })
      : null;
  // Ręczna cena karty na tym koncie — ten sam odczyt co podgląd wysyłki cen i okienko na karcie.
  const recznaGr =
    typeof ustawienia?.klucz === 'string' && ustawienia.klucz
      ? (cenyReczneKarty(db, kartaId).get(ustawienia.klucz) ?? null)
      : null;
  const { bledy, ostrzezenia, zadanie, dostawa } = produktErliZKarty({
    karta: { ...karta, opis },
    ustawienia,
    zdjecia,
    allegro,
    adresPublicznyZdjec,
    ilosc,
    wyjatekCennika: wyjatek,
    recznaGr,
  });
  const numery = (wartosc) => zdjecia.flatMap((z, i) => (z.ai === wartosc ? [i + 1] : []));
  const doOznaczenia = [...numery(1), ...numery(null)];
  if (doOznaczenia.length > 0) {
    ostrzezenia.push(
      `Zdjęcia ${doOznaczenia.join(', ')} mogą być wygenerowane przez AI. OMS nie oznacza tego w ERLI — jeśli tak jest, zaznacz to w panelu ERLI (tego znacznika nie da się potem wyłączyć).`,
    );
  }
  return {
    karta,
    bledy,
    ostrzezenia,
    dostawa,
    cialo: zadanie ? { ...zadanie, sku: karta.sku } : null,
    ilosc: ilosc ?? null,
  };
}
