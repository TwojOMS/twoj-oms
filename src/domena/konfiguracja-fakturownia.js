// PRZ-119.05 — Fakturownia (faktury sprzedaży) skonfigurowana w Ustawieniach. Wzór: domena/konfiguracja-infakt.js.
//
// Zapis w `konfiguracja_integracji`, wiersz `fakturownia`: domena konta jawnie (`ustawienia.domena`), token API jako
// sekret (`sekrety.token`). ⚠️ Gdy Fakturownia jest w .env (FAKTUROWNIA_API_TOKEN + FAKTUROWNIA_DOMENA), .env WYGRYWA
// w całości — ekran (zmiana 06) tylko to pokazuje.
//
// Adres API nie jest polem: klient składa go z domeny (`https://<domena>.fakturownia.pl`), a domena przechodzi ten
// sam wzorzec co w kliencie — bez `/`, `.` i `@`, więc z ekranu nie da się skierować tokenu pod obcy host.

/** Ekran Ustawienia → Integracje → Fakturownia — jedno źródło z adapterem (`integracje/programy/fakturownia.ts`). */
export const EKRAN_FAKTUROWNI = '/ustawienia/integracje/fakturownia';
/** Id integracji: wiersz w `konfiguracja_integracji` i nazwa programu w `OMS_PROGRAM_FAKTUROWY`. */
export const ID_FAKTUROWNI = 'fakturownia';
/** Ten sam wzorzec co `DOMENA_KONTA` w `oms/fakturownia/client.js` (część adresu przed .fakturownia.pl). */
export const WZOR_DOMENY_FAKTUROWNI = /^[a-z0-9][a-z0-9-]{0,62}$/;

const tekst = (v) => String(v ?? '').trim();

/**
 * Sprawdza formularz: domena (jawna) i token (sekret). Pusty token przy istniejącym zapisie = zostaje zapisany
 * (token nigdy nie wraca na ekran). Komunikaty nie cytują wpisanych wartości.
 * @returns {{ ustawienia: { domena: string }, sekrety: { token: string }, bledy: string[] }}
 */
export function sprawdzFormularzFakturowni(body = {}, zapisane = null) {
  const bledy = [];
  const domena = tekst(body.domena);
  if (!domena) bledy.push('Podaj domenę konta Fakturowni — część adresu przed .fakturownia.pl.');
  else if (!WZOR_DOMENY_FAKTUROWNI.test(domena)) {
    bledy.push('Domena konta to sama część adresu przed .fakturownia.pl — małe litery, cyfry i myślnik (bez https://, kropek i ukośników).');
  }
  // Token wklejany ze schowka często niesie spację albo koniec linii na brzegu — te obcinamy.
  const token = tekst(body.token);
  const stary = String(zapisane?.sekrety?.token ?? '');
  if (!token) { if (!stary) bledy.push('Podaj token API Fakturowni.'); }
  else if (/\s/u.test(token)) bledy.push('Token API nie może zawierać spacji — skopiuj go w całości, bez dopisków.');
  // Dolna granica chroni maskowanie tokenu w komunikatach klienta (krótki „token” zamazałby zwykłe słowa).
  else if (token.length < 12) bledy.push('To za krótkie na token API Fakturowni — skopiuj cały token (Ustawienia konta → API).');
  else if (token.length > 200) bledy.push('Token API może mieć najwyżej 200 znaków.');
  return { ustawienia: { domena }, sekrety: { token: token || stary }, bledy };
}

/** Opcje createFakturowniaClient z zapisu ekranu: tylko token i domena; transport domyślny (bez ponowień). */
export function opcjeKlientaFakturowni(zapis) {
  return {
    token: String(zapis?.sekrety?.token ?? ''),
    domena: String(zapis?.ustawienia?.domena ?? ''),
    fetchImpl: undefined,
  };
}
