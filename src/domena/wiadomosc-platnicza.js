import { blokPlatnosci, stanPlatnosci, STAN_PLATNOSCI } from './blok-platnosci.js';
import { dzienWarszawa } from './format-daty.js';
import { PODPIS } from './potwierdzenie-zamowienia.js';
import { bladOperatora } from './bledy.js';
import { zdaniaDoMaila, zdanieProformy, naglowekTekstu, DOMYSLNE_ZDANIA, tekstyModelu } from './zdania-platnosci.js';

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
//
// PRZ-102.17: TREŚĆ zdań z Ustawień → Szablony wiadomości → „Zdania o płatności" (`zdania`, domyślne = dawne zdania
// stąd, co do znaku — domena/zdania-platnosci.js). WYBÓR zdania (która gałąź) zostaje tutaj i nie da się go zmienić
// z panelu; zdanie przy pobraniu musi tam mówić o kurierze albo doręczeniu (regulaTresci).
function zamkniecie(temat_id, stan, zalaczonyDokument, zdania) {
  if (stan === STAN_PLATNOSCI.POBRANIE) return zdania.pobranie;
  if (stan === STAN_PLATNOSCI.POKRYTE) return zdania.oplacone;
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
    return zalaczonyDokument ? zdania.bez_danych_z_zalacznikiem : zdania.bez_danych_bez_zalacznika;
  }
  if (temat_id === 'proforma') return zdania.proforma;
  if (temat_id === 'przypomnienie') return zdania.przypomnienie;
  return zdania.pozostale;
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
  // PRZ-102.17: zdania z panelu (zdaniaPlatnosciTeraz w usłudze, czytane przy każdym mailu). Brak = domyślne.
  zdania = null,
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
  const t = zdaniaDoMaila(zdania ?? {});

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
    zdanieDokumentu: zalacznikProformy ? zdanieProformy(t.zalacznik_proformy, zalacznikProformy) : null,
    // ⚠️ TA SAMA ZASADA, co przy `zdanieDokumentu`: zdanie zalezy od FAKTU Z KOPERTY
    // (`zalacznikWywozu` podaje usluga z JUZ zlozonej listy zalacznikow), nie od tematu
    // maila ani od tego, ze zamowienie „jest WDT". Mail zapowiadajacy dokument, ktorego
    // nie ma w kopercie, jest gorszy niz mail bez dokumentu.
    zdanieWywozu: zalacznikWywozu ? t.zalacznik_wywozu : null,
    zamkniecie: zamkniecie(temat_id, stan, zalaczonyDokument, t),
    // Nagłówki sekcji DO ZAPŁATY i PRZELEW w brzmieniu z panelu (HTML: jak wpisane, styl robi wielkie litery;
    // tekst: naglowekTekstu). Dane pod nimi liczy blokPlatnosci — z panelu nie da się ich zmienić.
    naglowki: { doZaplaty: t.naglowek_do_zaplaty, przelew: t.naglowek_przelew },
    // PRZ-102.19: komplet tekstów (etykiety wierszy przelewu, „brutto", „Pozdrawiamy,") — renderery czytają je
    // przez `tekstyModelu`. Wartości obok etykiet (`platnosc`) liczy blokPlatnosci, nie panel.
    teksty: t,
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
 * Nagłówki sekcji z modelu (PRZ-102.17). Model złożony poza `modelWiadomosci` (np. w starszym teście) nie ma
 * `naglowki` — wtedy brzmienie domyślne, to samo co przed zmianą. Wersja tekstowa: wielkie litery (`naglowekTekstu`).
 */
export function naglowkiModelu(m) {
  return {
    doZaplaty: m?.naglowki?.doZaplaty ?? DOMYSLNE_ZDANIA.naglowek_do_zaplaty,
    przelew: m?.naglowki?.przelew ?? DOMYSLNE_ZDANIA.naglowek_przelew,
  };
}
const naglowkiTekstu = (m) => {
  const n = naglowkiModelu(m);
  return { doZaplaty: naglowekTekstu(n.doZaplaty), przelew: naglowekTekstu(n.przelew) };
};

/**
 * Środek maila między zdaniem wiodącym a zamknięciem: DO ZAPŁATY, PRZELEW i zdania o załącznikach — z pustą linią
 * na początku. JEDNO miejsce dla `blokiTekstuWiadomosci` (szablon) i `jakoTekstWiadomosci` (mail bez szablonu); do
 * PRZ-102.19 stały to dwie kopie, a etykiety z panelu w dwóch kopiach rozjechałyby się przy pierwszej poprawce.
 * Etykiety i „brutto" z `tekstyModelu` (PRZ-102.19); wartości obok nich policzył blokPlatnosci.
 */
function srodekTekstu(m) {
  const n = naglowkiTekstu(m);
  const e = tekstyModelu(m);
  return [
    ...sekcja(n.doZaplaty, [m.platnosc && `${m.platnosc.doZaplaty} ${e.dopisek_brutto}`]),
    ...sekcja(n.przelew, m.platnosc ? [
      m.platnosc.odbiorca && `${e.etykieta_odbiorca}: ${m.platnosc.odbiorca}`,
      `${e.etykieta_rachunek}: ${m.platnosc.rachunek}`,
      `${e.etykieta_tytul}: ${m.platnosc.tytul}`,
      m.platnosc.termin && `${e.etykieta_termin}: ${m.platnosc.termin}`,
    ] : []),
    ...(m.zdanieDokumentu ? ['', m.zdanieDokumentu] : []),
    ...(m.zdanieWywozu ? ['', m.zdanieWywozu] : []),
  ];
}

/**
 * Blok `{dane_platnosci}` szablonu (PRZ-101.03): DO ZAPŁATY, PRZELEW i zdania o załącznikach — dokładnie te linie,
 * które `jakoTekstWiadomosci` stawia między zdaniem wiodącym a zamknięciem, bez pustej linii na początku.
 * Pusty, gdy nie ma ani przelewu, ani załącznika (np. faktura opłacona bez PDF-u) — wtedy blok znika z maila.
 *
 * Zgodność z mailem bez szablonu pilnują tests/moduly/wiadomosci/szablony-rownosc.test.js i wzorzec bajt w bajt
 * (zdania-platnosci-rownosc-prz102-17.test.js).
 */
export function blokiTekstuWiadomosci(m) {
  return { dane_platnosci: srodekTekstu(m).slice(1) };
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
    ...srodekTekstu(m),
    '',
    m.zamkniecie,
    '',
    tekstyModelu(m).pozdrowienie,
    m.sprzedawca,
  ].join('\n');
}

