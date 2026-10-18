import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  zapiszProduktSklepowy, utworzKarte, powiazProdukt, SORTOWANIE_KART,
} from '../../../src/oms/db/magazyn.js';


// EKRAN MAGAZYNU — pierwsza rzecz z tej partii, ktora czlowiek zobaczy na ekranie.
//
// ⚠️ Ten test pilnuje TRZECH rzeczy, ktore odrozniaja ten ekran od „tabelki z bazy":
//   (1) awaria kanalu i liczba znikniętych sa WIDOCZNE — bez tego hamulec pustego odczytu
//       (Zadanie 7) i licznik ubytku roznia sie od stanu sprzed poprawki wylacznie wpisem
//       w `docker logs`;
//   (2) nazwa sortowania z adresu HTTP przechodzi przez BIALA LISTE — `?sort=constructor`
//       byl realna pieciusetka na glownym ekranie panelu;
//   (3) przycisk odczytu WRACA NATYCHMIAST — pelny przebieg to setki zadan HTTP.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

const STAN_PUSTY = {
  trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null,
};

// Atrapa uslugi przebiegu. `start` liczy wywolania, `stan` oddaje to, co ekran ma pokazac.
function atrapaMagazynu(stan = STAN_PUSTY) {
  return { start: vi.fn(() => ({ wystartowal: true })), stan: () => stan };
}

let db;
function serwer(magazyn = atrapaMagazynu()) {
  return buildOmsServer({ db, config, magazyn });
}

beforeEach(() => {
  db = openOmsDb(':memory:');
});

// Karta z produktem w kanale. Oddaje id karty.
function kartaZProduktem(karta, produkty = []) {
  const id = utworzKarte(db, karta);
  for (const p of produkty) {
    const produktId = zapiszProduktSklepowy(db, {
      wariant_id: '', odczytane_at: '2026-08-11T06:00:00.000Z', nazwa: karta.nazwa, ...p,
    });
    powiazProdukt(db, produktId, id);
  }
  return id;
}

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });

/**
 * WIERSZ TABELY KART o tej nazwie — sam wiersz, bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI ASERCJI. Nad tabela stoi pasek filtrow
 * (Zadanie 10) z listami wyboru kanalu i paczkomatu, ktore renderuja DOKLADNIE te same
 * napisy, co komorki tabeli, i w tej samej kolejnosci: `<option value="tak">tak</option>`,
 * `…>nie<…`, `…>nieoznaczone<…` oraz cztery etykiety kanalow. Asercja na golym napisie
 * albo na kolejnosci przez `indexOf` jest wiec spelniona przez SAM PASEK FILTROW —
 * zmierzone: po skasowaniu CALEJ tresci komorki paczkomatu suita szla 4413/4413 na zielono.
 *
 * Wszystko, co dotyczy zawartosci wiersza, ma przechodzic przez te funkcje.
 */
function wierszKarty(body, nazwa) {
  // ⚠️ NAZWA JEST ODNOSNIKIEM NA KARTE PRODUKTU (Zadanie 11) — samo `<div>nazwa</div>` juz
  // w tej kolumnie nie stoi, wiec wzorzec, ktory tego nie widzi, nie znajdzie ANI JEDNEGO
  // wiersza i cala suita padnie na „nie ma wiersza" zamiast na tresci asercji.
  const wiersz = body.split('<tr>').find((w) => w.includes(`>${nazwa}</a></div>`));
  // Brak wiersza to blad testu, a nie „pusty wiersz" — inaczej kazda asercja `not.toMatch`
  // przeszlaby na pustym napisie i znowu mielibysmy falszywa zielen.
  if (!wiersz) throw new Error(`W tabeli nie ma wiersza karty „${nazwa}"`);
  return wiersz;
}

/**
 * KOMORKA MINIATURY tego wiersza — sama komorka, bez reszty wiersza i bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI ASERCJI, i to z DWOCH powodow naraz.
 * Po pierwsze, ten sam adres zdjecia moze stac w sasiedniej kolumnie (odnosnik do produktu)
 * albo w innym wierszu tabeli — `body.toContain(adres)` bylby wiec spelniony przez cudzy
 * wiersz. Po drugie, `not.toContain` na CALEJ stronie jest spelnione takze wtedy, gdy
 * wiersza nie ma w ogole. Brak komorki jest tu bledem TESTU i ma RZUCAC.
 */
function komorkaMiniatury(body, nazwa) {
  const komorka = /<td class="kol-mini">([\s\S]*?)<\/td>/.exec(wierszKarty(body, nazwa));
  if (!komorka) throw new Error(`Wiersz karty „${nazwa}" nie ma komórki miniatury`);
  return komorka[1];
}

// Komorki kanalow TEGO wiersza, w kolejnosci renderowania. Oddaje ich TRESC — po niej
// widac, ktora cena stoi w ktorej kolumnie.
const komorkiKanalow = (wiersz) => [...wiersz.matchAll(/<td class="magazyn-kanal">([\s\S]*?)<\/td>/g)]
  .map((m) => m[1].replace(/<[^>]*>/g, '').trim());

describe('GET /magazyn — tabela kart', () => {
  it('pokazuje karta z cena w kolumnie wlasciwego kanalu, a kanal bez produktu kreska', async () => {
    kartaZProduktem(
      { nazwa: 'Kandelabr', sku: 'LMP-KAN-1', szerokosc_mm: 700, wysokosc_mm: 1000 },
      [{ kanal: 'pro', produkt_id: '944', cena_gr: 7490 }],
    );
    const app = serwer();
    // ⚠️ KOLUMNY CEN ZYJA W TRYBIE KATALOGOWYM (przebudowa 2026-08-25, Zadanie 5) — ekran
    // domyslny pokazuje kolumne „Stan" zamiast czterech kanalow. Zmienil sie ADRES, nie
    // asercja: wszystko ponizej pilnuje dokladnie tego samego, co przed przebudowa.
    const r = await get(app, '/magazyn?widok=katalog');

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kandelabr');
    // ⚠️ CENA PRZYPIETA DO SWOJEJ KOLUMNY, nie do strony. Samo `toContain('74.90')` nie
    // mowilo NIC o tym, w ktorym z czterech kanalow ta cena stoi — a tytul tego testu
    // obiecuje wlasnie kolumne. Wzorzec bierze PIERWSZA komorke kanalu (PRO) razem
    // z nastepna (sklep A), ktora ma byc pusta.
    expect(r.body).toMatch(
      /<td class="magazyn-kanal">\s*74\.90\s*<\/td>\s*<td class="magazyn-kanal">\s*<span class="magazyn-brak">—<\/span>/,
    );
    // Kanal bez produktu ma pokazac KRESKE, a nie pusta komorke: pusta wyglada jak
    // komorka, ktorej cos nie doliczylo.
    //
    // ⚠️ KRESKA PRZYPIETA DO KOMORKI KANALU — i to jest DRUGA poprawka tej asercji.
    // Najpierw stalo tu gole `toContain('—')`: myslnik wystepuje w ukladzie strony 223 razy,
    // wiec asercja byla spelniona zawsze. Po zawezeniu do `<span class="magazyn-brak">—</span>`
    // mutacja kasujaca kreske z kolumny kanalu DALEJ PRZECHODZILA — bo ten sam znacznik
    // rysuje komorka KATEGORII, ktorej ta karta tez nie ma. Nienosna asercje potrafi
    // podeprzec nie tylko arkusz ukladu, ale i sasiednia kolumna tej samej strony.
    expect(r.body).toMatch(/<td class="magazyn-kanal">\s*<span class="magazyn-brak">—<\/span>/);
  });

  it('cztery osobne kolumny kanalow, Allegro rozbite na dwa konta', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr' }, []);
    // ⚠️ TRYB KATALOGOWY — kolumny kanalow zeszly z ekranu domyslnego (Zadanie 5).
    const r = await get(serwer(), '/magazyn?widok=katalog');
    // ⚠️ ETYKIETY W NAGLOWKACH TABELI, nie „gdziekolwiek na stronie". Pasek filtrow
    // (Zadanie 10) ma pole wyboru `name="kanal"` z DOKLADNIE tymi czterema etykietami, wiec
    // petla po `toContain` byla spelniona bez udzialu tabeli: mutacja `naglowkiKanalow
    // .slice(0, 3)` razem z `w.kanaly.slice(0, 3)` zdejmowala kanal z ekranu, a suita szla
    // 4413/4413 na zielono. Etykiety ida z `domain/kanaly.js` (adresKanalu) — druga mapa
    // nazw rozjechalaby sie z kolumna „Kanal sprzedazy" na liscie zamowien.
    const naglowki = [...r.body.matchAll(/<th class="magazyn-kanal">([^<]*)<\/th>/g)].map((m) => m[1].trim());
    expect(naglowki).toEqual([
      'pro.szkicownia.pl', 'szkicownia.pl', 'Allegro szkicownia_pl', 'Allegro AmarkaPL',
    ]);
  });

  // ⚠️⚠️ TEN TEST WIAZE ODCZYT Z KOLUMNA i jest jedynym miejscem, ktore to robi. Kanal
  // czytany do lustra, ale bez kolumny na ekranie, jest gorszy niz kanal nieczytany:
  // magazyn twierdzi wtedy, ze karty nigdzie tam nie ma, a on tam jest i ma cene.
  // Cena rozna dla kazdego kanalu, zeby pomylka w mapowaniu nie mogla sie schowac.
  it('cena KAZDEGO czytanego kanalu stoi w SWOJEJ kolumnie', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr' }, [
      { kanal: 'pro', produkt_id: 'p1', cena_gr: 7490 },
      { kanal: 'szkicownia', produkt_id: 's1', cena_gr: 9900 },
      { kanal: 'allegro_szkicownia', produkt_id: 'a1', cena_gr: 11100 },
      { kanal: 'allegro_amarka', produkt_id: 'b1', cena_gr: 22200 },
    ]);
    // ⚠️ TRYB KATALOGOWY — to on niesie ceny kanalow po przebudowie (Zadanie 5).
    const r = await get(serwer(), '/magazyn?widok=katalog');

    expect(komorkiKanalow(wierszKarty(r.body, 'Kandelabr')))
      .toEqual(['74.90', '99.00', '111.00', '222.00']);
    // Liczba kolumn cen ma sie zgadzac z liczba kanalow, ktore panel w ogole czyta.
    expect(komorkiKanalow(wierszKarty(r.body, 'Kandelabr'))).toHaveLength(4);
  });

  it('SKU stoi POD nazwa, a karta bez SKU mowi „bez SKU" zamiast pustki', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr', sku: 'LMP-KAN-1' }, []);
    kartaZProduktem({ nazwa: 'Lampion' }, []);
    const r = await get(serwer(), '/magazyn');

    // Znacznik `.sku` to jest wlasnie „mniejszym drukiem, pod nazwa" — asercja na golym
    // napisie przeszlaby takze wtedy, gdyby SKU wrocilo do wlasnej kolumny.
    expect(r.body).toContain('<div class="sku">LMP-KAN-1</div>');
    expect(r.body).toContain('<div class="sku">bez SKU</div>');
    // SKU nie ma wlasnej kolumny (prosba wlasciciela) — naglowek tabeli o nim milczy.
    expect(r.body).not.toMatch(/<th[^>]*>\s*SKU\s*<\/th>/);
  });

  it('wymiary z milimetrow na centymetry, brak jako kreska', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr', szerokosc_mm: 700, wysokosc_mm: 1000 }, []);
    // Polowiczny wymiar to nadal BRAK wymiarow — ta sama regula, co w filtrze braków.
    kartaZProduktem({ nazwa: 'Lampion', szerokosc_mm: 700 }, []);
    const r = await get(serwer(), '/magazyn');

    expect(r.body).toContain('70 × 100 cm');
    expect(r.body).not.toContain('700 × 1000');
    // Wiersz z jednym wymiarem ma pokazac BRAK, a nie polowe wymiaru.
    expect(r.body).not.toMatch(/× (null|undefined|—) cm/);
  });

  it('paczkomat ma TRZY odrozialne stany, a nieoznaczony to nie to samo co „nie"', async () => {
    kartaZProduktem({ nazwa: 'Akarta', paczkomat: 'tak' }, []);
    kartaZProduktem({ nazwa: 'Bkarta', paczkomat: 'nie' }, []);
    kartaZProduktem({ nazwa: 'Ckarta' }, []);
    const r = await get(serwer(), '/magazyn');

    // ⚠️⚠️ ASERCJE NA WIERSZU SWOJEJ KARTY, nie na stronie. Poprzednia wersja pilnowala
    // napisow `>tak<`, `>nie<`, `nieoznaczone` i ich KOLEJNOSCI przez `indexOf` — a pasek
    // filtrow z Zadania 10 renderuje te trzy napisy w dokladnie tej samej kolejnosci jako
    // pozycje listy wyboru. Zmierzone: skasowanie CALEJ tresci komorki paczkomatu oraz
    // zamiana galezi 'tak' ↔ 'nie' przechodzily obie, 4413/4413 na zielono.
    //
    // Stawka: pole jest WYLACZNIE RECZNE (regula progu 640 mm wypadla decyzja wlasciciela),
    // wiec nie ma drugiego zrodla prawdy — a to ono rozstrzyga o sposobie wysylki.
    expect(wierszKarty(r.body, 'Akarta')).toMatch(/<td[^>]*>\s*<span class="znacznik znacznik--ok">tak<\/span>\s*<\/td>/);
    expect(wierszKarty(r.body, 'Bkarta')).toMatch(/<td[^>]*>\s*<span class="znacznik znacznik--cichy">nie<\/span>\s*<\/td>/);
    // Trzeci stan MA sie roznic od „nie": pierwszy to robota do wykonania, drugi decyzja.
    expect(wierszKarty(r.body, 'Ckarta')).toMatch(/<td[^>]*>\s*<span class="magazyn-brak">nieoznaczone<\/span>\s*<\/td>/);
    // ...i zaden wiersz nie niesie CUDZEGO stanu (mutacja zamieniajaca galezie).
    expect(wierszKarty(r.body, 'Akarta')).not.toContain('>nie<');
    expect(wierszKarty(r.body, 'Bkarta')).not.toContain('>tak<');
  });

  // ⚠️⚠️ SEDNO POPRAWKI Z 2026-08-12, PRZYPIETE WPROST: adres miniatury na liscie POCHODZI
  // Z LUSTRA (kolumna `miniatura`, wypelniona ze Store API sklepu), a NIE z reguly opartej
  // na nazwie pliku oryginalu. Adresy dobrane tak, zeby oba zrodla dawaly ROZNY wynik:
  // Sklep A skaluje miniatury do 247x296, wiec zgadywanie skleiloby `-150x150`, ktorego
  // pod zadnym zdjeciem tego sklepu NIE MA (zmierzone: 608 z 684 adresow = 404).
  it('miniatura idzie z lustra, a nie z reguly po nazwie pliku, i wczytuje sie leniwie', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr' }, [{
      kanal: 'szkicownia',
      produkt_id: '7179',
      zdjecia_json: JSON.stringify(['https://sklep-polcien.example.invalid/wp-content/uploads/2024/03/kandelabr.jpg']),
      miniatura: 'https://sklep-polcien.example.invalid/wp-content/uploads/2024/03/kandelabr-247x296.jpg',
    }]);
    const r = await get(serwer(), '/magazyn');
    const komorka = komorkaMiniatury(r.body, 'Kandelabr');

    expect(komorka).toContain('src="https://sklep-polcien.example.invalid/wp-content/uploads/2024/03/kandelabr-247x296.jpg"');
    expect(komorka).not.toContain('-150x150');
    // ~1010 wierszy razy jedno zdjecie — bez `lazy` przegladarka rusza po komplet naraz.
    expect(komorka).toContain('loading="lazy"');
  });

  // ⚠️⚠️ PARA MILCZENIA I NAJWAZNIEJSZY STRAZNIK TEJ POPRAWKI: wiersz, ktorego miniatury
  // lustro NIE ZNA, ma nie pokazac NICZEGO. Ani adresu zgadnietego (to on daje 404), ani
  // oryginalu — 608 oryginalow po ~250 kB to ponad 150 MB na JEDNEJ stronie listy, czyli
  // lekarstwo gorsze od choroby. Pusta komorka jest dzis i tak stanem widocznym; wypelni sie
  // sama po najblizszym odczycie katalogow.
  it('wiersz bez zapisanej miniatury nie pokazuje ani zgadnietego adresu, ani oryginalu', async () => {
    kartaZProduktem({ nazwa: 'Plecionka' }, [{
      kanal: 'szkicownia',
      produkt_id: '7180',
      zdjecia_json: JSON.stringify(['https://sklep-polcien.example.invalid/wp-content/uploads/2024/03/plecionka.jpg']),
      miniatura: null,
    }]);
    const r = await get(serwer(), '/magazyn');
    const komorka = komorkaMiniatury(r.body, 'Plecionka');

    expect(komorka).not.toContain('<img');
    expect(komorka).not.toContain('kenitra');
  });

  it('adres produktu spoza http(s) NIE trafia do odnosnika', async () => {
    kartaZProduktem({ nazwa: 'Kandelabr' }, [
      { kanal: 'pro', produkt_id: '944', cena_gr: 7490, adres: 'https://pro.sklep-polcien.example.invalid/produkt/kandelabr' },
      { kanal: 'szkicownia', produkt_id: '55', cena_gr: 9900, adres: 'javascript:alert(1)' },
    ]);
    // ⚠️ Odnosniki do sklepow siedza w komorkach kanalow, czyli w TRYBIE KATALOGOWYM
    // (Zadanie 5) — bariera adresu jest ta sama, zmienil sie wylacznie ekran, na ktorym stoi.
    const r = await get(serwer(), '/magazyn?widok=katalog');

    expect(r.body).toContain('https://pro.sklep-polcien.example.invalid/produkt/kandelabr');
    expect(r.body).not.toContain('javascript:');
    // Cena zostaje na ekranie takze wtedy, gdy adres odpadl — odmowa dotyczy odnosnika,
    // nie wiersza.
    expect(r.body).toContain('99.00');
  });

  it('tabela ma wlasny przewijak poziomy', async () => {
    const r = await get(serwer(), '/magazyn');
    // Dziewiec kolumn i miniatury rozpychaly juz raz cala strone razem z paskiem akcji.
    expect(r.body).toMatch(/class="[^"]*przewijak-tabeli/);
  });

  it('pusta lista MOWI, ze jest pusta', async () => {
    // ⚠️ TRYB KATALOGOWY, bo to jego zestaw kolumn liczy `colspan` ponizej (Zadanie 5);
    // wariant porzadkow ma wlasna asercje w opisie „dwa tryby tabeli".
    const r = await get(serwer(), '/magazyn?widok=katalog');
    expect(r.statusCode).toBe(200);
    // ⚠️ CALE ZDANIE, nie „pusto": nazwa klasy `.pusto` stoi w arkuszu ukladu, ktory jedzie
    // w kazdej stronie panelu — alternatywa `|pusto` przepuszczala ten test zawsze.
    expect(r.body).toContain('Nie ma tu jeszcze ani jednej karty produktu.');
    // ⚠️ `colspan` liczy sie z liczby kolumn kanalow (`6 + naglowkiKanalow.length`), wiec
    // rozjezdza sie CICHO przy kazdej zmianie zestawu kolumn — komunikat pustej listy
    // przestaje wtedy siegac konca tabeli i wyglada jak polamany render. Cztery kanaly
    // plus zaznaczenie, miniatura, karta, wymiary, kategoria i paczkomat = dziesiec.
    // (Bylo dziewiec do 2026-08-12; kolumne zaznaczenia dolozyla edycja hurtem.)
    expect(r.body).toContain('colspan="10"');
  });
});

describe('GET /magazyn — sortowanie z adresu', () => {
  beforeEach(() => {
    kartaZProduktem({ nazwa: 'Karta-A', wysokosc_mm: 100 }, []);
    kartaZProduktem({ nazwa: 'Karta-B', wysokosc_mm: 900 }, []);
  });

  it('sortowanie po wymiarze przestawia kolejnosc wierszy', async () => {
    const app = serwer();
    const a = await get(app, '/magazyn?sort=wysokosc&kier=asc');
    const b = await get(app, '/magazyn?sort=wysokosc&kier=desc');

    expect(a.body.indexOf('Karta-A')).toBeLessThan(a.body.indexOf('Karta-B'));
    expect(b.body.indexOf('Karta-A')).toBeGreaterThan(b.body.indexOf('Karta-B'));
  });

  it('nazwa sortowania z lancucha prototypow NIE wywala listy i wraca do domyslnej', async () => {
    const app = serwer();
    // ⚠️ `SORTOWANIE[x] ?? domyslne` oddaje TU funkcje z Object.prototype — realna
    // pieciusetka zlapana na glownym ekranie przy Zadaniu 4.
    for (const zly of ['constructor', 'toString', 'hasOwnProperty', 'nazwa; DROP TABLE karty_produktow']) {
      const r = await get(app, `/magazyn?sort=${encodeURIComponent(zly)}`);
      expect(r.statusCode).toBe(200);
      expect(r.body.indexOf('Karta-A')).toBeLessThan(r.body.indexOf('Karta-B'));
      const tresc = r.body.slice(r.body.indexOf('<main class="kolumna-glowna">'), r.body.indexOf('</main>'));
      expect(tresc).not.toContain(zly === 'nazwa; DROP TABLE karty_produktow' ? 'DROP TABLE' : `sort=${zly}`);
    }
  });

  it('ekran MOWI, po ktorej kolumnie sortuje — takze gdy nazwa z adresu odpadla', async () => {
    const app = serwer();

    const poWymiarze = await get(app, '/magazyn?sort=wysokosc&kier=desc');
    expect(poWymiarze.body).toMatch(/aria-sort="descending"[^>]*>\s*<a[^>]*>Wymiary/);

    // ⚠️ TU JEST CALA STAWKA BIALEJ LISTY W TRASIE. Nazwa spoza listy wraca do domyslnej,
    // czyli lista JEST ulozona po nazwie — i ekran ma to powiedziec. Bez tego pokazywalby
    // jedna kolejnosc, a adres twierdzil drugie, i nikt by tych dwoch rzeczy nie zestawil.
    const zly = await get(app, '/magazyn?sort=constructor&kier=desc');
    expect(zly.body).toMatch(/aria-sort="descending"[^>]*>\s*<a[^>]*>Karta/);
    const tresc = zly.body.slice(zly.body.indexOf('<main class="kolumna-glowna">'), zly.body.indexOf('</main>'));
    expect(tresc).not.toContain('sort=constructor');
  });

  it('kierunek spoza „asc/desc" wraca do rosnacego, a nie do SQL-a', async () => {
    const r = await get(serwer(), '/magazyn?sort=wysokosc&kier=desc%3B+DROP');
    expect(r.statusCode).toBe(200);
    expect(r.body.indexOf('Karta-A')).toBeLessThan(r.body.indexOf('Karta-B'));
  });

  it('KAZDY odnosnik sortowania w naglowku tabeli jest znany warstwie zapytan', async () => {
    // ⚠️ Bez tego testu naglowek moglby oferowac klucz, ktorego `db/magazyn.js` nie zna:
    // zapytanie po cichu wracaloby do sortowania domyslnego, a kolumna pokazywalaby sie
    // jako aktywna. Rozjazd widoczny wylacznie dla kogos, kto sprawdzi kolejnosc wierszy.
    const r = await get(serwer(), '/magazyn');
    const klucze = [...r.body.matchAll(/href="\/magazyn\?sort=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));

    expect(klucze.length).toBeGreaterThan(0);
    for (const k of klucze) expect(SORTOWANIE_KART).toContain(k);
  });
});

describe('GET /magazyn — stan ostatniego odczytu', () => {
  it('blad kanalu widac PRZY KANALE, w pelnej tresci hamulca', async () => {
    const komunikat = 'Kanał pro: odczyt oddał 0 pozycji, a lustro trzyma 668 żywych. To wygląda na '
      + 'awarię sklepu (odmowa kodem 200: konflikt wtyczki, tryb konserwacji, przerwany import), a nie '
      + 'na pusty katalog — więc NIE oznaczam niczego jako zniknięte i zostawiam lustro bez zmian. '
      + 'Jeśli kanał naprawdę został wygaszony, oznacz jego wiersze ręcznie.';
    const app = serwer(atrapaMagazynu({
      ...STAN_PUSTY,
      skonczony_at: '2026-08-11T07:00:00.000Z',
      kanaly: [{ kanal: 'pro', zapisane: 0, znikniete: 0, blad: komunikat }],
    }));
    const r = await get(app, '/magazyn');

    // ⚠️ CALY komunikat, nie „błąd odczytu". Ten napis mowi, co zrobic — skrocony
    // zostawia czlowieka z ta sama niewiedza, co brak komunikatu.
    //
    // ⚠️ I STOI W TYM SAMYM WIERSZU, CO NAZWA KANALU. Osobna asercja na nazwe kanalu PRO
    // byla nienosna: ta nazwa stoi TAKZE w naglowku kolumny cen, wiec „blad przy kanale"
    // przechodzilby nawet wtedy, gdyby komunikat wyladowal na dole strony bez zadnego
    // zwiazku z kanalem, ktorego dotyczy.
    expect(r.body).toMatch(
      /<td>pro\.szkicownia\.pl<\/td>[\s\S]{0,600}Jeśli kanał naprawdę został wygaszony, oznacz jego wiersze ręcznie\./,
    );
  });

  it('kanal bez bledu NIE pokazuje ostrzezenia, tylko liczby przebiegu', async () => {
    const app = serwer(atrapaMagazynu({
      ...STAN_PUSTY,
      skonczony_at: '2026-08-11T07:00:00.000Z',
      kanaly: [{ kanal: 'pro', zapisane: 104, znikniete: 3, blad: null }],
    }));
    const r = await get(app, '/magazyn');

    // ⚠️⚠️ OBIE LICZBY PRZYPIETE DO SWOJEGO KANALU I DO SWOJEJ KOLUMNY, jednym wzorcem.
    // Wczesniej stalo tu `toContain('znikn')` — a slowo „znikn" wystepuje PIEC RAZY
    // w komentarzach arkusza ukladu, ktory jedzie w kazdej stronie panelu, wiec asercja
    // byla spelniona zawsze: recenzent skasowal `<%= k.znikniete %>` z komorki i suita
    // dalej swiecila na zielono.
    //
    // Liczba znikniętych jest JEDYNYM sygnalem odczytu CZESCIOWEGO — sklepu, ktory oddal
    // jedna pozycje z 668 i PRZESZEDL przez hamulec, bo hamulec celowo lapie wylacznie zero
    // (prog na ubytku uniemozliwilby wycofanie czegokolwiek ze sprzedazy). Zgubiona kolumna
    // znaczy, ze tego sklepu nie zauwazy juz nikt.
    expect(r.body).toMatch(
      /<td>pro\.szkicownia\.pl<\/td>\s*<td class="liczba">104<\/td>\s*<td class="liczba">3<\/td>/,
    );
    expect(r.body).not.toContain('Odczyt przerwany');
  });

  it('trwajacy przebieg pokazuje postep, a zakonczony juz nie', async () => {
    const wTrakcie = serwer(atrapaMagazynu({
      ...STAN_PUSTY, trwa: true, zaczety_at: '2026-08-11T07:00:00.000Z',
      postep: { kanal: 'szkicownia', zrobione: 120, zTego: 668 },
    }));
    const r = await get(wTrakcie, '/magazyn');
    // Obie liczby w JEDNYM napisie i przy nazwie czytanego kanalu — osobne `toContain`
    // przechodzilyby takze wtedy, gdyby na ekran trafila jedna z nich albo obie w oderwaniu
    // od siebie („120" i „668" to dwie liczby, „120 z 668" to zdanie o postepie).
    expect(r.body).toMatch(/szkicownia\.pl<\/strong>\s*—\s*120 z 668\./);

    const po = await get(serwer(), '/magazyn');
    expect(po.body).not.toContain('668');
  });
});

// ⚠️⚠️ NIEZMIENNIK Z PRZEWODNIKA (sekcja 9): wynik odczytu MUSI BYC WIDOCZNY — cichy zly
// odczyt wyglada identycznie jak sklep, w ktorym nic sie nie zmienilo. `<details>` wolno
// zwinac WYLACZNIE przy spokoju; trwanie i KAZDY blad (przebiegu albo kanalu) maja
// renderowac sekcje OTWARTA. Regula liczy sie w trasie (`opisPrzebiegu`), nigdy w widoku.
describe('GET /magazyn — odczyt katalogów zwinięty do linii', () => {
  it('spokój = details zamknięty', async () => {
    const stan = {
      ...STAN_PUSTY,
      skonczony_at: '2026-08-24T19:14:00Z',
      kanaly: [{ kanal: 'szkicownia', zapisane: 828, znikniete: 0, blad: null }],
    };
    const r = await get(serwer(atrapaMagazynu(stan)), '/magazyn');

    // ⚠️ CALY znacznik otwierajacy, bez `open` — asercja na atrybucie ma obejmowac cale
    // otwarcie tagu, nie sama tresc (inaczej mutacja dodajaca `open` zawsze przechodzi).
    expect(r.body).toMatch(/<details class="odczyt-szczegoly">/);
    expect(r.body).not.toMatch(/<details class="odczyt-szczegoly" open>/);
  });

  it('błąd kanału = details OTWARTY (cichy zły odczyt nie może wyglądać jak spokój)', async () => {
    const stan = {
      ...STAN_PUSTY,
      skonczony_at: '2026-08-24T19:14:00Z',
      kanaly: [{ kanal: 'szkicownia', zapisane: 0, znikniete: 0, blad: 'odmowa 500' }],
    };
    const r = await get(serwer(atrapaMagazynu(stan)), '/magazyn');

    expect(r.body).toMatch(/<details class="odczyt-szczegoly" open>/);
  });

  it('przebieg w trakcie = details OTWARTY', async () => {
    const stan = {
      ...STAN_PUSTY, trwa: true, postep: { kanal: 'szkicownia', zrobione: 3, zTego: 828 },
    };
    const r = await get(serwer(atrapaMagazynu(stan)), '/magazyn');

    expect(r.body).toMatch(/<details class="odczyt-szczegoly" open>/);
  });

  it('błąd CAŁEGO przebiegu (blad na poziomie top, bez awarii kanału) też otwiera', async () => {
    // Sekcja 9 przewodnika mowi wprost o DWOCH zrodlach bledu: przebiegu i kanalu. Ten
    // test pilnuje tego pierwszego — bez niego mutacja `stan.trwa || kanaly.some(...)`
    // (bez `Boolean(stan.blad)`) przeszlaby cala reszte suity na zielono.
    const stan = { ...STAN_PUSTY, blad: 'Odczyt przerwany, zanim ruszył: brak konfiguracji' };
    const r = await get(serwer(atrapaMagazynu(stan)), '/magazyn');

    expect(r.body).toMatch(/<details class="odczyt-szczegoly" open>/);
  });
});

describe('POST /magazyn/odswiez', () => {
  it('bez naglowka Origin ochrona CSRF odmawia', async () => {
    const magazyn = atrapaMagazynu();
    const r = await serwer(magazyn).inject({
      method: 'POST',
      url: '/magazyn/odswiez',
      headers: { authorization: auth.authorization },
      payload: {},
    });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(magazyn.start.mock.calls).toHaveLength(0);
  });

  it('startuje przebieg i NATYCHMIAST wraca na liste', async () => {
    const magazyn = atrapaMagazynu();
    const r = await serwer(magazyn).inject({
      method: 'POST', url: '/magazyn/odswiez', headers: auth, payload: {},
    });

    expect(magazyn.start.mock.calls).toHaveLength(1);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/magazyn');
  });
});

describe('/magazyn bez skonfigurowanych sklepow', () => {
  it('GET oddaje strone „pusta celowo" z powodem, a nie 404', async () => {
    const app = buildOmsServer({ db, config });
    const r = await get(app, '/magazyn');

    expect(r.statusCode).toBe(200);
    // ⚠️ ASERCJA NA TRESCI POWODU (`BEZ_SKLEPOW.opis`), a nie na slowach „Magazyn" i „pusta".
    // Oba stoja w ukladzie strony — pierwsze w ikonie paska, drugie w nazwie klasy i w
    // komentarzu arkusza — wiec tamta para przechodzila TAKZE wtedy, gdyby trasa przestala
    // renderowac `pusta-strona.ejs` i oddala cokolwiek innego z kodem 200. Nazwy zmiennych
    // srodowiskowych w arkuszu nie wystepuja i wystapic nie moga.
    expect(r.body).toContain('OMS_KANALY');
    // Ikona w pasku prowadzaca w 404 wyglada jak usterka panelu, a nie jak funkcja,
    // ktorej jeszcze nie ma (ta sama decyzja, co przy /faktury i /raporty).
    expect(r.body).toContain('<h2>Magazyn</h2>');
  });

  it('POST odmawia CZYTELNIE, zamiast udawac, ze odczyt ruszyl', async () => {
    const app = buildOmsServer({ db, config });
    const r = await app.inject({ method: 'POST', url: '/magazyn/odswiez', headers: auth, payload: {} });

    expect(r.statusCode).toBe(503);
    // Cale zdanie odmowy: samo „sklep" trafialoby takze w uklad strony, gdyby ta odpowiedz
    // kiedys zaczela jechac przez szablon.
    expect(r.body).toContain('nie ma skąd czytać katalogu');
  });
});

// ⚠️ WYSZUKIWARKA I FILTRY. Trzy rzeczy, ktore ten opis pilnuje i ktorych nie widac
// z warstwy zapytan (ta byla przypieta juz w Zadaniu 4):
//   (1) parametry adresu W OGOLE DOCHODZA do zapytania — trasa ignorowala je do konca
//       Zadania 9, wiec „filtr dziala" znaczylo wylacznie „db go umie";
//   (2) filtry LACZA SIE Z FRAZA i przezywaja klikniecie w naglowek sortujacy — ten
//       niezmiennik (4.13b) zostal raz zlamany i objawial sie jako „przefiltrowana, ale
//       ZUPELNIE INNA lista";
//   (3) pusty wynik zawezenia MOWI CO INNEGO niz pusty magazyn.
describe('GET /magazyn — wyszukiwarka i filtry', () => {
  // Katalog, w ktorym zadne pojedyncze kryterium nie wystarcza: fraza „szpulka" trafia w dwie
  // karty, kanal „pro" w dwie inne, a oba naraz — w jedna. Bez tego „zawezone oboma" nie
  // roznilo by sie od „zawezone jednym".
  function katalog() {
    kartaZProduktem({ nazwa: 'Szpulka na PRO' }, [{ kanal: 'pro', produkt_id: '1', cena_gr: 7490 }]);
    kartaZProduktem({ nazwa: 'Szpulka na szkicownia' }, [{ kanal: 'szkicownia', produkt_id: '2', cena_gr: 3000 }]);
    kartaZProduktem({ nazwa: 'Kandelabr na PRO' }, [{ kanal: 'pro', produkt_id: '3', cena_gr: 9900 }]);
  }
  // ⚠️ NAZWA JEST ODNOSNIKIEM NA KARTE PRODUKTU (Zadanie 11) — i wzorzec ma tego pilnowac,
  // a nie omijac: bez `<a>` w srodku ta funkcja oddaje pusta liste, czyli KAZDE porownanie
  // „lista zawiera dokladnie te karty" przechodziloby na dwoch pustych tablicach.
  //
  // ⚠️ `(?:\?[^"]*)?` — od Zadania 6 odnosnik niesie DALEJ adres powrotu jako „?wroc=…"
  // (dokladna wartosc ma wlasny test w magazyn-karta.test.js); wzorzec ma tolerowac ten
  // dopisek, a nie przestac widziec wiersza — to, co ten test sprawdza (KTORE karty i w
  // JAKIEJ kolejnosci), z zawartoscia query string nie ma nic wspolnego.
  const nazwyWTabeli = (body) => [
    ...body.matchAll(/<td class="komorka-karta">\s*<div><a href="\/magazyn\/\d+(?:\?[^"]*)?">([^<]+)<\/a><\/div>/g),
  ].map((m) => m[1]);

  it('fraza i filtr kanalu zawezaja OBA NARAZ, a nie kazdy osobno', async () => {
    katalog();
    const app = serwer();

    // Kazde kryterium z osobna zostawia dwa karty — dopiero razem jeden. Gdyby trasa gubila
    // ktorekolwiek, ta asercja pokazalaby dwa wiersze zamiast jednego.
    expect(nazwyWTabeli((await get(app, '/magazyn?fraza=Szpulka')).body))
      .toEqual(['Szpulka na PRO', 'Szpulka na szkicownia']);
    expect(nazwyWTabeli((await get(app, '/magazyn?kanal=pro')).body))
      .toEqual(['Kandelabr na PRO', 'Szpulka na PRO']);
    expect(nazwyWTabeli((await get(app, '/magazyn?fraza=Szpulka&kanal=pro')).body))
      .toEqual(['Szpulka na PRO']);
  });

  it('formularz filtrow niesie fraze UKRYTYM POLEM, a wyszukiwarka niesie filtry', async () => {
    katalog();
    const r = await get(serwer(), '/magazyn?fraza=Szpulka&kanal=pro&brak=sku');

    // Bez tych pol klikniecie „Filtruj" skladaloby adres BEZ frazy, a „Szukaj" — bez filtrow.
    expect(r.body).toContain('<input type="hidden" name="fraza" value="Szpulka">');
    expect(r.body).toContain('<input type="hidden" name="kanal" value="pro">');
    expect(r.body).toContain('<input type="hidden" name="brak" value="sku">');
    // I jedno, i drugie ma stac WEWNATRZ wlasciwego formularza, a nie gdziekolwiek na stronie.
    expect(r.body).toMatch(
      /<form class="filtry"[\s\S]{0,400}<input type="hidden" name="fraza" value="Szpulka">[\s\S]*?<\/form>/,
    );
    expect(r.body).toMatch(
      /<form class="szukajka"[\s\S]{0,400}<input type="hidden" name="kanal" value="pro">[\s\S]*?<\/form>/,
    );
  });

  it('formularz filtrow NIE wysyla wlasnego pola dwa razy', async () => {
    // Fastify oddaje powtorzony parametr jako TABLICE, parser odrzuca ja do `null` — czyli
    // filtr znikalby dokladnie w formularzu, ktory sluzy do jego ustawiania.
    katalog();
    const r = await get(serwer(), '/magazyn?kanal=pro');
    const filtrowy = /<form class="filtry"[\s\S]*?<\/form>/.exec(r.body)[0];

    expect(filtrowy).not.toContain('<input type="hidden" name="kanal"');
    // A samo pole wyboru ma pamietac, co jest ustawione.
    expect(filtrowy).toMatch(/<option value="pro" selected>/);
  });

  it('KAZDY naglowek sortujacy niesie dalej fraze i filtry', async () => {
    // ⚠️ SEDNO NIEZMIENNIKA 4.13b PO STRONIE ODNOSNIKOW. Adres budowany od zera
    // (`/magazyn?sort=…&kier=…`) kasowalby zawezenie, po ktorym wlasciciel wlasnie chcial
    // zaznaczyc wszystko i ustawic pole hurtem.
    katalog();
    const r = await get(serwer(), '/magazyn?fraza=Szpulka&kanal=pro&brak=sku&cenaOd=10');
    // Wylacznie odnosniki NAGLOWKA (te maja klase `zaznacz-wszystkie`) — „Wyczyść zawężenie"
    // tez niesie `sort`, ale CELOWO bez filtrow, wiec wpadlby tu jako falszywa czerwien.
    const adresy = [...r.body.matchAll(/<a class="zaznacz-wszystkie" href="(\/magazyn\?[^"]+)"/g)]
      .map((m) => m[1]);

    // Szesc odnosnikow sortujacych: nazwa, SKU, wymiary, kategoria, paczkomat (i wariant
    // klucza) — zero znaczyloby, ze petla nie sprawdzila NICZEGO.
    expect(adresy.length).toBeGreaterThanOrEqual(5);
    for (const adres of adresy) {
      const q = new URLSearchParams(adres.replace(/&amp;/g, '&').slice(adres.indexOf('?') + 1));
      expect(q.get('fraza'), adres).toBe('Szpulka');
      expect(q.get('kanal'), adres).toBe('pro');
      expect(q.get('brak'), adres).toBe('sku');
      expect(q.get('cenaOd'), adres).toBe('10.00');
    }
  });

  it('klikniecie w naglowek sortujacy NAPRAWDE zostawia ten sam zbior wierszy', async () => {
    // Sam adres moglby niesc parametry, ktorych trasa i tak nie czyta — dlatego test IDZIE
    // pod ten adres i porownuje zawartosc tabeli.
    katalog();
    const app = serwer();
    const przed = await get(app, '/magazyn?fraza=Szpulka&kanal=pro');
    const adres = /href="(\/magazyn\?[^"]*sort=wysokosc[^"]*)"/.exec(przed.body)[1].replace(/&amp;/g, '&');
    const po = await get(app, adres);

    expect(nazwyWTabeli(przed.body)).toEqual(['Szpulka na PRO']);
    expect(nazwyWTabeli(po.body)).toEqual(['Szpulka na PRO']);
  });

  it('formularze niosa dalej SORTOWANIE — „Filtruj" nie wraca do kolejnosci domyslnej', async () => {
    katalog();
    const r = await get(serwer(), '/magazyn?sort=wysokosc&kier=desc');

    // ⚠️ OSOBNO W KAZDYM Z DWOCH FORMULARZY. Asercja na calej stronie byla NIENOSNA:
    // oba formularze rysuja te same dwa pola, wiec skasowanie ich z jednego przechodzilo
    // dzieki drugiemu — dokladnie ten sam wzorzec, co kreska z sasiedniej kolumny
    // podpierajaca asercje o kolumnie kanalu.
    for (const wzorzec of [/<form class="filtry"[\s\S]*?<\/form>/, /<form class="szukajka"[\s\S]*?<\/form>/]) {
      const formularz = wzorzec.exec(r.body)[0];
      expect(formularz, String(wzorzec)).toContain('<input type="hidden" name="sort" value="wysokosc">');
      expect(formularz, String(wzorzec)).toContain('<input type="hidden" name="kier" value="desc">');
    }
  });

  it('nierozpoznana wartosc filtru NIE zaweza listy do pustej', async () => {
    // Straznik alarmuje (nizej: `kanal=pro` zaweza) i straznik MILCZY (tutaj: literowka
    // w adresie ma pokazac liste). Przepuszczona dalej oddalaby pusty ekran bez slowa
    // wyjasnienia — a pusty ekran wyglada jak „nie ma takich kart".
    katalog();
    const app = serwer();
    for (const zly of ['kanal=sklepu-nie-ma', 'brak=allegro', 'paczkomat=brak', 'cenaOd=dużo', 'kanal=constructor']) {
      const r = await get(app, `/magazyn?${zly}`);
      expect(r.statusCode, zly).toBe(200);
      expect(nazwyWTabeli(r.body), zly).toHaveLength(3);
    }
    expect(nazwyWTabeli((await get(app, '/magazyn?kanal=pro')).body)).toHaveLength(2);
  });

  it('cena z pola wraca do pola ZLOTOWKAMI, a nie groszami', async () => {
    // ⚠️ Filtr zyje w groszach (kolumna `cena_gr`), pole formularza mowi zlotowkami.
    // Przepisanie surowej wartosci zamienialoby „od 10 zl" w „od 1000 zl" przy pierwszym
    // klknieciu — po cichu, bo obie postacie sa poprawnymi liczbami.
    katalog();
    const r = await get(serwer(), '/magazyn?cenaOd=74,90');

    expect(r.body).toContain('name="cenaOd" value="74.90"');
    expect(r.body).not.toContain('value="7490"');
    // I filtr faktycznie zadzialal na groszach: 74,90 zl odcina karta za 30 zl.
    expect(nazwyWTabeli(r.body)).toEqual(['Kandelabr na PRO', 'Szpulka na PRO']);
  });

  it('filtr kategorii jest NADZBIOREM: kategoria glowna karty ALBO kategorie z lustra', async () => {
    // ⚠️ Rozstrzygniecie z Zadania 4. Karta z RECZNIE ustawiona kategoria glowna, a bez
    // produktu w lustrze, musi sie znalezc — inaczej nie da sie go nawet oznaczyc hurtem
    // przez ten sam filtr, ktorym sie go szuka.
    kartaZProduktem({ nazwa: 'Recznie oznaczony', kategoria_glowna: 'Aplikacje' }, []);
    kartaZProduktem({ nazwa: 'Z lustra' }, [{
      kanal: 'pro', produkt_id: '7', cena_gr: 1000,
      kategorie_json: JSON.stringify(['Lampy wiszące', 'Boho', 'Na ściany', 'Aplikacje']),
    }]);
    kartaZProduktem({ nazwa: 'Obcy', kategoria_glowna: 'Boho' }, []);
    const r = await get(serwer(), '/magazyn?kategoria=Aplikacje');

    expect(nazwyWTabeli(r.body)).toEqual(['Recznie oznaczony', 'Z lustra']);
  });

  it('pole wyboru kategorii zna nazwy z OBU zrodel, wiec kazda pozycja cos znajduje', async () => {
    // Pozycja pola wyboru, ktorej filtr nie umie trafic, oddaje pusty ekran — czyli obraz
    // nieodrozialny od „nie ma takich kart", i to jest dokladnie ta awaria, dla ktorej
    // to pole w ogole powstalo. Tyle ze tedy wraca drzwiami, w ktorych literowki popelnic
    // sie nie da.
    kartaZProduktem({ nazwa: 'Recznie oznaczony', kategoria_glowna: 'Aplikacje' }, []);
    kartaZProduktem({ nazwa: 'Z lustra' }, [{
      kanal: 'pro', produkt_id: '7', cena_gr: 1000, kategorie_json: JSON.stringify(['Boho']),
    }]);
    // ⚠️⚠️ PRODUKT BEZ KARTY — i to jest CALY ten test. `kartaZProduktem` wiaze KAZDY produkt
    // z kartą, wiec sama ta atrapa GWARANTOWALA badana wlasciwosc, zamiast ja sprawdzac:
    // petla nizej nie miala jak trafic na pozycje, ktorej filtr nie umie znalezc.
    //
    // Taki produkt jest stanem ZWYCZAJNYM, nie krancowym: po „Odczytaj katalogi" lustro ma
    // wszystko, co przyslal sklep, a karty powstaja dopiero z osobnego klikniecia. Czesc
    // z nich nie powstanie NIGDY — ~26 wariantow bez rozmiaru i zaslepki, ktorych
    // `powodPominiecia` nie powiaze (Zadanie 8). Kategoria wystepujaca tylko u nich bylaby
    // martwa pozycja bez konca.
    zapiszProduktSklepowy(db, {
      kanal: 'pro', produkt_id: '99', wariant_id: '', nazwa: 'Swiezo odczytany',
      cena_gr: 1000, kategorie_json: JSON.stringify(['Farmhouse']),
      odczytane_at: '2026-08-11T06:00:00.000Z',
    });

    const app = serwer();
    const r = await get(app, '/magazyn');
    const pozycje = [...(/<select name="kategoria">[\s\S]*?<\/select>/.exec(r.body)[0])
      .matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

    // Lista pozycji ma byc DOKLADNIE zbiorem osiagalnym przez filtr — ani mniej, ani wiecej.
    // „Farmhouse" jest w lustrze, ale filtr chodzi po produktach POWIAZANYCH z kartą, wiec
    // pozycja bylaby nietrafialna.
    expect(pozycje).toEqual(['Aplikacje', 'Boho']);
    for (const k of pozycje) {
      expect(nazwyWTabeli((await get(app, `/magazyn?kategoria=${encodeURIComponent(k)}`)).body), k)
        .toHaveLength(1);
    }
    // Druga polowa pary: kategoria pominieta w liscie NAPRAWDE nic nie znajduje — czyli
    // zawezenie listy nie jest przesada, tylko odwzorowaniem tego, co filtr umie.
    expect(nazwyWTabeli((await get(app, '/magazyn?kategoria=Farmhouse')).body)).toHaveLength(0);
  });

  it('popsuty JSON kategorii w lustrze nie kladzie ani listy, ani pola wyboru', async () => {
    // Lustro bierze sie z cudzego API — `json_each` na popsutym napisie RZUCA.
    kartaZProduktem({ nazwa: 'Zdrowy', kategoria_glowna: 'Boho' }, []);
    kartaZProduktem({ nazwa: 'Popsuty' }, [{
      kanal: 'pro', produkt_id: '9', cena_gr: 1000, kategorie_json: '{to nie jest JSON',
    }]);
    const r = await get(serwer(), '/magazyn?kategoria=Boho');

    expect(r.statusCode).toBe(200);
    expect(nazwyWTabeli(r.body)).toEqual(['Zdrowy']);
  });

  it('⚠️ PUSTY WYNIK ZAWEZENIA to inny komunikat niz PUSTY MAGAZYN', async () => {
    katalog();
    const app = serwer();
    const zFiltrem = await get(app, '/magazyn?fraza=czego-tu-nie-ma');

    // „Nie ma tu jeszcze ani jednej karty produktu" przy aktywnym filtrze jest NIEPRAWDA — katalog
    // ma trzy karty. Czlowiek czyta to jako utrate danych i idzie szukac awarii odczytu.
    expect(zFiltrem.body).not.toContain('Nie ma tu jeszcze ani jednej karty produktu');
    expect(zFiltrem.body).toContain('katalog nie jest pusty, tylko zapytanie nic nie trafiło');
    // Wyjscie z pustego wyniku jest NA EKRANIE, a nie w pamieci o tym, co sie wpisalo.
    expect(zFiltrem.body).toMatch(/class="pusto">[\s\S]*?href="[^"]*"[^>]*>Wyczyść zawężenie/);
  });

  it('pusty magazyn BEZ zawezenia dalej mowi o pustym magazynie', async () => {
    // Druga polowa pary: straznik ma milczec, kiedy filtru nie ma. Bez tego komunikat
    // o zawezeniu wyswietlalby sie na swiezym panelu, w ktorym nikt niczego nie zawezal.
    const r = await get(serwer(), '/magazyn');

    expect(r.body).toContain('Nie ma tu jeszcze ani jednej karty produktu.');
    expect(r.body).not.toContain('katalog nie jest pusty');
    // Pasek zawezenia (liczba wynikow, „Wyczyść") tez ma sie NIE pokazywac.
    expect(r.body).not.toContain('Wyczyść zawężenie');
  });

  it('liczba wynikow stoi przy zawezeniu, zeby pusty ekran dalo sie odroznic od awarii', async () => {
    katalog();
    const app = serwer();
    // ⚠️ ODMIANA TROJFORMOWA, jak `ileKart` w trasie (widok niczego nie liczy): „2 karty",
    // nie dwuformowe „2 kart" — ten sam wzorzec, co w `opisZawezenia` kawałek niżej na tej
    // samej stronie.
    const dwa = await get(app, '/magazyn?kanal=pro');
    expect(dwa.body).toMatch(/<span class="wynik-filtra">2 karty<\/span>/);

    const jeden = await get(app, '/magazyn?fraza=Szpulka&kanal=pro');
    expect(jeden.body).toMatch(/<span class="wynik-filtra">1 karta<\/span>/);
  });
});

describe('pasek gorny', () => {
  // ⚠️ TA asercja CELOWO trafia w uklad strony (layout-oms.ejs) — bo to on jest tu
  // przedmiotem testu: ikona w pasku jest JEDYNYM wejsciem na ten ekran i bez niej trasa
  // istnieje wylacznie dla kogos, kto zna adres. Wzorzec pilnuje, ze to ODNOSNIK-IKONA
  // paska, a nie dowolne wystapienie adresu na stronie.
  it('ma ikone prowadzaca na /magazyn', async () => {
    const r = await get(serwer(), '/magazyn');
    const menu = r.body.match(/<nav class="oms-menu" aria-label="Główna">[\s\S]*?<\/nav>/)?.[0];
    expect(menu).toBeDefined();
    expect(menu).toMatch(/<a href="\/magazyn" aria-current="page">[\s\S]*?<span>Magazyn<\/span><\/a>/);
  });
});

describe('kafle braków', () => {
  it('pięć kafli z liczbami z całego katalogu, niezależnymi od zawężenia', async () => {
    const db = openOmsDb(':memory:');
    // fikstura ze strażnikiem: jeden komplet, jeden bez wszystkiego
    utworzKarte(db, { nazwa: 'Kompletny', sku: 'S1', szerokosc_mm: 1, wysokosc_mm: 1, kategoria_glowna: 'K', paczkomat: 'tak' });
    utworzKarte(db, { nazwa: 'Dziurawy' });
    const app = buildOmsServer({ db, config, magazyn: atrapaMagazynu() });
    const res = await app.inject({ method: 'GET', url: '/magazyn?brak=wymiary', headers: auth });
    const html = res.body;
    // liczby po CAŁYM katalogu, mimo aktywnego zawężenia
    expect(html).toMatch(/class="kafel-ile">1</); // bezSku=1 itd. — po jednym dziurawym
    expect(html).toContain('class="kafel kafel--aktywny"'); // kafel wymiarów podświetlony
    expect(html).toContain('1 / 2'); // komplet / razem
    // kafel aktywny linkuje na ZDJĘCIE filtra (adres bez brak=), nieaktywny na swój brak
    // ⚠️ adres kafla niesie dalej TAKZE sort/kier (adresMagazynu, niezmiennik 4.13b) — stad
    // `(&|")` zamiast wymagania natychmiastowego konca atrybutu.
    expect(html).toMatch(/href="\/magazyn\?brak=sku(&|")/);
  });

  it('select „Braki" zniknął z formularza filtrów, a filtr kafla przeżywa „Filtruj"', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, magazyn: atrapaMagazynu() });
    const res = await app.inject({ method: 'GET', url: '/magazyn?brak=sku', headers: auth });
    expect(res.body).not.toContain('<select name="brak">');
    // brak wędruje ukrytym polem formularza filtrów (inaczej „Filtruj" kasuje kafel)
    expect(res.body).toMatch(/<input type="hidden" name="brak" value="sku">/);
  });
});

// ⚠️⚠️ DWA TRYBY TABELI (przebudowa 2026-08-25, Zadanie 5). Ekran DOMYSLNY to TRYB
// PORZADKOW: cztery kolumny cen ustepuja jednej kolumnie „Stan", ktora mowi, ILE brakuje
// przy karcie (kolejka roboty). Ceny wracaja o jedno klikniecie — `?widok=katalog`.
//
// CO JEST TU PRZYPIETE:
//   (1) domyslny ekran ma „Stan" i ZERO kolumn kanalow, a katalogowy odwrotnie — para,
//       nie polowa (bez drugiej strony mutacja renderujaca OBA zestawy naraz przechodzi);
//   (2) tryb spoza pary WRACA DO DOMYSLNEGO i nie zawęża listy (inaczej niz filtr);
//   (3) tryb jedzie KAZDYM odnosnikiem ekranu i OBOMA formularzami GET (niezmiennik 4.13b)
//       — jeden pominiety odnosnik znaczy „klikam sortowanie i wracam do innych kolumn";
//   (4) przelacznik jest JEDYNYM odnosnikiem, ktory tryb zmienia, i robi to ZACHOWUJAC
//       zawezenie oraz kolejnosc.
describe('dwa tryby tabeli — porządki i katalog', () => {
  // Fikstura ze straznikiem: jedna karta kompletna i jedna bez wszystkiego, zeby OBIE
  // postacie kolumny „Stan" (komplet / N brakow) mialy na czym wystapic.
  function dwaKarty() {
    utworzKarte(db, {
      nazwa: 'Kompletny', sku: 'S1', szerokosc_mm: 1, wysokosc_mm: 1,
      kategoria_glowna: 'K', paczkomat: 'tak',
    });
    utworzKarte(db, { nazwa: 'Dziurawy' });
  }

  // ⚠️ Naglowek „Stan" PRZYPIETY DO SWOJEGO ODNOSNIKA SORTUJACEGO, a nie do golego slowa:
  // sortowanie po `braki` jest cala trescia tej kolumny („najwiecej roboty na wierzch"),
  // wiec `toContain('Stan')` przeszloby takze na naglowku martwym.
  const NAGLOWEK_STANU = /<th[^>]*>\s*<a[^>]*href="[^"]*sort=braki[^"]*"[^>]*>Stan/;

  /** Pasek nad tabela (zawezenie z lewej, przelacznik z prawej). RZUCA, gdy go nie ma. */
  function glowaTabeli(body) {
    const m = /<div class="tabela-glowa">([\s\S]*?)<\/div>/.exec(body);
    if (!m) throw new Error('Nad tabelą nie ma paska „tabela-glowa"');
    return m[1];
  }

  /**
   * PRZELACZNIK TRYBU — adres i napis. RZUCA, gdy go nie ma: bez tego `not.toContain`
   * na `undefined` przechodziloby na zielono i nie chronilo niczego.
   *
   * ⚠️ SZUKA WYLACZNIE W PASKU NAD TABELA (`glowaTabeli`), a nie na calej stronie. Przewijak
   * tabeli jedzie w bok razem z zawartoscia, wiec przelacznik przeniesiony do srodka
   * wyjezdzalby czlowiekowi poza ekran przy pierwszym przewinieciu — a asercja szukajaca
   * po calym `body` nie zauwazylaby tej przeprowadzki.
   */
  function przelacznik(body) {
    const glowa = glowaTabeli(body);
    const span = /<span class="przelacznik">([\s\S]*?)<\/span>/.exec(glowa);
    if (!span) throw new Error('W pasku nad tabelą nie ma przełącznika trybu kolumn');
    const a = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(span[1]);
    if (!a) throw new Error(`Przełącznik trybu nie jest odnośnikiem: ${span[1].trim()}`);
    return { adres: a[1].replace(/&amp;/g, '&'), napis: a[2].replace(/<[^>]*>/g, '').trim() };
  }

  /** Liczba naglowkow PIERWSZEGO wiersza `<thead>` — czyli tylu kolumn ma tabela. */
  function ileKolumn(body) {
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(body);
    if (!thead) throw new Error('Tabela kart nie ma nagłówka');
    const wiersz = /<tr>([\s\S]*?)<\/tr>/.exec(thead[1]);
    if (!wiersz) throw new Error('Nagłówek tabeli kart nie ma ani jednego wiersza');
    return (wiersz[1].match(/<th\b/g) ?? []).length;
  }

  /** `colspan` komorki komunikatu pustej tabeli. RZUCA, gdy tabela nie jest pusta. */
  function colspanPustej(body) {
    const m = /<td colspan="(\d+)" class="pusto">/.exec(body);
    if (!m) throw new Error('Tabela nie renderuje komunikatu pustej listy');
    return Number(m[1]);
  }

  /** Parametry adresu jako zwykly obiekt — porownanie CALOSCI, nie pojedynczych pol. */
  const pola = (adres) => Object.fromEntries(new URLSearchParams(adres.slice(adres.indexOf('?') + 1)));

  // Identyfikatory wierszy, ktore ekran oznaczyl jako `checked` — czyli to, co wyslalaby
  // przegladarka. ⚠️ Wylacznie pola `name="zaznaczone"`: uklad strony i paski filtrow niosa
  // wlasne pola wyboru, wiec liczenie „wszystkich checkboxow" mierzyloby co innego.
  const zaznaczoneWierszeIdy = (body) => [
    ...body.matchAll(/<input\b([^>]*\bname="zaznaczone"[^>]*)>/g),
  ].filter((m) => /\bchecked\b/.test(m[1])).map((m) => /\bvalue="([^"]*)"/.exec(m[1])[1]);

  it('domyślnie porządki: kolumna Stan, ZERO kolumn kanałów', async () => {
    dwaKarty();
    const r = await get(serwer(), '/magazyn');

    expect(r.body).toMatch(NAGLOWEK_STANU);
    // ⚠️ KLASA W POSTACI ATRYBUTU (`class="…"`). Gola nazwa `magazyn-kanal` stoi w arkuszu
    // ukladu, ktory jedzie w KAZDEJ stronie panelu, wiec `not.toContain('magazyn-kanal')`
    // bylo by czerwone zawsze i o niczym by nie mowilo.
    expect(r.body).not.toContain('class="magazyn-kanal"');
    // Stan liczy TRASA (odmiana razem z liczba) — widok niczego nie liczy.
    expect(wierszKarty(r.body, 'Kompletny')).toContain('<span class="znacznik znacznik--ok">komplet</span>');
    expect(wierszKarty(r.body, 'Dziurawy')).toContain('<span class="stan-braki">4 braki</span>');
    // ...i zaden wiersz nie niesie CUDZEGO stanu (mutacja zamieniajaca galezie).
    expect(wierszKarty(r.body, 'Kompletny')).not.toContain('class="stan-braki"');
    expect(wierszKarty(r.body, 'Dziurawy')).not.toContain('>komplet<');
  });

  it('widok=katalog: kolumny kanałów wracają, kolumna Stan znika', async () => {
    dwaKarty();
    const r = await get(serwer(), '/magazyn?widok=katalog');

    expect(r.body).toContain('class="magazyn-kanal"');
    expect(r.body).not.toMatch(NAGLOWEK_STANU);
    expect(r.body).not.toContain('sort=braki');
    // ⚠️ KLASA W POSTACI ATRYBUTU. Gola nazwa `stan-braki` stoi w bloku `<style>` ukladu,
    // ktory jedzie w KAZDEJ stronie panelu — asercja na niej byla czerwona zawsze
    // (zlapane przy pierwszym uruchomieniu tej suity).
    expect(r.body).not.toContain('class="stan-braki"');
    // Kolejnosc kolumn katalogu ZOSTAJE DZISIEJSZA — ceny miedzy kategoria a paczkomatem.
    const naglowki = [...r.body.matchAll(/<th class="magazyn-kanal">([^<]*)<\/th>/g)].map((m) => m[1].trim());
    expect(naglowki).toEqual([
      'pro.szkicownia.pl', 'szkicownia.pl', 'Allegro szkicownia_pl', 'Allegro AmarkaPL',
    ]);
  });

  it('tryb spoza pary WRACA DO DOMYSLNEGO i nie zawęża listy', async () => {
    dwaKarty();
    const app = serwer();

    // ⚠️ Ta sama pulapka, co przy sortowaniu: `MAPA[x] ?? domyslne` oddaje przy
    // `?widok=constructor` funkcje z `Object.prototype`, a nie `undefined`.
    for (const zly of ['constructor', 'toString', 'katalogi', 'porzadki; DROP TABLE karty_produktow']) {
      const r = await get(app, `/magazyn?widok=${encodeURIComponent(zly)}`);
      expect(r.statusCode, zly).toBe(200);
      expect(r.body, zly).toMatch(NAGLOWEK_STANU);
      expect(r.body, zly).not.toContain('class="magazyn-kanal"');
      // ⚠️ TRYB NIE JEST FILTREM: literowka ma pokazac liste w domyslnym ukladzie, a nie
      // pusty ekran (nierozpoznany FILTR oddaje pusto — te dwie decyzje sa rozne celowo).
      expect(r.body, zly).toContain('Dziurawy');
    }
  });

  it('przełącznik prowadzi w DRUGI tryb, zachowując zawężenie i kolejność', async () => {
    dwaKarty();
    const app = serwer();

    const wKatalogu = await get(app, '/magazyn?brak=sku&widok=katalog');
    const doPorzadkow = przelacznik(wKatalogu.body);
    expect(doPorzadkow.napis).toMatch(/porządk/);
    // ⚠️ CALY komplet parametrow, nie „zawiera brak=sku": przelacznik gubiacy sort/kier
    // wracalby do kolejnosci domyslnej po cichu (niezmiennik 4.13b). Tryb domyslny
    // NIE stoi w adresie — stad jego brak w oczekiwanym obiekcie.
    expect(pola(doPorzadkow.adres)).toEqual({ brak: 'sku', sort: 'nazwa', kier: 'asc' });

    const wPorzadkach = await get(app, '/magazyn?brak=sku&sort=braki&kier=desc');
    const doKatalogu = przelacznik(wPorzadkach.body);
    expect(doKatalogu.napis).toMatch(/kanał/);
    expect(pola(doKatalogu.adres)).toEqual({
      brak: 'sku', sort: 'braki', kier: 'desc', widok: 'katalog',
    });
  });

  // ⚠️⚠️ ZAZNACZENIE PRZEZYWA PRZELACZENIE KOLUMN — mocniej niz przy sortowaniu, bo
  // przelacznik nie zmienia nawet KOLEJNOSCI, wylacznie zestaw kolumn. Droga typowa:
  // zawez do kart do przejecia numerow, zaznacz wszystkie, zajrzyj w ceny kanalow „na
  // kontrole" — zgubiony `zaznacz` odhaczylby tu cala liste w polowie roboty, po cichu.
  it('przełącznik niesie zaznaczenie — i NIE dorabia go, gdy go nie było', async () => {
    dwaKarty();
    const app = serwer();

    const zZaznaczeniem = przelacznik((await get(app, '/magazyn?zaznacz=1&widok=katalog')).body);
    expect(pola(zZaznaczeniem.adres).zaznacz).toBe('1');

    // ⚠️ DRUGA POLOWA PARY — bez niej mutacja „zaznacz: true" na sztywno przechodzi, a kazde
    // przelaczenie trybu zaznaczaloby caly katalog czlowiekowi, ktory nie zaznaczyl nic.
    const bezZaznaczenia = przelacznik((await get(app, '/magazyn?widok=katalog')).body);
    expect(bezZaznaczenia.adres).not.toContain('zaznacz');
    // ...a pola wyboru wierszy naprawde ida za adresem w OBIE strony.
    const poPrzelaczeniu = await get(app, zZaznaczeniem.adres);
    expect(zaznaczoneWierszeIdy(poPrzelaczeniu.body)).toHaveLength(2);
    expect(zaznaczoneWierszeIdy((await get(app, bezZaznaczenia.adres)).body)).toHaveLength(0);
  });

  it('OBA formularze GET niosą tryb ukrytym polem — „Filtruj" nie wraca do porządków', async () => {
    dwaKarty();
    const r = await get(serwer(), '/magazyn?widok=katalog');

    // ⚠️ OSOBNO W KAZDYM Z DWOCH FORMULARZY. Asercja na calej stronie jest NIENOSNA: oba
    // rysuja te same pola, wiec skasowanie ich z jednego przechodziloby dzieki drugiemu.
    for (const wzorzec of [/<form class="filtry"[\s\S]*?<\/form>/, /<form class="szukajka"[\s\S]*?<\/form>/]) {
      const formularz = wzorzec.exec(r.body)[0];
      expect(formularz, String(wzorzec)).toContain('<input type="hidden" name="widok" value="katalog">');
    }
    // ⚠️ DRUGA POLOWA PARY: tryb domyslny NIE zasmieca ani adresu, ani formularzy — inaczej
    // „/magazyn" i „/magazyn?widok=porzadki" bylyby dwoma adresami jednej rzeczy.
    expect((await get(serwer(), '/magazyn')).body).not.toContain('name="widok"');
  });

  it('⚠️ KAŻDY odnośnik ekranu niesie tryb dalej — poza samym przełącznikiem', async () => {
    dwaKarty();
    const r = await get(serwer(), '/magazyn?widok=katalog&brak=sku');

    // Przelacznik jest JEDYNYM odnosnikiem, ktory tryb ZMIENIA — wycinamy go, zeby nie
    // wpadl tu jako falszywa czerwien.
    const bezPrzelacznika = r.body.replace(/<span class="przelacznik">[\s\S]*?<\/span>/, '');
    expect(bezPrzelacznika.length).toBeLessThan(r.body.length);
    const adresy = [...bezPrzelacznika.matchAll(/href="(\/magazyn\?[^"]+)"/g)]
      .map((m) => m[1].replace(/&amp;/g, '&'));

    // Piec kafli, piec naglowkow sortujacych, „zaznacz" i „Wyczyść zawężenie" — zero albo
    // garstka znaczylyby, ze petla nizej nie sprawdzila niczego.
    expect(adresy.length).toBeGreaterThanOrEqual(10);
    for (const adres of adresy) {
      expect(pola(adres).widok, adres).toBe('katalog');
    }
  });

  it('pusta tabela sięga końca w OBU trybach', async () => {
    // ⚠️ `colspan` liczy sie z zestawu kolumn, wiec rozjezdza sie CICHO przy zmianie trybu:
    // komunikat pustej listy przestaje wtedy siegac konca tabeli i wyglada jak polamany
    // render. Siedem kolumn porzadkow (zaznaczenie, miniatura, karta, wymiary, kategoria,
    // paczkomat, stan) i dziesiec katalogu (te same bez stanu, plus cztery kanaly).
    const app = serwer();
    expect((await get(app, '/magazyn')).body).toContain('colspan="7"');
    expect((await get(app, '/magazyn?widok=katalog')).body).toContain('colspan="10"');
  });

  // ⚠️⚠️ STRAZNIK DRYFU: `colspan` jest LITERALEM w trasie (`kolumnPustej`), a liczba kolumn
  // bierze sie z gałęzi `<% if %>` w szablonie — dwa miejsca, ktore rozjezdzaja sie CICHO
  // przy dolozeniu albo zdjeciu kolumny. Asercja na samej liczbie (7/10) utrwalilaby wtedy
  // ZLA wartosc, bo pilnowalaby literalu, a nie tabeli. Tutaj porownujemy jedno z drugim.
  it('⚠️ colspan pustej tabeli ZGADZA SIĘ z liczbą nagłówków — w obu trybach', async () => {
    const app = serwer(); // pusta baza: komunikat pustej listy sie renderuje
    for (const [url, tryb] of [['/magazyn', 'porzadki'], ['/magazyn?widok=katalog', 'katalog']]) {
      const { body } = await get(app, url);
      // Zero naglowkow znaczyloby, ze porownujemy dwie dziury — a nie tabele z komunikatem.
      expect(ileKolumn(body), tryb).toBeGreaterThan(0);
      expect(colspanPustej(body), tryb).toBe(ileKolumn(body));
    }
  });

  // Druga polowa tego samego straznika: tabela Z WIERSZAMI ma tyle samo komorek, co
  // naglowkow. Rozjazd thead/tbody (kolumna dolozona z jednej strony) przesuwa CALA
  // zawartosc o jedno pole w prawo — cena pod paczkomatem, wymiar pod kategoria.
  it('⚠️ każdy wiersz ma tyle komórek, ile tabela ma nagłówków — w obu trybach', async () => {
    dwaKarty();
    const app = serwer();
    for (const [url, tryb] of [['/magazyn', 'porzadki'], ['/magazyn?widok=katalog', 'katalog']]) {
      const { body } = await get(app, url);
      const tabela = /<table class="tresc-lista magazyn-tabela">([\s\S]*?)<\/table>/.exec(body)[1];
      const wiersze = tabela.split('<tr>').filter((w) => w.includes('<td'));
      expect(wiersze, tryb).toHaveLength(2);
      for (const w of wiersze) expect((w.match(/<td\b/g) ?? []).length, tryb).toBe(ileKolumn(body));
    }
  });

  it('odmiana liczby braków: 1 brak / 2 braki', async () => {
    // Odmiane liczy TRASA, nie widok — a „brakow" (12–14) jest przy 1–4 nieosiagalne.
    utworzKarte(db, {
      nazwa: 'JedenBrak', sku: 'S1', szerokosc_mm: 1, wysokosc_mm: 1, kategoria_glowna: 'K',
    });
    utworzKarte(db, { nazwa: 'DwaBraki', szerokosc_mm: 1, wysokosc_mm: 1, kategoria_glowna: 'K' });
    const r = await get(serwer(), '/magazyn');

    expect(wierszKarty(r.body, 'JedenBrak')).toContain('<span class="stan-braki">1 brak</span>');
    expect(wierszKarty(r.body, 'DwaBraki')).toContain('<span class="stan-braki">2 braki</span>');
  });

  it('pasek nad tabelą mówi, co zawęża listę — i nie powtarza liczby z paska filtrów', async () => {
    dwaKarty();
    const app = serwer();

    // Bez zawezenia pasek mowi LICZBA (nie ma czego nazwac), bo chipy filtrow sa wtedy ukryte.
    // ⚠️ ODMIANA TROJFORMOWA, jak `ileKart` w magazyn-hurt.ejs: „2 karty", nie „2 kart"
    // — kolumna trafila do trasy wlasnie po to, zeby liczyc poprawnie.
    expect(glowaTabeli((await get(app, '/magazyn')).body)).toContain('bez zawężenia · 2 karty');
    // Piata pozycja wraca do formy mnogiej („5 kart") — bez tego przypadku dwuformowy
    // wariant („N karty") przechodzilby na dwojce i nikt by tego nie zestawil.
    for (const n of [3, 4, 5]) utworzKarte(db, { nazwa: `Karta-${n}` });
    expect(glowaTabeli((await get(app, '/magazyn')).body)).toContain('bez zawężenia · 5 kart');
    // Przy zawezeniu NAZYWA je, a liczby NIE powtarza — ta sama liczba w dwoch miejscach
    // zaczyna zyc wlasnym zyciem przy pierwszej zmianie jednego z nich.
    const zKaflem = glowaTabeli((await get(app, '/magazyn?brak=sku')).body);
    expect(zKaflem).toContain('zawężenie: bez SKU');
    expect(zKaflem).not.toMatch(/\d+ karta/);
  });
});

describe('widok magazynu a paleta motywu', () => {
  it('nie ma ANI JEDNEGO koloru wpisanego wprost', async () => {
    // ⚠️ Paleta ma wariant jasny i ciemny; wartosc wpisana w widoku zadziala w jasnym
    // i po cichu zniknie w ciemnym, bo nikt nie oglada obu naraz.
    const { readFileSync } = await import('./pliki-historyczne.js');
    // ⚠️ TRZECI PLIK JEST TU NIEPRZYPADKOWO: `_magazyn-pominiete-lista.ejs` wchodzi w DWA
    // miejsca (grupa rozwinieta i zwinieta), wiec akurat jego brak na tej liscie bylby
    // dziura w najczesciej dolaczanym szablonie modulu.
    for (const plik of ['magazyn-lista.ejs', 'magazyn-pominiete.ejs', '_magazyn-pominiete-lista.ejs']) {
      const tresc = readFileSync(new URL(`../../src/oms/web/views/${plik}`, import.meta.url), 'utf8');
      expect(tresc).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(tresc).not.toMatch(/rgba?\(/i);
    }
  });
});
