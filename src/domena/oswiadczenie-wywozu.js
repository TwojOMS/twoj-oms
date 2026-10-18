import { bladOperatora } from './bledy.js';
import { daneFaktury } from './dane-faktury.js';
import { czyNipUe, rozbijNipUe } from './wdt.js';

// „POTWIERDZENIE WYWOZU TOWARÓW" — model dokumentu z art. 42 ust. 4 ustawy o VAT.
// Przy wywozie wlasnym srodkiem transportu nabywcy (przypadek Alfatrendu: DPD wiezie
// paczke pod polski adres, klient sam przewozi ja na Slowacje) stawka 0% WYMAGA — oprocz
// specyfikacji sztuk ladunku (ust. 3 pkt 3, mamy: „Specyfikacja do paczki") — dokumentu
// z co najmniej: stronami i adresami, adresem dostarczenia, okresleniem towarow i ilosci,
// potwierdzeniem przyjecia w panstwie UE innym niz Polska oraz rodzajem i numerem
// rejestracyjnym srodka transportu. Ten modul SKLADA DANE; rysuje pdf/oswiadczenie-wywozu-pdf.js.
//
// ⚠️ DOKUMENT JEST ILOSCIOWY, BEZ KWOT — ustawa kwot tu nie wymaga, a kartka z cenami
// mogłaby zostac zaksiegowana u klienta obok faktury (ta sama lekcja, co stopka specyfikacji).

// Nazwy panstw czlonkowskich pod kodami VAT-UE — do zdania „na terytorium: Slowacji".
// `XI` to Irlandia Polnocna (protokol irlandzki) — jedyny kod spoza ISO.
const NAZWY_PANSTW_UE = {
  AT: 'Austrii', BE: 'Belgii', BG: 'Bułgarii', CY: 'Cypru', CZ: 'Czech', DE: 'Niemiec',
  DK: 'Danii', EE: 'Estonii', EL: 'Grecji', ES: 'Hiszpanii', FI: 'Finlandii', FR: 'Francji',
  HR: 'Chorwacji', HU: 'Węgier', IE: 'Irlandii', IT: 'Włoch', LT: 'Litwy', LU: 'Luksemburga',
  LV: 'Łotwy', MT: 'Malty', NL: 'Niderlandów', PT: 'Portugalii', RO: 'Rumunii', SE: 'Szwecji',
  SI: 'Słowenii', SK: 'Słowacji', XI: 'Irlandii Północnej',
};

/**
 * Model potwierdzenia wywozu dla JEDNEGO zamowienia WDT.
 *
 * `sprzedawca` przychodzi z konfiguracji (config.nadawca + config.proforma.nip) — dokladnie
 * te same zrodla, ktorymi jada paczki i proformy, zeby dokumenty firmy nie mialy dwoch
 * adresow. `dzis` podaje wolajacy (dzienWarszawa), bo modul jest czysty.
 */
export function modelOswiadczenia(z, { sprzedawca, dzis = null } = {}) {
  const d = daneFaktury(z);
  if (!czyNipUe(d.nip)) {
    throw bladOperatora(
      'Potwierdzenie wywozu dotyczy wyłącznie dostawy wewnątrzwspólnotowej (WDT) — '
      + 'nabywca tego zamówienia nie ma numeru VAT-UE innego państwa członkowskiego.',
    );
  }
  if (!sprzedawca?.nazwa || !sprzedawca?.ulica) {
    throw bladOperatora(
      'Panel nie zna adresu sprzedawcy — bez niego dokument wywozu nie ma strony dostawcy. '
      + 'Wpisz adres firmy w Ustawienia → Firma (/ustawienia/firma) albo w pliku konfiguracji (DPD_NADAWCA_*).',
    );
  }

  const { kraj } = rozbijNipUe(d.nip);
  const pozycje = (z.pozycje ?? []).map((p, i) => ({
    lp: i + 1,
    nazwa: p.nazwa,
    ilosc: p.ilosc,
  }));
  if (pozycje.length === 0) {
    throw bladOperatora('Zamówienie nie ma żadnej pozycji — nie ma czego potwierdzać na dokumencie wywozu.');
  }

  return {
    zamowienieNumer: z.numer ?? '',
    fakturaNumer: z.faktura?.numer ?? null,
    dzis,
    sprzedawca: {
      nazwa: sprzedawca.nazwa,
      adres: [sprzedawca.ulica, [sprzedawca.kod, sprzedawca.miasto].filter(Boolean).join(' ')].filter(Boolean),
      // Prefiks PL — ten sam wymog, co na fakturze (art. 106e ust. 1 pkt 24): dokument
      // wywozu identyfikuje te same strony, ktore stoja na dokumencie sprzedazy.
      nip: `PL${String(sprzedawca.nip ?? '').trim().replace(/^PL/i, '')}`,
    },
    nabywca: {
      nazwa: d.firma ?? '',
      adres: [d.ulica, [d.kod, d.miasto].filter(Boolean).join(' ')].filter(Boolean),
      nip: d.nip,
    },
    // Panstwo przeznaczenia — z prefiksu numeru VAT-UE nabywcy. Dopelniacz, bo wchodzi
    // w zdanie „przyjęcie towarów na terytorium …".
    panstwo: NAZWY_PANSTW_UE[kraj] ?? `państwa o kodzie ${kraj}`,
    kodPanstwa: kraj,
    pozycje,
  };
}
