// PRZ-160 E3.06 — oferta Allegro z karty: błędy, ostrzeżenia, dokładne żądanie POST /sale/product-offers
// i droga produktu. Czysta funkcja bez bazy i sieci; wejście składa E3.06b, używają jej podgląd i pętla.
import { brakiUstawienOfert } from './erli-oferty-ustawienia.js';
import { bezIlosciKanalu, OSTRZEZENIE_BRAK_STANU } from './erli-produkt.js';
import { dobierzCennik, regulyKonta } from './cennik-dostaw.js';
import { cenaZNarzutem, kwotaDziesietna } from './cena-kanalu.js';
import { poprawneSekcje, sekcjeDlaAllegro } from './opis-sekcje.js';

/** Problemy pętli Allegro zapisywane w rejestrze (§4.0) — jedno miejsce na kształty. */
export const PROBLEMY_ALLEGRO = Object.freeze({
  'wiele-produktow': produkty => ({ kod: 'wiele-produktow', produkty }),
  'parameter-mismatch': (produktId, parametr) => ({ kod: 'parameter-mismatch', produktId, parametr }),
  duplikat: oferty => ({ kod: 'duplikat', oferty }),
  walidacja: bledy => ({ kod: 'walidacja', bledy }),
  aktywacja: tekst => ({ kod: 'aktywacja', tekst }),
  // `tekst` = powód, dla którego pętla nie wznowiła wyprzedanej oferty (D41) — decyzja zapadła, czeka na człowieka.
  zakonczona: (sztuk, tekst) => (tekst ? { kod: 'zakonczona', sztuk, tekst } : { kod: 'zakonczona', sztuk }),
  'brak-w-allegro': () => ({ kod: 'brak-w-allegro' }),
  'bez-potwierdzenia': () => ({ kod: 'bez-potwierdzenia' }),
  komenda: (rodzaj, tekst) => ({ kod: 'komenda', rodzaj, tekst }),
  // E3.26a: Allegro nie zakończyło oferty (ENDED) po MAKS_PROB_ZDJECIA próbach — pętla przestaje próbować.
  zdejmowanie: tekst => ({ kod: 'zdejmowanie', tekst }),
});

export const PARAMETR_STAN = '11323';
export const STAN_NOWY = '11323_1';
export const LIMIT_NAZWY = 75;
export const LIMIT_ZDJEC = 16;
export const LIMIT_INFORMACJI_BEZPIECZENSTWA = 5000;
/** Miejsce zdjęcia, które pętla wgra przed wysyłką; `podstawWgraneZdjecia` wstawia adres z Allegro. */
export const ZNACZNIK_WGRANIA = 'oms-zdjecie:';
// [A1] „Znak & jest encjonowany jako &amp; dlatego zajmuje 5 miejsc w tytule”. Inne znaki — niepotwierdzone.
const ENCJE_NAZWY = { '&': 5 };
// Dozwolone `delivery.handlingTime` (dokumentacja; P13 tylko potwierdza) — dni → wartość ISO 8601.
export const CZASY_WYSYLKI = Object.freeze([
  [0, 'PT0S'], [1, 'PT24H'], [2, 'P2D'], [3, 'P3D'], [4, 'P4D'], [5, 'P5D'], [7, 'P7D'], [10, 'P10D'],
  [14, 'P14D'], [21, 'P21D'], [30, 'P30D'], [60, 'P60D'],
]);
// Zwolnienie z VAT (stawka karty `zw`). Niepotwierdzone — brak przykładu e3-dok-*; P13/E3.17 sprawdza.
export const VAT_ZW_ALLEGRO = Object.freeze({ exemption: 'MONEY_EQUIVALENT', rate: 'zw' });
const STAWKI = new Set(['23', '8', '5', '0']);
const PRZELICZNIKI = {
  mm_na_cm: w => (Number(w) / 10).toFixed(2),
  g_na_kg: w => (Number(w) / 1000).toFixed(3),
};
const ALLEGROIMG = /^https:\/\/(?:[a-z0-9-]+\.)*allegroimg\.com\//i;
const CZEKAJACE_REJESTR = new Set(['szkic', 'do_wyslania', 'wyslana', 'sprawdzana', 'aktywna']);
const CZEKAJACE_LUSTRO = new Set(['ACTIVE', 'ACTIVATING']);
const ADRES_KATEGORII = '/magazyn/kategorie';
const ADRES_MAREK = '/magazyn/marki';

const napis = w => (typeof w === 'string' ? w.trim() : w == null ? '' : String(w).trim());
const lista = w => (Array.isArray(w) ? w : []);

/** Długość tytułu tak, jak liczy ją Allegro — po zamianie encji. */
export function dlugoscNazwyAllegro(nazwa) {
  let n = 0;
  for (const znak of nazwa) n += ENCJE_NAZWY[znak] ?? 1;
  return n;
}

function json(w) {
  if (w == null || w === '') return null;
  if (typeof w === 'object') return w;
  try { return JSON.parse(w); } catch { return undefined; }
}

// Parametr importu ({wartosci, wartosciId, zakres}) → kształt Allegro.
function zImportu(p) {
  if (Array.isArray(p.wartosciId) && p.wartosciId.length) return { id: p.id, valuesIds: [...p.wartosciId] };
  if (Array.isArray(p.wartosci) && p.wartosci.length) return { id: p.id, values: [...p.wartosci] };
  if (p.zakres) return { id: p.id, rangeValue: p.zakres };
  return null;
}

function maWartosc(p) {
  return Boolean(p && ((Array.isArray(p.valuesIds) && p.valuesIds.length) || (Array.isArray(p.values) && p.values.length)
    || p.rangeValue));
}

/**
 * @param {object} wejscie kształty §4.0 — opis pól w teście `tests/domena/allegro-oferta-z-karty.test.js`
 * @returns {{bledy: {kod: string, tekst: string, adres?: string}[], ostrzezenia: {kod: string, tekst: string}[],
 *   zadanie: object | null, droga: 'katalog-id'|'ean'|'nowy'|null, doWgrania: object[]}}
 */
export function ofertaAllegroZKarty(wejscie) {
  const {
    karta = {}, konto = {}, znakInstalacji, ustawienia = {}, zdjecia = [], wgraneZdjecia = [], daneImportu = null,
    kartaAllegro = null, mapaKategorii = [], reguly = [], opisyKategorii = {}, marki = [], producenciMarek = [],
    ofertyKarty = [], katalog = null, teraz = new Date().toISOString(), ilosc,
  } = wejscie ?? {};
  const bledy = [];
  const ostrzezenia = [];
  const blad = (kod, tekst, adres) => bledy.push(adres ? { kod, tekst, adres } : { kod, tekst });
  const ostrzez = (kod, tekst) => ostrzezenia.push({ kod, tekst });
  const nazwaKonta = napis(konto.nazwa) || napis(konto.klucz) || 'Allegro';

  // Nazwa (1–75 znaków po encjach) — z nadpisania na karcie, gdy jest.
  const name = napis(kartaAllegro?.nazwa) || napis(karta.nazwa);
  const dlugosc = dlugoscNazwyAllegro(name);
  if (dlugosc < 1 || dlugosc > LIMIT_NAZWY) {
    blad('nazwa', `Nazwa dla Allegro ma ${dlugosc} znaków po zamianie encji (& liczy się jak 5) — dozwolone 1–${LIMIT_NAZWY}. Skróć ją na karcie (sekcja Allegro).`);
  }

  // Kategoria (D33): nadpisanie → import → mapa (główna, potem pierwsza zmapowana) → błąd.
  const kategorieKarty = lista(wejscie?.kategorieKarty).length ? wejscie.kategorieKarty
    : [karta.kategoria_glowna].filter(Boolean);
  const zMapy = nazwa => mapaKategorii.find(m => m.kategoriaKarty === nazwa)?.kategoriaAllegroId;
  const kategoriaImportu = napis(daneImportu?.kategoria_id);
  let kategoria = napis(kartaAllegro?.kategoria_id) || kategoriaImportu;
  if (!kategoria) {
    const glowna = napis(karta.kategoria_glowna) || kategorieKarty[0];
    kategoria = napis(zMapy(glowna));
    if (!kategoria) {
      const zastepcza = kategorieKarty.find(k => napis(zMapy(k)));
      if (zastepcza) {
        kategoria = napis(zMapy(zastepcza));
        ostrzez('kategoria-zastepcza', `Kategoria główna „${glowna}” nie ma kategorii Allegro — użyto kategorii „${zastepcza}”.`);
      }
    }
  }
  const opis = kategoria ? opisyKategorii[kategoria] : null;
  const nazwaKategorii = napis(lista(opis?.sciezka).at(-1)?.nazwa) || kategoria;
  if (!kategoria) {
    blad('kategoria', 'Przypisz kategorię Allegro w Magazyn → Kategorie.', ADRES_KATEGORII);
  } else if (!opis) {
    blad('opis-kategorii', `Pobierz opis kategorii Allegro ${kategoria} (Magazyn → Kategorie).`, ADRES_KATEGORII);
  } else if (!opis.lisc) {
    blad('kategoria-nie-lisc', `Kategoria Allegro „${nazwaKategorii}” nie jest liściem — wybierz najniższą kategorię.`, ADRES_KATEGORII);
  }
  const zgodnaZImportem = Boolean(kategoria) && kategoria === kategoriaImportu;

  // Droga produktu (D34). Wybór katalogu przychodzi z pętli; podgląd nie używa sieci.
  const ean = napis(karta.ean);
  const produktId = napis(katalog?.produktId) || napis(kartaAllegro?.produkt_id)
    || (zgodnaZImportem ? napis(daneImportu?.produkt_id) : '');
  const droga = produktId ? 'katalog-id' : ean && !katalog?.brak ? 'ean' : 'nowy';
  if (droga === 'nowy' && opis && !opis.tworzenieProduktu) {
    blad('kategoria-bez-produktow', `Kategoria Allegro „${nazwaKategorii}” nie pozwala tworzyć produktów — dodaj EAN na karcie albo wybierz produkt z Katalogu.`);
  }

  // Parametry: nadpisanie na karcie → import (ta sama kategoria) → reguła kategorii.
  const nadpisane = new Map(lista(kartaAllegro?.parametry).map(p => [napis(p.id), p]));
  const zImportuMapa = new Map(zgodnaZImportem
    ? [...lista(daneImportu?.parametry?.produkt), ...lista(daneImportu?.parametry?.oferta)].map(p => [napis(p.id), p])
    : []);
  const regulyKategorii = new Map(reguly.filter(r => napis(r.kategoriaAllegroId) === kategoria).map(r => [napis(r.parametrId), r]));
  const marka = napis(karta.marka);

  function zReguly(p, r) {
    if (r.rodzaj === 'stala') return r.wartosc ? { id: p.id, ...json(r.wartosc) } : null;
    if (r.rodzaj !== 'pole') return null; // 'na_karcie' — tylko z nadpisania na karcie
    if (r.pole === 'marka') {
      if (!marka) return null;
      const m = marki.find(x => napis(x.marka) === marka);
      if (!m) {
        blad('marka', `Marka „${marka}” nie ma odpowiednika w Allegro — przypisz ją w Magazyn → Marki.`, ADRES_MAREK);
        return null;
      }
      if (!lista(m.kategorieSprawdzone).map(String).includes(kategoria)) {
        blad('marka-kategoria', `Sprawdź markę ${marka} w kategorii ${nazwaKategorii} (Magazyn → Marki).`, ADRES_MAREK);
        return null;
      }
      return napis(m.wartoscId) ? { id: p.id, valuesIds: [napis(m.wartoscId)] }
        : napis(m.wartoscTekst) ? { id: p.id, values: [napis(m.wartoscTekst)] } : null;
    }
    const surowa = karta[r.pole];
    if (surowa == null || napis(surowa) === '') return null;
    if (r.przelicznik) {
      const przelicz = PRZELICZNIKI[r.przelicznik];
      if (!przelicz || !Number.isFinite(Number(surowa))) {
        blad('parametr', `Nie umiem przeliczyć pola ${r.pole} dla parametru „${p.nazwa}” — popraw regułę w Magazyn → Kategorie.`, ADRES_KATEGORII);
        return null;
      }
      return { id: p.id, values: [przelicz(surowa)] };
    }
    return { id: p.id, values: [napis(surowa)] };
  }

  const parametryProduktu = [];
  const parametryOferty = [];
  for (const p of lista(opis?.parametry)) {
    const id = napis(p.id);
    const doProduktu = p.opisujeProdukt === true;
    // Produkt z Katalogu ma własne parametry produktu — wysyłamy tylko parametry oferty.
    if (doProduktu && droga !== 'nowy') continue;
    // Nowy produkt może użyć pól karty także przed przypisaniem reguł kategorii.
    const poleDomyslne = doProduktu && droga === 'nowy'
      ? (napis(p.nazwa) === 'Marka' ? 'marka' : napis(p.nazwa) === 'EAN (GTIN)' ? 'ean' : null) : null;
    const regula = regulyKategorii.get(id) ?? (poleDomyslne ? { rodzaj: 'pole', pole: poleDomyslne } : null);
    const wymagany = p.wymagany || (droga === 'nowy' && p.wymaganyDlaProduktu);
    let wartosc = nadpisane.has(id) ? { id, ...nadpisane.get(id) } : null;
    if (!maWartosc(wartosc) && zImportuMapa.has(id)) wartosc = zImportu({ ...zImportuMapa.get(id), id });
    if (!maWartosc(wartosc) && regula) {
      const bledyPrzed = bledy.length;
      wartosc = zReguly({ ...p, id }, regula);
      // Domyślne pole karty przy parametrze opcjonalnym: marka spoza mapy nie blokuje — parametr po prostu nie idzie.
      if (!wymagany && !regulyKategorii.has(id)) bledy.length = bledyPrzed;
    }
    if (maWartosc(wartosc)) {
      (doProduktu ? parametryProduktu : parametryOferty).push(wartosc);
      continue;
    }
    // „Stan” bez wartości dostaje niżej domyślne „Nowy”.
    if (!wymagany || id === PARAMETR_STAN) continue;
    if (regula?.pole === 'ean') {
      blad('gtin', `Kategoria „${nazwaKategorii}” wymaga parametru „${p.nazwa}” dla nowego produktu — uzupełnij EAN na karcie albo przypisz regułę w Magazyn → Kategorie Allegro.`);
    } else if (regula?.pole === 'marka' && marka) {
      // Błąd mapy marki (brak, kategoria) już zgłoszony; zostaje marka zmapowana na „bez marki” (D36).
      if (!bledy.some(b => b.kod === 'marka' || b.kod === 'marka-kategoria')) {
        blad('marka', `Marka „${marka}” jest przypisana w Allegro jako „bez marki”, a kategoria ${nazwaKategorii} wymaga parametru „${p.nazwa}” — wybierz wartość w Magazyn → Marki.`, ADRES_MAREK);
      }
    } else if (doProduktu && droga === 'nowy') {
      const wskazowka = poleDomyslne === 'marka' ? 'markę na karcie' : `parametr „${p.nazwa}” na karcie (sekcja Allegro)`;
      blad('parametr', `Kategoria „${nazwaKategorii}” wymaga parametru „${p.nazwa}” dla nowego produktu — uzupełnij ${wskazowka} albo przypisz regułę w Magazyn → Kategorie Allegro.`, ADRES_KATEGORII);
    } else {
      blad('parametr', `Uzupełnij parametr „${p.nazwa}” — na karcie (sekcja Allegro) albo regułą w Magazyn → Kategorie.`, ADRES_KATEGORII);
    }
  }
  // „Stan” zawsze w parameters[] (D33, 1.2) — domyślnie „Nowy”, gdy żadne źródło go nie dało.
  const stanWProdukcie = parametryProduktu.findIndex(p => napis(p.id) === PARAMETR_STAN);
  if (stanWProdukcie >= 0) parametryOferty.push(...parametryProduktu.splice(stanWProdukcie, 1));
  if (!parametryOferty.some(p => napis(p.id) === PARAMETR_STAN)) parametryOferty.unshift({ id: PARAMETR_STAN, valuesIds: [STAN_NOWY] });

  // Zdjęcia (D32): kolejność galerii, najwyżej 16.
  const wgrane = new Map(lista(wgraneZdjecia).map(w => [w.zdjecie_id, w]));
  const posortowane = [...zdjecia].sort((a, b) => (a.kolejnosc ?? 0) - (b.kolejnosc ?? 0));
  if (!posortowane.length) blad('zdjecia', 'Dodaj co najmniej jedno zdjęcie na karcie produktu.');
  if (posortowane.length > LIMIT_ZDJEC) ostrzez('zdjecia-limit', `Allegro przyjmie ${LIMIT_ZDJEC} z ${posortowane.length} zdjęć — pójdzie pierwsze ${LIMIT_ZDJEC} w kolejności galerii.`);
  const images = [];
  const doWgrania = [];
  const adresZdjecia = new Map(); // id zdjęcia → adres w images
  for (const [i, z] of posortowane.slice(0, LIMIT_ZDJEC).entries()) {
    const numer = i + 1;
    const zrodlo = napis(z.adres_zrodlowy);
    let adres;
    if (ALLEGROIMG.test(zrodlo)) {
      // Allegro trzyma oznaczenie z pierwszego wgrania — inne ręczne oznaczenie nie przejdzie.
      if (z.ai_reczne === 1) {
        blad('zdjecie-ai', `Zdjęcie ${numer} pochodzi z Allegro, a jego oznaczenie AI zmieniono w OMS-ie — Allegro go nie zmieni. Usuń zdjęcie z karty albo wgraj inny plik.`);
        continue;
      }
      adres = zrodlo;
    } else if (z.ai == null) {
      blad('zdjecie-ai', `Określ, czy zdjęcie ${numer} jest wygenerowane przez AI (galeria karty).`);
      continue;
    } else {
      const w = wgrane.get(z.id);
      if (w && w.ai !== z.ai) {
        blad('zdjecie-ai', `Zdjęcie ${numer} wgrano do Allegro z innym oznaczeniem AI — oznaczenia nie da się zmienić. Usuń zdjęcie z karty albo wgraj inny plik.`);
        continue;
      }
      if (w && napis(w.adres) && (!w.wygasa_at || w.wygasa_at > teraz)) adres = napis(w.adres);
      else {
        adres = `${ZNACZNIK_WGRANIA}${z.id}`;
        doWgrania.push({ ...z, numer });
      }
    }
    images.push(adres);
    adresZdjecia.set(z.id, adres);
  }

  // Opis: sekcje Allegro; zdjęcia opisu muszą być zdjęciami oferty.
  let description;
  if (karta.opis == null || lista(karta.opis.sekcje).length === 0) {
    ostrzez('opis', 'Oferta nie ma opisu — uzupełnij opis na karcie.');
  } else {
    const walidacja = poprawneSekcje(karta.opis);
    if (!walidacja.ok) blad('opis', `Popraw opis na karcie: ${walidacja.bledy.join(' ')}`);
    else {
      const sekcje = {
        sekcje: karta.opis.sekcje.map((s, i) => ({
          elementy: s.elementy.map(e => {
            if (e.typ !== 'zdjecie') return e;
            const z = posortowane.find(x => napis(x.adres_zrodlowy) === e.adres
              || (x.sha256 && e.adres.includes(`/z/${x.sha256}.`)) || napis(wgrane.get(x.id)?.adres) === e.adres);
            const adres = z ? adresZdjecia.get(z.id) : undefined;
            if (!adres) blad('opis', `Zdjęcie w sekcji ${i + 1} opisu nie jest zdjęciem oferty — dodaj je do galerii karty (pierwsze ${LIMIT_ZDJEC}) albo usuń z opisu.`);
            return { ...e, adres: adres ?? e.adres };
          }),
        })),
      };
      const wynik = sekcjeDlaAllegro(sekcje);
      if (wynik.blad) blad('opis', wynik.blad);
      else description = wynik;
    }
  }

  // Ustawienia konta, cena (D45), ilość (D14), dostawa, VAT.
  // Cennik dobrany do rozmiaru (E3d.02, D5–D6); brak cennika konta zgłaszają braki ustawień. E3d.02-03: wyjątek
  // z karty wystarcza także na koncie bez reguł — jak w ERLI (`produktErliZKarty`).
  const dostawa = dobierzCennik({ karta, reguly: regulyKonta(ustawienia), wyjatek: wejscie?.wyjatekCennika });
  const braki = brakiUstawienOfert(ustawienia, 'allegro').filter(b => !(b === 'cennik dostaw' && dostawa.cennik));
  if (braki.length) blad('ustawienia', `Uzupełnij w konfiguratorze konta ${nazwaKonta}: ${braki.join(', ')}.`);
  if (dostawa.odmowa?.kod === 'brak-wymiarow') blad('cennik', dostawa.odmowa.tekst);
  // Wyjątek z karty spoza bieżącej listy cenników konta (zniknął po „Pobierz z Allegro”) — odmowa tylko przy tworzeniu
  // oferty (podgląd i zatwierdzenie, `tworzenie: true`); cena, ilość i wznowienie żywej oferty idą bez niej (E3d.02-03p3).
  const listaCennikow = Array.isArray(ustawienia.slowniki?.cenniki) ? ustawienia.slowniki.cenniki : [];
  if (wejscie?.tworzenie === true && dostawa.powod?.rodzaj === 'wyjatek' && !listaCennikow.some(p => p?.id === dostawa.cennik)) {
    blad('cennik', 'Cennik z karty nie istnieje już na koncie Allegro — wybierz inny');
  }
  const cena = cenaZNarzutem(karta.cena_gr, ustawienia.narzutBp);
  if (cena.bledy.includes('cena')) blad('cena', 'Ustaw cenę brutto większą od zera na karcie, w całkowitej liczbie groszy.');
  if (cena.bledy.includes('narzut')) blad('narzut', `Ustaw nieujemny, całkowity narzut w konfiguratorze konta ${nazwaKonta}.`);
  if (cena.bledy.includes('zakres')) blad('cena', 'Cena z narzutem przekracza bezpieczny zakres — zmniejsz cenę lub narzut.');
  // E4.06 (D47): `ilosc` = wynik iloscDlaKanalu; null (poza „brak-stalej”) → bez pola ilości i bez błędu.
  const bezIlosci = bezIlosciKanalu(ilosc);
  const stock = ilosc ? ilosc.ilosc : ustawienia.stalaIlosc;
  if (!bezIlosci && stock != null && (!Number.isSafeInteger(stock) || stock < 0)) blad('ilosc', 'Stała liczba sztuk musi być całkowita i nieujemna.');
  if (ilosc?.powod === 'brak-stanu') ostrzez('ilosc', OSTRZEZENIE_BRAK_STANU);
  const dni = ustawienia.czasWysylkiDni;
  const handlingTime = Number.isSafeInteger(dni) && dni >= 0 ? CZASY_WYSYLKI.find(([d]) => d >= dni)?.[1] : undefined;
  if (dni != null && !handlingTime) blad('czas-wysylki', `Czas wysyłki ${dni} dni jest poza wartościami Allegro (najwyżej 60 dni).`);
  const vat = (napis(karta.stawka_vat) || napis(ustawienia.stawkaVat)).toLowerCase();
  let taxSettings;
  if (vat === 'zw') taxSettings = { subject: 'GOODS', exemption: VAT_ZW_ALLEGRO.exemption, rates: [{ rate: VAT_ZW_ALLEGRO.rate, countryCode: 'PL' }] };
  else if (STAWKI.has(vat)) taxSettings = { subject: 'GOODS', rates: [{ rate: `${vat}.00`, countryCode: 'PL' }] };
  else if (vat) blad('vat', `Stawka VAT „${vat}” nie jest obsługiwana w Allegro — ustaw 23, 8, 5, 0 albo zw.`);

  // GPSR (D35).
  const pozycja = {};
  const przypisanie = marka ? producenciMarek.find(x => napis(x.marka) === marka) : null;
  const producentKonta = () => {
    if (!napis(ustawienia.producentId)) {
      blad('producent', `Ustaw producenta konta ${nazwaKonta} (krok Oferty w konfiguratorze konta).`);
      return;
    }
    pozycja.responsibleProducer = { type: 'ID', id: napis(ustawienia.producentId) };
    if (napis(ustawienia.osobaOdpowiedzialnaId)) pozycja.responsiblePerson = { id: napis(ustawienia.osobaOdpowiedzialnaId) };
  };
  if (przypisanie?.zrodlo === 'konto') producentKonta();
  else if (przypisanie?.zrodlo === 'wybrany' && napis(przypisanie.producentId)) {
    pozycja.responsibleProducer = { type: 'ID', id: napis(przypisanie.producentId) };
    if (napis(przypisanie.osobaOdpowiedzialnaId)) pozycja.responsiblePerson = { id: napis(przypisanie.osobaOdpowiedzialnaId) };
  } else if (droga === 'katalog-id') {
    // Bez przypisania pole pomijamy — Allegro bierze dane GPSR z produktu (A2).
  } else if (!marka) producentKonta();
  else blad('producent', `Przypisz producenta marki ${marka} na koncie ${nazwaKonta} (Ustawienia → Integracje → Allegro → konto → krok Oferty).`);

  const informacja = json(karta.informacja_bezpieczenstwa);
  if (informacja === undefined) blad('bezpieczenstwo', 'Informacja o bezpieczeństwie na karcie jest uszkodzona — wpisz ją ponownie.');
  else if (informacja?.typ === 'ATTACHMENTS') {
    if (napis(informacja.konto) === napis(konto.klucz) && lista(informacja.zalaczniki).length) {
      pozycja.safetyInformation = { type: 'ATTACHMENTS', attachments: informacja.zalaczniki.map(z => ({ id: napis(z.id) })) };
    } else blad('bezpieczenstwo', `Załączniki bezpieczeństwa należą do innego konta Allegro — na koncie ${nazwaKonta} wpisz informację tekstem.`);
  } else {
    const tekst = napis(informacja?.typ === 'TEXT' ? informacja.tekst : '') || napis(ustawienia.bezpieczenstwoDomyslne);
    if (!tekst) blad('bezpieczenstwo', `Wpisz informację o bezpieczeństwie na karcie albo tekst domyślny konta ${nazwaKonta}.`);
    else if (tekst.length > LIMIT_INFORMACJI_BEZPIECZENSTWA) blad('bezpieczenstwo', `Informacja o bezpieczeństwie ma ${tekst.length} znaków — Allegro przyjmie najwyżej ${LIMIT_INFORMACJI_BEZPIECZENSTWA}.`);
    else pozycja.safetyInformation = { type: 'TEXT', description: tekst };
  }

  // external.id (D31) i D43.
  const znak = napis(znakInstalacji);
  if (!znak) blad('znak-instalacji', 'Brak znaku instalacji OMS — sygnatury oferty nie da się nadać.');
  const czynne = lista(ofertyKarty).filter(o => (o.zrodlo === 'lustro'
    ? CZEKAJACE_LUSTRO.has(napis(o.stan).toUpperCase()) : CZEKAJACE_REJESTR.has(napis(o.stan)))).length;
  if (czynne >= 2) ostrzez('dwie-oferty', `Karta ma już ${czynne} aktywne albo czekające oferty na kontach Allegro — Allegro nie pozwala na więcej niż dwie oferty tego samego przedmiotu w stanie Nowy w podkategorii, niezależnie od liczby kont.`);

  if (bledy.length) return { bledy, ostrzezenia, zadanie: null, droga, doWgrania, dostawa };

  const product = droga === 'katalog-id' ? { id: produktId }
    : droga === 'ean' ? { id: ean, idType: 'GTIN' }
      : { name, category: { id: kategoria }, parameters: parametryProduktu, images: [...images] };
  const afterSalesServices = { returnPolicy: { id: napis(ustawienia.zwrotyId) }, impliedWarranty: { id: napis(ustawienia.reklamacjeId) } };
  if (napis(ustawienia.gwarancjaId)) afterSalesServices.warranty = { id: napis(ustawienia.gwarancjaId) };
  const lokalizacja = json(ustawienia.lokalizacja);
  const zadanie = {
    name,
    category: { id: kategoria },
    productSet: [{ product, ...pozycja }],
    parameters: parametryOferty,
    sellingMode: { format: 'BUY_NOW', price: { amount: kwotaDziesietna(cena.grosze), currency: 'PLN' } },
    ...(bezIlosci ? {} : { stock: { available: stock, unit: 'UNIT' } }),
    delivery: { handlingTime, shippingRates: { id: dostawa.cennik } },
    afterSalesServices,
    taxSettings,
    ...(lokalizacja ? { location: lokalizacja } : {}),
    images,
    ...(description ? { description } : {}),
    external: { id: `${znak}-K${karta.id}` },
    publication: { status: 'INACTIVE' },
    language: 'pl-PL',
  };
  return { bledy, ostrzezenia, zadanie, droga, doWgrania, dostawa };
}

/** Po wgraniu zdjęć pętla wstawia adresy Allegro w miejsce `ZNACZNIK_WGRANIA<id>` (images, produkt, opis). */
export function podstawWgraneZdjecia(zadanie, adresy) {
  const podstaw = url => {
    if (typeof url !== 'string' || !url.startsWith(ZNACZNIK_WGRANIA)) return url;
    const nowy = adresy instanceof Map ? adresy.get(url.slice(ZNACZNIK_WGRANIA.length)) : adresy?.[url.slice(ZNACZNIK_WGRANIA.length)];
    if (!nowy) throw new Error(`Brak adresu Allegro dla zdjęcia ${url.slice(ZNACZNIK_WGRANIA.length)}.`);
    return nowy;
  };
  const kopia = structuredClone(zadanie);
  kopia.images = lista(kopia.images).map(podstaw);
  for (const pozycja of lista(kopia.productSet)) {
    if (Array.isArray(pozycja.product?.images)) pozycja.product.images = pozycja.product.images.map(podstaw);
  }
  for (const sekcja of lista(kopia.description?.sections)) {
    for (const item of lista(sekcja.items)) if (item.type === 'IMAGE') item.url = podstaw(item.url);
  }
  return kopia;
}
