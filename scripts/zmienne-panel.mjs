// Odpowiedniki pól formularzy, nie wszystkie ustawienia danej integracji.
// Źródła: domena/konfiguracja-{dpd,inpost,infakt,gus,ksef-kosztow}.js, core/adres-firmy.ts, domena/rachunek-firmy.js, domena/nip-bdo-firmy.js,
// moduly/ustawienia/trasy/poczta.js, moduly/wiadomosci/konfiguracja.ts i moduly/wiadomosci/podpis-maili.js (pod src/).
// Daty: moduly/raporty/{pokrycie.js,trasy/pokrycie.js}; logo: moduly/ustawienia/trasy/logo.js i core/web/logo-instalacji.js.
// Ścieżki są względem Ustawień, poza pełną ścieżką „Analizy i finanse”.
export const ZMIENNE_PANEL = Object.freeze({
  OMS_RAPORTY_PODLOGA_KOSZTOW: 'Analizy i finanse → Finanse → Kompletność danych (tylko administrator; plik wygrywa; bez restartu)',
  OMS_RAPORTY_PODLOGA_ZWROTOW: 'Analizy i finanse → Finanse → Kompletność danych (tylko administrator; plik wygrywa; bez restartu)',
  OMS_STATYSTYKI_PIERWSZY_DZIEN: 'Analizy i finanse → Finanse → Kompletność danych (tylko administrator; plik wygrywa; bez restartu)',
  OMS_LOGO_PLIK: 'Firma → Logo (tylko administrator; plik wygrywa; bez restartu)',
  OMS_LOGO_ALT: 'Firma → Logo (tylko administrator; plik wygrywa, gdy ustawia też OMS_LOGO_PLIK; bez restartu)',
  INFAKT_API_KEY: 'Integracje → inFakt',
  // PRZ-121.02: wybór modułu faktur — zapisuje tylko administrator; plik wygrywa; zmiana po ponownym uruchomieniu.
  OMS_PROGRAM_FAKTUROWY: 'Integracje → Moduł faktur (tylko administrator; plik wygrywa; po ponownym uruchomieniu)',
  GUS_KLUCZ: 'Integracje → GUS',
  KSEF_TOKEN: 'Integracje → KSeF',
  KSEF_NIP: 'Integracje → KSeF',
  DPD_LOGIN: 'Integracje → Kurierzy → DPD',
  DPD_PASSWORD: 'Integracje → Kurierzy → DPD',
  DPD_FID: 'Integracje → Kurierzy → DPD',
  DPD_INFO_CHANNEL: 'Integracje → Kurierzy → DPD',
  INPOST_TOKEN: 'Integracje → Kurierzy → InPost',
  INPOST_ORGANIZACJA: 'Integracje → Kurierzy → InPost',
  INPOST_PACZKOMAT_NADAWCZY: 'Integracje → Kurierzy → InPost',
  DPD_NADAWCA_NAZWA: 'Firma',
  DPD_NADAWCA_ULICA: 'Firma',
  DPD_NADAWCA_KOD: 'Firma',
  DPD_NADAWCA_MIASTO: 'Firma',
  DPD_NADAWCA_KRAJ: 'Firma',
  DPD_NADAWCA_TELEFON: 'Firma',
  DPD_NADAWCA_EMAIL: 'Firma',
  // PRZ-102.20: rachunek i bank — zapisuje tylko administrator (domena/rachunek-firmy.js).
  OMS_RACHUNEK: 'Firma (tylko administrator)',
  OMS_BANK: 'Firma (tylko administrator)',
  // PRZ-108.10: NIP i BDO — zapisuje tylko administrator, każde pole osobno (domena/nip-bdo-firmy.js).
  OMS_SPRZEDAWCA_NIP: 'Firma (tylko administrator)',
  OMS_SPRZEDAWCA_BDO: 'Firma (tylko administrator)',
  SMTP_HOST: 'Integracje → Poczta wychodząca',
  SMTP_PORT: 'Integracje → Poczta wychodząca',
  SMTP_USER: 'Integracje → Poczta wychodząca',
  SMTP_PASS: 'Integracje → Poczta wychodząca',
  MAIL_FROM: 'Integracje → Poczta wychodząca',
  OMS_ADRES_PANELU: 'Integracje → Poczta wychodząca → Adres panelu',
  OMS_MAIL_MARKA: 'Integracje → Poczta wychodząca → Podpis maili',
  OMS_MAIL_STOPKA: 'Integracje → Poczta wychodząca → Podpis maili',
});
