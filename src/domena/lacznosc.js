// Lista uslug, ktorych osiagalnosc panel potrafi sprawdzic, i podsumowanie wyniku.
// Modul jest CZYSTY: nie dotyka sieci, bazy ani zegara — cele wynikaja WYLACZNIE
// z konfiguracji, ktora panel dostal.
//
// ⚠️ POWSTAL PO AWARII 17.08.2026. Po restarcie NAS-a panel pokazywal „Sklep nieosiągalny:
// fetch failed" przy sklepach, Allegro i inFakcie naraz — a wszystkie trzy usługi działały.
// Padł DNS (DHCP rozdawało adres serwera skasowanego 19 dni wcześniej). Komunikat „fetch
// failed" nie odróżnia „nie znam nazwy" od „usługa nie odpowiada", więc szukanie zaczęło się
// od kodu panelu zamiast od sieci. Ten ekran ma to rozstrzygać w pięć sekund.
//
// ⚠️ SPRAWDZAMY TYLKO TO, CO PANEL MA SKONFIGUROWANE. Sztywna lista adresów świeciłaby
// czerwienią przy usłudze, której ten panel w ogóle nie używa — a czerwień, której nie da
// się naprawić, uczy nie czytać ekranu.

/** Host z adresu albo `null`, gdy adresu nie da się przeczytać (zła wartość w konfiguracji). */
function hostZAdresu(adres) {
  try {
    return new URL(String(adres)).hostname;
  } catch {
    return null;
  }
}

const cel = (klucz, nazwa, url) => ({ klucz, nazwa, url: String(url ?? ''), host: hostZAdresu(url) });

/**
 * Cele sprawdzenia — po jednym na skonfigurowaną usługę, w kolejności ważności dla operatora:
 * sklepy (skąd przychodzą zamówienia), Allegro, dokumenty, kurierzy, GUS.
 */
export function celeLacznosci(config = {}) {
  const cele = [];

  for (const [klucz, sklep] of Object.entries(config.sklepy ?? {})) {
    cele.push(cel(`sklep:${klucz}`, `Sklep ${klucz}`, sklep?.baseUrl));
  }
  for (const [klucz, kanal] of Object.entries(config.kanaly ?? {})) {
    cele.push(cel(`allegro:${klucz}`, kanal?.etykieta ? `Allegro — ${kanal.etykieta}` : `Allegro ${klucz}`, kanal?.api));
  }
  // Własny adres jest tym samym baseUrl, którego używa skonfigurowany klient.
  // Bez nadpisania zachowujemy historyczny cel diagnostyki domyślnej usługi.
  if (config.infakt) cele.push(cel('infakt', 'inFakt', config.infakt.baseUrl ?? 'https://api.infakt.pl'));
  if (config.ksef) cele.push(cel('ksef', 'KSeF', config.ksef.api));
  if (config.dpd) cele.push(cel('dpd', 'DPD', config.dpd.url));
  if (config.inpost) cele.push(cel('inpost', 'InPost', config.inpost.url));
  if (config.gus) cele.push(cel('gus', 'GUS (REGON)', config.gus.url));

  return cele;
}

/**
 * Podsumowanie wyników.
 * ⚠️ PUSTA LISTA TO NIE „wszystko działa". Panel bez ani jednej skonfigurowanej usługi nie ma
 * czego sprawdzać, a zielony napis byłby zdaniem o niczym, wyglądającym jak zdanie o faktach.
 */
export function podsumowanie(wyniki = []) {
  const dziala = wyniki.filter((w) => w.ok).length;
  return {
    ile: wyniki.length,
    dziala,
    nieDziala: wyniki.length - dziala,
    wszystkoOk: wyniki.length > 0 && dziala === wyniki.length,
  };
}
