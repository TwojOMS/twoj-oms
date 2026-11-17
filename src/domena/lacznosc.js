// Lista usług, których osiągalność panel potrafi sprawdzić, i podsumowanie wyniku.
// Moduł jest CZYSTY: nie dotyka sieci, bazy ani zegara — cele wynikają WYŁĄCZNIE
// z konfiguracji, którą panel dostał.
//
// ⚠️ POWSTAŁ PO AWARII. Po restarcie serwera w sieci lokalnej panel pokazywał „Sklep nieosiągalny:
// fetch failed” przy sklepach, Allegro i inFakcie naraz — a wszystkie trzy usługi działały.
// Padł DNS (DHCP rozdawało adres nieistniejącego już serwera). Komunikat „fetch
// failed" nie odróżnia „nie znam nazwy" od „usługa nie odpowiada", więc szukanie zaczęło się
// od kodu panelu zamiast od sieci. Ten ekran ma to rozstrzygać w pięć sekund.
//
// ⚠️ SPRAWDZAMY TYLKO TO, CO PANEL MA SKONFIGUROWANE. Sztywna lista adresów świeciłaby
// czerwienią przy usłudze, której ten panel w ogóle nie używa — a czerwień, której nie da
// się naprawić, uczy nie czytać ekranu.

import { MODULY_KURIEROW } from './moduly-kurierow.ts';

/** Host z adresu albo `null`, gdy adresu nie da się przeczytać (zła wartość w konfiguracji). */
function hostZAdresu(adres) {
  try {
    return new URL(String(adres)).hostname;
  } catch {
    return null;
  }
}

/** Historyczny cel diagnostyki inFaktu bez własnego adresu w konfiguracji (ten sam host co klient). */
export const ADRES_DIAGNOSTYKI_INFAKTU = 'https://api.infakt.pl';

const cel = (klucz, nazwa, url) => ({ klucz, nazwa, url: String(url ?? ''), host: hostZAdresu(url) });

/**
 * Cele sprawdzenia — po jednym na skonfigurowaną usługę, w kolejności ważności dla operatora:
 * sklepy (skąd przychodzą zamówienia), Allegro, dokumenty, kurierzy, GUS.
 */
export function celeLacznosci(config = {}) {
  const cele = [];

  // Kanały z konfiguratora i sklepy ERLI z pliku (`config.celeKanalow = [{ klucz: 'typ:…', nazwa, url }]`, gotowe
  // nazwy, tylko połączone) — każdy obok kanałów z pliku tego samego rodzaju.
  const zKanalow = config.celeKanalow ?? [];
  const dodajZKanalow = (prefiks) => {
    for (const c of zKanalow) if (c.klucz.startsWith(`${prefiks}:`)) cele.push(cel(c.klucz, c.nazwa, c.url));
  };
  for (const [klucz, sklep] of Object.entries(config.sklepy ?? {})) {
    cele.push(cel(`sklep:${klucz}`, `Sklep ${klucz}`, sklep?.baseUrl));
  }
  dodajZKanalow('sklep');
  for (const [klucz, kanal] of Object.entries(config.kanaly ?? {})) {
    cele.push(cel(`allegro:${klucz}`, kanal?.etykieta ? `Allegro — ${kanal.etykieta}` : `Allegro ${klucz}`, kanal?.api));
  }
  dodajZKanalow('allegro');
  for (const c of zKanalow) {
    if (!c.klucz.startsWith('sklep:') && !c.klucz.startsWith('allegro:')) cele.push(cel(c.klucz, c.nazwa, c.url));
  }
  // Program fakturowy — klucz i nazwa z opisu programu (`config.program = { opis, url }`), adres podaje
  // wołający (ten, którego używa skonfigurowany klient; ustawienia/cele-diagnostyki.ts). Stary kształt `config.infakt`
  // zostaje dla wołających bez programu: własny adres = baseUrl klienta, bez nadpisania historyczny cel inFaktu.
  if (config.program) cele.push(cel(config.program.opis.id, config.program.opis.nazwa.mianownik, config.program.url));
  else if (config.infakt) cele.push(cel('infakt', 'inFakt', config.infakt.baseUrl ?? ADRES_DIAGNOSTYKI_INFAKTU));
  if (config.ksef) cele.push(cel('ksef', 'KSeF', config.ksef.api));
  for (const { klucz, nazwa, umowa } of Object.values(MODULY_KURIEROW)) {
    if (umowa === 'wlasna' && config[klucz]) cele.push(cel(klucz, nazwa, config[klucz].url));
  }
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
