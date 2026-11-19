import { adresKanalu } from '../../domena/kanaly.js';
import { fmtDataCzas } from '../../domena/format-daty.js';
import { cenaPolska, zl } from '../../domena/kwoty.js';

// Karta pokazuje tylko ostatnie zmiany; pełny ślad zostaje w tabeli, a liczba wszystkich jest w nagłówku.
export const LIMIT_HISTORII = 50;

const POLA = { cena: 'cena', status: 'status', steruj_cena: 'sterowanie ceną' };
const WYNIKI = { ok: 'zapisano', blad: 'błąd', w_toku: 'w toku' };
const RODZAJE_CELU = { produkt: 'produkt', wariant: 'wariant', oferta: 'oferta' };

function opisCelu(cel) {
  // Cel „karta” to ręczna cena ustawiona na karcie, a nie zapis na ofercie w kanale.
  if (cel === 'karta') return 'ręczna cena na karcie';
  const [rodzaj, ...reszta] = String(cel).split(':');
  return RODZAJE_CELU[rodzaj] && reszta.length ? `${RODZAJE_CELU[rodzaj]} ${reszta.join(':')}` : String(cel);
}

function opisWartosci({ cel, pole }, wartosc) {
  if (pole === 'cena') {
    // Brak ceny ręcznej na karcie znaczy, że kanał bierze cenę z narzutu konta.
    if (wartosc === null) return cel === 'karta' ? 'narzut konta' : '—';
    const gr = Number(wartosc);
    return Number.isFinite(gr) ? cenaPolska(zl(gr)) : wartosc;
  }
  if (pole === 'steruj_cena') return { 0: 'wyłączone', 1: 'włączone' }[wartosc] ?? wartosc ?? '—';
  return wartosc ?? '—';
}

/** Ostatnie zmiany wysłane do kanałów dla jednej karty; `null`, gdy karta nie ma żadnego wpisu. */
export function historiaZmianKanalow(db, kartaId, definicje) {
  const lacznie = Number(
    db.prepare('SELECT COUNT(*) AS n FROM zmiany_w_kanalach WHERE karta_id = ?').get(kartaId)?.n ?? 0,
  );
  if (!lacznie) return null;
  // Przy tej samej chwili późniejszy wpis ma większy id, więc też idzie wyżej.
  const wiersze = db
    .prepare(
      `SELECT id, kanal, cel, pole, stara, nowa, kto, at, wynik, blad FROM zmiany_w_kanalach
       WHERE karta_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(kartaId, LIMIT_HISTORII);
  return {
    lacznie,
    ucieto: lacznie > wiersze.length,
    wpisy: wiersze.map((w) => ({
      id: Number(w.id),
      kto: w.kto,
      kiedy: fmtDataCzas(w.at) || w.at,
      kanal: adresKanalu(w.kanal, definicje),
      oferta: opisCelu(w.cel),
      pole: POLA[w.pole] ?? w.pole,
      bylo: opisWartosci(w, w.stara),
      jest: opisWartosci(w, w.nowa),
      wynik: WYNIKI[w.wynik] ?? w.wynik,
      blad: w.blad,
    })),
  };
}
