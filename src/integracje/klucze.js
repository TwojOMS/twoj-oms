// Metadane dla konfiguracji modułów etapu 3. Moduł przejmuje kluczeIntegracji
// z właściwej deklaracji, dzięki czemu rdzeń blokuje poświadczenia w trybie próby.
const deklaracja = (...kluczeIntegracji) => Object.freeze({ kluczeIntegracji: Object.freeze(kluczeIntegracji) });
// Kanały są konfigurowalne, więc moduł dodaje deklarację dla każdego swojego
// prefiksu env zamiast wpisywać nazwy kont konkretnej firmy.
export function kluczeKanalu(typ, prefiks) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefiks)) throw new Error('Nieprawidłowy prefiks kanału');
  if (typ === 'allegro') return deklaracja(`${prefiks}_CLIENT_ID`, `${prefiks}_CLIENT_SECRET`);
  if (typ === 'woo') return deklaracja(`${prefiks}_CK`, `${prefiks}_CS`);
  throw new Error('Nieznany typ kanału');
}
export const integracje = Object.freeze({
  allegro: deklaracja('ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET'),
  woo: deklaracja('WOO_CK', 'WOO_CS'),
  apilo: deklaracja('APILO_CREDENTIALS_PATH'),
  dpd: deklaracja('DPD_LOGIN', 'DPD_PASSWORD'),
  inpost: deklaracja('INPOST_TOKEN'),
  infakt: deklaracja('INFAKT_API_KEY'),
  ksef: deklaracja('KSEF_TOKEN'),
  gus: deklaracja('GUS_KLUCZ'),
  meta: deklaracja('META_TOKEN'),
  ga4: deklaracja('GA4_KLUCZ'),
  vies: deklaracja(),
});
