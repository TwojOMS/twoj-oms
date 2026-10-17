import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  utworzKarte, zapiszProduktSklepowy, powiazProdukt, zajeteSku, produktyKart,
} from '../../../src/oms/db/magazyn.js';
import { przejeciaZeSklepu } from '../../../src/domena/przejecie-sku.js';

// PRZEJECIE NUMERU ZE SKLEPU — krok, ktorego NIE MA w planie, a bez ktorego zapis do sklepow
// nadpisywalby TOZSAMOSC produktow.
//
// PO CO TO ISTNIEJE (zmierzone na produkcji 2026-08-12): 278 kart — czwarta czesc katalogu —
// nie ma NASZEGO numeru, ale ich produkt ma WLASNY numer w sklepie („LMP-NIEUPOWAZN-168",
// „PD10"). Generator SKU ich nie przejmuje: poprawnie nie wydaje numeru zajetego, ale zostawia
// ROZBIEZNOSC — rejestr milczy, sklep ma numer. Gdyby potem pojechal zapis, nadpisalby numer
// bedacy tozsamoscia produktu.
//
// ⚠️⚠️ CZTERY RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) przejmujemy WYLACZNIE numer, ktory JUZ JEST w sklepie — nic nie wymyslamy;
//   (2) karta powiazany z produktami o ROZNYCH numerach NIE MA jednej poprawnej odpowiedzi
//       i ma trafic do czlowieka, a nie do zapisu;
//   (3) porownanie NIECZULE NA WIELKOSC LITER — `karty.sku` ma UNIQUE typu BINARY, wiec
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

const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });

/** Produkt w lustrze, powiazany z kartą. Oddaje id wiersza lustra. */
function produktO(kartaId, { kanal = 'pro', produkt_id = null, sku = null, nazwa = 'Produkt' } = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produkt_id ?? `p${Math.random().toString(36).slice(2, 9)}`,
    wariant_id: '',
    nazwa,
    sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  if (kartaId) powiazProdukt(db, id, kartaId);
  return id;
}

const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

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

/** Wiersz JEDNEJ karty z tabeli przejecia — sam wiersz, bez reszty sekcji. */
function wierszPozycji(body, nazwa) {
  const znacznik = `<div class="nazwa-karty">${nazwa}</div>`;
  const w = sekcja(body, 'przejecie-pozycje').split('<tr').find((t) => t.includes(znacznik));
  if (!w) throw new Error(`W podgladzie nie ma karty „${nazwa}"`);
  return w;
}

const nazwyNaEkranie = (body) => [...sekcja(body, 'przejecie-pozycje')
  .matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);

// ================================================================================
// REGULA (domain/przejecie-sku.js)
// ================================================================================

describe('przejeciaZeSklepu', () => {
  const W = (id, nazwa, sku = null) => ({ id, nazwa, sku });
  const P = (karta_id, sku, kanal = 'pro', nazwa = 'Produkt') => ({
    karta_id, sku_sklepu: sku, kanal, nazwa, produkt_id: '900', wariant_id: '',
  });

  it('karta bez naszego numeru przejmuje numer swojego produktu', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'LMP-NIEUPOWAZN-168')], null);
    expect(p.sku).toBe('LMP-NIEUPOWAZN-168');
    expect(p.zla).toBe(false);
  });

  // ⚠️ MILCZENIE STRAZNIKA „ma juz numer": karta BEZ numeru ma sie pojawic (test wyzej),
  // a Z numerem — nigdy. Numer raz nadany jest tozsamoscia produktu.
  it('karta, która ma już nasz numer, nie jest ruszana', () => {
    expect(przejeciaZeSklepu([W(1, 'Bursztyn', 'PLC-001')], [P(1, 'PD10')], null)).toEqual([]);
  });

  it('sam napis z odstępów w naszym SKU to brak numeru, a nie numer', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn', '   ')], [P(1, 'PD10')], null);
    expect(p.sku).toBe('PD10');
  });

  it('karta, której produkty nie mają numeru w sklepie, nie ma czego przejąć', () => {
    expect(przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, null), P(1, '   ')], null)).toEqual([]);
  });

  it('karta bez ani jednego powiązanego produktu nie ma czego przejąć', () => {
    expect(przejeciaZeSklepu([W(1, 'Bursztyn')], [], null)).toEqual([]);
  });

  // ⚠️⚠️ NAJWAZNIEJSZA PARA W TEJ SUICIE. Karta powiazany z produktami o ROZNYCH numerach nie
  // ma jednej poprawnej odpowiedzi — panel nie ma prawa wybierac za czlowieka.
  it('produkty o RÓŻNYCH numerach nie dają propozycji, tylko trafiają do człowieka', () => {
    const [p] = przejeciaZeSklepu(
      [W(1, 'Bursztyn')],
      [P(1, 'LMP-PLA-118', 'pro'), P(1, 'PD10', 'szkicownia')],
      null,
    );
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/różne numery/i);
    // Oba numery MUSZA byc widoczne — „rozbieznosc" bez pokazania czego nie da sie rozstrzygnac.
    expect(p.uwaga).toContain('LMP-PLA-118');
    expect(p.uwaga).toContain('PD10');
  });

  // MILCZENIE tego samego straznika: ten sam numer w dwoch sklepach to JEDNA odpowiedz.
  it('ten sam numer w dwóch kanałach jest jedną odpowiedzią, nie rozbieżnością', () => {
    const [p] = przejeciaZeSklepu(
      [W(1, 'Bursztyn')],
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
      [W(1, 'Bursztyn')],
      [P(1, 'PD10', 'pro'), P(1, 'pd10', 'szkicownia')],
      null,
    );
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
  });

  it('puste numery pozostałych produktów nie robią rozbieżności', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, null), P(1, 'PD10'), P(1, '  ')], null);
    expect(p.sku).toBe('PD10');
    expect(p.zla).toBe(false);
  });

  it('odstępy wokół numeru w sklepie są obcinane, a nie robią rozbieżności', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, ' PD10 '), P(1, 'PD10')], null);
    expect(p.sku).toBe('PD10');
  });

  it('produkt CUDZEGO karty nie jest źródłem numeru', () => {
    expect(przejeciaZeSklepu([W(1, 'Bursztyn')], [P(2, 'PD10')], null)).toEqual([]);
  });

  // ⚠️ KOLIZJA Z NUMEREM ZAJETYM GDZIE INDZIEJ. Przejety numer laduje w `karty.sku`,
  // wiec musi byc wolny takze w NASZYM rejestrze.
  it('numer zajęty przez inną kartę jest kolizją, nie propozycją', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')],
      new Map([['PD10', 'karta „Dąbek" (#7)']]));
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/zajęt/i);
    expect(p.uwaga).toContain('Dąbek');
  });

  // ⚠️ POROWNANIE NIECZULE NA WIELKOSC LITER: baza (BINARY) przepuscilaby „pd10" obok „PD10",
  // a sklep odbilby je jako duplikat. Ostrozniej znaczy tutaj WIECEJ wykrytych kolizji.
  it('zajęty numer rozpoznajemy bez względu na wielkość liter', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')],
      new Map([['pd10', 'karta „Dąbek" (#7)']]));
    expect(p.zla).toBe(true);
  });

  // MILCZENIE straznika kolizji: numer, ktorego nikt inny nie ma, przechodzi.
  it('numer wolny w rejestrze nie jest kolizją', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')],
      new Map([['PLC-001', 'karta „Dąbek" (#7)']]));
    expect(p.zla).toBe(false);
    expect(p.sku).toBe('PD10');
  });

  // ⚠️⚠️ DWA KARTY PO TEN SAM NUMER. Baza przyjmie „PD10" i „pd10" jako rozne, a sklep nie —
  // wiec obie pozycje musza wrocic OZNACZONE, a nie jedna „wolna" i jedna kolizyjna.
  it('dwa karty po ten sam numer to kolizja po OBU stronach', () => {
    const wynik = przejeciaZeSklepu(
      [W(1, 'Bursztyn'), W(2, 'Dąbek')],
      [P(1, 'PD10'), P(2, 'pd10')],
      null,
    );
    expect(wynik.map((p) => p.zla)).toEqual([true, true]);
    expect(wynik[0].uwaga).toContain('Dąbek');
    expect(wynik[1].uwaga).toContain('Bursztyn');
  });

  it('dwa karty po różne numery przechodzą oba', () => {
    const wynik = przejeciaZeSklepu(
      [W(1, 'Bursztyn'), W(2, 'Dąbek')],
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
      [W(2, 'Lampy podłogowe'), W(1, 'Bursztyn')],
      [P(1, 'PD10'), P(2, 'PD11')],
      null,
    );
    expect(wynik.map((p) => p.nazwa)).toEqual(['Bursztyn', 'Lampy podłogowe']);
  });

  it('ta sama karta podana dwa razy daje jedną pozycję', () => {
    const wynik = przejeciaZeSklepu([W(1, 'Bursztyn'), W(1, 'Bursztyn')], [P(1, 'PD10')], null);
    expect(wynik).toHaveLength(1);
  });

  it('źródło numeru jest częścią odpowiedzi', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10', 'szkicownia', 'Lampka')], null);
    expect(p.zrodlo).toContain('szkicownia');
    expect(p.zrodlo).toContain('Lampka');
  });

  it('brak kart i brak produktów oddaje pustą listę, a nie wyjątek', () => {
    expect(przejeciaZeSklepu(null, null, null)).toEqual([]);
  });

  // ⚠️⚠️ ROZBIEZNOSC I KOLIZJA TO DWIE ROZNE ODPOWIEDZI, a nie dwa odcienie tej samej.
  // Rozbieznosc znaczy „nie wiem, ktory numer" i dotyczy JEDNEJ karty. Kolizja znaczy „ten
  // numer jest czyjas tozsamoscia" i wstrzymuje CALY zapis (tak jak w generatorze SKU) —
  // wiec trasa musi je rozroznic, a jedynym miejscem, ktore je zna, jest ta regula.
  it('rodzaj rozróżnia rozbieżność od kolizji i od pozycji gotowej', () => {
    const gotowa = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10')], null)[0];
    const rozne = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10'), P(1, 'PD11')], null)[0];
    const zajeta = przejeciaZeSklepu([W(1, 'A')], [P(1, 'PD10')], new Map([['PD10', 'gdzieś']]))[0];
    const spor = przejeciaZeSklepu([W(1, 'A'), W(2, 'B')], [P(1, 'PD10'), P(2, 'PD10')], null);
    expect([gotowa.rodzaj, rozne.rodzaj, zajeta.rodzaj]).toEqual(['gotowe', 'rozbieznosc', 'kolizja']);
    // Spor dwoch kart o jeden numer JEST kolizja — kosztem jest ten sam co przy zajetym:
    // numer w sklepie nalezy do jednego produktu.
    expect(spor.map((p) => p.rodzaj)).toEqual(['kolizja', 'kolizja']);
  });
});

// ================================================================================
// ZAPYTANIE (db/magazyn.js) — numery zajete POZA produktami tych kart
// ================================================================================

describe('zajeteSku z pominięciem produktów wskazanych kart', () => {
  // ⚠️⚠️ BEZ TEGO POMINIECIA PRZEJECIE NIE DZIALALOBY NIGDY: numer, ktory chcemy przejac,
  // ZYJE w lustrze, wiec `zajeteSku` widzi go jako zajety — przez produkt TEJ SAMEJ karty.
  it('numer własnego produktu karty nie wraca jako zajęty', () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    expect([...zajeteSku(db, { pomijajProduktyKart: [id] }).keys()]).toEqual([]);
  });

  // MILCZENIE tego samego straznika: bez pominiecia numer JEST zajety — i tak ma byc,
  // bo generator SKU liczy na to, ze o numerach ze sklepow dowie sie stad.
  it('bez pominięcia ten sam numer wraca jako zajęty', () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    expect(zajeteSku(db).has('PD10')).toBe(true);
  });

  it('numer produktu INNEJ karty wraca jako zajęty mimo pominięcia', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(b, { sku: 'PD11' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PD11')).toBe(true);
  });

  it('numer produktu NIEPOWIĄZANEGO z żadnym kartą wraca jako zajęty', () => {
    const a = kartaO('Bursztyn');
    produktO(null, { sku: 'PD12' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PD12')).toBe(true);
  });

  it('nasze numery z rejestru wracają jako zajęte mimo pominięcia produktów', () => {
    const a = kartaO('Bursztyn');
    kartaO('Dąbek', { sku: 'PLC-001' });
    expect(zajeteSku(db, { pomijajProduktyKart: [a] }).has('PLC-001')).toBe(true);
  });

  it('śmieć zamiast numeru karty nie trafia do SQL-a i nie psuje odczytu', () => {
    const a = kartaO('Bursztyn');
    produktO(a, { sku: 'PD10' });
    expect(zajeteSku(db, { pomijajProduktyKart: ["1); DROP TABLE karty_produktow; --"] }).has('PD10'))
      .toBe(true);
  });
});

describe('produktyKart', () => {
  it('oddaje produkty WIELU kart naraz, z numerem karty przy każdym', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    const wynik = produktyKart(db, [a, b]);
    expect(wynik.map((p) => [p.karta_id, p.sku_sklepu]).sort())
      .toEqual([[a, 'PD10'], [b, 'PD11']].sort());
  });

  it('produkt CUDZEGO karty nie wchodzi do wyniku', () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(b, { sku: 'PD11' });
    expect(produktyKart(db, [a])).toEqual([]);
  });

  // ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU NADAL TRZYMA SWOJ NUMER — inaczej karta z jednym produktem
  // wycofanym i jednym zywym o INNYM numerze wygladalby na jednoznaczny, a nie jest.
  it('produkt zniknięty ze sklepu też wraca — jego numer nadal istnieje', () => {
    const a = kartaO('Bursztyn');
    const p = produktO(a, { sku: 'PD10' });
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run('2026-08-01', p);
    expect(produktyKart(db, [a])).toHaveLength(1);
  });

  it('pusta lista kart oddaje pusto, bez zapytania o wszystko', () => {
    const a = kartaO('Bursztyn');
    produktO(a, { sku: 'PD10' });
    expect(produktyKart(db, [])).toEqual([]);
  });
});

// ================================================================================
// EKRAN (web/routes/magazyn.js + magazyn-przejecie.ejs)
// ================================================================================

describe('POST /magazyn/przejmij-podglad', () => {
  it('pokazuje numer do przejęcia razem ze kartą', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'LMP-NIEUPOWAZN-168' });
    const r = await podglad(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(wierszPozycji(r.body, 'Bursztyn')).toContain('LMP-NIEUPOWAZN-168');
  });

  // ⚠️⚠️ PODGLAD NICZEGO NIE ZAPISUJE — jest osobna trasa wlasnie po to, zeby „przejmij"
  // nie dalo sie wywolac przez pomylke w polu formularza.
  it('nie zapisuje ANI JEDNEGO numeru', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    await podglad(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBeNull();
  });

  it('puste zaznaczenie odmawia i nic nie pokazuje', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    const r = await podglad(serwer(), {});
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie zaznaczono/i);
    expect(wiersz(id).sku).toBeNull();
  });

  it('bez nagłówka źródła odmawia i nic nie zapisuje', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) }, authBezZrodla);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(wiersz(id).sku).toBeNull();
  });

  it('bez podpiętego sklepu zakładka odmawia', async () => {
    const r = await podglad(serwer(null), { zaznaczone: '1' });
    expect(r.statusCode).toBe(503);
  });

  it('rozbieżność jest widoczna przy karcie, a przycisk zapisu nie obejmuje tej pozycji', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'LMP-PLA-118', kanal: 'pro' });
    produktO(id, { sku: 'PD10', kanal: 'szkicownia' });
    const r = await podglad(serwer(), { zaznaczone: String(id) });
    expect(wierszPozycji(r.body, 'Bursztyn')).toMatch(/różne numery/i);
    // Formularz zatwierdzenia niesie WYLACZNIE numery kart gotowych do przejecia.
    expect(r.body).not.toContain(`<input type="hidden" name="zaznaczone" value="${id}">`);
  });

  it('karta bez numeru w sklepie nie trafia na listę', async () => {
    const zNumerem = kartaO('Bursztyn');
    const bezNumeru = kartaO('Dąbek');
    produktO(zNumerem, { sku: 'PD10' });
    produktO(bezNumeru, { sku: null });
    const r = await podglad(serwer(), { zaznaczone: [String(zNumerem), String(bezNumeru)] });
    expect(nazwyNaEkranie(r.body)).toEqual(['Bursztyn']);
  });
});

describe('wejście z listy magazynu', () => {
  // ⚠️⚠️ TRASA BEZ PRZYCISKU JEST KODEM MARTWYM, a suita swieci wtedy na zielono — ta sama
  // klasa usterki, co zgubiona linia okablowania w bootstrap.js. Ekran przejecia ma byc
  // OSIAGALNY z listy, tym samym formularzem, co hurt i generator (pola wyboru stoja
  // w wierszach tabeli, a formularzy nie wolno zagniezdzac).
  it('lista prowadzi na podgląd przejęcia, nigdy wprost na zapis', async () => {
    kartaO('Bursztyn');
    const r = await serwer().inject({ method: 'GET', url: '/magazyn', headers: auth });
    expect(r.body).toContain('formaction="/magazyn/przejmij-podglad"');
    expect(r.body).not.toContain('formaction="/magazyn/przejmij-zapisz"');
  });
});

describe('POST /magazyn/przejmij-zapisz', () => {
  it('przejęty numer ląduje w rejestrze', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'LMP-NIEUPOWAZN-168' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id).sku).toBe('LMP-NIEUPOWAZN-168');
  });

  // ⚠️⚠️ ZESTAW LICZONY PONOWNIE, ze stanu BIEZACEGO — nigdy przepisany z ekranu. Miedzy
  // podgladem a klknieciem mogl wejsc odczyt katalogow albo drugi operator.
  it('liczy zestaw PONOWNIE: numer zmieniony w lustrze po podglądzie jedzie w nowej postaci', async () => {
    const id = kartaO('Bursztyn');
    const produkt = produktO(id, { sku: 'PD10' });
    await podglad(serwer(), { zaznaczone: String(id) });
    db.prepare('UPDATE produkty_sklepowe SET sku_sklepu = ? WHERE id = ?').run('PD99', produkt);
    await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBe('PD99');
  });

  // ⚠️ KARTA, KTORA ZDOBYLA NUMER MIEDZY PODGLADEM A KLIKNIECIEM, nie jest przenumerowywana.
  it('karta, która w międzyczasie dostała numer, nie jest nadpisywana', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    db.prepare('UPDATE karty_produktow SET sku = ? WHERE id = ?').run('PLC-007', id);
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(wiersz(id).sku).toBe('PLC-007');
    expect(r.body).toMatch(/ma już numer|nie ruszam/i);
  });

  // ⚠️⚠️ KOLIZJA WSTRZYMUJE CALOSC — ta sama zasada, co w generatorze SKU. Polowicznie
  // ponumerowany katalog jest gorszy niz odmowa.
  it('kolizja wstrzymuje CAŁY zapis, także pozycje bezkolizyjne', async () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    kartaO('Lampy podłogowe', { sku: 'PD10' });
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    const r = await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)] });
    expect(r.statusCode).toBe(400);
    expect(wiersz(a).sku).toBeNull();
    expect(wiersz(b).sku).toBeNull();
  });

  // MILCZENIE straznika kolizji: bez kolizji oba karty dostaja numer.
  it('bez kolizji przechodzą wszystkie zaznaczone karty', async () => {
    const a = kartaO('Bursztyn');
    const b = kartaO('Dąbek');
    produktO(a, { sku: 'PD10' });
    produktO(b, { sku: 'PD11' });
    await zatwierdz(serwer(), { zaznaczone: [String(a), String(b)] });
    expect([wiersz(a).sku, wiersz(b).sku]).toEqual(['PD10', 'PD11']);
  });

  it('rozbieżność nie zapisuje NICZEGO dla swojej karty, ale nie blokuje reszty', async () => {
    const sporny = kartaO('Bursztyn');
    const czysty = kartaO('Dąbek');
    produktO(sporny, { sku: 'LMP-PLA-118', kanal: 'pro' });
    produktO(sporny, { sku: 'PD10', kanal: 'szkicownia' });
    produktO(czysty, { sku: 'PD11' });
    await zatwierdz(serwer(), { zaznaczone: [String(sporny), String(czysty)] });
    expect(wiersz(sporny).sku).toBeNull();
    expect(wiersz(czysty).sku).toBe('PD11');
  });

  it('po zapisie zostaje ekran wyniku, bez przekierowania', async () => {
    const id = kartaO('Bursztyn');
    produktO(id, { sku: 'PD10' });
    const r = await zatwierdz(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(sekcja(r.body, 'przejecie-pozycje')).toContain('PD10');
  });
});
