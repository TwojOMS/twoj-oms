import { describe, it, expect } from 'vitest';
import { przejeciaZeSklepu } from '../../src/domena/przejecie-sku.js';

describe('przejeciaZeSklepu', () => {
  const W = (id, nazwa, sku = null) => ({ id, nazwa, sku });
  const P = (karta_id, sku, kanal = 'pro', nazwa = 'Produkt') => ({
    karta_id,
    sku_sklepu: sku,
    kanal,
    nazwa,
    produkt_id: '900',
    wariant_id: '',
  });

  it('karta bez naszego numeru przejmuje numer swojego produktu', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PP-001')], null);
    expect(p.sku).toBe('PP-001');
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
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PP-118', 'pro'), P(1, 'PD10', 'polnoc')], null);
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/różne numery/i);
    // Oba numery MUSZA byc widoczne — „rozbieznosc" bez pokazania czego nie da sie rozstrzygnac.
    expect(p.uwaga).toContain('PP-118');
    expect(p.uwaga).toContain('PD10');
  });

  // MILCZENIE tego samego straznika: ten sam numer w dwoch sklepach to JEDNA odpowiedz.
  it('ten sam numer w dwóch kanałach jest jedną odpowiedzią, nie rozbieżnością', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10', 'pro'), P(1, 'PD10', 'polnoc')], null);
    expect(p.sku).toBe('PD10');
    expect(p.zla).toBe(false);
  });

  // ⚠️ „PD10" i „pd10" to DLA SKLEPU jeden numer, a dla naszej kolumny (UNIQUE BINARY) dwa.
  // Ktory z nich jest prawda, wie wylacznie czlowiek.
  it('numery różniące się WYŁĄCZNIE wielkością liter też idą do człowieka', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10', 'pro'), P(1, 'pd10', 'polnoc')], null);
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
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')], new Map([['PD10', 'karta „Dąbek" (#7)']]));
    expect(p.sku).toBeNull();
    expect(p.zla).toBe(true);
    expect(p.uwaga).toMatch(/zajęt/i);
    expect(p.uwaga).toContain('Dąbek');
  });

  // ⚠️ POROWNANIE NIECZULE NA WIELKOSC LITER: baza (BINARY) przepuscilaby „pd10" obok „PD10",
  // a sklep odbilby je jako duplikat. Ostrozniej znaczy tutaj WIECEJ wykrytych kolizji.
  it('zajęty numer rozpoznajemy bez względu na wielkość liter', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')], new Map([['pd10', 'karta „Dąbek" (#7)']]));
    expect(p.zla).toBe(true);
  });

  // MILCZENIE straznika kolizji: numer, ktorego nikt inny nie ma, przechodzi.
  it('numer wolny w rejestrze nie jest kolizją', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10')], new Map([['PLC-001', 'karta „Dąbek" (#7)']]));
    expect(p.zla).toBe(false);
    expect(p.sku).toBe('PD10');
  });

  // ⚠️⚠️ DWA KARTY PO TEN SAM NUMER. Baza przyjmie „PD10" i „pd10" jako rozne, a sklep nie —
  // wiec obie pozycje musza wrocic OZNACZONE, a nie jedna „wolna" i jedna kolizyjna.
  it('dwa karty po ten sam numer to kolizja po OBU stronach', () => {
    const wynik = przejeciaZeSklepu([W(1, 'Bursztyn'), W(2, 'Dąbek')], [P(1, 'PD10'), P(2, 'pd10')], null);
    expect(wynik.map((p) => p.zla)).toEqual([true, true]);
    expect(wynik[0].uwaga).toContain('Dąbek');
    expect(wynik[1].uwaga).toContain('Bursztyn');
  });

  it('dwa karty po różne numery przechodzą oba', () => {
    const wynik = przejeciaZeSklepu([W(1, 'Bursztyn'), W(2, 'Dąbek')], [P(1, 'PD10'), P(2, 'PD11')], null);
    expect(wynik.map((p) => p.sku)).toEqual(['PD10', 'PD11']);
    expect(wynik.map((p) => p.zla)).toEqual([false, false]);
  });

  // ⚠️ POWTARZALNOSC: kolejnosc wierszy z bazy zalezy od planu zapytania, a czlowiek ma
  // zobaczyc ten sam ekran przy podgladzie i przy zatwierdzeniu.
  it('kolejność jest alfabetyczna, nie taka jak w wejściu', () => {
    const wynik = przejeciaZeSklepu([W(2, 'Lampy podłogowe'), W(1, 'Bursztyn')], [P(1, 'PD10'), P(2, 'PD11')], null);
    expect(wynik.map((p) => p.nazwa)).toEqual(['Bursztyn', 'Lampy podłogowe']);
  });

  it('ta sama karta podana dwa razy daje jedną pozycję', () => {
    const wynik = przejeciaZeSklepu([W(1, 'Bursztyn'), W(1, 'Bursztyn')], [P(1, 'PD10')], null);
    expect(wynik).toHaveLength(1);
  });

  it('źródło numeru jest częścią odpowiedzi', () => {
    const [p] = przejeciaZeSklepu([W(1, 'Bursztyn')], [P(1, 'PD10', 'polnoc', 'Lampka')], null);
    expect(p.zrodlo).toContain('polnoc');
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
