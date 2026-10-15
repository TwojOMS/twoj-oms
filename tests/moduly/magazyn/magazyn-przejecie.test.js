import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  utworzWzor, zapiszProduktSklepowy, powiazProdukt, zajeteSku, produktyWzorow,
} from '../../../src/oms/db/magazyn.js';
import { przejeciaZeSklepu } from '../../../src/domena/przejecie-sku.js';

// PRZEJECIE NUMERU ZE SKLEPU — krok, ktorego NIE MA w planie, a bez ktorego zapis do sklepow
// nadpisywalby TOZSAMOSC produktow.
//
// PO CO TO ISTNIEJE (zmierzone na produkcji 2026-08-12): 278 wzorow — czwarta czesc katalogu —
// nie ma NASZEGO numeru, ale ich produkt ma WLASNY numer w sklepie („PRO-NIEUPOWAZN-168",
// „PD10"). Generator SKU ich nie przejmuje: poprawnie nie wydaje numeru zajetego, ale zostawia
// ROZBIEZNOSC — rejestr milczy, sklep ma numer. Gdyby potem pojechal zapis, nadpisalby numer
// bedacy tozsamoscia produktu.
//
// ⚠️⚠️ CZTERY RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) przejmujemy WYLACZNIE numer, ktory JUZ JEST w sklepie — nic nie wymyslamy;
//   (2) wzor powiazany z produktami o ROZNYCH numerach NIE MA jednej poprawnej odpowiedzi
//       i ma trafic do czlowieka, a nie do zapisu;
//   (3) porownanie NIECZULE NA WIELKOSC LITER — `wzory.sku` ma UNIQUE typu BINARY, wiec
//       „PD10" i „pd10" przejete z dwoch sklepow przeszlyby przez baze, a w sklepie bylyby
//       jednym numerem;
//   (4) numer wlasnego produktu NIE JEST kolizja — inaczej nie dalo by sie przejac niczego.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
// ⚠️ TE SAME poswiadczenia, ale BEZ `origin` — ochrona CSRF stoi na naglowku zrodla.
const authBezZrodla = { authorization: auth.authorization };

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

// ——— MATERIAL ———————————————————————————————————————————————————————————————

const wzorO = (nazwa, reszta = {}) => utworzWzor(db, { nazwa, ...reszta });

/** Produkt w lustrze, powiazany z wzorem. Oddaje id wiersza lustra. */
function produktO(wzorId, { kanal = 'pro', produkt_id = null, sku = null, nazwa = 'Produkt' } = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produkt_id ?? `p${Math.random().toString(36).slice(2, 9)}`,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  if (wzorId) powiazProdukt(db, id, wzorId);
  return id;
}

const wiersz = (id) => db.prepare('SELECT * FROM wzory WHERE id = ?').get(id);

const post = (app, url, payload, naglowki = auth) => app.inject({
  method: 'POST', url, headers: naglowki, payload,
});
const podglad = (app, payload, naglowki) => post(app, '/magazyn/przejmij-podglad', payload, naglowki);
const zatwierdz = (app, payload, naglowki) => post(app, '/magazyn/przejmij-zapisz', payload, naglowki);

/**
 * JEDNA SEKCJA EKRANU — bez reszty strony.
 *
 * ⚠️⚠️ TO NIE JEST WYGODA, TYLKO WARUNEK NOSNOSCI KAZDEJ ASERCJI TUTAJ. Wspolny uklad
 * (`layout-oms.ejs`) jedzie w KAZDEJ stronie i niesie wlasne pola formularzy, a ekran
 * przejecia pokazuje ten sam numer w kilku miejscach. RZUCA, gdy sekcji nie ma — inaczej
 * kazde `not.toContain` przechodziloby na pustym napisie, czyli zielono i bez ochrony.
 */
function sekcja(body, id) {
  const trafienie = new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}"`);
  return trafienie[0];
}

/** Wiersz JEDNEGO wzoru z tabeli przejecia — sam wiersz, bez reszty sekcji. */
function wierszPozycji(body, nazwa) {
  const znacznik = `<div class="nazwa-wzoru">${nazwa}</div>`;
  const w = sekcja(body, 'przejecie-pozycje').split('<tr').find((t) => t.includes(znacznik));
  if (!w) throw new Error(`W podgladzie nie ma wzoru „${nazwa}"`);
  return w;
}

const nazwyNaEkranie = (body) => [...sekcja(body, 'przejecie-pozycje')
  .matchAll(/<div class="nazwa-wzoru">([^<]*)<\/div>/g)].map((m) => m[1]);

// ================================================================================
// REGULA (domain/przejecie-sku.js)
// ================================================================================

describe('przejeciaZeSklepu', () => {
  const W = (id, nazwa, sku = null) => ({ id, nazwa, sku });
  const P = (wzor_id, sku, kanal = 'pro', nazwa = 'Produkt') => ({
    wzor_id, sku_sklepu: sku, kanal, nazwa, produkt_id: '900', wariant_id: '',
  });

  it('wzór bez naszego numeru przejmuje numer swojego produktu', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, 'PRO-NIEUPOWAZN-168')], null);
    expect(p.sku).toBe('PRO-NIEUPOWAZN-168');
    expect(p.zla).toBe(false);
  });

  // ⚠️ MILCZENIE STRAZNIKA „ma juz numer": wzor BEZ numeru ma sie pojawic (test wyzej),
  // a Z numerem — nigdy. Numer raz nadany jest tozsamoscia produktu.
  it('wzór, który ma już nasz numer, nie jest ruszany', () => {
    expect(przejeciaZeSklepu([W(1, 'Ewakuacja', 'STE-001')], [P(1, 'PD10')], null)).toEqual([]);
  });

  it('sam napis z odstępów w naszym SKU to brak numeru, a nie numer', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja', '   ')], [P(1, 'PD10')], null);
    expect(p.sku).toBe('PD10');
  });

  it('wzór, którego produkty nie mają numeru w sklepie, nie ma czego przejąć', () => {
    expect(przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, null), P(1, '   ')], null)).toEqual([]);
  });

  it('wzór bez ani jednego powiązanego produktu nie ma czego przejąć', () => {
    expect(przejeciaZeSklepu([W(1, 'Ewakuacja')], [], null)).toEqual([]);
  });

  // ⚠️⚠️ NAJWAZNIEJSZA PARA W TEJ SUICIE. Wzor powiazany z produktami o ROZNYCH numerach nie
  // ma jednej poprawnej odpowiedzi — panel nie ma prawa wybierac za czlowieka.
  it('produkty o RÓŻNYCH numerach nie dają propozycji, tylko trafiają do człowieka', () => {
    const [p] = przejeciaZeSklepu(
      [W(1, 'Ewakuacja')],
      [P(1, 'PRO-EV-118', 'pro'), P(1, 'PD10', 'szkicownia')],
      null,
    );
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/różne numery/i);
    // Oba numery MUSZA byc widoczne — „rozbieznosc" bez pokazania czego nie da sie rozstrzygnac.
    expect(p.uwaga).toContain('PRO-EV-118');
    expect(p.uwaga).toContain('PD10');
  });

  // MILCZENIE tego samego straznika: ten sam numer w dwoch sklepach to JEDNA odpowiedz.
  it('ten sam numer w dwóch kanałach jest jedną odpowiedzią, nie rozbieżnością', () => {
    const [p] = przejeciaZeSklepu(
      [W(1, 'Ewakuacja')],
      [P(1, 'PD10', 'pro'), P(1, 'PD10', 'szkicownia')],
      null,
    );
    expect(p.sku).toBe('PD10');
    expect(p.zla).toBe(false);
  });

  // ⚠️ „PD10" i „pd10" to DLA SKLEPU jeden numer, a dla naszej kolumny (UNIQUE BINARY) dwa.
  // Ktory z nich jest prawda, wie wylacznie czlowiek.
  it('numery różniące się WYŁĄCZNIE wielkością liter też idą do człowieka', () => {
    const [p] = przejeciaZeSklepu(
      [W(1, 'Ewakuacja')],
      [P(1, 'PD10', 'pro'), P(1, 'pd10', 'szkicownia')],
      null,
    );
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
  });

  it('puste numery pozostałych produktów nie robią rozbieżności', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, null), P(1, 'PD10'), P(1, '  ')], null);
    expect(p.sku).toBe('PD10');
    expect(p.zla).toBe(false);
  });

  it('odstępy wokół numeru w sklepie są obcinane, a nie robią rozbieżności', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, ' PD10 '), P(1, 'PD10')], null);
    expect(p.sku).toBe('PD10');
  });

  it('produkt CUDZEGO wzoru nie jest źródłem numeru', () => {
    expect(przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(2, 'PD10')], null)).toEqual([]);
  });

  // ⚠️ KOLIZJA Z NUMEREM ZAJETYM GDZIE INDZIEJ. Przejety numer laduje w `wzory.sku`,
  // wiec musi byc wolny takze w NASZYM rejestrze.
  it('numer zajęty przez inny wzór jest kolizją, nie propozycją', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, 'PD10')],
      new Map([['PD10', 'wzór „Parking" (#7)']]));
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/zajęt/i);
    expect(p.uwaga).toContain('Parking');
  });

  // ⚠️ POROWNANIE NIECZULE NA WIELKOSC LITER: baza (BINARY) przepuscilaby „pd10" obok „PD10",
  // a sklep odbilby je jako duplikat. Ostrozniej znaczy tutaj WIECEJ wykrytych kolizji.
  it('zajęty numer rozpoznajemy bez względu na wielkość liter', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, 'PD10')],
      new Map([['pd10', 'wzór „Parking" (#7)']]));
    expect(p.zla).toBe(true);
  });

  // MILCZENIE straznika kolizji: numer, ktorego nikt inny nie ma, przechodzi.
  it('numer wolny w rejestrze nie jest kolizją', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, 'PD10')],
      new Map([['STE-001', 'wzór „Parking" (#7)']]));
    expect(p.zla).toBe(false);
    expect(p.sku).toBe('PD10');
  });

  // ⚠️⚠️ DWA WZORY PO TEN SAM NUMER. Baza przyjmie „PD10" i „pd10" jako rozne, a sklep nie —
  // wiec obie pozycje musza wrocic OZNACZONE, a nie jedna „wolna" i jedna kolizyjna.
  it('dwa wzory po ten sam numer to kolizja po OBU stronach', () => {
    const wynik = przejeciaZeSklepu(
      [W(1, 'Ewakuacja'), W(2, 'Parking')],
      [P(1, 'PD10'), P(2, 'pd10')],
      null,
    );
    expect(wynik.map((p) => p.zla)).toEqual([true, true]);
    expect(wynik[0].uwaga).toContain('Parking');
    expect(wynik[1].uwaga).toContain('Ewakuacja');
  });

  it('dwa wzory po różne numery przechodzą oba', () => {
    const wynik = przejeciaZeSklepu(
      [W(1, 'Ewakuacja'), W(2, 'Parking')],
      [P(1, 'PD10'), P(2, 'PD11')],
      null,
    );
    expect(wynik.map((p) => p.sku)).toEqual(['PD10', 'PD11']);
    expect(wynik.map((p) => p.zla)).toEqual([false, false]);
  });

  // ⚠️ POWTARZALNOSC: kolejnosc wierszy z bazy zalezy od planu zapytania, a czlowiek ma
  // zobaczyc ten sam ekran przy podgladzie i przy zatwierdzeniu.
  it('kolejność jest alfabetyczna, nie taka jak w wejściu', () => {
    const wynik = przejeciaZeSklepu(
      [W(2, 'Zakazy'), W(1, 'Ewakuacja')],
      [P(1, 'PD10'), P(2, 'PD11')],
      null,
    );
    expect(wynik.map((p) => p.nazwa)).toEqual(['Ewakuacja', 'Zakazy']);
  });

  it('ten sam wzór podany dwa razy daje jedną pozycję', () => {
    const wynik = przejeciaZeSklepu([W(1, 'Ewakuacja'), W(1, 'Ewakuacja')], [P(1, 'PD10')], null);
    expect(wynik).toHaveLength(1);
  });

  it('źródło numeru jest częścią odpowiedzi', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Ewakuacja')], [P(1, 'PD10', 'szkicownia', 'Tabliczka')], null);
    expect(p.zrodlo).toContain('szkicownia');
    expect(p.zrodlo).toContain('Tabliczka');
  });

  it('brak wzorów i brak produktów oddaje pustą listę, a nie wyjątek', () => {
    expect(przejeciaZeSklepu(null, null, null)).toEqual([]);
  });

  // ⚠️⚠️ ROZBIEZNOSC I KOLIZJA TO DWIE ROZNE ODPOWIEDZI, a nie dwa odcienie tej samej.
  // Rozbieznosc znaczy „nie wiem, ktory numer" i dotyczy JEDNEGO wzoru. Kolizja znaczy „ten
  // numer jest czyjas tozsamoscia" i wstrzymuje CALY zapis (tak jak w generatorze SKU) —
  // wiec trasa musi je rozroznic, a jedynym miejscem, ktore je zna, jest ta regula.
  it('rodzaj rozróżnia rozbieżność od kolizji i od pozycji gotowej', () => {
    const gotowa = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10')], null)[0];
    const rozne = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10'), P(1, 'PD11')], null)[0];
    const zajeta = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10')], new Map([['PD10', 'gdzieś']]))[0];
    const spor = przejeciaZeSklepu([W(1, 'A'), W(2, 'B')], [P(1, 'PD10'), P(2, 'PD10')], null);
    expect([gotowa.rodzaj, rozne.rodzaj, zajeta.rodzaj]).toEqual(['gotowe', 'rozbieznosc', 'kolizja']);
    // Spor dwoch wzorow o jeden numer JEST kolizja — kosztem jest ten sam co przy zajetym:
    // numer w sklepie nalezy do jednego produktu.
    expect(spor.map((p) => p.rodzaj)).toEqual(['kolizja', 'kolizja']);
  });
});

// ================================================================================
// ZAPYTANIE (db/magazyn.js) — numery zajete POZA produktami tych wzorow
// ================================================================================

describe('zajeteSku z pominięciem produktów wskazanych wzorów', () => {
  // ⚠️⚠️ BEZ TEGO POMINIECIA PRZEJECIE NIE DZIALALOBY NIGDY: numer, ktory chcemy przejac,
  // ZYJE w lustrze, wiec `zajeteSku` widzi go jako zajety — przez produkt TEGO SAMEGO wzoru.
  it('numer własnego produktu wzoru nie wraca jako zajęty', () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    expect([...zajeteSku(db, { pomijajProduktyWzorow: [id] }).keys()]).toEqual([]);
  });

  // MILCZENIE tego samego straznika: bez pominiecia numer JEST zajety — i tak ma byc,
  // bo generator SKU liczy na to, ze o numerach ze sklepow dowie sie stad.
  it('bez pominięcia ten sam numer wraca jako zajęty', () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    expect(zajeteSku(db).has('PD10')).toBe(true);
  });

  it('numer produktu INNEGO wzoru wraca jako zajęty mimo pominięcia', () => {
    const a = wzorO('Ewakuacja');
    const b = wzorO('Parking');
    produktO(b, { sku: 'PD11' });
    expect(zajeteSku(db, { pomijajProduktyWzorow: [a] }).has('PD11')).toBe(true);
  });

  it('numer produktu NIEPOWIĄZANEGO z żadnym wzorem wraca jako zajęty', () => {
    const a = wzorO('Ewakuacja');
    produktO(null, { sku: 'PD12' });
    expect(zajeteSku(db, { pomijajProduktyWzorow: [a] }).has('PD12')).toBe(true);
  });

  it('nasze numery z rejestru wracają jako zajęte mimo pominięcia produktów', () => {
    const a = wzorO('Ewakuacja');
    wzorO('Parking', { sku: 'STE-001' });
    expect(zajeteSku(db, { pomijajProduktyWzorow: [a] }).has('STE-001')).toBe(true);
  });

  it('śmieć zamiast numeru wzoru nie trafia do SQL-a i nie psuje odczytu', () => {
    const a = wzorO('Ewakuacja');
    produktO(a, { sku: 'PD10' });
    expect(zajeteSku(db, { pomijajProduktyWzorow: ["1); DROP TABLE wzory; --"] }).has('PD10'))
      .toBe(true);
  });
});

describe('produktyWzorow', () => {
  it('oddaje produkty WIELU wzorów naraz, z numerem wzoru przy każdym', () => {
    const a = wzorO('Ewakuacja');
    const b = wzorO('Parking');
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    const wynik = produktyWzorow(db, [a, b]);
    expect(wynik.map((p) => [p.wzor_id, p.sku_sklepu]).sort())
      .toEqual([[a, 'PD10'], [b, 'PD11']].sort());
  });

  it('produkt CUDZEGO wzoru nie wchodzi do wyniku', () => {
    const a = wzorO('Ewakuacja');
    const b = wzorO('Parking');
    produktO(b, { sku: 'PD11' });
    expect(produktyWzorow(db, [a])).toEqual([]);
  });

  // ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU NADAL TRZYMA SWOJ NUMER — inaczej wzor z jednym produktem
  // wycofanym i jednym zywym o INNYM numerze wygladalby na jednoznaczny, a nie jest.
  it('produkt zniknięty ze sklepu też wraca — jego numer nadal istnieje', () => {
    const a = wzorO('Ewakuacja');
    const p = produktO(a, { sku: 'PD10' });
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run('2026-08-01', p);
    expect(produktyWzorow(db, [a])).toHaveLength(1);
  });

  it('pusta lista wzorów oddaje pusto, bez zapytania o wszystko', () => {
    const a = wzorO('Ewakuacja');
    produktO(a, { sku: 'PD10' });
    expect(produktyWzorow(db, [])).toEqual([]);
  });
});

// ================================================================================
// EKRAN (web/routes/magazyn.js + magazyn-przejecie.ejs)
// ================================================================================

describe('POST /magazyn/przejmij-podglad', () => {
  it('pokazuje numer do przejęcia razem ze wzorem', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PRO-NIEUPOWAZN-168' });
    const r = await podglad(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(wierszPozycji(r.body, 'Ewakuacja')).toContain('PRO-NIEUPOWAZN-168');
  });

  // ⚠️⚠️ PODGLAD NICZEGO NIE ZAPISUJE — jest osobna trasa wlasnie po to, zeby „przejmij"
  // nie dalo sie wywolac przez pomylke w polu formularza.
  it('nie zapisuje ANI JEDNEGO numeru', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    await podglad(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBeNull();
  });

  it('puste zaznaczenie odmawia i nic nie pokazuje', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    const r = await podglad(serwer(), {});
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie zaznaczono/i);
    expect(wiersz(id).sku).toBeNull();
  });

  it('bez nagłówka źródła odmawia i nic nie zapisuje', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) }, authBezZrodla);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(wiersz(id).sku).toBeNull();
  });

  it('bez podpiętego sklepu zakładka odmawia', async () => {
    const r = await podglad(serwer(null), { zaznaczone: '1' });
    expect(r.statusCode).toBe(503);
  });

  it('rozbieżność jest widoczna przy wzorze, a przycisk zapisu nie obejmuje tej pozycji', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PRO-EV-118', kanal: 'pro' });
    produktO(id, { sku: 'PD10', kanal: 'szkicownia' });
    const r = await podglad(serwer(), { zaznaczone: String(id) });
    expect(wierszPozycji(r.body, 'Ewakuacja')).toMatch(/różne numery/i);
    // Formularz zatwierdzenia niesie WYLACZNIE numery wzorow gotowych do przejecia.
    expect(r.body).not.toContain(`<input type="hidden" name="zaznaczone" value="${id}">`);
  });

  it('wzór bez numeru w sklepie nie trafia na listę', async () => {
    const zNumerem = wzorO('Ewakuacja');
    const bezNumeru = wzorO('Parking');
    produktO(zNumerem, { sku: 'PD10' });
    produktO(bezNumeru, { sku: null });
    const r = await podglad(serwer(), { zaznaczone: [String(zNumerem), String(bezNumeru)] });
    expect(nazwyNaEkranie(r.body)).toEqual(['Ewakuacja']);
  });
});

describe('wejście z listy magazynu', () => {
  // ⚠️⚠️ TRASA BEZ PRZYCISKU JEST KODEM MARTWYM, a suita swieci wtedy na zielono — ta sama
  // klasa usterki, co zgubiona linia okablowania w bootstrap.js. Ekran przejecia ma byc
  // OSIAGALNY z listy, tym samym formularzem, co hurt i generator (pola wyboru stoja
  // w wierszach tabeli, a formularzy nie wolno zagniezdzac).
  it('lista prowadzi na podgląd przejęcia, nigdy wprost na zapis', async () => {
    wzorO('Ewakuacja');
    const r = await serwer().inject({ method: 'GET', url: '/magazyn', headers: auth });
    expect(r.body).toContain('formaction="/magazyn/przejmij-podglad"');
    expect(r.body).not.toContain('formaction="/magazyn/przejmij-zapisz"');
  });
});

describe('POST /magazyn/przejmij-zapisz', () => {
  it('przejęty numer ląduje w rejestrze', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PRO-NIEUPOWAZN-168' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id).sku).toBe('PRO-NIEUPOWAZN-168');
  });

  // ⚠️⚠️ ZESTAW LICZONY PONOWNIE, ze stanu BIEZACEGO — nigdy przepisany z ekranu. Miedzy
  // podgladem a klknieciem mogl wejsc odczyt katalogow albo drugi operator.
  it('liczy zestaw PONOWNIE: numer zmieniony w lustrze po podglądzie jedzie w nowej postaci', async () => {
    const id = wzorO('Ewakuacja');
    const produkt = produktO(id, { sku: 'PD10' });
    await podglad(serwer(), { zaznaczone: String(id) });
    db.prepare('UPDATE produkty_sklepowe SET sku_sklepu = ? WHERE id = ?').run('PD99', produkt);
    await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBe('PD99');
  });

  // ⚠️ WZOR, KTORY ZDOBYL NUMER MIEDZY PODGLADEM A KLKNIECIEM, nie jest przenumerowywany.
  it('wzór, który w międzyczasie dostał numer, nie jest nadpisywany', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    db.prepare('UPDATE wzory SET sku = ? WHERE id = ?').run('STE-007', id);
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBe('STE-007');
    expect(r.body).toMatch(/ma już numer|nie ruszam/i);
  });

  // ⚠️⚠️ KOLIZJA WSTRZYMUJE CALOSC — ta sama zasada, co w generatorze SKU. Polowicznie
  // ponumerowany katalog jest gorszy niz odmowa.
  it('kolizja wstrzymuje CAŁY zapis, także pozycje bezkolizyjne', async () => {
    const a = wzorO('Ewakuacja');
    const b = wzorO('Parking');
    wzorO('Zakazy', { sku: 'PD10' });
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    const r = await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)] });
    expect(r.statusCode).toBe(400);
    expect(wiersz(a).sku).toBeNull();
    expect(wiersz(b).sku).toBeNull();
  });

  // MILCZENIE straznika kolizji: bez kolizji oba wzory dostaja numer.
  it('bez kolizji przechodzą wszystkie zaznaczone wzory', async () => {
    const a = wzorO('Ewakuacja');
    const b = wzorO('Parking');
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)] });
    expect([wiersz(a).sku, wiersz(b).sku]).toEqual(['PD10', 'PD11']);
  });

  it('rozbieżność nie zapisuje NICZEGO dla swojego wzoru, ale nie blokuje reszty', async () => {
    const sporny = wzorO('Ewakuacja');
    const czysty = wzorO('Parking');
    produktO(sporny, { sku: 'PRO-EV-118', kanal: 'pro' });
    produktO(sporny, { sku: 'PD10', kanal: 'szkicownia' });
    produktO(czysty, { sku: 'PD11' });
    await zatwierdz(serwer(), { zaznaczone: [String(sporny), String(czysty)] });
    expect(wiersz(sporny).sku).toBeNull();
    expect(wiersz(czysty).sku).toBe('PD11');
  });

  it('po zapisie zostaje ekran wyniku, bez przekierowania', async () => {
    const id = wzorO('Ewakuacja');
    produktO(id, { sku: 'PD10' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(sekcja(r.body, 'przejecie-pozycje')).toContain('PD10');
  });
});
