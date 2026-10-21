// PRZELICZANIE NETTO ↔ BRUTTO w formularzach pozycji: „Dodaj pozycję” na karcie i wiersze ekranu „Nowe zamówienie”.
//
// Do PRZ-105 (21.10.2026) mieszkało w stronie (`_skrypt-cena.ejs`) — tam nie dało się go przetestować, a od
// PRZ-105 liczy stawką WIERSZA (lista 23/8/5/0), więc reguł przybyło. Plik, nie skrypt w stronie: test
// (tests/public/cena-netto.test.js) importuje DOKŁADNIE to, co wykonuje przeglądarka.
//
// Zasady, które zostają bez zmian:
//  - brutto jest WARTOŚCIĄ PRZECHOWYWANĄ (domain/pozycje-reczne.js: parsujNowaPozycje — serwer przelicza z netto
//    WYŁĄCZNIE przy pustym brutto). Przy wyłączonym skrypcie formularz działa dalej, operator wpisuje brutto;
//  - arytmetyka przez grosze, dokładnie jak domain/vat.js (bruttoZNetto, nettoZBruttoDoPokazania);
//  - stawka NIE jest wpisana tutaj — dojeżdża atrybutem `data-vat` formularza (domyślna z Ustawień) albo listą
//    w wierszu. Druga kopia „23” w przeglądarce rozjechałaby się cicho z fakturą.
// PRZ-105:
//  - `data-wdt="1"` (nabywca z UE) = 0%, tak jak policzy dokument; ekran zakładania przestawia go na żywo
//    z pola NIP (public/suma-podglad.js);
//  - zmiana STAWKI zostawia brutto i przelicza netto (ten sam kierunek, co serwer); przy samym netto liczy brutto.
//
// ⚠️ KOLEJNOŚĆ: public/suma-podglad.js słucha `input` na TYM SAMYM formularzu i musi dostać brutto już
// policzone. Moduły wykonują się w kolejności dokumentu, więc ten plik stoi w stronie PRZED tamtym.

const zaokr = (x) => (Math.round(x) / 100).toFixed(2);
const liczba = (v) => Number(String(v ?? '').trim().replace(',', '.'));

/** Stawka (liczba) dla wiersza albo `null`, gdy nie ma jej skąd wziąć — wtedy skrypt niczego nie liczy. */
export function stawkaWiersza(zasieg, formularz) {
  if (formularz?.dataset?.wdt === '1') return 0;
  const lista = zasieg?.querySelector('select[name$="vat"]');
  const zListy = lista ? Number(lista.value) : NaN;
  if (Number.isFinite(zListy)) return zListy;
  const surowa = formularz?.dataset?.vat;
  if (surowa === undefined || String(surowa).trim() === '') return null;
  const n = Number(surowa);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Obsługa jednego zdarzenia `input` w formularzu. */
export function przelicz(zdarzenie, formularz) {
  const pole = zdarzenie?.target;
  const nazwa = pole && pole.name ? pole.name : '';
  const toNetto = /cena_netto$/.test(nazwa);
  const toBrutto = /cena_brutto$/.test(nazwa);
  const toStawka = /(^|_)vat$/.test(nazwa);
  if (!toNetto && !toBrutto && !toStawka) return;
  const zasieg = (pole.closest && pole.closest('tr')) || formularz;
  const netto = zasieg.querySelector('input[name$="cena_netto"]');
  const brutto = zasieg.querySelector('input[name$="cena_brutto"]');
  if (!netto || !brutto) return;
  const stawka = stawkaWiersza(zasieg, formularz);
  if (stawka === null) return;
  const mnoznik = 1 + stawka / 100;
  const zNetto = () => {
    const n = liczba(netto.value);
    brutto.value = Number.isFinite(n) && String(netto.value).trim() ? zaokr(Math.round(n * 100) * mnoznik) : '';
  };
  const zBrutto = () => {
    const b = liczba(brutto.value);
    netto.value = Number.isFinite(b) && String(brutto.value).trim() ? zaokr(Math.round(b * 100) / mnoznik) : '';
  };
  // Recenzja PRZ-105: zmiana STAWKI liczy z pola, które operator wpisał OSTATNIO (znacznik na wierszu).
  // „Netto 100, potem 8%” ma dać brutto 108, a nie zostawić 123 policzone starą stawką. Bez znacznika
  // (wiersz z magazynu, formularz wczytany z serwera) brutto — wartość przechowywana — zostaje.
  const znacznik = zasieg.dataset ?? {};
  if (toNetto) { znacznik.zrodlo = 'netto'; zNetto(); }
  else if (toBrutto) { znacznik.zrodlo = 'brutto'; zBrutto(); }
  else if (znacznik.zrodlo === 'netto' && String(netto.value).trim()) zNetto();
  else if (String(brutto.value).trim()) zBrutto();
  else if (String(netto.value).trim()) zNetto();
}

/** Podpięcie do strony: nasłuch na FORMULARZU (wiersze dokładane bez przeładowania też są objęte). */
export function podepnij(dokument) {
  const formularze = [];
  dokument.querySelectorAll('input[name$="cena_netto"]').forEach((pole) => {
    const f = pole.closest('form');
    if (f && !formularze.includes(f)) formularze.push(f);
  });
  formularze.forEach((f) => f.addEventListener('input', (e) => przelicz(e, f)));
  return formularze.length;
}

if (typeof document !== 'undefined') podepnij(document);
