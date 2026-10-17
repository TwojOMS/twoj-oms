import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  zapiszProduktSklepowy, utworzKarte, powiazProdukt, niepowiazaneOfertyAllegro,
} from '../../../src/oms/db/magazyn.js';

// EKRAN POWIAZAN OFERT ALLEGRO Z KARTAMI PRODUKTOW.
//
// PO CO ISTNIEJE: lustro trzyma 447 ofert Allegro i wszystkie maja `karta_id IS NULL`.
// Pole `external` jest na Allegro puste we wszystkich ofertach, a nazwy sa sprzedazowe —
// wiec jedyna droga jest RECZNA, a jedyna pomoca ranking po nazwie.
//
// ⚠️⚠️ CZTERY RZECZY, KTORE TEN OPIS PILNUJE, BO ROZSTRZYGNAL JE WLASCICIEL:
//   (1) NIC nie wiaze sie bez klikniecia — wejscie na strone jest CZYTANIEM;
//   (2) kart moze byc ZERO (tak jest dzis na produkcji) i ekran ma wtedy powiedziec,
//       od czego zaczac, a nie pokazac pusta tabele;
//   (3) lista wszystkich kart stoi na stronie RAZ, a nie w kazdym z 447 wierszy;
//   (4) wiazanie jest ODWRACALNE.

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
let numerKolejny;
function serwer(magazyn = atrapaMagazynu()) {
  return buildOmsServer({ db, config, magazyn });
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  numerKolejny = 0;
});

// Oferta Allegro w lustrze. Oddaje id wiersza — czyli to, czym formularz nazywa pole.
function oferta(nazwa, nadpisania = {}) {
  numerKolejny += 1;
  return zapiszProduktSklepowy(db, {
    kanal: 'allegro_szkicownia', produkt_id: `oferta-${numerKolejny}`, wariant_id: '',
    nazwa, odczytane_at: '2026-08-11T06:00:00.000Z', ...nadpisania,
  });
}
const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

const get = (app, url) => app.inject({ method: 'GET', url, headers: auth });
const post = (app, url, payload, naglowki = auth) => app.inject({
  method: 'POST', url, headers: naglowki, payload,
});

/**
 * WIERSZ TEJ OFERTY — sam wiersz, bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI KAZDEJ ASERCJI NA TYM EKRANIE. Strona
 * niesie JEDNA WSPOLNA liste podpowiedzi (`<datalist>`) ze WSZYSTKIMI nazwami kart —
 * taki jest wymog rozmiaru strony. Kazda asercja „nazwa karty jest na stronie" jest wiec
 * spelniona przez SAMA TE LISTE, nawet gdyby tabela nie renderowala ani jednego kandydata.
 * Zmierzone: po skasowaniu CALEJ petli kandydatow z szablonu asercje na golych nazwach
 * dalej swiecily na zielono.
 *
 * Wszystko, co dotyczy zawartosci wiersza, ma przechodzic przez te funkcje.
 */
function wierszOferty(body, nazwa) {
  const wiersz = body.split('<tr').find((w) => w.includes(`<div class="nazwa-oferty">${nazwa}</div>`));
  // Brak wiersza to blad testu, a nie „pusty wiersz": inaczej kazda asercja `not.toContain`
  // przeszlaby na pustym napisie i znowu mielibysmy falszywa zielen.
  if (!wiersz) throw new Error(`Na ekranie powiazan nie ma wiersza oferty „${nazwa}"`);
  return wiersz;
}

// Nazwy kandydatow TEGO wiersza, w kolejnosci renderowania.
const kandydaci = (wiersz) => [...wiersz.matchAll(/<span class="kandydat-nazwa">([^<]*)<\/span>/g)]
  .map((m) => m[1]);

// Wartosci przyciskow wyboru TEGO wiersza (puste = „nie wiążę").
const wybory = (wiersz) => [...wiersz.matchAll(/<input type="radio" name="karta_\d+" value="([^"]*)"/g)]
  .map((m) => m[1]);

const nazwyOfert = (body) => [...body.matchAll(/<div class="nazwa-oferty">([^<]*)<\/div>/g)]
  .map((m) => m[1]);

const kartaOferty = (id) => db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?')
  .get(id).karta_id;

/**
 * PANEL WYNIKU zatwierdzenia — sam panel, bez reszty strony.
 *
 * ⚠️ Bez tego zawezenia asercja „na ekranie stoi nazwa pominietej oferty" jest spelniona
 * przez SAMA TABELE ROBOCZA: oferta pominieta nie zostala powiazana, wiec dalej stoi na
 * liscie do powiazania kilka wierszy nizej. Zmierzone: po skasowaniu calej sekcji wyniku
 * z szablonu asercja na golej nazwie dalej przechodzila.
 */
function panelWyniku(body) {
  const panel = /<section class="panel wynik-powiazan">[\s\S]*?<\/section>/.exec(body);
  if (!panel) throw new Error('Na ekranie nie ma panelu wyniku zatwierdzenia');
  return panel[0];
}

describe('GET /magazyn/powiazania — lista ofert i kandydaci', () => {
  it('pokazuje TRZECH najlepszych kandydatow przy ofercie, najlepszego pierwszego', async () => {
    kartaO('Trójnóg podłogowy - 64cm');
    kartaO('Trójnóg podłogowy do salonu z wysokim sufitem i szerokim oknem');
    kartaO('Trójnóg');
    kartaO('Kandelabr srebrny');
    oferta('Trójnóg podłogowy - DUŻA lampa, dąb olejowany i lniany abażur');

    const r = await get(serwer(), '/magazyn/powiazania');
    expect(r.statusCode).toBe(200);

    const wiersz = wierszOferty(r.body, 'Trójnóg podłogowy - DUŻA lampa, dąb olejowany i lniany abażur');
    expect(kandydaci(wiersz)).toEqual([
      'Trójnóg podłogowy - 64cm',
      'Trójnóg podłogowy do salonu z wysokim sufitem i szerokim oknem',
      'Trójnóg',
    ]);
    // „Kandelabr srebrny" nie ma z ta oferta ani jednego wspolnego slowa — i dlatego nie stoi
    // przy niej jako kandydat. Na stronie JEST (wspolna lista podpowiedzi), w wierszu NIE MA.
    expect(wiersz).not.toContain('Kandelabr srebrny');
    expect(r.body).toContain('Kandelabr srebrny');
    // ⚠️ PIERWSZY WYBOR JEST PUSTY („nie wiążę") i musi byc: panel nie ma JavaScriptu, wiec
    // bez tej pozycji raz kliknietego przycisku nie da sie odznaczyc inaczej niz
    // przeladowaniem strony — a wtedy ginie praca z pozostalych wierszy tego samego hurtu.
    expect(wybory(wiersz)).toHaveLength(4);
    // ⚠️ I JEST ZAZNACZONY Z GORY — sama jego obecnosc nie wystarcza. Bez `checked` zaden
    // przycisk wiersza nie jest wybrany, wiec po kliknieciu kandydata nie ma juz do czego
    // wrocic: „rozmyslilem sie" wymagaloby przeladowania strony, a to kasuje wybory
    // z pozostalych 446 wierszy tego samego hurtu. (Zmierzone mutacja: samo zdjecie
    // `checked` przechodzilo przez cala suite na zielono.)
    expect(wiersz).toMatch(/<input type="radio" name="karta_\d+" value="" checked>/);
  });

  it('ocena i wspolne slowa stoja PRZY kandydacie, policzone poza widokiem', async () => {
    kartaO('Klosz mleczny');
    oferta('KLOSZ MLECZNY');

    const wiersz = wierszOferty((await get(serwer(), '/magazyn/powiazania')).body, 'KLOSZ MLECZNY');
    // Para z pomiaru: nazwy roznia sie WYLACZNIE wielkoscia liter, wiec ocena jest pelna.
    expect(wiersz).toMatch(/<span class="kandydat-ocena">100%<\/span>/);
    // Wspolne slowa sa jedynym uzasadnieniem oceny, jakie czlowiek dostaje — bez nich
    // procent jest liczba bez pokrycia.
    expect(wiersz).toMatch(/<span class="kandydat-slowa">[^<]*KLOSZ[^<]*MLECZNY[^<]*<\/span>/);
  });

  // ⚠️⚠️ ZERO WSPOLNYCH SLOW TO NIE JEST POWOD, ZEBY UKRYC OFERTE. Wiersz ma stac na liscie
  // razem z reszta, bo to jest robota do wykonania — tyle ze recznie. Ukryty znaczylby
  // „nie ma nic do zrobienia", a to nieprawda.
  it('oferta bez ani jednego kandydata ZOSTAJE na liscie, z sama droga reczna', async () => {
    kartaO('Kandelabr srebrny');
    oferta('Trójnóg podłogowy');

    const wiersz = wierszOferty((await get(serwer(), '/magazyn/powiazania')).body, 'Trójnóg podłogowy');
    expect(kandydaci(wiersz)).toEqual([]);
    // Zostaje SAMO „nie wiążę" — zadna karta nie zostala podsunieta na chybil trafil.
    expect(wybory(wiersz)).toEqual(['']);
    // Pole reczne jest w KAZDYM wierszu, takze w tym — inaczej ta oferta bylaby nie do
    // powiazania z panelu w ogole.
    expect(wiersz).toMatch(/<input class="reczny" type="text" name="reczny_\d+"/);
    // I wiersz MOWI, ze pusto jest celowo, a nie ze cos sie nie doliczylo.
    expect(wiersz).toContain('Żadna karta nie ma z tą nazwą wspólnego słowa');
  });

  it('oferta JUZ powiazana znika z listy roboty', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const zwiazana = oferta('KANDELABR ozdobny');
    oferta('LAMPION ozdobny');
    powiazProdukt(db, zwiazana, kandelabr);

    expect(nazwyOfert((await get(serwer(), '/magazyn/powiazania')).body)).toEqual(['LAMPION ozdobny']);
  });

  // ⚠️⚠️ ROZSTRZYGNIECIE WLASCICIELA: NIC NIE WIAZE SIE BEZ KLIKNIECIA. Zadnego automatu,
  // zadnego „powiąż wszystkie pewne" wykonywanego przy wejsciu na strone.
  it('wejscie na strone niczego NIE wiaze', async () => {
    kartaO('Klosz mleczny');
    const id = oferta('KLOSZ MLECZNY');
    const app = serwer();

    // Ocena 100% — gdyby gdziekolwiek stal automat, ta oferta bylaby pierwsza, ktora zlapie.
    await get(app, '/magazyn/powiazania');
    await get(app, '/magazyn/powiazania');

    expect(kartaOferty(id)).toBe(null);
    expect(niepowiazaneOfertyAllegro(db, ['allegro_szkicownia', 'allegro_amarka'])).toHaveLength(1);
  });

  // ⚠️⚠️ ROZSTRZYGNIECIE 3: 447 wierszy razy ~965 kart to megabajty. Lista podpowiedzi
  // stoi na stronie RAZ i wszystkie wiersze pokazuja na nia atrybutem `list`.
  it('lista wszystkich kart stoi na stronie RAZ, a nie w kazdym wierszu', async () => {
    for (let i = 0; i < 12; i += 1) kartaO(`Karta numer ${i}`);
    for (let i = 0; i < 5; i += 1) oferta(`Oferta numer ${i}`);

    const r = await get(serwer(), '/magazyn/powiazania');
    expect(r.body.match(/<datalist/g)).toHaveLength(1);
    // ...a kazdy wiersz z niej korzysta — inaczej „jedna lista" znaczyloby „lista, ktorej
    // nikt nie uzywa", a droga reczna nie istnialaby.
    expect(r.body.match(/list="karty-do-wyboru"/g)).toHaveLength(5);
    // Ani jednego pola wyboru z pelnym katalogiem w srodku.
    expect(r.body).not.toContain('<select name="karta_');
  });

  it('cala robota jedzie JEDNYM formularzem — zatwierdzenie jest HURTOWE', async () => {
    kartaO('Kandelabr srebrny');
    oferta('KANDELABR ozdobny');
    oferta('KANDELABR duży');

    const r = await get(serwer(), '/magazyn/powiazania');
    const formularz = /<form class="powiazania"[\s\S]*?<\/form>/.exec(r.body)[0];
    // Oba wiersze w JEDNYM formularzu: przycisk zatwierdza wszystkie naraz.
    expect(formularz).toContain('<div class="nazwa-oferty">KANDELABR ozdobny</div>');
    expect(formularz).toContain('<div class="nazwa-oferty">KANDELABR duży</div>');
    expect(formularz).toMatch(/action="\/magazyn\/powiazania"/);
  });
});

describe('GET /magazyn/powiazania — gdy nie ma z czym wiazac', () => {
  // ⚠️⚠️ TO JEST STAN DZISIEJSZY PRODUKCJI, a nie przypadek krancowy: 447 ofert i ZERO
  // kart, bo zakladanie kart to osobny przycisk. Pusta tabela z 447 wierszami bez ani
  // jednego kandydata wygladalaby jak zepsute dopasowanie.
  it('ZERO kart: ekran mowi, od czego zaczac, zamiast pokazac pusta tabele', async () => {
    oferta('KANDELABR ozdobny');
    const r = await get(serwer(), '/magazyn/powiazania');

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Rejestr kart jest pusty');
    // ⚠️ ASERCJA NA DRODZE WYJSCIA, nie na samym slowie „pusty": bez wskazania przycisku
    // komunikat zostawia czlowieka z ta sama niewiedza, co pusta tabela.
    expect(r.body).toContain('Utwórz karty z niepowiązanych');
    // I ANI JEDNEGO wiersza oferty — bo nie ma czego przy nim postawic.
    expect(nazwyOfert(r.body)).toEqual([]);
  });

  it('karty sa, ofert nie ma: ekran mowi, ze robota skonczona', async () => {
    kartaO('Kandelabr srebrny');
    const r = await get(serwer(), '/magazyn/powiazania');

    expect(r.body).toContain('Żadna oferta Allegro nie czeka na powiązanie');
    // Druga polowa pary: komunikat „rejestr pusty" ma tu MILCZEC — karta przeciez jest.
    expect(r.body).not.toContain('Rejestr kart jest pusty');
  });

  it('panel bez sklepow oddaje strone „pusta celowo", a nie 404', async () => {
    const app = buildOmsServer({ db, config });
    const r = await get(app, '/magazyn/powiazania');

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('SKLEP_*/ALLEGRO_*');
  });
});

describe('POST /magazyn/powiazania — zatwierdzenie hurtem', () => {
  it('wiaze wiele par jednym kliknieciem', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const lampion = kartaO('Lampion srebrny');
    const a = oferta('KANDELABR ozdobny');
    const b = oferta('LAMPION ozdobny');

    const r = await post(serwer(), '/magazyn/powiazania', {
      [`karta_${a}`]: String(kandelabr), [`karta_${b}`]: String(lampion),
    });

    expect(r.statusCode).toBe(200);
    expect(kartaOferty(a)).toBe(kandelabr);
    expect(kartaOferty(b)).toBe(lampion);
    // Ekran wyniku MOWI, ile powiazano — bez tego operacja hurtowa jest niema.
    expect(panelWyniku(r.body)).toContain('Powiązane oferty: <strong>2</strong>');
  });

  it('wiersz zostawiony na „nie wiążę" NIE zostaje powiazany', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    const b = oferta('LAMPION ozdobny');

    const r = await post(serwer(), '/magazyn/powiazania', {
      [`karta_${a}`]: String(kandelabr), [`karta_${b}`]: '', [`reczny_${b}`]: '',
    });

    // Druga polowa pary: straznik ma MILCZEC przy pustym wyborze, a nie wiazac „czegokolwiek".
    expect(kartaOferty(a)).toBe(kandelabr);
    expect(kartaOferty(b)).toBe(null);
    // ⚠️ I NIE MELDUJE GO JAKO POMINIETEGO. Brak decyzji nie jest pominieciem: przy 447
    // wierszach kazde zatwierdzenie zostawia setki pustych, a lista „pominietych" z setkami
    // pozycji przestaje byc czytana — czyli chowa te kilka, ktore naprawde cos znacza.
    expect(panelWyniku(r.body)).not.toContain('LAMPION ozdobny');
    expect(panelWyniku(r.body)).not.toContain('nie rozpoznałem karty');
  });

  it('wpis reczny BIJE zaznaczonego kandydata', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const lampion = kartaO('Lampion srebrny');
    const a = oferta('KANDELABR ozdobny');

    // Czlowiek zaznaczyl podpowiedz, a potem wpisal wlasny wybor — wygrywa to, co wpisal.
    const r = await post(serwer(), '/magazyn/powiazania', {
      [`karta_${a}`]: String(kandelabr), [`reczny_${a}`]: `Lampion srebrny [#${lampion}]`,
    });

    expect(r.statusCode).toBe(200);
    expect(kartaOferty(a)).toBe(lampion);
  });

  it('wpis reczny przyjmuje sam numer karty, a nie tylko pozycje z listy', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');

    await post(serwer(), '/magazyn/powiazania', { [`reczny_${a}`]: ` ${kandelabr} ` });
    expect(kartaOferty(a)).toBe(kandelabr);
  });

  // ⚠️ NIEZMIENNIK 4.13a: pominiete wracaja Z POWODEM i musza byc widoczne. Ciche
  // wyrzucenie wiersza z hurtu znaczyloby „zatwierdzilem czterdziesci, weszlo trzydziesci
  // dziewiec" — bez slowa o tym, ktore i dlaczego.
  it('wpis reczny, ktorego nie da sie rozpoznac, POMIJA wiersz i mowi o tym', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    const b = oferta('LAMPION ozdobny');

    const r = await post(serwer(), '/magazyn/powiazania', {
      [`karta_${a}`]: String(kandelabr), [`reczny_${b}`]: 'Karty o takiej nazwie nie ma',
    });

    // Reszta hurtu przechodzi — jeden zly wiersz nie blokuje trzydziestu dziewieciu dobrych.
    expect(kartaOferty(a)).toBe(kandelabr);
    expect(kartaOferty(b)).toBe(null);
    // ⚠️ W PANELU WYNIKU, a nie „gdziekolwiek na stronie": oferta pominieta NIE zostala
    // powiazana, wiec dalej stoi w tabeli roboczej kilka wierszy nizej — asercja na golej
    // nazwie byla spelniona przez sama te tabele, takze po skasowaniu calego panelu wyniku.
    expect(panelWyniku(r.body)).toContain('LAMPION ozdobny');
    expect(panelWyniku(r.body)).toContain('nie rozpoznałem karty');
  });

  it('numer karty spoza rejestru tez POMIJA wiersz zamiast wywalac zapis', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    const b = oferta('LAMPION ozdobny');

    const r = await post(serwer(), '/magazyn/powiazania', {
      [`karta_${a}`]: String(kandelabr), [`karta_${b}`]: '999999',
    });

    expect(r.statusCode).toBe(200);
    expect(kartaOferty(a)).toBe(kandelabr);
    expect(kartaOferty(b)).toBe(null);
    expect(panelWyniku(r.body)).toContain('nie rozpoznałem karty');
  });

  // ⚠️⚠️ FORMULARZ Z 447 WIERSZAMI ZYJE W KARCIE DLUGO. Druga karta, przycisk Wstecz albo
  // powtorzone wyslanie przynosza pare, ktora ktos juz rozstrzygnal INACZEJ.
  it('oferta powiazana w miedzyczasie NIE daje sie nadpisac i wraca jako nieaktualna', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const lampion = kartaO('Lampion srebrny');
    const a = oferta('KANDELABR ozdobny');
    powiazProdukt(db, a, kandelabr);

    const r = await post(serwer(), '/magazyn/powiazania', { [`karta_${a}`]: String(lampion) });

    expect(kartaOferty(a)).toBe(kandelabr);
    expect(panelWyniku(r.body)).toContain('ktoś ją powiązał w międzyczasie');
    // ...i mowi to NAZWA, a nie numerem wiersza — inaczej komunikat jest nie do uzycia.
    expect(panelWyniku(r.body)).toContain('KANDELABR ozdobny');
  });

  it('bez naglowka Origin ochrona CSRF odmawia i NIC sie nie wiaze', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');

    const r = await post(serwer(), '/magazyn/powiazania', { [`karta_${a}`]: String(kandelabr) },
      { authorization: auth.authorization });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaOferty(a)).toBe(null);
  });

  it('panel bez sklepow odmawia CZYTELNIE zamiast udawac, ze powiazal', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    const app = buildOmsServer({ db, config });

    const r = await post(app, '/magazyn/powiazania', { [`karta_${a}`]: String(kandelabr) });

    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('nie ma skąd czytać katalogu');
    // ⚠️ ODMOWA MA POPRZEDZAC ZAPIS, a nie po nim nastapic. Straznik postawiony ZA operacja
    // oddaje ten sam kod bledu i ten sam komunikat, a powiazanie i tak siedzi juz w bazie —
    // czyli 503 klamie. Bez tej asercji przesuniecie strazniks jest niewidoczne.
    expect(kartaOferty(a)).toBe(null);
  });
});

describe('POST /magazyn/powiazania/odepnij — wiazanie jest ODWRACALNE', () => {
  it('odpina oferte i wraca ona na liste do powiazania', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    powiazProdukt(db, a, kandelabr);
    const app = serwer();

    const r = await post(app, '/magazyn/powiazania/odepnij', { id: String(a) });

    expect(r.statusCode).toBe(200);
    expect(kartaOferty(a)).toBe(null);
    expect(nazwyOfert(r.body)).toContain('KANDELABR ozdobny');
  });

  it('ekran POKAZUJE, co jest juz powiazane — inaczej nie ma czego odpiac', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    powiazProdukt(db, a, kandelabr);

    const r = await get(serwer(), '/magazyn/powiazania');
    const juz = /<section class="panel juz-powiazane"[\s\S]*?<\/section>/.exec(r.body)[0];
    // Nazwa oferty I nazwa karty w JEDNYM wierszu — bez pary czlowiek nie wie, co odpina.
    expect(juz).toMatch(/KANDELABR ozdobny[\s\S]{0,400}Kandelabr srebrny/);
    expect(juz).toMatch(new RegExp(`<input type="hidden" name="id" value="${a}">`));
  });

  it('bez naglowka Origin ochrona CSRF odmawia i powiazanie zostaje', async () => {
    const kandelabr = kartaO('Kandelabr srebrny');
    const a = oferta('KANDELABR ozdobny');
    powiazProdukt(db, a, kandelabr);

    const r = await post(serwer(), '/magazyn/powiazania/odepnij', { id: String(a) },
      { authorization: auth.authorization });

    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(kartaOferty(a)).toBe(kandelabr);
  });
});

describe('GET /magazyn/powiazania — szukanie i kolejnosc z adresu', () => {
  function katalog() {
    kartaO('Kandelabr srebrny');
    kartaO('Lampion srebrny');
    oferta('KANDELABR ozdobny', { kanal: 'allegro_szkicownia' });
    oferta('LAMPION ozdobny', { kanal: 'allegro_amarka' });
    oferta('ABAŻUR ozdobny', { kanal: 'allegro_szkicownia' });
  }

  it('fraza zaweza liste ofert', async () => {
    katalog();
    expect(nazwyOfert((await get(serwer(), '/magazyn/powiazania?fraza=lampion')).body))
      .toEqual(['LAMPION ozdobny']);
  });

  it('filtr konta Allegro zaweza liste ofert', async () => {
    katalog();
    expect(nazwyOfert((await get(serwer(), '/magazyn/powiazania?kanal=allegro_amarka')).body))
      .toEqual(['LAMPION ozdobny']);
  });

  it('nierozpoznana wartosc filtru NIE zaweza listy do pustej', async () => {
    // Druga polowa pary: straznik ma milczec, gdy wartosci z adresu nie rozumie —
    // pusty ekran wyglada jak „nie ma czego wiazac", a jest ich 447.
    katalog();
    const app = serwer();
    for (const zly of ['kanal=nie-ma-takiego', 'kanal=constructor', 'kanal=pro']) {
      const r = await get(app, `/magazyn/powiazania?${zly}`);
      expect(r.statusCode, zly).toBe(200);
      expect(nazwyOfert(r.body), zly).toHaveLength(3);
    }
  });

  it('kolejnosc po ocenie stawia najpewniejsze na gorze, a nazwa sortowania z prototypu NIE wywala ekranu', async () => {
    kartaO('Kandelabr srebrny');
    oferta('Kandelabr srebrny');
    oferta('KANDELABR duży dekoracyjny do salonu w domu jednorodzinnym');
    const app = serwer();

    expect(nazwyOfert((await get(app, '/magazyn/powiazania?sort=ocena&kier=desc')).body))
      .toEqual(['Kandelabr srebrny', 'KANDELABR duży dekoracyjny do salonu w domu jednorodzinnym']);

    // ⚠️ `SORTOWANIE[x] ?? domyslne` oddaje TU funkcje z Object.prototype — realna
    // pieciusetka zlapana przy Zadaniu 4 na ekranie magazynu. Nierozpoznana nazwa WRACA
    // DO DOMYSLNEJ (alfabetycznej), bo kolejnosc nie zaweza zbioru.
    for (const zly of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = await get(app, `/magazyn/powiazania?sort=${zly}`);
      expect(r.statusCode, zly).toBe(200);
      // Kolejnosc ALFABETYCZNA (domyslna) — a nie ta sprzed chwili po ocenie. Bez tej
      // asercji test przechodzilby takze wtedy, gdyby nierozpoznana nazwa zostawiala
      // kolejnosc losowa albo ostatnia uzyta.
      expect(nazwyOfert(r.body), zly).toEqual([
        'KANDELABR duży dekoracyjny do salonu w domu jednorodzinnym', 'Kandelabr srebrny',
      ]);
    }
  });

  it('formularz szukania niesie dalej filtr konta, a filtr niesie fraze', async () => {
    // Niezmiennik 4.13b: filtry LACZA SIE z fraza, a nie kasuja jej. Formularz GET wysyla
    // wylacznie WLASNE pola, wiec kazdy z nich musi niesc wartosci drugiego ukrytym polem.
    katalog();
    const r = await get(serwer(), '/magazyn/powiazania?fraza=ozdobny&kanal=allegro_szkicownia');
    const szukajka = /<form class="szukajka"[\s\S]*?<\/form>/.exec(r.body)[0];

    expect(szukajka).toContain('<input type="hidden" name="kanal" value="allegro_szkicownia">');
    expect(szukajka).toContain('value="ozdobny"');
  });
});

describe('wejscie na ekran powiazan', () => {
  it('ekran magazynu prowadzi na powiazania odnosnikiem', async () => {
    // Bez tego odnosnika trasa istnieje wylacznie dla kogos, kto zna adres.
    // ⚠️ Od 10.09.2026 odnosnik niesie `?wroc=…` (adres powrotu na TE liste, 4.13d) — ten
    // test pilnuje WEJSCIA na ekran, a nie ksztaltu adresu, wiec dopuszcza oba warianty.
    // Sam adres powrotu ma wlasne asercje nizej.
    const r = await get(serwer(), '/magazyn');
    expect(r.body).toMatch(/<a class="link-edytuj" href="\/magazyn\/powiazania(\?[^"]*)?">/);
  });

  // ---------------------------------------------------------------------------------
  // POWROT NA ZAWEZONY MAGAZYN (4.13d, trzecia partia z 2026-09-10).
  //
  // ⚠️ Ten ekran ma WLASNA nawigacje — filtry, szukajke i trzy naglowki sortujace — wiec
  // adres powrotu musi ja PRZEZYC. Odnosnik naprawiony bez tego dzialalby wylacznie do
  // pierwszego klikniecia w cokolwiek na stronie, czyli w praktyce nigdy: po to sie tu
  // wchodzi, zeby przejsc kilkanascie wierszy zawezeniem.
  // ---------------------------------------------------------------------------------
  describe('powrót na zawężony magazyn', () => {
    const ZAWEZENIE = '/magazyn?fraza=kandelabr&brak=sku';
    // Adres, ktory lista SKLADA jako swoj wlasny (adresPowrotuListy) — z kolejnoscia,
    // bo powrot ma odtworzyc ekran, a nie samo zawezenie.
    const ZAWEZENIE_Z_LISTY = ZAWEZENIE + '&sort=nazwa&kier=asc';
    const ESC = ZAWEZENIE.replace(/&/g, '&amp;');
    const odnosnikPowrotu = (body) => {
      const m = body.match(/<p class="wroc">[\s\S]*?<\/p>/);
      expect(m).not.toBeNull();
      return m[0];
    };

    it('odnośnik z listy magazynu niesie zawężenie, na którym stoi operator', async () => {
      kartaO('Kandelabr 70x100');
      const app = serwer();
      const r = await get(app, ZAWEZENIE);
      expect(r.body).toContain(`href="/magazyn/powiazania?wroc=${encodeURIComponent(ZAWEZENIE_Z_LISTY)}"`);
    });

    it('ekran powiązań odsyła tam, skąd kliknięto', async () => {
      kartaO('Kandelabr 70x100');
      oferta('Kandelabr ozdobny');
      const app = serwer();
      const r = await get(app, `/magazyn/powiazania?wroc=${encodeURIComponent(ZAWEZENIE)}`);
      expect(odnosnikPowrotu(r.body)).toContain(`href="${ESC}"`);
    });

    // ⚠️ Adres jedzie KAZDA droga tego ekranu — tak samo, jak tryb kolumn na liscie magazynu
    // (4.66). Naglowek sortujacy skladany od zera zgubilby go po pierwszym klknieciu.
    it('przeżywa własną nawigację ekranu: sortowanie, filtry i szukajkę', async () => {
      kartaO('Kandelabr 70x100');
      oferta('Kandelabr ozdobny');
      const app = serwer();
      const r = await get(app, `/magazyn/powiazania?wroc=${encodeURIComponent(ZAWEZENIE)}`);
      // Nagłówki sortujące.
      const naglowki = [...r.body.matchAll(/<a class="zaznacz-wszystkie" href="([^"]*)"/g)].map((m) => m[1]);
      expect(naglowki.length).toBeGreaterThan(0);
      for (const adres of naglowki) expect(adres).toContain(`wroc=${encodeURIComponent(ZAWEZENIE)}`);
      // Oba formularze GET (filtry i szukajka) — ukrytym polem, jak niosą nawzajem swoje wartości.
      for (const klasa of ['filtry', 'szukajka']) {
        const start = r.body.indexOf(`<form class="${klasa}"`);
        expect(start).toBeGreaterThan(-1);
        expect(r.body.slice(start, r.body.indexOf('</form>', start)))
          .toContain(`<input type="hidden" name="wroc" value="${ESC}">`);
      }
      // ⚠️⚠️ FORMULARZ WIAZANIA HURTEM TEZ — i to jest osobna asercja, nie powtorka.
      // Test niżej POST-uje `wroc` wprost do trasy, czyli sprawdza SAMA TRASE: skasowanie
      // ukrytego pola z szablonu przechodziło przez niego na zielono (zmierzone mutacją),
      // a przeglądarka nie miałaby czego wysłać i adres ginąłby po pierwszym powiązaniu.
      const startHurtu = r.body.indexOf('<form class="powiazania"');
      expect(startHurtu).toBeGreaterThan(-1);
      expect(r.body.slice(startHurtu, r.body.indexOf('</form>', startHurtu)))
        .toContain(`<input type="hidden" name="wroc" value="${ESC}">`);
    });

    // Obie trasy POST renderują TEN SAM ekran (`ekranPowiazan`), więc adres ma przeżyć
    // także wiązanie hurtem i odpięcie — inaczej ginie po pierwszej wykonanej robocie.
    it('przeżywa powiązanie hurtem i odpięcie', async () => {
      const w = kartaO('Kandelabr 70x100');
      const o = oferta('Kandelabr ozdobny');
      const app = serwer();
      const powiazane = await post(app, '/magazyn/powiazania', { [`karta_${o}`]: String(w), wroc: ZAWEZENIE });
      expect(odnosnikPowrotu(powiazane.body)).toContain(`href="${ESC}"`);
      // ⚠️ Formularz „Odepnij" stoi w sekcji „już powiązane", czyli powstaje DOPIERO po
      // powiązaniu — i on też musi oddać adres, inaczej odpięcie odsyła na goły magazyn.
      const startOdepnij = powiazane.body.indexOf('<form method="post" action="/magazyn/powiazania/odepnij">');
      expect(startOdepnij).toBeGreaterThan(-1);
      expect(powiazane.body.slice(startOdepnij, powiazane.body.indexOf('</form>', startOdepnij)))
        .toContain(`<input type="hidden" name="wroc" value="${ESC}">`);
      const odpiete = await post(app, '/magazyn/powiazania/odepnij', { id: String(o), wroc: ZAWEZENIE });
      expect(odnosnikPowrotu(odpiete.body)).toContain(`href="${ESC}"`);
    });

    it('adres spoza magazynu jest odrzucany — zostaje goły magazyn', async () => {
      kartaO('Kandelabr 70x100');
      oferta('Kandelabr ozdobny');
      const app = serwer();
      for (const zly of ['//obcy.example.com/', '/?status=nowe', '/magazyn//obcy']) {
        const r = await get(app, `/magazyn/powiazania?wroc=${encodeURIComponent(zly)}`);
        expect(odnosnikPowrotu(r.body)).toContain('href="/magazyn"');
      }
    });
  });

  it('widok powiazan nie ma ANI JEDNEGO koloru wpisanego wprost', async () => {
    // Paleta ma wariant jasny i ciemny; wartosc wpisana w widoku zadziala w jasnym
    // i po cichu zniknie w ciemnym, bo nikt nie oglada obu naraz.
    const { readFileSync } = await import('./pliki-historyczne.js');
    const tresc = readFileSync(
      new URL('../../src/oms/web/views/magazyn-powiazania.ejs', import.meta.url), 'utf8',
    );
    expect(tresc).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(tresc).not.toMatch(/rgba?\(/i);
  });
});
