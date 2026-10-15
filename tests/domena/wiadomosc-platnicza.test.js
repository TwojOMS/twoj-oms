import { describe, it, expect } from 'vitest';
import { modelWiadomosci, jakoTekstWiadomosci, TEMAT_MAILA } from '../pomoc/platnicza-parytetu.js';
import { renderWiadomoscHtml } from '../pomoc/wiadomosc-html-parytetu.js';
import { stanPlatnosci, STAN_PLATNOSCI } from '../../src/domena/blok-platnosci.js';

const zam = (nad = {}) => ({
  numer: 'R/2026/015', utworzone_at: '2026-08-21T09:15:00', kwota_brutto: '990.00',
  metoda_wysylki: 'dpd', pobranie: 0, platnosci: [], termin_platnosci: '14',
  // ⚠️ E-MAIL SIEDZI W `klient`, nie w `dostawa` — `adresOdbiorcy` i `daneFaktury` czytają
  // OBA `klient.email` (różnią się dopiero ręcznymi nadpisaniami). Fikstura z `dostawa.email`
  // dawałaby zamówienie BEZ adresata i milczącą odmowę.
  klient: { email: 'sklep@betamet.pl' },
  pozycje: [{ zrodlo_id: 1, nazwa: 'Szablon', ilosc: 10, cena_brutto: '99.00', brutto_linii: '990.00' }],
  koszt_dostawy_brutto: '0.00', ...nad,
});

const opcje = {
  rachunek: '07 1090 1014 0000 0000 0000 0001',
  odbiorca: 'Lumina Marek Zywiecki',
  dzis: '2026-08-22',
};

describe('temat maila', () => {
  it('proforma i faktura niosą numer dokumentu', () => {
    expect(TEMAT_MAILA.proforma(zam(), { numer: 'PF/3/08/2026' }))
      .toBe('Proforma PF/3/08/2026 — zamówienie nr R/2026/015');
    expect(TEMAT_MAILA.faktura(zam(), { numer: '42/08/2026' }))
      .toBe('Faktura 42/08/2026 — zamówienie nr R/2026/015');
  });

  it('przypomnienie niesie sam numer zamówienia', () => {
    expect(TEMAT_MAILA.przypomnienie(zam(), null))
      .toBe('Przypomnienie o płatności — zamówienie nr R/2026/015');
  });

  // ⚠️ ŁATKA `.replace('  ', ' ')` ZASTĄPIONA NORMALIZACJĄ (sprzątanie po recenzji całości
  // gałęzi, 22.08.2026). Stara wersja stała w DWÓCH kopiach i była wadliwa tak samo w obu:
  // `String.replace` z NAPISEM podmienia wyłącznie PIERWSZE wystąpienie, więc temat z dwiema
  // dziurami naraz dalej wychodził z podwójnym odstępem — tyle że w drugim miejscu. Odstępu
  // na końcu nie obcinała nigdy.
  it('brak numeru dokumentu nie zostawia podwójnego odstępu ani ogona', () => {
    expect(TEMAT_MAILA.proforma(zam(), null)).toBe('Proforma — zamówienie nr R/2026/015');
    for (const temat of [TEMAT_MAILA.proforma({}, null), TEMAT_MAILA.faktura({}, null),
      TEMAT_MAILA.przypomnienie({})]) {
      expect(temat).not.toMatch(/ {2}/);
      expect(temat).not.toMatch(/\s$/);
    }
  });
});

describe('model wiadomości', () => {
  it('przypomnienie: kwota, przelew i zdanie o załączonej proformie', () => {
    const m = modelWiadomosci(zam(), {
      temat_id: 'przypomnienie', dokument: { numer: 'PF/3/08/2026' }, zalacznikProformy: 'PF/3/08/2026', ...opcje,
    });
    expect(m.wiodace).toBe('przypominamy o płatności za zamówienie nr R/2026/015 z dnia 2026-08-21.');
    expect(m.platnosc).toMatchObject({ doZaplaty: '990,00 zł', tytul: 'PF/3/08/2026', termin: 'termin 14 dni — do 2026-09-04' });
    expect(m.zdanieDokumentu).toBe('W załączeniu proforma PF/3/08/2026.');
    expect(m.zamkniecie).toContain('Jeśli płatność już wyszła');
    expect(m.sprzedawca).toBe('Szkicownia.pl');
  });

  // ⚠️⚠️ BŁĄD Z RECENZJI (22.08.2026): zdanie o załączonej proformie zależało od TEMATU
  // (`temat_id === 'przypomnienie'`) i od tego, czy jest PODANY `dokument` — a nie od tego,
  // co NAPRAWDĘ jedzie w załączniku. `dokument` przy przypomnieniu bywa numerem FAKTURY
  // (bo to on jedzie do tytułu przelewu), więc stare zdanie nazywało fakturę proformą.
  it('przypomnienie BEZ załączonej proformy nie ma zdania o załączniku', () => {
    const m = modelWiadomosci(zam(), { temat_id: 'przypomnienie', dokument: { numer: '42/08/2026' }, ...opcje });
    expect(m.zdanieDokumentu).toBeNull();
  });

  it('proforma: własne zdanie wiodące i zdanie o realizacji', () => {
    const m = modelWiadomosci(zam(), { temat_id: 'proforma', dokument: { numer: 'PF/3/08/2026' }, ...opcje });
    expect(m.wiodace).toBe('w załączeniu przesyłamy proformę PF/3/08/2026 do zamówienia nr R/2026/015.');
    expect(m.zdanieDokumentu).toBeNull();
    expect(m.zamkniecie).toContain('Po zaksięgowaniu wpłaty');
  });

  it('faktura nieopłacona ma blok przelewu z numerem faktury w tytule', () => {
    const m = modelWiadomosci(zam(), { temat_id: 'faktura', dokument: { numer: '42/08/2026' }, ...opcje });
    expect(m.wiodace).toBe('w załączeniu przesyłamy fakturę 42/08/2026 do zamówienia nr R/2026/015.');
    expect(m.platnosc.tytul).toBe('42/08/2026');
  });

  // ⚠️ Faktura do zamówienia opłaconego NIE ŻĄDA pieniędzy — blok znika, a zamiast niego
  // stoi podziękowanie. Prośba o zapłatę czegoś, co klient zapłacił, to telefon reklamacyjny.
  //
  // ⚠️⚠️ FIKSTURA MUSI BYĆ NAPRAWDĘ „POKRYTE" (recenzja 22.08.2026), nie „jakikolwiek brak
  // bloku" — `platnosc === null` ma CZTERY różne powody i tylko jeden z nich to podziękowanie.
  // Asercja na `stanPlatnosci` obok treści dowodzi, że ten test broni WŁAŚCIWEGO powodu,
  // a nie zdaje egzamin przypadkiem, bo fikstura akurat trafiła w inny z czterech.
  it('faktura opłacona: bez bloku, z podziękowaniem', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(stanPlatnosci(z, opcje)).toBe(STAN_PLATNOSCI.POKRYTE);
    const m = modelWiadomosci(z, { temat_id: 'faktura', dokument: { numer: '42/08/2026' }, ...opcje });
    expect(m.platnosc).toBeNull();
    expect(m.zamkniecie).toContain('Zamówienie jest opłacone');
  });

  // ⚠️⚠️ BŁĄD Z RECENZJI (22.08.2026): `platnosc === null` ma CZTERY różne powody, a przed tą
  // poprawką `zamkniecie` czytało tylko `Boolean(platnosc)` — więc FAKTURA DO ZAMÓWIENIA ZA
  // POBRANIEM mówiła klientowi „Zamówienie jest opłacone", zanim kurier cokolwiek zainkasował.
  it('faktura przy pobraniu NIE mówi "opłacone" — mówi o kurierze', () => {
    const z = zam({ pobranie: 1, kwota_pobrania: '990.00' });
    const m = modelWiadomosci(z, { temat_id: 'faktura', dokument: { numer: '42/08/2026' }, ...opcje });
    expect(m.platnosc).toBeNull();
    expect(m.zamkniecie).not.toContain('opłacone');
    expect(m.zamkniecie).toContain('kurier');
  });

  // Ten sam błąd, inny z czterech powodów: brak rachunku w konfiguracji to NASZA usterka,
  // nie dowód, że klient zapłacił.
  // ⚠️ `zalaczonyDokument: true` NIE JEST OZDOBNIKIEM FIKSTURY: faktura ZAWSZE jedzie z PDF-em
  // (services/wiadomosci.js pobiera go z inFaktu przed złożeniem modelu), więc zdanie „na
  // dokumencie w załączniku" jest tu prawdziwe. Odwrotny przypadek — przypomnienie BEZ
  // proformy, czyli mail bez ani jednego załącznika — ma własny test niżej.
  it('faktura bez rachunku NIE mówi "opłacone" — odsyła do dokumentu', () => {
    const m = modelWiadomosci(zam(), {
      temat_id: 'faktura', dokument: { numer: '42/08/2026' }, zalaczonyDokument: true, ...opcje, rachunek: null,
    });
    expect(m.platnosc).toBeNull();
    expect(m.zamkniecie).not.toContain('opłacone');
    expect(m.zamkniecie).toContain('dokumencie');
  });

  // ⚠️⚠️ ZDANIE SPAROWANE Z FAKTEM (sprzątanie po recenzji całości gałęzi, 22.08.2026) — ta
  // sama klasa błędu, którą naprawiliśmy przy `zdanieDokumentu`. Przy braku rachunku
  // przypomnienie BEZ proformy nie ma w kopercie NICZEGO, a mimo to odsyłało klienta „na
  // dokument w załączniku". Mail zapowiadający dokument, którego nie ma, jest gorszy niż mail
  // bez dokumentu: klient szuka załącznika, nie znajduje i dzwoni.
  it('przypomnienie BEZ załącznika nie odsyła do dokumentu, którego nie ma', () => {
    const m = modelWiadomosci(zam(), {
      temat_id: 'przypomnienie', dokument: null, ...opcje, rachunek: null,
    });
    expect(m.platnosc).toBeNull();
    expect(m.zamkniecie).not.toContain('załączniku');
    expect(m.zamkniecie).not.toContain('dokumencie');
    expect(m.zamkniecie).not.toContain('opłacone');
    // Klient dostaje DROGĘ WYJŚCIA, a nie samo milczenie o pieniądzach (niezmiennik 4.9).
    expect(m.zamkniecie).toContain('odpowiedzi na tego maila');
  });

  // ⚠️⚠️ CZWARTY Z CZTERECH POWODÓW, DOPISANY PO WERYFIKACJI MUTACYJNEJ ZADANIA 10
  // (22.08.2026, scripts/mutacje-wiadomosci.mjs). `stanPlatnosci` miał już test na stan
  // „błąd wyceny" (tests/oms/wiadomosci-domena.test.js), ale nic nie sprawdzało, CO
  // `zamkniecie` w tym stanie mówi klientowi — a to jest funkcja, którą naprawdę czyta mail.
  // Bez tego strażnika błąd wyceny cicho spada do zdania „Po zaksięgowaniu wpłaty…" (przy
  // temacie „proforma") albo do ogólnego „Jeśli coś się nie zgadza…" (przy pozostałych) —
  // czyli mail zaczyna zapewniać coś o pieniądzach, których panel sam nie umie policzyć.
  // Ta sama gałąź i to samo zdanie co przy braku rachunku wyżej (`BRAK_RACHUNKU` i `BLAD`
  // dzielą JEDNO „nie wolno twierdzić niczego o pieniądzach" — zamkniecie() w
  // wiadomosc-platnicza.js), więc i asercja jest ta sama; różni się tylko sposób wymuszenia
  // stanu — POZYCJA Z PUSTĄ CENĄ, ta sama sztuczka co w teście „blad" w
  // wiadomosci-domena.test.js (`grosze()` rzuca, `saldoWplat` łapie i oddaje `stan: 'blad'`).
  it('faktura z błędem wyceny pozycji NIE mówi "opłacone" — odsyła do dokumentu', () => {
    const z = zam({
      pozycje: [{ zrodlo_id: 1, nazwa: 'Zepsuta pozycja', ilosc: 1, cena_brutto: '', brutto_linii: null }],
    });
    expect(stanPlatnosci(z, opcje)).toBe(STAN_PLATNOSCI.BLAD);
    const m = modelWiadomosci(z, {
      temat_id: 'faktura', dokument: { numer: '42/08/2026' }, zalaczonyDokument: true, ...opcje,
    });
    expect(m.platnosc).toBeNull();
    expect(m.zamkniecie).not.toContain('opłacone');
    expect(m.zamkniecie).toContain('dokumencie');
  });

  // ⚠️ NIEZNANY TEMAT RZUCA, NIE UDAJE PRZYPOMNIENIA (recenzja 22.08.2026). Fallback
  // `WIODACE[temat_id] ?? WIODACE.przypomnienie` po cichu wysyłałby treść przypomnienia pod
  // tematem, którego nikt nie wybrał — literówka w wywołaniu (np. `temat_id: 'faktóra'`)
  // nie dałaby żadnego sygnału, tylko klienta z mailem podpisanym niewłaściwie.
  it('temat nieznany rzuca, nie udaje przypomnienia', () => {
    expect(() => modelWiadomosci(zam(), { temat_id: 'costam', ...opcje })).toThrow(/costam/);
  });
});

describe('wersja tekstowa', () => {
  it('ma sekcje i te same kwoty, co model', () => {
    const m = modelWiadomosci(zam(), { temat_id: 'przypomnienie', dokument: { numer: 'PF/3/08/2026' }, ...opcje });
    const t = jakoTekstWiadomosci(m);
    expect(t).toContain('DO ZAPŁATY');
    expect(t).toContain('990,00 zł');
    expect(t).toContain('PRZELEW');
    expect(t).toContain('Tytuł przelewu: PF/3/08/2026');
    expect(t).toContain('Termin: termin 14 dni — do 2026-09-04');
    expect(t.endsWith('Szkicownia.pl')).toBe(true);
  });

  // ⚠️ Bez bloku płatności tekst NIE MA pustych nagłówków — sekcja bez treści czyta się
  // jak usterka systemu.
  it('bez bloku płatności nie ma nagłówków przelewu', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    const m = modelWiadomosci(z, { temat_id: 'faktura', dokument: { numer: '42/08/2026' }, ...opcje });
    const t = jakoTekstWiadomosci(m);
    expect(t).not.toContain('PRZELEW');
    expect(t).not.toContain('DO ZAPŁATY');
  });
});

describe('renderer HTML', () => {
  const model = (nad = {}) => modelWiadomosci(zam(nad), {
    temat_id: 'przypomnienie', dokument: { numer: 'PF/3/08/2026' }, ...opcje,
  });

  it('jest kompletnym dokumentem z kopertą', () => {
    const html = renderWiadomoscHtml(model());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('SZKICOWNIA');
  });

  // ⚠️ TABELA, nie akapit ze spacjami — dane do przelewu klient PRZEPISUJE do banku.
  it('dane do przelewu stoją w tabeli, z kwotą i tytułem', () => {
    const html = renderWiadomoscHtml(model());
    expect(html).toContain('<table');
    expect(html).toContain('990,00 zł');
    expect(html).toContain('PF/3/08/2026');
    expect(html).toContain('Tytuł przelewu');
  });

  // ⚠️ FIKSTURA MUSI BYĆ NAPRAWDĘ „POKRYTE" (recenzja 22.08.2026, ta sama uwaga co w
  // wiadomosc-platnicza.test.js) — patrz asercja na `stanPlatnosci` obok treści.
  it('bez bloku płatności nie ma sekcji przelewu', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(stanPlatnosci(z, opcje)).toBe(STAN_PLATNOSCI.POKRYTE);
    const html = renderWiadomoscHtml(modelWiadomosci(
      z,
      { temat_id: 'faktura', dokument: { numer: '42/08/2026' }, ...opcje },
    ));
    expect(html).not.toContain('Tytuł przelewu');
    expect(html).toContain('Zamówienie jest opłacone');
  });

  // ⚠️ Escapowanie należy do renderera treści — koperta wpuszcza `body` bez zmian.
  it('escapuje dane z zamówienia', () => {
    const html = renderWiadomoscHtml(modelWiadomosci(
      zam({ numer: 'R<script>/1' }),
      { temat_id: 'przypomnienie', dokument: null, ...opcje },
    ));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // ⚠️ Numer rachunku klient PRZEPISUJE do banku — w czcionce proporcjonalnej cyfry zlewają
  // się w jeden ciąg (ta sama reguła i to samo uzasadnienie, co przy numerze konta w treściach
  // wyceny — src/mail/mail-html.js, `liniaPudelka`/`RE_NUMER_KONTA`; recenzja 22.08.2026).
  it('numer rachunku stoi w czcionce o stałej szerokości', () => {
    const html = renderWiadomoscHtml(model());
    const komorkaRachunku = html.slice(html.indexOf('>Rachunek<'), html.indexOf('>Rachunek<') + 400);
    expect(komorkaRachunku).toContain('monospace');
  });
});

// ⚠️⚠️ STRAŻNIK „MODEL LICZY SIĘ RAZ, RENDERUJĄ GO DWA RENDERERY" (przegląd 22.08.2026).
// Testy wyżej sprawdzają obie wersje OSOBNO, każda przeciw tej samej stałej literałowej
// ('990,00 zł') — co udowadnia, że każda z osobna zgadza się z oczekiwaniem autora testu,
// ale NIE, że obie zgadzają się ZE SOBĄ dla jednego konkretnego obiektu modelu. Gdyby jeden
// z rendererów zaczął kiedyś formatować kwotę czy tytuł przelewu inaczej niż mówi model
// (np. obcinając grosze albo skracając tytuł), oba testy wyżej mogłyby dalej być zielone,
// dopóki ktoś ręcznie nie zaktualizowałby ich obu tą samą literówką. Ten blok czyta wartości
// WPROST z `m.platnosc`, więc porównuje rendery z modelem, a nie ze sobą nawzajem powtórzone.
describe('spójność renderera HTML i wersji tekstowej', () => {
  it('kwota do zapłaty i tytuł przelewu w obu wersjach pochodzą z tego samego modelu', () => {
    const m = modelWiadomosci(zam(), { temat_id: 'przypomnienie', dokument: { numer: 'PF/3/08/2026' }, ...opcje });
    const tekst = jakoTekstWiadomosci(m);
    const html = renderWiadomoscHtml(m);

    expect(m.platnosc).not.toBeNull();
    expect(tekst).toContain(m.platnosc.doZaplaty);
    expect(html).toContain(m.platnosc.doZaplaty);
    expect(tekst).toContain(m.platnosc.tytul);
    expect(html).toContain(m.platnosc.tytul);
    expect(tekst).toContain(m.platnosc.termin);
    expect(html).toContain(m.platnosc.termin);
    // ⚠️ RACHUNEK I ODBIORCA DOŁOŻONE (recenzja 22.08.2026) — to jedyne dwa pola bloku
    // przelewu, których rozjazd między HTML-em a tekstem wysyłałby pieniądze pod zły adres,
    // a strażnik ich dotąd nie pilnował.
    expect(tekst).toContain(m.platnosc.rachunek);
    expect(html).toContain(m.platnosc.rachunek);
    expect(tekst).toContain(m.platnosc.odbiorca);
    expect(html).toContain(m.platnosc.odbiorca);
  });

  // Ta sama próba dla wpłaty częściowej — inna kwota niż w teście wyżej, żeby strażnik
  // nie zdawał egzaminu tylko dlatego, że ktoś przepisał tę samą literówkę w dwóch miejscach.
  it('po wpłacie częściowej obie wersje pokazują tę samą resztę', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '400.00' }] });
    const m = modelWiadomosci(z, { temat_id: 'proforma', dokument: { numer: 'PF/3/08/2026' }, ...opcje });
    const tekst = jakoTekstWiadomosci(m);
    const html = renderWiadomoscHtml(m);

    expect(m.platnosc.doZaplaty).toBe('590,00 zł');
    expect(tekst).toContain('590,00 zł');
    expect(html).toContain('590,00 zł');
  });
});
