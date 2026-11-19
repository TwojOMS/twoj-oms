import { nalozNadpisaniaPozycji } from '../../domena/pozycje-reczne.js';
import { kartaPozycji, zamowienieZdejmuje } from '../../domena/stany-magazynowe.js';

const DOBA_MS = 24 * 60 * 60 * 1000;

// Odstępy jako literał w SQL, nie parametr: tylko wtedy planista dopasuje indeksy pozycji na tych samych
// wyrażeniach (migracja zamówień 0005 trzyma kopię zestawu — zmiana tutaj wymaga nowego indeksu).
const ODSTEPY =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

// Identyfikatory zawężają odczyt. O tym, czy pozycja wskazuje kartę, rozstrzyga dopiero domena.
// Dla zamówień z poprawkami pobieramy wszystkie ich pozycje, żeby zachować indeksy starych wierszy bez zrodlo_id.
const SQL_SPRZEDAZ = `
  WITH identyfikatory AS MATERIALIZED (SELECT value FROM json_each(:identyfikatory)),
  pasujace AS MATERIALIZED (
    SELECT p.* FROM pozycje p
    WHERE trim(CAST(p.produkt_id AS TEXT), '${ODSTEPY}') IN identyfikatory
       OR trim(p.oferta_id, '${ODSTEPY}') IN identyfikatory
  ),
  zamowienia_karty AS MATERIALIZED (
    SELECT z.* FROM zamowienia z
    WHERE z.id IN (SELECT zamowienie_id FROM pasujace)
      AND z.sklep IN (SELECT value FROM json_each(:kanaly))
  ),
  pozycje_karty AS (
    SELECT p.* FROM pasujace p JOIN zamowienia_karty z ON z.id = p.zamowienie_id
    WHERE z.pozycje_reczne_json IS NULL
    UNION ALL
    SELECT p.* FROM zamowienia_karty z JOIN pozycje p ON p.zamowienie_id = z.id
    WHERE z.pozycje_reczne_json IS NOT NULL
  ),
  zamowienia_z_pozycjami AS (
    SELECT z.sklep, json_object(
      'anulowane', z.anulowane, 'anulowane_recznie', z.anulowane_recznie, 'status_woo', z.status_woo,
      'utworzone_at', z.utworzone_at, 'pozycje_reczne_json', z.pozycje_reczne_json,
      'pozycje', json_group_array(json_object(
        'id', p.id, 'zrodlo', p.zrodlo, 'zrodlo_id', p.zrodlo_id, 'produkt_id', p.produkt_id,
        'wariant_id', p.wariant_id, 'oferta_id', p.oferta_id, 'ilosc', p.ilosc,
        'nazwa', p.nazwa, 'cena_brutto', p.cena_brutto
      ) ORDER BY p.id)
    ) AS zamowienie
    FROM pozycje_karty p JOIN zamowienia_karty z ON z.id = p.zamowienie_id
    GROUP BY z.id
  ),
  sprzedaz AS (
    SELECT sklep, json_group_array(json(zamowienie)) AS zamowienia
    FROM zamowienia_z_pozycjami GROUP BY sklep
  )
  SELECT
    (SELECT json_group_object(sklep, json(zamowienia)) FROM sprzedaz) AS zamowienia,
    (SELECT json_group_array(json_object(
      'kanal', kanal, 'produktId', produkt_id, 'wariantId', wariant_id, 'kartaId', karta_id
    )) FROM produkty_sklepowe WHERE produkt_id IN identyfikatory) AS lustro,
    (SELECT json_group_array(json_object(
      'kanal', kanal, 'produktId', id_zewnetrzne, 'kartaId', karta_id
    )) FROM oferty_kanalow WHERE id_zewnetrzne IN identyfikatory) AS rejestr
`;

export function sprzedazKartyWedlugKanalu(db, kartaId, produkty, oferty, teraz = Date.now()) {
  const wynik = new Map();
  if (!produkty.length && !oferty.length) return wynik;

  const wiersze = db.prepare(SQL_SPRZEDAZ).get({
    identyfikatory: JSON.stringify([
      ...new Set([...produkty.map((p) => p.produkt_id), ...oferty.map((o) => o.idZewnetrzne)]),
    ]),
    kanaly: JSON.stringify([...new Set(['reczne', ...produkty.map((p) => p.kanal), ...oferty.map((o) => o.kanal)])]),
  });
  const lustro = Map.groupBy(JSON.parse(wiersze.lustro), (w) => w.produktId);
  const rejestr = Map.groupBy(JSON.parse(wiersze.rejestr), (w) => w.produktId);
  const kartyLustra = ({ kanal, produktId, wariantId }) => {
    const pasujace = (lustro.get(produktId) ?? []).filter(
      (p) => (kanal === null || p.kanal === kanal) && (wariantId === null || p.wariantId === wariantId),
    );
    // Jak przy rozchodzie, wiersz lustra (także bez karty) ma pierwszeństwo przed rejestrem.
    if (!pasujace.length && wariantId === null) {
      return (rejestr.get(produktId) ?? []).filter((o) => o.kanal === kanal).map((o) => o.kartaId);
    }
    return pasujace.map((p) => p.kartaId);
  };

  // Przedział ma długość dokładnie 30 dób także przy zmianie czasu w Warszawie.
  const granica = teraz - 30 * DOBA_MS;
  for (const [kanal, zamowienia] of Object.entries(JSON.parse(wiersze.zamowienia))) {
    const sztuki = { lacznie: 0, ostatnie30Dni: 0 };
    for (const z of zamowienia) {
      if (!zamowienieZdejmuje(z)) continue;
      const pozycje = z.pozycje_reczne_json ? nalozNadpisaniaPozycji(z.pozycje, z.pozycje_reczne_json) : z.pozycje;
      const data = Date.parse(z.utworzone_at);
      for (const p of pozycje) {
        const ilosc = Number(p.ilosc);
        if (!Number.isInteger(ilosc) || ilosc <= 0 || kartaPozycji(p, kanal, kartyLustra)?.kartaId !== kartaId)
          continue;
        sztuki.lacznie += ilosc;
        if (data >= granica && data <= teraz) sztuki.ostatnie30Dni += ilosc;
      }
    }
    wynik.set(kanal, sztuki);
  }
  return wynik;
}
