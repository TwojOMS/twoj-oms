import { blokPlatnosci, stanPlatnosci, STAN_PLATNOSCI } from './blok-platnosci.js';
import { dzienWarszawa } from './format-daty.js';
import { PODPIS } from './potwierdzenie-zamowienia.js';
import { bladOperatora } from './bledy.js';

// TREŚĆ TRZECH MAILI Z DOKUMENTEM ALBO O PIENIĄDZACH (22.08.2026): proforma, faktura,
// przypomnienie o płatności.
//
// ⚠️ JEDEN MODUŁ NA TRZY TEMATY, a nie trzy pliki po jednym. Te maile różnią się WYŁĄCZNIE
// zdaniem wiodącym, zdaniem zamykającym i tym, co jedzie w tytule przelewu — cała reszta
// (kwota, dane do przelewu, termin, podpis) jest wspólna. Trzy kopie tej samej koperty
// rozjechałyby się przy pierwszej poprawce numeru konta.
//
// ⚠️ POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA TU NIE NALEŻY i nie zostało tu wciągnięte. Tamten
// mail ma TABELĘ POZYCJI i nie mówi o pieniądzach do zapłaty — ma własną domenę
// (`domain/potwierdzenie-zamowienia.js`) sprzed dnia i działa na produkcji. Sklejenie obu
// dałoby jeden moduł z dwoma rozłącznymi połowami i warunkiem na wierzchu.
//
// ⚠️ MODUŁ CZYSTY: nie czyta plików, nie pyta inFaktu, nie wysyła. Numer dokumentu przychodzi
// ARGUMENTEM (`dokument`), bo skąd go wziąć, wie usługa — a treść ma dać się obejrzeć
// na ekranie podglądu i przetestować bez sieci.

/**
 * Odstępy zwinięte RAZ I PORZĄDNIE — jeden przebieg zamiast łatki w każdym temacie.
 *
 * ⚠️ DO 22.08.2026 STAŁY TU DWIE KOPIE `.replace('  ', ' ')` — i obie były wadliwe tak samo:
 * `String.replace` z napisem (nie wyrażeniem) podmienia WYŁĄCZNIE PIERWSZE wystąpienie, więc
 * temat, w którym brakowało i numeru dokumentu, i numeru zamówienia, dalej wychodził
 * z podwójnym odstępem — tyle że w drugim miejscu. Nie obcinały też odstępu na końcu, który
 * przy pustym numerze zamówienia zostawał w temacie maila.
 */
const jedenOdstep = (s) => s.replace(/\s+/g, ' ').trim();

/** Temat wiadomości (subject) — jedno źródło dla podglądu, wysyłki i rejestru. */
export const TEMAT_MAILA = Object.freeze({
  proforma: (z, dokument) => jedenOdstep(`Proforma ${dokument?.numer ?? ''} — zamówienie nr ${z?.numer ?? ''}`),
  faktura: (z, dokument) => jedenOdstep(`Faktura ${dokument?.numer ?? ''} — zamówienie nr ${z?.numer ?? ''}`),
  przypomnienie: (z) => jedenOdstep(`Przypomnienie o płatności — zamówienie nr ${z?.numer ?? ''}`),
});

// Zdanie wiodące — pierwsze po „Dzień dobry,". Mówi, po co ten mail, zanim klient zobaczy
// jakąkolwiek kwotę.
const WIODACE = Object.freeze({
  proforma: (z, d) => `w załączeniu przesyłamy proformę ${d?.numer ?? ''} do zamówienia nr ${z.numer}.`,
  faktura: (z, d) => `w załączeniu przesyłamy fakturę ${d?.numer ?? ''} do zamówienia nr ${z.numer}.`,
  przypomnienie: (z) => `przypominamy o płatności za zamówienie nr ${z.numer} z dnia ${dzienWarszawa(z.utworzone_at ?? '')}.`,
});

/**
 * Zdanie zamykające — nad podpisem, oddzielone kreską.
 *
 * ⚠️ ZALEŻY OD STANU PIENIĘDZY (`stanPlatnosci`), NIE OD SAMEGO `Boolean(platnosc)`
 * (recenzja 22.08.2026). `platnosc === null` ma CZTERY różne powody, a mylenie ich ze sobą
 * dawało FAKTURZE DO ZAMÓWIENIA ZA POBRANIEM zdanie „Zamówienie jest opłacone" — zanim kurier
 * cokolwiek zainkasował. Cztery stany, cztery różne zdania; żadne z nich nie zgaduje.
 */
function zamkniecie(temat_id, stan, zalaczonyDokument) {
  if (stan === STAN_PLATNOSCI.POBRANIE) {
    return 'Należność pobierze kurier przy doręczeniu — nie trzeba nic przelewać.';
  }
  if (stan === STAN_PLATNOSCI.POKRYTE) return 'Zamówienie jest opłacone — dziękujemy.';
  // ⚠️ Brak rachunku i błąd wyceny: NIE WOLNO twierdzić niczego o pieniądzach. Odsyłamy
  // do dokumentu, który klient ma w załączniku i który mówi prawdę sam.
  //
  // ⚠️⚠️ ZDANIE SPAROWANE Z FAKTEM (sprzątanie po recenzji całości gałęzi, 22.08.2026) — ta
  // sama klasa błędu, którą naprawiliśmy przy `zdanieDokumentu`. „Znajdziesz na dokumencie
  // w załączniku" obiecywało załącznik, którego przy PRZYPOMNIENIU BEZ PROFORMY po prostu
  // nie ma: mail zapowiadający dokument, którego nie ma w kopercie, jest gorszy niż mail bez
  // dokumentu. `zalaczonyDokument` przychodzi z usługi, z JUŻ ZŁOŻONEJ listy załączników —
  // nie z tematu maila i nie z drugiej kopii reguły „co się dokłada do czego".
  if (stan === STAN_PLATNOSCI.BRAK_RACHUNKU || stan === STAN_PLATNOSCI.BLAD) {
    return zalaczonyDokument
      ? 'Szczegóły płatności znajdziesz na dokumencie w załączniku.'
      : 'Szczegóły płatności podamy w odpowiedzi na tego maila — wystarczy napisać.';
  }
  if (temat_id === 'proforma') return 'Po zaksięgowaniu wpłaty przekażemy zamówienie do realizacji.';
  if (temat_id === 'przypomnienie') {
    return 'Jeśli płatność już wyszła, prosimy zignorować tę wiadomość. A gdyby coś było '
      + 'niejasne — wystarczy odpowiedzieć na tego maila.';
  }
  return 'Jeśli coś się nie zgadza, wystarczy odpowiedzieć na tego maila.';
}

/**
 * MODEL wiadomości — wszystko policzone RAZ, w postaci gotowej do wypisania.
 *
 * ⚠️ TYTUŁ PRZELEWU zależy od tematu i to jest cała jego reguła: przy proformie i fakturze
 * jedzie numer TEGO dokumentu, przy przypomnieniu — numer dokumentu, który klient ma przed
 * sobą (proforma albo faktura), a gdy żadnego nie ma, numer zamówienia. Tytuł niepasujący
 * do dokumentu znaczy przelew, którego księgowość nie dopasuje.
 */
export function modelWiadomosci(z, {
  // ⚠️ `zalaczonyDokument` to FAKT ZE ZŁOŻONEJ KOPERTY („czy w załącznikach cokolwiek jest"),
  // a nie wniosek z tematu maila. Podaje go usługa, bo tylko ona wie, czy PDF się pobrał —
  // ten moduł niczego nie czyta z dysku ani z inFaktu i nie ma prawa tego zgadywać.
  temat_id, dokument = null, zalacznikProformy = null, zalacznikWywozu = false,
  zalaczonyDokument = false,
  rachunek, odbiorca, dzis, podpis = PODPIS,
} = {}) {
  // ⚠️ NIEZNANY TEMAT RZUCA, NIE UDAJE PRZYPOMNIENIA (recenzja 22.08.2026). Fallback
  // `WIODACE[temat_id] ?? WIODACE.przypomnienie`, który stał tu wcześniej, po cichu wysyłałby
  // treść przypomnienia pod tematem, którego nikt nie wybrał — literówka w wywołaniu
  // (np. `temat_id: 'faktóra'`) nie dawałaby żadnego sygnału, tylko klienta z mailem
  // podpisanym niewłaściwie.
  if (!Object.hasOwn(WIODACE, String(temat_id ?? ''))) {
    throw bladOperatora(`Nieznany temat wiadomości: „${temat_id}".`);
  }

  const tytul = dokument?.numer ?? z?.numer ?? '';
  const stan = stanPlatnosci(z, { rachunek });
  const platnosc = blokPlatnosci(z, { rachunek, odbiorca, tytul, dzis });

  return {
    temat_id,
    numer: String(z?.numer ?? ''),
    dzien: dzienWarszawa(z?.utworzone_at ?? ''),
    wiodace: WIODACE[temat_id](z, dokument),
    platnosc,
    // ⚠️ ZALEŻY OD TEGO, CO NAPRAWDĘ JEDZIE W ZAŁĄCZNIKU (`zalacznikProformy`), NIE OD
    // TEMATU MAILA (recenzja 22.08.2026). Poprzednia wersja pokazywała to zdanie przy KAŻDYM
    // `temat_id === 'przypomnienie'` z podanym `dokument` — a `dokument` przy przypomnieniu
    // bywa numerem FAKTURY (bo to on jedzie do tytułu przelewu), więc zdanie nazywało
    // proformą dokument, który wcale nią nie jest.
    zdanieDokumentu: zalacznikProformy ? `W załączeniu proforma ${zalacznikProformy}.` : null,
    // ⚠️ TA SAMA ZASADA, co przy `zdanieDokumentu`: zdanie zalezy od FAKTU Z KOPERTY
    // (`zalacznikWywozu` podaje usluga z JUZ zlozonej listy zalacznikow), nie od tematu
    // maila ani od tego, ze zamowienie „jest WDT". Mail zapowiadajacy dokument, ktorego
    // nie ma w kopercie, jest gorszy niz mail bez dokumentu.
    zdanieWywozu: zalacznikWywozu
      ? 'W załączeniu również „Potwierdzenie wywozu towarów" (WDT) — prosimy o podpis '
        + 'i odesłanie skanu po przewiezieniu towarów na miejsce.'
      : null,
    zamkniecie: zamkniecie(temat_id, stan, zalaczonyDokument),
    // Marka podana przez użytkownika; wspólny neutralny fallback z potwierdzeniem.
    sprzedawca: String(podpis ?? '').trim() || PODPIS,
  };
}

/** Sekcja tekstu: NAGŁÓWEK + wcięte linie. Pusta lista nie tworzy sekcji. */
function sekcja(naglowek, linie) {
  const tresc = (linie ?? []).filter((l) => l !== null && l !== undefined && l !== '');
  return tresc.length ? ['', naglowek, ...tresc.map((l) => `  ${l}`)] : [];
}

/**
 * Zapasowa postać tekstowa — TE SAME dane, ten sam podział na sekcje.
 *
 * ⚠️ ŻADNEGO UKŁADU TRZYMANEGO SPACJAMI: kolumny wyrównywane spacjami rozjeżdżają się
 * w każdej czcionce proporcjonalnej, a klient pocztowy bez HTML-a bywa właśnie taki.
 */
export function jakoTekstWiadomosci(m) {
  return [
    'Dzień dobry,',
    '',
    m.wiodace,
    ...sekcja('DO ZAPŁATY', [m.platnosc && `${m.platnosc.doZaplaty} brutto`]),
    ...sekcja('PRZELEW', m.platnosc ? [
      `Odbiorca: ${m.platnosc.odbiorca}`,
      `Rachunek: ${m.platnosc.rachunek}`,
      `Tytuł przelewu: ${m.platnosc.tytul}`,
      m.platnosc.termin && `Termin: ${m.platnosc.termin}`,
    ] : []),
    ...(m.zdanieDokumentu ? ['', m.zdanieDokumentu] : []),
    ...(m.zdanieWywozu ? ['', m.zdanieWywozu] : []),
    '',
    m.zamkniecie,
    '',
    'Pozdrawiamy,',
    m.sprzedawca,
  ].join('\n');
}
