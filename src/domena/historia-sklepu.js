import { dzienWarszawa } from './format-daty.js';


// Zamiana surowego zamowienia WooCommerce na wiersz `sprzedaz_historyczna`.
//
// ⚠️⚠️ TEN MODUL JEST JEDYNYM MIEJSCEM, W KTORYM DANE OSOBOWE KLIENTA MOGA SIE POJAWIC —
// i wychodzi z niego wiersz, ktory ich NIE MA. Mail i nazwisko sa potrzebne wylacznie
// do DECYZJI (zamowienie testowe? klient WDT?), ktora zapada w `decyzja()` nizej, w pamieci.
// Do bazy nie leci nic: `klientEmail` i `klientNazwa` sa twardo `null`.
// Cena tej decyzji jest jawna i opisana w planie
// (plan importu historii sklepu z 27.08.2026): wskaznik
// „nowi kontra powracajacy" nie policzy sie przed granica ery Apilo.

/** Konto Apilo, ktore w `kanaly-raportowe.js` odpowiada danemu sklepowi. */


/** Statusy, ktore SA sprzedaza. Cokolwiek spoza obu list PRZERYWA import (patrz `decyzja`). */
export const STATUSY_LICZONE = new Set(['completed', 'processing']);

/**
 * Statusy, ktore sprzedaza NIE sa. `pending` i `on-hold` to koszyk, za ktory nikt nie zaplacil;
 * `refunded` to zwrot calkowity — raport ma wlasne pojecie zwrotu i doliczanie ich tutaj
 * liczyloby ten sam pieniadz dwa razy.
 */
export const STATUSY_ODRZUCONE = new Set([
  'pending', 'on-hold', 'cancelled', 'refunded', 'failed', 'trash', 'checkout-draft',
]);

const dwaMiejsca = (n) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Brutto linii w zlotowkach.
 *
 * ⚠️ `line_items[].total` W WOOCOMMERCE JEST NETTO (po rabatach, bez VAT-u), a podatek stoi
 * osobno w `total_tax`. Sama `total` zanizylaby kazda pozycje o 23% — ranking produktow
 * wygladalby poprawnie (proporcje te same), a kwoty nie zgadzalyby sie z naglowkiem.
 */
export const bruttoLiniiZl = (p) => dwaMiejsca(Number(p.total ?? 0) + Number(p.total_tax ?? 0));

export function wierszHistorii(sklep, z, { konta }) {
  const konto = konta.get(sklep);
  // ⚠️ PRZERYWA, a nie wpada do worka. Sklep bez konta nie ma kanalu raportowego, wiec
  // `kanalHistoryczny` i tak by sie wywalil — lepiej tutaj, z nazwa sklepu w komunikacie.
  if (konto === undefined) throw new Error(`Nie znam konta raportowego dla sklepu "${sklep}".`);

  // ⚠️⚠️ `date_created_gmt` + 'Z', NIGDY `date_created`. Woo oddaje GMT BEZ oznaczenia strefy,
  // a `dzienWarszawa` traktuje wartosc bez strefy jako czas WARSZAWSKI — czyli surowe
  // `date_created_gmt` zostaloby przesuniete o dwie godziny w zla strone. `date_created`
  // (lokalny) dalby dzis ten sam dzien, ale zalezy od ustawienia strefy w WordPressie:
  // jedno klikniecie w panelu sklepu przepisaloby archiwum sprzed lat.
  const utworzoneAt = `${z.date_created_gmt}Z`;

  const pozycje = [
    ...(z.line_items ?? []).map((p) => ({
      nazwa: p.name,
      sku: p.sku || null,
      // Ten sam ksztalt, co `originalCode` z Apilo ('<produkt>|<wariant>') — dzieki temu
      // regula rozpoznajaca zaslepke panelu ofert ('28040|…') dziala bez wyjatku dla Woo.
      originalCode: `${p.product_id}|${p.variation_id ?? 0}`,
      ilosc: Number(p.quantity ?? 0),
      bruttoLinii: bruttoLiniiZl(p),
      typ: 1,
    })),
    ...(z.shipping_lines ?? []).map((p) => ({
      nazwa: p.method_title, sku: null, originalCode: null,
      ilosc: 1, bruttoLinii: bruttoLiniiZl(p), typ: 2,
    })),
    ...(z.fee_lines ?? []).map((p) => ({
      nazwa: p.name, sku: null, originalCode: null,
      ilosc: 1, bruttoLinii: bruttoLiniiZl(p), typ: 2,
    })),
  ];

  return {
    apiloId: `woo:${sklep}:${z.id}`,
    zrodlo: `woo:${sklep}`,
    platformAccountId: konto,
    numer: String(z.number ?? z.id),
    dzien: dzienWarszawa(utworzoneAt),
    utworzoneAt,
    brutto: String(z.total),
    waluta: z.currency ?? 'PLN',
    // Kolumna `status` trzyma LICZBOWE statusy Apilo; wpisanie tam numerka udajacego Woo
    // byloby klamstwem widocznym dopiero przy `STATUSY_ODRZUCONE.has(w.status)` w raporcie.
    status: null,
    statusZrodla: z.status,
    paymentStatus: z.date_paid_gmt ? 2 : null,
    tagi: [],
    // ⚠️⚠️ TU KONCZY SIE DROGA DANYCH OSOBOWYCH. Nie zmieniac bez decyzji z planu.
    klientEmail: null,
    klientNazwa: null,
    // ⚠️ 0 znaczy „nie wiemy", a nie „paragon". Woo nie zapisuje zadania faktury w sposob,
    // ktoremu mozna zaufac wstecz — raport MUSI o tym powiedziec (domain/zastrzezenia-historii.js).
    faktura: 0,
    pozycje,
  };
}

/**
 * Co zrobic z surowym zamowieniem sklepu: zapisac, pominac czy PRZERWAC caly import.
 *
 * ⚠️⚠️ KOLEJNOSC MA ZNACZENIE. Klient WDT idzie PIERWSZY, przed wykluczeniem testowych:
 * gdyby kiedys ktoras z tych regul objela adres WDT-owca, import po cichu wyrzucilby
 * zamowienie zamiast sie zatrzymac — a to jest dokladnie ten przypadek, ktorego archiwum
 * bez maila nie umie juz naprawic pozniej.
 *
 * ⚠️ TO JEST SWIADOME ODEJSCIE OD ZASADY „klasyfikuj przy odczycie" (`kanaly-raportowe.js`).
 * Powod: obie te reguly czytaja MAILA, a maila w archiwum nie bedzie. Koszt jest przyjety
 * z otwartymi oczami — zmiana reguly wymaga powtorzenia importu. Powtorzenie jest tanie:
 * zrodlem jest nasz wlasny sklep, ktory nigdzie sie nie wybiera (inaczej niz Apilo).
 */
export function decyzja(z, { klienciWdt = new Set(), czyTestowe = () => false } = {}) {
  const b = z?.billing ?? {};
  const email = String(b.email ?? '');
  const nazwa = `${b.first_name ?? ''} ${b.last_name ?? ''} ${b.company ?? ''}`;

  if (klienciWdt.has(email.toLowerCase())) {
    return {
      akcja: 'stop',
      powod: `Zamowienie ${z.number}: klient WDT w oknie importu. Archiwum nie przechowuje`
        + ' maila, wiec regula 0% VAT nie zadzialaby przy odczycie i sprzedaz zostalaby'
        + ' zanizona o 23%. Rozstrzygnij recznie przed wznowieniem.',
    };
  }
  if (czyTestowe(email, nazwa)) return { akcja: 'pomin', powod: 'testowe' };
  if (STATUSY_ODRZUCONE.has(z.status)) return { akcja: 'pomin', powod: `status ${z.status}` };
  if (!STATUSY_LICZONE.has(z.status)) {
    return {
      akcja: 'stop',
      powod: `Nieznany status WooCommerce: "${z.status}" (zamowienie ${z.number}).`
        + ' Dopisz go do STATUSY_LICZONE albo STATUSY_ODRZUCONE — po pomiarze, nie na oko.',
    };
  }
  return { akcja: 'zapisz', powod: null };
}
