// PRZ-092 — kurier DPD Polska skonfigurowany w Ustawieniach (wzór: formularz kuriera w Apilo).
//
// Dla instalacji klientów Twojego OMS-u: dane API od DPD (login, główny numer klienta = Master FID, hasło)
// wpisuje się na ekranie zamiast do oms.env. ⚠️ Gdy DPD jest w .env (DPD_URL), .env WYGRYWA i formularz tylko to
// pokazuje — instalacja skonfigurowana plikiem nie zmienia zachowania po tej zmianie.
//
// Adres nadawcy NIE jest polem formularza: to wspólny adres firmy (etykiety DPD i InPost, proformy,
// specyfikacje, potwierdzenie wywozu) — z pliku (DPD_NADAWCA_*) albo z Ustawień → Firma (PRZ-093.08,
// src/oms/db/adres-firmy.js). Osobny adres tylko dla DPD rozjechałby się z fakturami.

/** Adresy produkcyjnych usług DPD Polska (te same co w działającej konfiguracji .env). */
export const ADRESY_DPD = Object.freeze({
  url: 'https://dpdservices.dpd.com.pl/DPDPackageObjServicesService/DPDPackageObjServices',
  infoUrl: 'https://dpdinfoservices.dpd.com.pl/DPDInfoServicesObjEventsService/DPDInfoServicesObjEvents',
});

export const TYPY_ETYKIET_DPD = Object.freeze([
  Object.freeze({ klucz: 'LBL_PRINTER', etykieta: 'Drukarka etykiet 10×15 cm (PDF i ZPL dla Zebry)' }),
  Object.freeze({ klucz: 'A4', etykieta: 'Zwykła drukarka — etykieta na kartce A4' }),
]);

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz. Puste hasło (i kanał śledzenia) przy istniejącym zapisie = „zostaw zapisane” — pole hasła
 * nigdy nie wraca na ekran, więc bez tej reguły każdy zapis innego pola kasowałby hasło.
 * @returns {{ ustawienia: object, sekrety: object, bledy: string[] }}
 */
export function sprawdzFormularzDpd(body = {}, zapisane = null) {
  const bledy = [];
  const nazwa = tekst(body.nazwa);
  const login = tekst(body.login);
  const fid = tekst(body.fid);
  const typEtykiety = tekst(body.typEtykiety);
  const haslo = String(body.haslo ?? '');
  const kanal = tekst(body.kanal);

  if (!nazwa) bledy.push('Podaj nazwę — dowolną, np. „DPD”.');
  else if (nazwa.length > 60) bledy.push('Nazwa może mieć najwyżej 60 znaków.');
  if (!login) bledy.push('Podaj login od DPD.');
  else if (login.length > 64 || /\s/.test(login)) bledy.push('Login od DPD nie może zawierać spacji (najwyżej 64 znaki).');
  if (!fid) bledy.push('Podaj główny numer klienta DPD (Master FID).');
  else if (!/^\d{1,12}$/.test(fid)) bledy.push('Główny numer klienta DPD (Master FID) to same cyfry.');
  if (!TYPY_ETYKIET_DPD.some((t) => t.klucz === typEtykiety)) bledy.push('Wybierz typ etykiety.');

  const stareHaslo = String(zapisane?.sekrety?.haslo ?? '');
  if (!haslo.trim() && !stareHaslo) bledy.push('Podaj hasło od DPD.');
  else if (haslo.length > 200) bledy.push('Hasło może mieć najwyżej 200 znaków.');
  if (kanal.length > 64) bledy.push('Kanał śledzenia może mieć najwyżej 64 znaki.');

  return {
    ustawienia: { nazwa, login, fid, typEtykiety },
    sekrety: { haslo: haslo.trim() ? haslo : stareHaslo, kanal: kanal || String(zapisane?.sekrety?.kanal ?? '') },
    bledy,
  };
}

/** Opcje createDpdClient z zapisu formularza i wspólnego adresu nadawcy. Śledzenie tylko z kanałem DPD Info. */
export function opcjeKlientaDpd(zapis, nadawca) {
  const kanal = tekst(zapis.sekrety.kanal);
  return {
    url: ADRESY_DPD.url, login: zapis.ustawienia.login, haslo: zapis.sekrety.haslo, fid: zapis.ustawienia.fid,
    infoUrl: kanal ? ADRESY_DPD.infoUrl : '', channel: kanal,
    formatEtykiety: zapis.ustawienia.typEtykiety, nadawca,
  };
}
