import { ofertaPoIdZewnetrznym } from '../../../oms/db/oferty-kanalow.ts';

export const LIMIT_STRONY_PRZEJECIA = 100;
export const MAKS_STRON_PRZEJECIA = 20;

/** Tylko odczyt. ERLI oddaje tablicę, a kursor bierze się z ostatniego produktu odpowiedzi. */
export async function pobierzOfertyReczne(konto) {
  const produkty = new Map();
  let after;
  for (let strona = 0; strona < MAKS_STRON_PRZEJECIA; strona++) {
    const wynik = await konto.katalog.odczytOfert({
      pagination: {
        sortField: 'externalId',
        order: 'ASC',
        limit: LIMIT_STRONY_PRZEJECIA,
        ...(after === undefined ? {} : { after }),
      },
    });
    if (!wynik.ok) throw new Error('Nie udało się odczytać ofert ERLI. Spróbuj ponownie.');
    const lista = Array.isArray(wynik.dane) ? wynik.dane : wynik.dane?.products;
    if (!Array.isArray(lista)) throw new Error('Niepoprawna odpowiedź odczytu ofert ERLI.');
    let nowe = 0;
    for (const p of lista) {
      if (typeof p?.externalId !== 'string' || !p.externalId.trim()) continue;
      if (!produkty.has(p.externalId)) {
        produkty.set(p.externalId, p);
        nowe++;
      }
    }
    if (lista.length < LIMIT_STRONY_PRZEJECIA) return { produkty: [...produkty.values()], limit: false };
    const nastepny = lista.at(-1)?.cursor ?? lista.at(-1)?.externalId;
    if (!nowe || !nastepny || nastepny === after)
      throw new Error('ERLI nie przesuwa strony wyników. Pobierz oferty ponownie.');
    after = nastepny;
  }
  return { produkty: [...produkty.values()], limit: true };
}

export function propozycjePrzejecia(db, kanal, produkty) {
  const karty = db.prepare('SELECT id, sku, ean, nazwa FROM karty_produktow').all();
  const tekst = (v) => (typeof v === 'string' ? v.trim() : '');
  return produkty
    .filter((p) => !ofertaPoIdZewnetrznym(db, kanal, p.externalId))
    .map((p) => {
      const ean = tekst(p.ean);
      const poEan = ean ? karty.filter((k) => tekst(k.ean) === ean) : [];
      const poSku = karty.filter((k) => tekst(k.sku) && [tekst(p.sku), tekst(p.externalId)].includes(tekst(k.sku)));
      const pasujace = poEan.length ? poEan : poSku;
      const karta = pasujace.length === 1 ? pasujace[0] : null;
      const powod =
        pasujace.length > 1
          ? `Niejednoznaczny ${poEan.length ? 'EAN' : 'SKU'} — kilka kart.`
          : karta
            ? `Dopasowanie po ${poEan.length ? 'EAN' : 'SKU'}`
            : 'Brak dopasowania po EAN lub SKU';
      return { produkt: p, karta, powod };
    });
}

/** Bez await wewnątrz: wszystkie zapisy albo żaden. */
export function transakcjaOfert(db, wykonaj) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = wykonaj();
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
