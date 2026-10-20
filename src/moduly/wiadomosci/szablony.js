import {
  trescPotwierdzenia, modelPotwierdzenia, modelZamowienia, blokiTekstuPotwierdzenia,
} from '../../domena/potwierdzenie-zamowienia.js';
import { modelWiadomosci, jakoTekstWiadomosci, TEMAT_MAILA, blokiTekstuWiadomosci } from '../../domena/wiadomosc-platnicza.js';
import {
  zlozTresc, zlozTemat, polaZamowienia, liniePodpisu, rodzajSzablonu, PLATNICZE,
} from '../../domena/szablony-wiadomosci.js';
import { adresatKlienta } from '../../domena/adresat-klienta.js';
import { dzienWarszawa } from '../../domena/format-daty.js';
import { renderPotwierdzenieHtml, blokiHtmlPotwierdzenia } from '../../core/poczta/potwierdzenie-html.js';
import { renderWiadomoscHtml, blokiHtmlWiadomosci } from '../../core/poczta/wiadomosc-html.js';
import { renderSzablonHtml, podpisHtml } from '../../core/poczta/szablon-html.js';
import { tekstZeStopka } from './oprawa.js';
import { trescMaila } from '../ustawienia/poczta-kont.js';
import { odbiorcaPrzelewu } from '../../domena/adres-sprzedawcy.js';
import { modelWyslane, blokiTekstuWyslane } from '../../domena/wiadomosc-wyslane.js';
import { blokiHtmlWyslane } from '../../core/poczta/wyslane-html.js';
import { zdaniaDoMaila, tekstyModelu } from '../../domena/zdania-platnosci.js';

/** Link w podglądzie maila do pracownika — zmyślony, nie prowadzi nigdzie (PRZ-101.06). */
export const PRZYKLADOWY_LINK = 'https://panel.example/haslo/przykladowy-link';

// SKŁADANIE MAILA ZE SZABLONU (PRZ-101.03) — jedno miejsce dla podglądu na karcie, wysyłki, podglądu
// w Ustawieniach i wstawiania szablonu w odpowiedzi Allegro.
//
// ⚠️ `szablon = null` (nikt nie zapisał zmiany) = DZISIEJSZA DROGA: te same funkcje, które składały mail przed
// szablonami (`trescPotwierdzenia`, `jakoTekstWiadomosci`, renderery HTML). Produkcja bez zapisu nie zmienia ani
// znaku. Zapisany szablon idzie przez `zlozTresc` + `renderSzablonHtml` z blokami policzonymi z TEGO SAMEGO modelu.

function zeSzablonu(szablon, { pola, blokiTekst, blokiHtml, oprawa }) {
  const { czesci, tekst } = zlozTresc(szablon.tresc, { pola, bloki: blokiTekst });
  return { temat: zlozTemat(szablon.temat, pola), tekst, html: renderSzablonHtml(czesci, blokiHtml, oprawa) };
}

/** Potwierdzenie przyjęcia zamówienia. Rzuca odmowę domeny (anulowane, bez adresu, bez pozycji). */
// PRZ-102.19: `zdania` — teksty z Ustawień → Szablony wiadomości (zdaniaPlatnosciTeraz w usłudze); brak = domyślne.
export function mailPotwierdzenia(z, { oprawa, szablon = null, zdania = null }) {
  if (!szablon) {
    const mail = trescPotwierdzenia(z, { podpis: oprawa.podpis, zdania });
    return { do: mail.do, temat: mail.temat, tekst: mail.tekst, html: renderPotwierdzenieHtml(mail.model, oprawa), model: mail.model };
  }
  const model = modelPotwierdzenia(z, { podpis: oprawa.podpis, zdania });
  return {
    do: adresatKlienta(z),
    ...zeSzablonu(szablon, {
      pola: polaZamowienia(z, { podpis: model.sprzedawca }),
      blokiTekst: { ...blokiTekstuPotwierdzenia(model), podpis: liniePodpisu(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
      blokiHtml: { ...blokiHtmlPotwierdzenia(model), podpis: podpisHtml(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
      oprawa,
    }),
    model,
  };
}

/** Proforma, faktura, przypomnienie — `model` z `modelWiadomosci` (usługa zna kopertę i załączniki). */
export function mailPlatniczy(z, model, { temat_id, dokument = null, oprawa, szablon = null }) {
  if (!szablon) {
    return { temat: TEMAT_MAILA[temat_id](z, dokument), tekst: jakoTekstWiadomosci(model), html: renderWiadomoscHtml(model, oprawa) };
  }
  const pola = {
    ...polaZamowienia(z, { podpis: model.sprzedawca }), numer_dokumentu: String(dokument?.numer ?? ''), zamkniecie: model.zamkniecie,
    // Z TEGO SAMEGO modelu, co sekcja DO ZAPŁATY — pole i blok nie mogą pokazać różnych kwot.
    do_zaplaty: model.platnosc?.doZaplaty ?? '',
  };
  return zeSzablonu(szablon, {
    pola,
    blokiTekst: { ...blokiTekstuWiadomosci(model), podpis: liniePodpisu(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
    blokiHtml: { ...blokiHtmlWiadomosci(model), podpis: podpisHtml(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
    oprawa,
  });
}

/** Szablon własny do kupującego z karty zamówienia. Bez załączników i bez danych do przelewu. */
export function mailWlasny(z, szablon, { oprawa, zdania = null }) {
  const model = modelZamowienia(z, { podpis: oprawa.podpis, zdania });
  const { pozycje, wysylka, dane_do_faktury } = blokiTekstuPotwierdzenia(model);
  const html = blokiHtmlPotwierdzenia(model);
  return {
    do: adresatKlienta(z),
    ...zeSzablonu(szablon, {
      pola: polaZamowienia(z, { podpis: model.sprzedawca }),
      blokiTekst: { pozycje, wysylka, dane_do_faktury, podpis: liniePodpisu(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
      blokiHtml: { pozycje: html.pozycje, wysylka: html.wysylka, dane_do_faktury: html.dane_do_faktury, podpis: podpisHtml(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
      oprawa,
    }),
  };
}

/**
 * PRZ-102.21: „Zamówienie wysłane" — zawsze ze szablonu (zapisanego albo domyślnego): starej drogi nie ma.
 * Bez załączników i bez danych do przelewu. Brak paczki z numerem odrzuca wcześniej `czyWolnoWyslac`.
 */
export function mailWyslane(z, szablon, { oprawa, zdania = null }) {
  const { sprzedawca, teksty } = modelZamowienia(z, { podpis: oprawa.podpis, zdania });
  const model = modelWyslane(z);
  return {
    do: adresatKlienta(z),
    ...zeSzablonu(szablon, {
      pola: polaZamowienia(z, { podpis: sprzedawca }),
      blokiTekst: { ...blokiTekstuWyslane(model), podpis: liniePodpisu(sprzedawca, teksty.pozdrowienie) },
      blokiHtml: { ...blokiHtmlWyslane(model), podpis: podpisHtml(sprzedawca, teksty.pozdrowienie) },
      oprawa,
    }),
  };
}

/**
 * Tekst szablonu własnego do odpowiedzi w wątku Allegro (sam tekst — Allegro nie przyjmuje HTML-u).
 * `z = null` (wątek bez rozpoznanego zamówienia): pola puste, bloki zamówienia znikają, zostaje podpis.
 */
export function tekstDoWatku(z, szablon, { podpis, zdania = null }) {
  if (!z) {
    const { pozdrowienie } = zdaniaDoMaila(zdania ?? {});
    return zlozTresc(szablon.tresc, { pola: polaZamowienia(null, { podpis }), bloki: { podpis: liniePodpisu(podpis, pozdrowienie) } }).tekst;
  }
  const model = modelZamowienia(z, { podpis, zdania });
  const { pozycje, wysylka, dane_do_faktury } = blokiTekstuPotwierdzenia(model);
  return zlozTresc(szablon.tresc, {
    pola: polaZamowienia(z, { podpis: model.sprzedawca }),
    bloki: { pozycje, wysylka, dane_do_faktury, podpis: liniePodpisu(model.sprzedawca, tekstyModelu(model).pozdrowienie) },
  }).tekst;
}

// ——— Podgląd w Ustawieniach na przykładowym zamówieniu ————————————————————————————————————
// Dane zamówienia i rachunek ZMYŚLONE (ten sam katalog lamp, co demo). Odbiorca z konfiguracji firmy, jak w mailu.
export const PRZYKLADOWY_RACHUNEK = '00 1111 2222 3333 4444 5555 6666';

export function przykladoweZamowienie(teraz = new Date()) {
  const wczoraj = new Date(new Date(teraz).getTime() - 24 * 3600 * 1000).toISOString();
  return {
    id: 0, numer: '1024', sklep: 'reczne', utworzone_at: wczoraj,
    kwota_brutto: '476.00', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45',
    metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', termin_platnosci: '14', pobranie: 0, platnosci: [],
    chce_fakture: 0, anulowane: 0,
    klient: { first_name: 'Anna', last_name: 'Nowak', email: 'anna.nowak@example.com', phone: '' },
    dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
    pozycje: [
      { nazwa: 'Lampa stołowa Grzybek 30 cm', sku: 'LMP-GRZ-30', ilosc: 2, cena_brutto: '189.00', brutto_linii: '378.00' },
      { nazwa: 'Klosz lniany 40 cm', sku: 'KLS-LEN-40', ilosc: 1, cena_brutto: '79.00', brutto_linii: '79.00' },
    ],
    // PRZ-102.21: jedna nadana paczka DPD — podgląd „Zamówienie wysłane" pokazuje numer i link śledzenia.
    przesylki: [{ kurier: 'dpd', status: 'nadana', numer_listu: '0000123456789U' }],
  };
}

/** Mail z (jeszcze niezapisanego) szablonu na przykładowym zamówieniu — to, co pokazuje „Podgląd". */
// PRZ-102.17: `zdania` — zdania o płatności z panelu (zdaniaPlatnosciTeraz); brak = domyślne.
// PRZ-102.18: `config` — odbiorca przelewu tą samą funkcją co prawdziwy mail.
export function podgladSzablonu(id, szablon, { oprawa, config = {}, teraz = new Date(), zdania = null }) {
  const rodzaj = rodzajSzablonu(id);
  // PRZ-101.06: mail do pracownika — ta sama funkcja, która go wysyła, ale z ZMYŚLONYM linkiem: prawdziwego tokenu
  // podgląd nie wydaje i nie pokazuje. Bez oprawy (marki i stopki) — tak jak dzisiejszy mail do pracownika.
  if (rodzaj === 'konto') {
    const m = trescMaila({ cel: id, imie: 'Anna', link: PRZYKLADOWY_LINK, szablon });
    return { do: 'anna.nowak@example.com', temat: m.subject, tekst: m.text, html: m.html };
  }
  const z = przykladoweZamowienie(teraz);
  let mail;
  if (rodzaj === 'potwierdzenie') mail = mailPotwierdzenia(z, { oprawa, szablon, zdania });
  else if (rodzaj === 'wyslane') mail = mailWyslane(z, szablon, { oprawa, zdania });
  else if (PLATNICZE.includes(rodzaj)) {
    const dokument = { numer: rodzaj === 'faktura' ? 'FV 12/10/2026' : 'PF 7/10/2026' };
    const model = modelWiadomosci(z, {
      temat_id: rodzaj, dokument, zalacznikProformy: rodzaj === 'przypomnienie' ? dokument.numer : null,
      zalaczonyDokument: true, rachunek: PRZYKLADOWY_RACHUNEK, odbiorca: odbiorcaPrzelewu(config),
      dzis: dzienWarszawa(new Date(teraz).toISOString()), podpis: oprawa.podpis, zdania,
    });
    mail = { do: adresatKlienta(z), ...mailPlatniczy(z, model, { temat_id: rodzaj, dokument, oprawa, szablon }) };
  } else mail = mailWlasny(z, szablon, { oprawa, zdania });
  return { do: mail.do, temat: mail.temat, tekst: tekstZeStopka(mail.tekst, oprawa.footer), html: mail.html };
}
