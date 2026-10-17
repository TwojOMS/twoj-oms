// Oferta Allegro → wiersz lustra magazynu (`produkty_sklepowe`).
//
// Regula CZYSTA i mieszkajaca w `domain/` celowo: styk z Allegro zachowal sie w tym
// projekcie juz dwa razy inaczej niz dokumentacja, wiec to, CO zapisujemy, ma dac sie
// sprawdzic bez sieci i bez tokenu.
//
// ⚠️ KSZTALT WEJSCIA JEST ZMIERZONY, NIE WZIETY Z DOKUMENTACJI (notatka
// `docs/superpowers/notatki/2026-08-06-magazyn-rozpoznanie.md`, 40 ofert z obu kont):
//   { id, name, sellingMode: { price: { amount, currency } }, primaryImage: { url },
//     publication: { status }, external, stock, stats, … }
// Z tego bierzemy PIEC pol. Reszta — w szczegolnosci `stock.available` — jest swiadomie
// pomijana (niezmiennik 8: magazyn nie prowadzi stanow magazynowych).

import { groszeZKwoty } from './kwota.js';
import { wymagajListyKanalow } from './lista-kanalow.js';
import { adresMiniatury } from './miniatury.js';

// ⚠️ BIALA LISTA KANALOW, nie „jakis napis". Kanal jest kluczem, po ktorym magazyn rozdziela
// wiersze (`UNIQUE (kanal, produkt_id, wariant_id)`) i po ktorym `oznaczZnikniete` decyduje,
// czyj katalog wlasnie zniknal ze sprzedazy. Literowka w kluczu zalozylaby kanal
// WIDMOWY: wiersze, ktorych nie widzi zaden filtr listy, a przy nastepnym przebiegu caly
// katalog prawdziwego kanalu oznaczony jako wycofany. Wartosci sa TE SAME, co klucze
// `config.kanaly` i kolumny `zamowienia.sklep`; listę przekazuje konfiguracja instancji.

// Adres oferty na Allegro. Sklejany, bo lista ofert go NIE niesie — a bez niego nie da sie
// z magazynu wejsc na oferte, ktora wlasnie sie oglada.
const ADRES_OFERTY = 'https://allegro.pl/oferta/';

// Ten sam warunek, co w domain/miniatury.js i z tego samego powodu: adres laduje wprost
// w atrybucie `src` naszego HTML-a.
const ADRES_HTTP = /^https?:\/\//i;

// ⚠️ JEDYNA WALUTA, KTORA LUSTRO UMIE ZAPISAC. `produkty_sklepowe.cena_gr` to goły `INTEGER`
// i kolumny waluty NIE MA (schema.sql) — Etap 1 jej nie dokłada, bo oba konta stoją na
// allegro.pl i sprzedają w złotówkach.
//
// ⚠️⚠️ NIE ODRZUCAMY EUR DLATEGO, ZE JEST ZLE, TYLKO DLATEGO, ZE KOLUMNA NIE NIESIE WALUTY —
// zapis byłby wtedy KLAMSTWEM. Zmierzone przy recenzji: oferta z `currency: 'EUR'` i kwotą
// „89.00" wpadała do lustra jako 8900 groszy, czyli wyglądała na ~4× tańszą od tego samego
// produktu w sklepie, i to CICHO. Konto Allegro B sprzedaje na pięć rynków (`allegro-cz`, `-sk`,
// `-hu`), więc to nie jest przypadek teoretyczny — dziś `sellingMode.price` oddaje cenę rynku
// bazowego, ale wystarczy jedna zmiana po stronie Allegro.
//
// ⚠️ GDYBY KIEDYS DOSZLA KOLUMNA WALUTY, TO JEST PIERWSZE MIEJSCE DO ZMIANY: strażnik
// zamienia się wtedy w przepisanie wartości, a nie w odmowę.
const WALUTA_LUSTRA = 'PLN';

/**
 * Cena z oferty Allegro (`sellingMode.price`) → GROSZE jako `INTEGER`.
 *
 * Samo przeliczenie kwoty siedzi w `domain/kwota.js` — TA SAMA regula obowiazuje ceny
 * ze sklepow (`services/magazyn-sync.js`), bo obie lada w tej samej kolumnie. Tutaj zostaje
 * to, co jest WYLACZNIE allegrowe: waluta.
 *
 * ⚠️ TRZY STANY, NIE DWA. Brak kwoty (`undefined`/`null`, brak `sellingMode`) to `null` —
 * stan normalny. Kwota, ktorej NIE UMIEMY przeliczyc, RZUCA (patrz `domain/kwota.js`).
 */
function groszeZCeny(cena, opisOferty) {
  const kwota = cena?.amount;
  if (kwota === undefined || kwota === null) return null;

  // ⚠️ WALUTA SPRAWDZANA ZANIM POLICZYMY GROSZE, i to jest cała różnica: kwota bez waluty
  // jest liczbą bez znaczenia. Brak pola i wartość nie-napis wpadają w ten sam warunek
  // ŚWIADOMIE — waluty, której nie da się zweryfikować, nie wolno zgadywać na „pewnie PLN",
  // a to są pieniądze. Ta odmowa domyka niespójność: przecinek dziesiętny i wartość ujemną
  // odrzucaliśmy głośno, a nieznaną walutę przyjmowaliśmy bez słowa.
  const waluta = cena?.currency;
  if (waluta !== WALUTA_LUSTRA) {
    throw new Error(
      `Allegro: oferta ${opisOferty} ma cenę w walucie "${String(waluta)}", a lustro magazynu `
      + `trzyma wyłącznie grosze ${WALUTA_LUSTRA} (kolumna cena_gr nie niesie waluty)`,
    );
  }

  // Prefiks „Allegro:" doklejamy TUTAJ, a nie w `domain/kwota.js`: ten sam komunikat
  // powstaje takze dla sklepow i musi wtedy nazywac sklep, a nie Allegro.
  try {
    return groszeZKwoty(kwota, `oferta ${opisOferty}`);
  } catch (e) {
    throw new Error(`Allegro: ${e.message}`);
  }
}

// Adres zdjecia glownego oferty. JEDNO miejsce, w ktorym ten plik wie, ze zdjecie siedzi
// w `primaryImage.url` — pytaja o to dwa pola wiersza (galeria i miniatura), a druga kopia
// tej wiedzy rozjechalaby sie po cichu: jedno pole zostaloby puste, drugie nie.
function adresZdjecia(oferta) {
  const url = oferta?.primaryImage?.url;
  if (typeof url !== 'string') return null;
  const adres = url.trim();
  return adres && ADRES_HTTP.test(adres) ? adres : null;
}

function zdjeciaJson(oferta) {
  const adres = adresZdjecia(oferta);
  if (!adres) return null;
  // ⚠️ JEDEN ELEMENT I TO WYSTARCZA. Lista ofert niesie wylacznie `primaryImage`; pelna
  // galeria kosztowalaby 447 osobnych wywolan `/sale/product-offers/{id}`, a zdjecia do
  // karty produktu i tak bierzemy ze SKLEPU, gdzie Woo oddaje komplet za darmo.
  // Tablica, a nie goly adres — kolumna jest wspolna z produktami sklepowymi.
  return JSON.stringify([adres]);
}

/**
 * Oferta Allegro → wiersz `produkty_sklepowe`, gotowy dla `zapiszProduktSklepowy`.
 *
 * `kanal` oraz jawna lista dozwolonych kanałów są obowiązkowe.
 */
export function ofertaNaProdukt(oferta, kanal, dozwoloneKanaly) {
  wymagajListyKanalow(dozwoloneKanaly);
  if (!dozwoloneKanaly.includes(kanal)) {
    throw new Error(
      `ofertaNaProdukt: „${String(kanal)}" nie jest kanałem Allegro (są: ${dozwoloneKanaly.join(', ')})`,
    );
  }

  // ⚠️ NAPIS, DOKLADNIE TAKI, JAKI PRZYSZEDL — nigdy przez `Number()`. Wiodace zera gina po
  // cichu, a identyfikator powyzej 2^53 zmienia sie w INNA oferte i wywala potem ODCZYT
  // z SQLite (RangeError), czyli jeden wiersz przestaje renderowac CALA liste magazynu.
  // Gdyby Allegro zaczelo oddawac liczbe, cyfry sa stracone juz w chwili `JSON.parse`
  // i zadne mapowanie ich nie odzyska — ma o tym powiedziec wyjatek, a nie cichy wiersz.
  const produktId = oferta?.id;
  if (typeof produktId !== 'string' || !produktId.trim()) {
    throw new Error(
      `ofertaNaProdukt: oferta bez identyfikatora tekstowego (dostałem ${JSON.stringify(oferta?.id) ?? 'undefined'})`,
    );
  }

  // Nazwa oferty jest JEDYNA rzecza, po ktorej czlowiek wiaze oferte z produktem — SKU nie ma,
  // bo `external` jest puste na wszystkich ofertach. Kolumna jest przy tym NOT NULL, wiec
  // bez tego straznika brak nazwy wychodzilby dopiero na bazie, w polowie 447 ofert.
  const nazwa = oferta?.name;
  if (typeof nazwa !== 'string' || !nazwa.trim()) {
    throw new Error(`ofertaNaProdukt: oferta ${produktId} nie ma nazwy`);
  }

  return {
    kanal,
    produkt_id: produktId,
    // ⚠️ PUSTY NAPIS, NIE `null`. Allegro nie ma wariantow, a w SQLite NULL-e w UNIQUE sa
    // wzajemnie ROZNE — przy `null` ta sama oferta wpadalaby do tabeli przy KAZDYM odczycie.
    wariant_id: '',
    nazwa,
    // ⚠️ Zmierzone: `external` jest `null` na WSZYSTKICH ofertach obu kont (0/40). Powiazanie
    // produktu z oferta jest przez to reczne — ale odczyt ma to przezyc, a nie sie wywrocic.
    sku_sklepu: oferta?.external?.id ?? null,
    cena_gr: groszeZCeny(oferta?.sellingMode?.price, produktId),
    zdjecia_json: zdjeciaJson(oferta),
    // ⚠️⚠️ JEDYNY KANAL, W KTORYM ADRES MINIATURY NADAL WYPROWADZAMY — i to jest decyzja,
    // a nie przeoczenie. Sklepy WooCommerce oddaja gotowy adres w Store API (patrz
    // `domain/miniatury.js: miniaturyZeStoreApi`), wiec od 2026-08-12 magazyn ich nie zgaduje.
    // Allegro odpowiednika nie ma: przy ofercie przychodzi wylacznie `primaryImage.url`.
    //
    // Regula Allegro to jednak NIE JEST ta sama klasa zgadywania, ktora wlasnie wyrzucilismy.
    // Tamta doklejala rozmiar do NAZWY PLIKU i zakladala, ze WordPress wygenerowal akurat
    // 150x150 — na sklepie A nieprawda w 608 z 684 przypadkow. Ta PODMIENIA SEGMENT SCIEZKI
    // (`/original/` → `/s150/`) i jest ZMIERZONA na zywym zdjeciu (05.08.2026): wszystkie
    // warianty odpowiadaja 200, `s150` wazy 7,9 kB.
    //
    // ⚠️ ZAPISUJEMY, a nie liczymy w widoku, bo lista magazynu czyta juz WYLACZNIE kolumne
    // `miniatura`. Osobna sciezka „sklep tak, Allegro inaczej" w szablonie bylaby dokladnie
    // ta kopia reguly, ktorej zakazuje niezmiennik 4.13c. Cena: gdyby Allegro zmienilo schemat
    // adresow, poprawka wymaga ponownego odczytu ofert, a nie samej zmiany widoku.
    miniatura: adresMiniatury(adresZdjecia(oferta)),
    adres: `${ADRES_OFERTY}${encodeURIComponent(produktId)}`,
    // Rozmiar jest w nazwie tylko w ~40% ofert i `wymiaryZTekstu` NIGDY nie zgaduje —
    // do lustra idzie caly tekst zrodlowy, wyprowadzenie milimetrow to osobna regula.
    rozmiar_tekst: nazwa,
    // ⚠️ Bez tego oferta zakonczona udaje zywa: wchodzi na liste „do powiazania" i do
    // generatora SKU na rowni ze sprzedawana.
    status_publikacji: oferta?.publication?.status ?? null,
  };
}
