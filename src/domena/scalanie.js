// Scalanie zamówień (PRZ-101.04, decyzje właściciela 18.10.2026).
//
// ⚠️ SCALENIE JEST LOGICZNE. Dołączone zamówienie zostaje w bazie pełnym zamówieniem (pozycje,
// wpłaty, kanał, poller) i dostaje tylko `scalone_do = id głównego`; główne niesie decyzję
// w `scalenie_json`. Pozycji NIE kopiujemy: poller kasuje i wstawia pozycje sklepowe co dwie
// minuty (oms/db/zamowienia.js, zapiszPozycje), a raporty i Finanse liczyłyby je podwójnie.
//
// ⚠️ JEDNO ZAMÓWIENIE = JEDNA FAKTURA. Faktura i proforma głównego obejmują pozycje całej grupy
// i wysyłkę według decyzji (`zamowienieGrupy`); dołączone własnego dokumentu mieć nie może.
// Stąd dwie twarde odmowy niżej: dołączane z fakturą i różny NIP (nabywca dokumentu jest jeden).
import { bladOperatora } from './bledy.js';
import { czyKanalAllegro } from './wysylka.js';
import { adresOdbiorcy } from './adres-odbiorcy.js';
import { daneFaktury } from './dane-faktury.js';
import { normalizujNip } from './klient-zbiorczy.js';
import { normalizuj } from './szukanie.js';
import { odczytajNadpisania } from './dane-reczne.js';
import {
  zl, wartoscPozycjiGrosze, wysylkaBruttoGrosze, kwotaOczekiwanaGrosze,
} from './suma-pozycji.js';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from './pozycje-faktury.js';
import { STAWKA_VAT } from './vat.js';
import { brakujacaKwotaGrosze } from './platnosci.js';
import { wysylkaEfektywna } from './wysylka-kwota.js';

export const WYSYLKA_Z_GLOWNEGO = 'glowne';
export const WYSYLKA_SUMA = 'suma';
export const DECYZJE_WYSYLKI = [WYSYLKA_Z_GLOWNEGO, WYSYLKA_SUMA];

/** Decyzja zapisana na zamówieniu głównym (`scalenie_json`) albo `null`. Nie rzuca. */
export function decyzjaScalenia(z) {
  const d = odczytajNadpisania(z?.scalenie_json);
  if (!Array.isArray(d.dolaczone) || !d.dolaczone.length) return null;
  return {
    ...d,
    wysylka: DECYZJE_WYSYLKI.includes(d.wysylka) ? d.wysylka : WYSYLKA_Z_GLOWNEGO,
    dolaczone: d.dolaczone.map(Number).filter(Number.isInteger),
  };
}

/** Identyfikatory zamówień dołączonych do `z` (puste, gdy `z` nie jest głównym grupy). */
export const idsDolaczonych = (z) => decyzjaScalenia(z)?.dolaczone ?? [];

/**
 * Początek `sync_woo_blad` GŁÓWNEGO, gdy nie dojechał status DOŁĄCZONEGO (services/sync-sklep.js).
 * Po nim „Rozdziel” poznaje ślad, który do głównego nie należy, i go zdejmuje.
 */
export const PREFIKS_BLEDU_DOLACZONYCH = 'dołączone ';

/**
 * Odmowa POBRANIA na zamówieniu scalonym (recenzja, W2) — `null`, gdy zamówienie nie jest w grupie.
 * Ta sama decyzja, co odmowa scalenia zamówień za pobraniem: kwota pobrania obejmowałaby jedno
 * zamówienie, a paczka jedzie za całą grupę. Wołają ją: zmiana metody na karcie, „Przywróć metodę
 * ze sklepu” i gotowość nadania (obrona w głębi — stan sprzed tej poprawki, ręczna zmiana bazy).
 */
export function powodOdmowyPobraniaGrupy(z) {
  if (z?.scalone_do) {
    return `Zamówienie jest scalone z zamówieniem ${z.scalone_do_numer ?? `#${z.scalone_do}`} — zamówień scalonych `
      + 'nie wysyłamy za pobraniem. Najpierw rozdziel zamówienia.';
  }
  if (idsDolaczonych(z).length) {
    return 'To zamówienie jest scalone z innymi — zamówień scalonych nie wysyłamy za pobraniem (kwota pobrania '
      + 'obejmowałaby tylko jedno zamówienie, a paczka jedzie za całą grupę). Najpierw rozdziel zamówienia.';
  }
  return null;
}

/** Domyślne główne: NAJSTARSZE (data złożenia, przy remisie mniejsze id). */
export function domyslneGlowne(zamowienia) {
  const posortowane = [...(zamowienia ?? [])].sort((a, b) => String(a.utworzone_at ?? '').localeCompare(String(b.utworzone_at ?? ''))
    || Number(a.id) - Number(b.id));
  return posortowane[0]?.id ?? null;
}

const nipEfektywny = (z) => normalizujNip(daneFaktury(z).nip) || '';

/**
 * Wszystkie powody odmowy scalenia — pusta lista znaczy „wolno". Każdy powód po polsku,
 * z numerem zamówienia, którego dotyczy. `zamowienia` — odczyt jak na karcie (`pobierzZamowienie`).
 */
export function powodyOdmowyScalenia(zamowienia, { glowneId } = {}) {
  const lista = zamowienia ?? [];
  if (lista.length < 2) return ['Zaznacz co najmniej dwa zamówienia — scalić można dwa lub więcej.'];
  const powody = [];
  if (!lista.some((z) => z.id === Number(glowneId))) powody.push('Zamówienie główne musi być jednym z zaznaczonych.');
  for (const z of lista) {
    const n = `Zamówienie ${z.numer}`;
    const glowne = z.id === Number(glowneId);
    // ⚠️ Decyzja właściciela 18.10: „Zamówień z Allegro raczej się nie scala”. Allegro ma własną fakturę
    // do checkout-formu i status SENT na każdym zamówieniu — jedna faktura grupy tego nie obsłuży.
    // Rozpoznanie Allegro — JEDNA reguła w repo (`czyKanalAllegro`, PRZ-101.08): prefiks `allegro_`
    // albo `typ: 'allegro'` z OMS_KANALY (rejestr ustawia moduł kanałów przy budowie aplikacji).
    if (czyKanalAllegro(z)) powody.push(`${n} jest z Allegro — zamówień z Allegro nie scalamy (tylko sklep i ręczne).`);
    if (z.anulowane) powody.push(`${n} jest anulowane.`);
    if (z.ma_zwrot || z.zwrot_at) powody.push(`${n} ma zwrot.`);
    if (z.wyslane_at) powody.push(`${n} jest już wysłane.`);
    if ((z.przesylki ?? []).length) powody.push(`${n} ma już nadaną przesyłkę — paczka nie obejmie pozycji pozostałych zamówień.`);
    // Status, który nie dojechał do sklepu, trzyma zamówienie na „Do zrobienia” (doZrobienia).
    // Dołączone zniknęłoby z listy razem z tą sprawą (recenzja, W4) — najpierw ją zamknąć.
    if (z.sync_woo_blad) {
      powody.push(`${n} ma status nieodesłany do sklepu („${String(z.sync_woo_blad).slice(0, 120)}”) — `
        + 'najpierw „Wyślij ponownie” na jego karcie, potem scal.');
    }
    if (z.scalone_do) powody.push(`${n} jest już dołączone do innego zamówienia.`);
    if (idsDolaczonych(z).length) powody.push(`${n} jest już zamówieniem głównym innej grupy.`);
    // Okres rozliczeniowy ma jedną fakturę ZBIORCZĄ za miesiąc (faktura-odmowa.js) — druga droga
    // fakturowania tych samych pozycji (faktura grupy) byłaby drugim dokumentem.
    if (z.okres_rozliczeniowy_id) powody.push(`${n} należy do miesięcznego okresu rozliczeniowego (faktura zbiorcza).`);
    // Pobranie w KAŻDYM członku grupy (także w głównym) — decyzja kierownika 18.10: kwota pobrania
    // obejmowałaby tylko jedno zamówienie. Rzadka funkcja: prostota ponad wygodę.
    if (z.pobranie) {
      powody.push(`${n}: zamówień za pobraniem nie scalamy — kwota pobrania obejmowałaby tylko jedno zamówienie.`);
    }
    // ⚠️ Dołączane z fakturą = dwie faktury na jedno zamówienie, czyli dokładnie to, czego scalenie
    // ma uniknąć (właściciel: „nie chcemy mieć dwóch faktur”). Główne z fakturą — tylko ostrzeżenie.
    if (!glowne && z.faktura) {
      powody.push(`${n} ma już fakturę${z.faktura.numer ? ` ${z.faktura.numer}` : ''} — po scaleniu byłyby dwie faktury. Dołączać można tylko zamówienia bez faktury.`);
    }
  }
  const nipy = [...new Set(lista.map(nipEfektywny))];
  if (nipy.length > 1) {
    powody.push(`Zamówienia mają różne NIP-y nabywcy (${nipy.map((x) => x || 'bez NIP-u').join(', ')}) — faktura jest jedna, więc nabywca musi być jeden.`);
  }
  return powody;
}

/**
 * Ostrzeżenia, które wymagają potwierdzenia „Rozumiem” — scalić wolno, ale człowiek ma wiedzieć.
 * `proformy` — zbiór id zamówień z wystawioną proformą (tabela `proformy`, czyta trasa).
 */
export function ostrzezeniaScalenia(zamowienia, { glowneId, proformy = new Set() } = {}) {
  const glowne = (zamowienia ?? []).find((z) => z.id === Number(glowneId));
  const wynik = [];
  if (glowne?.faktura) {
    wynik.push(`Zamówienie główne ${glowne.numer} ma już fakturę${glowne.faktura.numer ? ` ${glowne.faktura.numer}` : ''} — `
      + 'faktura NIE obejmuje dołączonych pozycji. Wystaw korektę albo nową fakturę po jej anulowaniu w inFakcie.');
  }
  for (const z of zamowienia ?? []) {
    if (proformy.has(z.id)) {
      wynik.push(`Zamówienie ${z.numer} ma proformę — jej kwota nie odpowiada scalonemu zamówieniu. Wystaw nową proformę z zamówienia głównego.`);
    }
  }
  return wynik;
}

// Pola porównania kupującego. Porównanie na POSTACI ZNORMALIZOWANEJ (wielkość liter, spacje,
// same cyfry telefonu), pokaz — na wartościach takich, jak na karcie. Wartości EFEKTYWNE
// (`adresOdbiorcy`, `daneFaktury`), więc ręczna poprawka na karcie wygrywa ze sklepem.
const telefon = (t) => {
  const c = String(t ?? '').replace(/\D/g, '');
  return c.length === 11 && c.startsWith('48') ? c.slice(2) : c;
};
const POLA_KUPUJACEGO = [
  { pole: 'nazwa', etykieta: 'Odbiorca', wartosc: (z) => adresOdbiorcy(z).nazwa, porownaj: normalizuj },
  { pole: 'firma', etykieta: 'Firma', wartosc: (z) => adresOdbiorcy(z).company, porownaj: normalizuj },
  {
    pole: 'adres',
    etykieta: 'Adres',
    wartosc: (z) => { const a = adresOdbiorcy(z); return [a.ulica, [a.kod, a.miasto].filter(Boolean).join(' ')].filter(Boolean).join(', '); },
    porownaj: normalizuj,
  },
  { pole: 'telefon', etykieta: 'Telefon', wartosc: (z) => adresOdbiorcy(z).phone, porownaj: telefon },
  { pole: 'email', etykieta: 'E-mail', wartosc: (z) => adresOdbiorcy(z).email || daneFaktury(z).email, porownaj: (v) => String(v ?? '').trim().toLowerCase() },
  { pole: 'nip', etykieta: 'NIP', wartosc: (z) => daneFaktury(z).nip, porownaj: (v) => normalizujNip(v) },
];

/**
 * Różnice danych kupującego — WYŁĄCZNIE informacja (adres i tak bierzemy z głównego).
 * Oddaje tylko pola, które się różnią: `[{ pole, etykieta, wartosci: [{ id, numer, wartosc }] }]`.
 */
export function roznicaKupujacego(zamowienia) {
  const wynik = [];
  for (const p of POLA_KUPUJACEGO) {
    const wartosci = (zamowienia ?? []).map((z) => ({ id: z.id, numer: z.numer, wartosc: p.wartosc(z) ?? '' }));
    if (new Set(wartosci.map((w) => p.porownaj(w.wartosc) ?? '')).size > 1) wynik.push({ pole: p.pole, etykieta: p.etykieta, wartosci });
  }
  return wynik;
}

/**
 * Czy kupujący zapłacił za dołączone zamówienie — ta sama miara, co saldo na karcie
 * (`brakujacaKwotaGrosze`: wpłaty wobec kwoty oczekiwanej). Nadpłata też jest „opłacone”.
 */
const oplacone = (z) => brakujacaKwotaGrosze(z) <= 0;

/**
 * Wysyłki, które wchodzą na fakturę grupy — KAŻDA osobną pozycją (PRZ-101.11, właściciel 19.10:
 * „kupujący zapłacił za dwie wysyłki — druga wysyłka wchodzi jako osobna pozycja. Kwoty
 * zgadzają się”). Wysyłka głównego wchodzi zawsze. Dołączonego:
 *  - „suma wysyłek” — zawsze;
 *  - „z zamówienia głównego” — tylko gdy dołączone jest OPŁACONE (kupujący za nią zapłacił,
 *    więc bez niej faktura byłaby niższa niż wpłaty); nieopłaconego wypada.
 * Zerowe wysyłki pomijamy (pusta linia na fakturze). `[{ id, numer, glowne, grosze, ilosc }]`.
 */
export function wysylkiGrupy(glowne, dolaczone, decyzja) {
  const wchodzi = (z, czyGlowne) => czyGlowne || decyzja === WYSYLKA_SUMA || oplacone(z);
  return [glowne, ...(dolaczone ?? [])]
    .map((z, i) => ({ z, czyGlowne: i === 0 }))
    .filter(({ z, czyGlowne }) => wchodzi(z, czyGlowne))
    .map(({ z, czyGlowne }) => ({
      id: z.id, numer: z.numer, glowne: czyGlowne, grosze: wysylkaBruttoGrosze(z), ilosc: wysylkaEfektywna(z).ilosc,
    }))
    .filter((w) => w.grosze !== 0);
}

/**
 * Jedno zdanie na ekran scalania: które wysyłki wejdą na fakturę (z kwotami), która wypada
 * i ile wyniesie faktura. Liczy tymi samymi funkcjami, co faktura. Rzuca na uszkodzonej kwocie.
 */
export function opisWysylekGrupy(glowne, dolaczone, decyzja) {
  const wchodza = wysylkiGrupy(glowne, dolaczone, decyzja);
  const ids = new Set(wchodza.map((w) => w.id));
  const wypadaja = (dolaczone ?? []).filter((d) => !ids.has(d.id) && wysylkaBruttoGrosze(d) !== 0);
  const kwota = (numer, gr) => `${numer} ${zl(gr)} zł`;
  const czesci = [wchodza.length
    ? `Na fakturę wejdzie wysyłka ${wchodza.map((w) => kwota(w.numer, w.grosze)).join(', ')}${wchodza.length > 1 ? ' — każda osobną pozycją' : ''}`
    : 'Na fakturze nie będzie wysyłki'];
  if (wypadaja.length) {
    czesci.push(`wysyłka nieopłaconego ${wypadaja.map((d) => kwota(d.numer, wysylkaBruttoGrosze(d))).join(', ')} wypada`);
  }
  return `${czesci.join('; ')}; faktura ${zl(kwotaGrupyGrosze(glowne, dolaczone, decyzja))} zł.`;
}

/** Wysyłka grupy w groszach — suma `wysylkiGrupy`. */
export function wysylkaGrupyGrosze(glowne, dolaczone, decyzja) {
  return wysylkiGrupy(glowne, dolaczone, decyzja).reduce((s, w) => s + w.grosze, 0);
}

/**
 * Kwota grupy oczekiwana od klienta w groszach: suma kwot oczekiwanych członków minus wysyłki,
 * które na fakturę nie wchodzą (`wysylkiGrupy`). TA SAMA miara, co bariera faktury.
 */
export function kwotaGrupyGrosze(glowne, dolaczone, decyzja) {
  const czlonkowie = [glowne, ...(dolaczone ?? [])];
  const wszystkie = czlonkowie.reduce((s, z) => s + kwotaOczekiwanaGrosze(z), 0);
  const wysylkiWszystkich = czlonkowie.reduce((s, z) => s + wysylkaBruttoGrosze(z), 0);
  return wszystkie - wysylkiWszystkich + wysylkaGrupyGrosze(glowne, dolaczone, decyzja);
}

/**
 * Zamówienie GRUPY do faktury i proformy — obiekt w kształcie `pobierzZamowienie`, na którym
 * `pozycjeDokumentu`, `sprawdzSumeDokumentu`, `kwotaOczekiwanaGrosze` i bariera „zapłacone”
 * liczą dokładnie tak, jak dla pojedynczego zamówienia.
 *
 * ⚠️ JAK TO DZIAŁA (dla recenzenta):
 *  - nabywca, adres, NIP, pobranie, faktura i przesyłki — z GŁÓWNEGO (spread);
 *  - pozycje — efektywne pozycje wszystkich członków (główne pierwsze), SPŁASZCZONE: `brutto_linii`
 *    = wartość linii po nakładkach, `zrodlo = 'grupa'`, bez `sklep` — więc człon różnicowy
 *    `kwotaOczekiwanaGrosze` wynosi dla nich 0 (nakładki są już w wartości);
 *  - wysyłka — kwota `wysylkaGrupyGrosze` (ilość 1), bez nadpisań: człon różnicowy wysyłki też 0;
 *    na dokument idzie rozbita na osobne pozycje (`grupa.wysylki`, `pozycjeDokumentu`), jedna
 *    na każde zamówienie, którego wysyłka wchodzi — kupujący widzi, za co zapłacił;
 *  - `kwota_brutto` = `kwotaGrupyGrosze`, więc kwota oczekiwana = kwota grupy;
 *  - wpłaty — wszystkich członków (bariera „zapłacone” i data zapłaty liczą się od całej grupy).
 * Bariera na tym obiekcie sprawdza tylko spójność spłaszczenia — spójność DANYCH każdego członka
 * sprawdza osobno `sprawdzCzlonkowGrupy` (bez tego bariera grupy by słabła).
 */
export function zamowienieGrupy(glowne, dolaczone) {
  const decyzja = decyzjaScalenia(glowne)?.wysylka ?? WYSYLKA_Z_GLOWNEGO;
  const czlonkowie = [glowne, ...dolaczone];
  // `sklep` (wartości sprzed nakładki) celowo zdjęte — patrz nagłówek; reszta pól pozycji (produkt,
  // oferta, zdjęcie) zostaje dla wydruków i karty. `klucz` (adres edycji pozycji) tylko z głównego:
  // karta głównego nie edytuje pozycji dołączonego.
  const pozycje = czlonkowie.flatMap((c) => (c.pozycje ?? []).map(({ sklep: _sklep, ...p }) => ({
    ...p,
    brutto_linii: zl(wartoscPozycjiGrosze(p)),
    zrodlo: 'grupa',
    reczna: p.zrodlo === 'reczna',
    klucz: c === glowne ? (p.klucz ?? null) : null,
    z_zamowienia: c.numer,
    z_zamowienia_id: c.id,
  })));
  const wysylki = wysylkiGrupy(glowne, dolaczone, decyzja);
  const wysylkaGr = wysylki.reduce((s, w) => s + w.grosze, 0);
  const kwotaGr = kwotaGrupyGrosze(glowne, dolaczone, decyzja);
  return {
    ...glowne,
    pozycje,
    pozycje_reczne_json: null,
    koszt_dostawy_brutto_sklep: wysylkaGr ? zl(wysylkaGr) : null,
    koszt_dostawy_netto_sklep: null,
    koszt_dostawy_brutto: wysylkaGr ? zl(wysylkaGr) : null,
    koszt_dostawy_netto: null,
    wysylka_ilosc: 1,
    kwota_brutto: zl(kwotaGr),
    platnosci: czlonkowie.flatMap((c) => c.platnosci ?? []),
    grupa: { decyzja, czlonkowie: czlonkowie.map((c) => ({ id: c.id, numer: c.numer })), wysylki },
  };
}

/**
 * Odmowy dokumentu GRUPY (rzuca `bladOperatora`): dołączone anulowane po scaleniu (klient anulował
 * w sklepie) i dane członka, które same się nie sumują — bariera każdego członka osobno.
 */
export function sprawdzCzlonkowGrupy(glowne, dolaczone) {
  for (const d of dolaczone) {
    if (d.anulowane) {
      throw bladOperatora(`Dołączone zamówienie ${d.numer} zostało anulowane — faktura grupy objęłaby anulowane pozycje. `
        + 'Rozdziel zamówienia albo wyjaśnij anulowanie.');
    }
  }
  for (const c of [glowne, ...dolaczone]) {
    try {
      // Stawka nie wplywa na bariere (porownuje brutto) — wbudowana wystarcza (PRZ-105).
      sprawdzSumeDokumentu(pozycjeDokumentu(c, { stawkaDomyslna: STAWKA_VAT }), c);
    } catch (e) {
      throw bladOperatora(`Zamówienie ${c.numer} (w grupie): ${e.message}`);
    }
  }
}
