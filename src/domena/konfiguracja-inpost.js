// PRZ-093.09 — kurier InPost (paczkomaty, API ShipX) skonfigurowany w Ustawieniach. Wzór: DPD z PRZ-092
// (domena/konfiguracja-dpd.js).
//
// Dla instalacji klientów Twojego OMS-u: token API ShipX i numer organizacji wpisuje się na ekranie zamiast do
// oms.env. ⚠️ Gdy InPost jest w .env (INPOST_TOKEN), .env WYGRYWA i formularz tylko to pokazuje — instalacja
// skonfigurowana plikiem nie zmienia zachowania po tej zmianie.
//
// Adres API NIE jest polem formularza: zawsze produkcyjny ShipX. Dowolny adres z ekranu znaczyłby, że konto
// z dostępem do Ustawień może wysłać token pod obcy adres. Inny adres (np. testowy) nadal da się ustawić
// w pliku (INPOST_URL) — wtedy cała konfiguracja InPost idzie z pliku.
// Adres nadawcy to wspólny adres firmy (plik DPD_NADAWCA_* → Ustawienia → Firma), jak przy DPD.

/** Produkcyjny adres API ShipX — ten sam, który kurierzy.ts podstawia, gdy w pliku nie ma INPOST_URL. */
export const ADRES_INPOST = 'https://api-shipx-pl.easypack24.net/v1';

/**
 * PRZ-094.15 — kod punktu nadawczego (`custom_attributes.dropoff_point` = „dropoff point name”, ShipX) po
 * przycięciu i zamianie na wielkie litery. To `name` punktu z API Points: paczkomat (KRA02APP, ABC01M) albo
 * PaczkoPunkt, którego `name` ma prefiks z myślnikiem (POP-WAW206). Człony A-Z0-9 rozdzielone pojedynczymi
 * myślnikami, 2–20 znaków. Plik (INPOST_PACZKOMAT_NADAWCZY) nie sprawdza kodu wcale — ekran nie może być
 * ostrzejszy od niego co do poprawnych kodów, tylko odrzuca spacje i znaki spoza zbioru.
 */
export const KOD_PUNKTU_NADAWCZEGO = /^(?=.{2,20}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz. Pusty token przy istniejącym zapisie = „zostaw zapisany” — token nigdy nie wraca na ekran,
 * więc bez tej reguły każdy zapis innego pola kasowałby token. Komunikaty błędów nie cytują wpisanych wartości.
 * @returns {{ ustawienia: object, sekrety: object, bledy: string[] }}
 */
export function sprawdzFormularzInpost(body = {}, zapisane = null) {
  const bledy = [];
  const nazwa = tekst(body.nazwa);
  const organizacja = tekst(body.organizacja);
  const paczkomatNadawczy = tekst(body.paczkomatNadawczy).toUpperCase();
  // Token wklejany ze schowka często niesie spację albo koniec linii na brzegu — te obcinamy.
  const token = tekst(body.token);

  if (!nazwa) bledy.push('Podaj nazwę — dowolną, np. „InPost”.');
  else if (nazwa.length > 60) bledy.push('Nazwa może mieć najwyżej 60 znaków.');
  if (!organizacja) bledy.push('Podaj numer organizacji InPost (ID organizacji w ShipX).');
  // Ta sama reguła co INPOST_ORGANIZACJA w pliku (kurierzy.ts): dodatnia liczba całkowita.
  else if (!/^\d{1,12}$/u.test(organizacja) || Number(organizacja) <= 0) bledy.push('Numer organizacji to same cyfry, większy od zera.');

  const staryToken = String(zapisane?.sekrety?.token ?? '');
  if (!token && !staryToken) bledy.push('Podaj token API ShipX.');
  else if (/\s/u.test(token)) bledy.push('Token nie może zawierać spacji — skopiuj go w całości, bez dopisków.');
  else if (token.length > 4000) bledy.push('Token może mieć najwyżej 4000 znaków.');

  if (paczkomatNadawczy && !KOD_PUNKTU_NADAWCZEGO.test(paczkomatNadawczy)) bledy.push('Kod punktu nadawczego to litery i cyfry, z myślnikami między członami, np. ABC01M albo POP-WAW206.');

  return {
    ustawienia: { nazwa, organizacja, paczkomatNadawczy },
    sekrety: { token: token || staryToken },
    bledy,
  };
}

/** Opcje createInpostClient z zapisu formularza i wspólnego adresu nadawcy — kształt jak z pliku (kurierzy.ts). */
export function opcjeKlientaInpost(zapis, nadawca) {
  return {
    url: ADRES_INPOST, token: zapis.sekrety.token, organizacja: Number(zapis.ustawienia.organizacja), nadawca,
    paczkomatNadawczy: tekst(zapis.ustawienia.paczkomatNadawczy).toUpperCase() || null,
  };
}
