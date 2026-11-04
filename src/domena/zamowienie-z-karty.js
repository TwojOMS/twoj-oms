import { bladOperatora } from './bledy.js';
import { METODA_DOMYSLNA } from './moduly-kurierow.ts';
import { parsujKosztDostawy } from './koszt-dostawy.js';
import { parsujNowaPozycje } from './pozycje-reczne.js';
import { czyWdt } from './wdt.js';
import { metodaWysylkiZWyboru, PLATNOSCI } from './nowe-zamowienie.js';

/**
 * Zadanie panelu indywidualnego → `dane` dla zalozZamowienieReczne.
 *
 * ⚠️ WLASNEGO PARSERA CEN I ILOSCI TU NIE MA i miec nie moze. Pozycje ida przez
 * `parsujNowaPozycje` — te sama funkcje, co formularz „Nowe zamowienie" i „Dodaj pozycje"
 * na karcie. Druga regula przeliczania brutto/netto rozjechalaby sie przy pierwszej
 * zmianie stawki VAT, a rozjazd widac dopiero na fakturze.
 *
 * ⚠️ DPD + PRZELEW NA SZTYWNO (decyzja wlasciciela 2026-08-05): tor manualny panelu to
 * przedplata i kurier. Nietypowy przypadek poprawia sie na karcie w OMS-ie.
 *
 * ⚠️ CALOSC PARSUJEMY PRZED PIERWSZYM ZAPISEM — dokladnie z tego samego powodu, co formularz
 * (domain/nowe-zamowienie.js): odmowa w polowie zostawilaby zamowienie z nadanym numerem,
 * ktorego nie da sie zwolnic, a karta panelu dostalaby blad i zalozylaby drugie.
 */
// PRZ-105: `stawkaDomyslna` (z Ustawień) podaje trasa — pozycje bez pola `vat` dostają ją, nie wbudowane 23.
// PRZ-122.B07c: `zw` (flaga programu wbudowanego) dopuszcza stawkę „zw” — jak na karcie; bez flagi jak dotąd.
// PRZ-122.B07f: `zwolniona` (firma zwolniona z VAT) — numer UE nabywcy to nie WDT, ceny bez stawki 0.
export function parsujZamowienieZKarty(body = {}, { stawkaDomyslna, zw = false, zwolniona = false } = {}) {
  const kartaId = String(body?.kartaId ?? '').trim();
  if (!kartaId) throw bladOperatora('Żądanie bez identyfikatora karty — nie ma czego oznaczyć.');
  const { metoda, pobranie } = metodaWysylkiZWyboru(METODA_DOMYSLNA, 'przelew');

  const wejscie = Array.isArray(body?.pozycje) ? body.pozycje : [];
  const pozycje = wejscie.map((p, i) => {
    try { return parsujNowaPozycje(p, { stawkaDomyslna, wdt: czyWdt(body?.nip, { zwolniona }), zw }); }
    catch (e) { throw bladOperatora(`Pozycja ${i + 1}: ${e.message}`); }
  });

  return {
    karta_id: kartaId,
    // ⚠️ Znacznik kanalu raportowego. Patrz spec §7 i ostrzezenie przy INSERCIE.
    indywidualne: 1,
    klient: body?.klient ?? null,
    dostawa: body?.dostawa ?? null,
    nip: body?.nip ?? null,
    chce_fakture: body?.chceFakture ? 1 : 0,
    metoda_wysylki: metoda,
    pobranie,
    // ⚠️ ETYKIETA DLA CZLOWIEKA ZE SLOWNIKA, nie wpisany tu drugi raz napis „Przelew”.
    // Lista wyboru w filtrach buduje sie z DISTINCT tej kolumny (db/filtry.js) — wlasna
    // kopia napisu rozjechalaby sie z formularzem przy pierwszej poprawce pisowni
    // i dala w filtrze dwie pozycje wygladajace na te sama.
    metoda_platnosci: PLATNOSCI.przelew,
    koszt_dostawy_brutto: parsujKosztDostawy(body?.kosztDostawyBrutto),
    uwagi: body?.uwagi ?? null,
    pozycje,
  };
}
