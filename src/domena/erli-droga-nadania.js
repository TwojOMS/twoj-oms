// Rozpoznanie wyłącznie ze słowników ERLI. Prefiks identyfikatora nie określa umowy.
// PRZ-157.11b: `mapa` (krok 3 konfiguratora, {typeId: kurier}) wybiera kuriera metody umowy firmy;
// metody Przesyłek Erli zawsze nadaje ERLI. 'brak' i każda wartość spoza listy = blokada przed nadaniem.
export const KURIERZY_MAPY_ERLI = /** @type {const} */ (['dpd', 'inpost_paczkomat', 'odbior']);

/** Kurier domyślny z przewoźnika metody (rozdz. 3); null = OMS nie ma kuriera dla tej metody. */
export function kurierDomyslnyErli(vendor, pickupPlace) {
  return vendor === 'dpd' ? 'dpd'
    : vendor === 'inpost' ? (pickupPlace ? 'inpost_paczkomat' : 'inpost_kurier')
    : vendor === 'selfPickup' ? 'odbior' : null;
}

/**
 * @typedef {{id:string, name?:string, vendor?:string}} Metoda
 * @param {{typeId?:string, pickupPlace?:unknown, nazwa?:string, metodyErli?:Metoda[], metodyDostawy?:Metoda[], mapa?:Record<string,string>}} dane
 * @returns {{droga:'przesylki_erli',metoda:Metoda}|{droga:'umowa',kurier:(typeof KURIERZY_MAPY_ERLI)[number]|'inpost_kurier',metoda:Metoda}|{droga:'blokada',komunikat:string}}
 */
export function drogaNadaniaErli({ typeId, pickupPlace, nazwa, metodyErli = [], metodyDostawy = [], mapa = {} }) {
  const erli = metodyErli.find(m => m.id === typeId);
  if (erli) return { droga: 'przesylki_erli', metoda: erli };
  const metoda = metodyDostawy.find(m => m.id === typeId);
  const opis = `${metoda?.name || nazwa || typeId || 'nieznana'} (${typeId ?? 'brak'})`;
  if (metoda && typeof typeId === 'string' && Object.hasOwn(mapa ?? {}, typeId)) {
    const zMapy = /** @type {any} */ (KURIERZY_MAPY_ERLI).includes(mapa[typeId]) ? mapa[typeId] : null;
    if (zMapy) return { droga: 'umowa', kurier: zMapy, metoda };
    return { droga: 'blokada', komunikat: `ERLI: metoda ${opis} nie ma kuriera — wybierz kuriera w Ustawieniach → ERLI → Metody dostawy albo nadaj w ERLI` };
  }
  const kurier = kurierDomyslnyErli(metoda?.vendor, pickupPlace);
  if (kurier && metoda) return { droga: 'umowa', kurier, metoda };
  return { droga: 'blokada', komunikat: `ERLI: nie wiem, jak nadać metodę ${opis} — sprawdź cennik dostaw w panelu ERLI albo mapowanie w Ustawieniach` };
}
