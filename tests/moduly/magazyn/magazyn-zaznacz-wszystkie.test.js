import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzWzor, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';

// „ZAZNACZ WSZYSTKIE" NA LISCIE WZOROW — druga tura tego samego zgloszenia wlasciciela:
// „ale dalej nie da sie zaznaczyc wszystkich pozycji. Tak jak zaznacza sie zamowienia na
// stronie glownej".
//
// ⚠️⚠️ POPRZEDNIA POPRAWKA ODPOWIEDZIALA NA INNE PYTANIE. Dolozyla przy kazdej akcji
// przycisk „dla wszystkich pasujacych", czyli zakres CALY-ALBO-NIC liczony z zawezenia.
// To NIE JEST zaznaczenie: nie da sie odhaczyc trzech wzorow i wykonac akcji na reszcie,
// a przy przejeciu numerow — nieodwracalnym — wlasnie o to chodzi. Oba mechanizmy zostaja,
// bo odpowiadaja na dwie rozne potrzeby.
//
// ⚠️⚠️ I W KODZIE STAL KOMENTARZ, ZE SIE NIE DA: „NAGLOWEK TEJ KOLUMNY JEST PUSTY CELOWO
// (…) bez JavaScriptu takie pole niczego by nie zaznaczylo". To bylo NIEPRAWDA i dowod
// stal w tym samym repozytorium: lista zamowien (`views/lista.ejs`) robi to od dawna
// ZWYKLYM ODNOSNIKIEM pod adres z `?zaznacz=1`, a `checked` wierszy renderuje sie z adresu.
// Odrzucilem mechanizm, ktory juz dzialal obok. Ta suita pilnuje, zeby wrocil i zostal.
//
// CO JEST TU PRZYPIETE:
//   (1) naglowek kolumny zaznaczen ma ODNOSNIK (nie pole wyboru) i prowadzi na `zaznacz=1`;
//   (2) przy `zaznacz=1` KAZDY wiersz jest `checked`, bez niego ANI JEDEN — para, nie polowa;
//   (3) zaznaczenie NIE JEST filtrem: ten sam zbior wierszy przed i po;
//   (4) odnosnik NIESIE zawezenie i kolejnosc — inaczej „zaznacz" kasowaloby filtr i
//       czlowiek zaznaczylby wzory, ktorych nie widzial (ten sam blad, co na liscie zamowien);
//   (5) zaznaczenie przezywa SORTOWANIE (ta sama lista, inna kolejnosc), ale NIE przezywa
//       zmiany filtru (inny zbior — zaznaczenie ma sie liczyc od nowa);
//   (6) DROGA DO KONCA: to, co ekran oznaczyl jako `checked`, po wyslaniu formularza
//       naprawde trafia w akcje jako `zakres=zaznaczone`.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};

const STAN_PUSTY = {
  trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null,
};
const atrapaMagazynu = () => ({ start: vi.fn(), stan: () => STAN_PUSTY });

let db;
let magazyn;
const serwer = (uslugaMagazynu = magazyn) => buildOmsServer({ db, config, magazyn: uslugaMagazynu });

beforeEach(() => {
  db = openOmsDb(':memory:');
  magazyn = atrapaMagazynu();
});

const wzorO = (nazwa, reszta = {}) => utworzWzor(db, { nazwa, ...reszta });

/** Produkt w lustrze z numerem sklepu — zeby przejecie numeru mialo co przejmowac. */
function produktO(wzorId, sku) {
  const id = zapiszProduktSklepowy(db, {
    kanal: 'pro',
    produkt_id: `p${wzorId}`,
    wariant_id: '',
    nazwa: 'Produkt',
    sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  powiazProdukt(db, id, wzorId);
  return id;
}

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload) => app.inject({
  method: 'POST', url, headers: auth, payload,
});

// ————————————————————————————————————————————————————————————————————————————————
// POMOCNIKI — CZYTAJA EKRAN TAK, JAK PRZEGLADARKA
// ————————————————————————————————————————————————————————————————————————————————

/**
 * POLA WYBORU WIERSZY: `{ id, zaznaczone }` w kolejnosci wystapienia.
 *
 * ⚠️ Wylacznie pola o nazwie `zaznaczone` — wspolny uklad (`layout-oms.ejs`) i paski filtrow
 * niosa wlasne pola wyboru, wiec liczenie „wszystkich checkboxow na stronie" mierzyloby
 * cos innego niz wiersze tabeli.
 */
function polaWierszy(body) {
  const znalezione = [];
  for (const m of body.matchAll(/<input\b([^>]*\bname="zaznaczone"[^>]*)>/g)) {
    const atrybuty = m[1];
    const wartosc = /\bvalue="([^"]*)"/.exec(atrybuty);
    znalezione.push({
      id: wartosc ? wartosc[1] : null,
      zaznaczone: /\bchecked\b/.test(atrybuty),
    });
  }
  return znalezione;
}

/** Identyfikatory wierszy oznaczonych jako zaznaczone — czyli to, co wyslalaby przegladarka. */
const zaznaczoneIdy = (body) => polaWierszy(body).filter((p) => p.zaznaczone).map((p) => p.id);

/**
 * ODNOSNIK Z NAGLOWKA KOLUMNY ZAZNACZEN. RZUCA, gdy go nie ma — inaczej `not.toContain`
 * na `undefined` przechodziloby na zielono i nie chronilo niczego.
 */
function odnosnikNaglowka(body) {
  const komorka = /<th class="kol-zaznacz"[^>]*>([\s\S]*?)<\/th>/.exec(body);
  if (!komorka) throw new Error('Tabela wzorów nie ma nagłówka kolumny zaznaczeń');
  const a = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(komorka[1]);
  if (!a) throw new Error(`W nagłówku kolumny zaznaczeń nie ma odnośnika: ${komorka[1].trim()}`);
  return { adres: a[1].replace(/&amp;/g, '&'), napis: a[2].replace(/<[^>]*>/g, '').trim() };
}

/** Zawezenie przenoszone formularzem akcji (ukryte pole `zawezenie`). */
function zawezenieFormularza(body) {
  const kawalek = body.split('<form ').find((f) => f.includes('name="zawezenie"'));
  if (!kawalek) throw new Error('Na ekranie magazynu nie ma formularza akcji');
  const m = /name="zawezenie" value="([^"]*)"/.exec(kawalek);
  return (m ? m[1] : '').replace(/&amp;/g, '&');
}

/**
 * Nazwy wzorow w tabeli LISTY — w KOLEJNOSCI renderu.
 *
 * ⚠️ RZUCA na komorce bez nazwy, zamiast oddac pusty napis. Pierwsza wersja tej funkcji
 * szukala `div.nazwa-wzoru` (klasa z ekranow PODGLADU, nie listy) i oddawala `['','']` —
 * czyli asercja „ta sama lista przed i po" bylaby spelniona przez dwie puste dziury.
 */
// ⚠️ WYJATEK OD „bez modyfikacji" (Zadanie 6, powrot z karty z zachowaniem filtrow):
// odnosnik nazwy wzoru od tego zadania niesie DALEJ adres listy jako „?wroc=…", wiec
// `href="/magazyn/{id}">` bez ogonka juz nie wystapi. `(?:\?[^"]*)?` tylko TOLERUJE ten
// dopisek — nie zmienia, CO ten test sprawdza (ten sam zbior wierszy przed i po zaznaczeniu).
const nazwyListy = (body) => [...body.matchAll(/<td class="komorka-wzor">([\s\S]*?)<\/td>/g)]
  .map((m) => {
    const nazwa = /<a href="\/magazyn\/\d+(?:\?[^"]*)?">([^<]*)<\/a>/.exec(m[1]);
    if (!nazwa) throw new Error(`Wiersz listy bez nazwy wzoru: ${m[1].trim()}`);
    return nazwa[1];
  });

/** Nazwy wzorow z tabeli podgladu przejecia. */
function nazwyWPodgladzie(body, idSekcji) {
  const s = new RegExp(`<section[^>]*id="${idSekcji}"[\\s\\S]*?</section>`).exec(body);
  if (!s) throw new Error(`W podglądzie nie ma sekcji „${idSekcji}"`);
  return [...s[0].matchAll(/<div class="nazwa-wzoru">([^<]*)<\/div>/g)].map((m) => m[1]);
}

// ================================================================================
// (1) NAGLOWEK KOLUMNY MA ODNOSNIK, A NIE PUSTKE
// ================================================================================

describe('nagłówek kolumny zaznaczeń prowadzi na „zaznacz wszystkie"', () => {
  it('jest odnośnikiem pod adres z zaznacz=1', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn');

    expect(odnosnikNaglowka(r.body).adres).toContain('zaznacz=1');
  });

  // ⚠️ ODNOSNIK, NIE POLE WYBORU. Pole wyboru w naglowku bez JavaScriptu NIE zaznaczyloby
  // niczego, a wygladaloby, jakby zaznaczylo — to jest dokladnie ta pulapka, ktora kazala mi
  // wczesniej uznac, ze „sie nie da". Nagłówek ma nie miec pola wyboru NIGDY.
  it('nagłówek nie ma pola wyboru — bo bez skryptu ono by kłamało', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn');
    const komorka = /<th class="kol-zaznacz"[^>]*>([\s\S]*?)<\/th>/.exec(r.body)[1];

    expect(komorka).not.toMatch(/<input/);
  });

  it('po zaznaczeniu wszystkich odnośnik zdejmuje zaznaczenie', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn?zaznacz=1');
    const odnosnik = odnosnikNaglowka(r.body);

    expect(odnosnik.adres).not.toContain('zaznacz=1');
    expect(odnosnik.napis.toLowerCase()).toContain('odznacz');
  });
});

// ================================================================================
// (2) PARA: ZAZNACZA WSZYSTKIE / NIE ZAZNACZA ZADNEGO
// ================================================================================

describe('adres rozstrzyga stan początkowy pól wyboru', () => {
  const trzy = () => ['Kotwica', 'Chmurka', 'Sowa'].map((n) => String(wzorO(n)));

  it('zaznacz=1 zaznacza KAŻDY wiersz listy', async () => {
    const idy = trzy();

    const r = await get(serwer(), '/magazyn?zaznacz=1');

    expect(polaWierszy(r.body)).toHaveLength(3);
    expect(zaznaczoneIdy(r.body).sort()).toEqual([...idy].sort());
  });

  // ⚠️⚠️ DRUGA POLOWA PARY — BEZ NIEJ TEST WYZEJ NIE CHRONI NICZEGO. Mutacja wpisujaca
  // `checked` na sztywno w szablonie przechodzi „zaznacza kazdy wiersz" i psuje CALY ekran:
  // kazde wejscie na /magazyn zaznaczaloby 964 wzory, a czlowiek klikalby akcje w
  // przekonaniu, ze nie zaznaczyl nic.
  it('bez zaznacz=1 NIE jest zaznaczony ani jeden wiersz', async () => {
    trzy();

    const r = await get(serwer(), '/magazyn');

    expect(polaWierszy(r.body)).toHaveLength(3);
    expect(zaznaczoneIdy(r.body)).toEqual([]);
  });

  // Nierozpoznana wartosc nie ma prawa zaznaczac — to samo rozstrzygniecie, co przy zakresie:
  // czego panel nie rozumie, to znaczy zbior WEZSZY.
  it('zaznacz=cokolwiek innego nie zaznacza niczego', async () => {
    trzy();

    const r = await get(serwer(), '/magazyn?zaznacz=tak');

    expect(zaznaczoneIdy(r.body)).toEqual([]);
  });
});

// ================================================================================
// (3) ZAZNACZENIE NIE JEST FILTREM
// ================================================================================

describe('zaznaczenie nie zawęża i nie rozszerza listy', () => {
  // ⚠️ `zaznacz` jedzie tym samym adresem, co filtry, wiec musi byc JAWNIE odrozniony od
  // filtru — inaczej lista po zaznaczeniu pokazywalaby inny zbior niz przed nim.
  it('ten sam zbiór wierszy przed i po zaznaczeniu', async () => {
    wzorO('Kotwica');
    wzorO('Chmurka');
    wzorO('Zmierzona', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const przed = await get(serwer(), '/magazyn?brak=wymiary');
    const po = await get(serwer(), '/magazyn?brak=wymiary&zaznacz=1');

    expect(nazwyListy(przed.body)).toEqual(['Chmurka', 'Kotwica']);
    expect(nazwyListy(po.body)).toEqual(nazwyListy(przed.body));
  });

  // ⚠️⚠️ ZAWEZENIE PRZENOSZONE DO AKCJI MA ZOSTAC CZYSTE. Gdyby `zaznacz=1` wpadlo do pola
  // `zawezenie`, przycisk „dla wszystkich pasujacych" niosłby ze soba stan pol wyboru —
  // dwie rozne rzeczy w jednym parametrze.
  it('zaznaczenie nie wchodzi do zawężenia przenoszonego do akcji', async () => {
    wzorO('Kotwica');

    const bez = await get(serwer(), '/magazyn?brak=sku');
    const z = await get(serwer(), '/magazyn?brak=sku&zaznacz=1');

    expect(zawezenieFormularza(z.body)).toBe(zawezenieFormularza(bez.body));
    expect(zawezenieFormularza(z.body)).not.toContain('zaznacz');
  });
});

// ================================================================================
// (4) ODNOSNIK NIESIE ZAWEZENIE I KOLEJNOSC
// ================================================================================

describe('„zaznacz wszystkie" nie kasuje tego, co zawęziło listę', () => {
  // ⚠️⚠️ TO JEST TEN BLAD, KTORY NA LISCIE ZAMOWIEN KOSZTOWAL OSOBNY KOMENTARZ: odnosnik
  // sklejony na piechote jako `/magazyn?zaznacz=1` gubi filtr, a czlowiek zaznacza WSZYSTKO
  // z katalogu w przekonaniu, ze zaznaczyl 277 pozycji, ktore widzial.
  it('odnośnik zachowuje filtr', async () => {
    wzorO('Kotwica');
    wzorO('Zmierzona', { szerokosc_mm: 300, wysokosc_mm: 400 });

    const r = await get(serwer(), '/magazyn?brak=wymiary');

    expect(odnosnikNaglowka(r.body).adres).toContain('brak=wymiary');
  });

  it('odnośnik zachowuje kolejność', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn?sort=wysokosc&kier=desc');
    const { adres } = odnosnikNaglowka(r.body);

    expect(adres).toContain('sort=wysokosc');
    expect(adres).toContain('kier=desc');
  });

  // ⚠️ SORTOWANIE NIE ZMIENIA ZBIORU, tylko kolejnosc — wiec zaznaczenie ma je PRZEZYC.
  // Bez tego klikniecie w naglowek „Wymiary" po zaznaczeniu wszystkiego odznaczaloby
  // cala liste po cichu.
  it('nagłówki sortowania niosą zaznaczenie dalej', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn?zaznacz=1');
    const doSortowania = /<a class="zaznacz-wszystkie" href="([^"]*)"[^>]*>Wymiary/.exec(r.body);

    expect(doSortowania).not.toBeNull();
    expect(doSortowania[1]).toContain('zaznacz=1');
  });

  // ⚠️ FILTR ZMIENIA ZBIOR, wiec zaznaczenie ma sie liczyc OD NOWA. Przeniesienie go przez
  // „Filtruj" znaczyloby „zaznaczone jest to, czego jeszcze nie widziales".
  it('formularz filtrów NIE przenosi zaznaczenia', async () => {
    wzorO('Kotwica');

    const r = await get(serwer(), '/magazyn?zaznacz=1');

    expect(r.body).not.toMatch(/<input type="hidden" name="zaznacz"/);
  });
});

// ================================================================================
// (5) DROGA DO KONCA — TO, CO EKRAN ZAZNACZYL, TRAFIA W AKCJE
// ================================================================================

describe('zaznaczone wiersze naprawdę trafiają w akcję', () => {
  function trzyDoPrzejecia() {
    const idy = [];
    for (const nazwa of ['Ewakuacja', 'Kotwica', 'Sowa']) {
      const id = wzorO(nazwa);
      produktO(id, `PRO-${nazwa.toUpperCase()}-1`);
      idy.push(id);
    }
    return idy;
  }

  // ⚠️⚠️ TO JEST CALE ZGLOSZENIE, PRZELOZONE NA TEST: jedno klikniecie w naglowek, potem
  // jedno w akcje — zamiast ponad stu klkniec w pola wyboru. Wysylamy DOKLADNIE to, co
  // ekran oznaczyl jako `checked`, a nie liste zlozona w tescie.
  it('jedno kliknięcie w nagłówek zastępuje sto kliknięć w pola wyboru', async () => {
    trzyDoPrzejecia();
    const app = serwer();

    const lista = await get(app, '/magazyn?brak=sku&zaznacz=1');
    const r = await post(app, '/magazyn/przejmij-podglad', {
      zakres: 'zaznaczone',
      zawezenie: zawezenieFormularza(lista.body),
      zaznaczone: zaznaczoneIdy(lista.body),
    });

    expect(r.statusCode).toBe(200);
    expect(nazwyWPodgladzie(r.body, 'przejecie-pozycje').sort())
      .toEqual(['Ewakuacja', 'Kotwica', 'Sowa']);
  });

  // ⚠️ DRUGA POLOWA: bez zaznaczenia ta sama droga ma nie przekazac NICZEGO. Gdyby ten test
  // przechodzil razem z poprzednim przy `checked` wpisanym na sztywno, poprzedni nie
  // dowodzilby niczego.
  it('bez kliknięcia w nagłówek ta sama droga nie niesie ani jednego wzoru', async () => {
    trzyDoPrzejecia();
    const app = serwer();

    const lista = await get(app, '/magazyn?brak=sku');
    const r = await post(app, '/magazyn/przejmij-podglad', {
      zakres: 'zaznaczone',
      zawezenie: zawezenieFormularza(lista.body),
      zaznaczone: zaznaczoneIdy(lista.body),
    });

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  // ⚠️ ODHACZENIE PO ZAZNACZENIU WSZYSTKICH MA DZIALAC — i to jest cala roznica miedzy tym
  // mechanizmem a przyciskiem „dla wszystkich pasujacych". Przegladarka wysyla stan pol
  // W CHWILI ZATWIERDZENIA, a nie to, co mowi adres; tu odwzorowujemy to, pomijajac jeden
  // identyfikator.
  it('odhaczenie jednego wiersza po zaznaczeniu wszystkich zostawia resztę', async () => {
    trzyDoPrzejecia();
    const app = serwer();

    const lista = await get(app, '/magazyn?brak=sku&zaznacz=1');
    const wszystkie = zaznaczoneIdy(lista.body);
    const bezJednego = wszystkie.slice(1);

    const r = await post(app, '/magazyn/przejmij-podglad', {
      zakres: 'zaznaczone',
      zawezenie: zawezenieFormularza(lista.body),
      zaznaczone: bezJednego,
    });

    expect(bezJednego).toHaveLength(2);
    expect(nazwyWPodgladzie(r.body, 'przejecie-pozycje')).toHaveLength(2);
  });
});
