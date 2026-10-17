// Zapytania magazynu: lustro sklepow (`produkty_sklepowe`) i nasz rejestr kart (`karty`).
//
// Na tej warstwie stoi caly modul — odczyt katalogow, tworzenie kart, lista i filtry —
// wiec kazda cicha usterka rozejdzie sie po wszystkim. Trzy rzeczy, ktore ten plik chroni:
//   (1) POWIAZANIE karty z produktem jest RECZNA PRACA wlasciciela i nie ma prawa zginac
//       przy odczycie sklepu (patrz `zapiszProduktSklepowy`);
//   (2) nazwa kolumny sortowania i nazwa kolumny zapisu nie moga trafic do SQL-a
//       z zapytania HTTP (biale listy nizej — parametru w `ORDER BY` zwiazac sie nie da);
//   (3) filtr, ktorego nie rozumiemy, NIE POSZERZA zbioru (patrz `warunkiKart`).
import { PACZKOMAT_WARTOSCI, czyPaczkomat } from '../../domena/paczkomat.js';
import { wymagajListyKanalow } from '../../domena/lista-kanalow.js';
import { kartaZProduktu, powodPominiecia } from '../../domena/karta-z-produktu.js';

const teraz = () => new Date().toISOString();

// ⚠️ `changes` i `lastInsertRowid` bywaja BigIntem. Oddany dalej rozjechalby sie
// z liczbami (`1n !== 1`) dokladnie w tych miejscach, gdzie porownujemy id karty.
const liczba = (x) => Number(x);

// Identyfikatory sklepowe sa TEKSTEM (patrz komentarz przy `produkty_sklepowe.produkt_id`).
// Konwersja stoi TUTAJ, w jednym miejscu: Woo oddaje liczbe, Allegro napis, a ten sam
// produkt zapisany raz jako 944 i raz jako '944' to dwa wiersze i dwie karty.
const idTekstem = (x) => (x === null || x === undefined ? '' : String(x));

// Kolumny LUSTRA — te, ktore sklep przepisuje przy kazdym odczycie.
//
// ⚠️⚠️ NIE MA TU `karta_id` I NIE WOLNO GO TU DOPISAC. Ta lista idzie wprost do
// `DO UPDATE SET`, wiec kolumna dopisana tutaj bylaby KASOWANA przy kazdym przebiegu
// odczytu — czyli kazde odswiezenie katalogu zrywaloby wszystkie powiazania kart
// z produktami, cala reczna prace wlasciciela, po cichu i bez jednego bledu.
// Z tego samego powodu nie ma tu `zniknal_at`: ta kolumna ma byc ZEROWANA (produkt
// wrocil do sklepu), a nie przepisywana z wejscia.
const KOLUMNY_LUSTRA = [
  'nazwa', 'sku_sklepu', 'cena_gr', 'kategorie_json', 'zdjecia_json', 'adres',
  // ⚠️ ADRES MINIATURY JEST KOLUMNA LUSTRA, nie nasza — sklep, ktory przeliczyl zdjecia
  // na nowo albo zmienil rozmiar miniatury, ma zostac ODWZOROWANY, a nie przemilczany.
  // Stad `DO UPDATE SET`, tak samo jak przy nazwie i cenie. To odroznia te kolumne od
  // `karta_id` i `zniknal_at`, ktorych ta lista dotykac nie moze.
  'miniatura',
  'rozmiar_tekst', 'kategoria_glowna_zrodla', 'opis_zrodlowy', 'status_publikacji',
  // ⚠️ ATRYBUTY WARIANTU SA KOLUMNA LUSTRA, nie nasza. Wlasciciel, ktory przemianowal wartosc
  // atrybutu w sklepie („Mosiądz" → „Mosiadz"), ma zobaczyc nowa wartosc po odczycie —
  // stad `DO UPDATE SET`, tak samo jak przy nazwie i cenie. Zbior kart, ktore juz powstaly,
  // to nie zmienia: `karta_id` tej listy NIE DOTYKA i dotykac nie moze (patrz wyzej).
  'atrybuty_json',
  // PRZ-090: wymiary i waga, ktore podaje sklep (z jednostka) — kolumny lustra, przepisywane przy kazdym odczycie.
  'wymiary_json', 'waga_tekst',
  'odczytane_at',
];

/**
 * Upsert jednego produktu sklepowego po `(kanal, produkt_id, wariant_id)`. Oddaje id wiersza
 * — TEGO SAMEGO przy kazdym kolejnym odczycie tego samego produktu.
 *
 * ⚠️ `wariant_id` normalizowany do pustego napisu. W SQLite NULL-e w UNIQUE sa wzajemnie
 * ROZNE, wiec przy NULL produkt prosty wpadalby do tabeli przy KAZDYM przebiegu odczytu.
 */
export function zapiszProduktSklepowy(db, produkt) {
  const kanal = produkt?.kanal;
  const produktId = idTekstem(produkt?.produkt_id);
  // Sprawdzamy TUTAJ, a nie zostawiamy bazie: `NOT NULL constraint failed` nie mowi,
  // ktory kanal i ktory produkt odczytu sie wysypal, a odczyt idzie po tysiacu wierszy.
  if (!kanal) throw new Error('zapiszProduktSklepowy: brak kanalu');
  if (!produktId) throw new Error(`zapiszProduktSklepowy: brak produkt_id (kanal ${kanal})`);

  const wartosci = [kanal, produktId, idTekstem(produkt.wariant_id)];
  // `?? null` jest istotne: node:sqlite ODMAWIA zwiazania `undefined`, wiec pole, ktorego
  // sklep akurat nie przyslal, wywalaloby caly przebieg zamiast zostawic pusta kolumne.
  for (const k of KOLUMNY_LUSTRA) wartosci.push(produkt[k] ?? null);

  const kolumny = ['kanal', 'produkt_id', 'wariant_id', ...KOLUMNY_LUSTRA];
  const wiersz = db.prepare(
    `INSERT INTO produkty_sklepowe (${kolumny.join(', ')})`
    + ` VALUES (${kolumny.map(() => '?').join(', ')})`
    + ' ON CONFLICT (kanal, produkt_id, wariant_id) DO UPDATE SET '
    + KOLUMNY_LUSTRA.map((k) => `${k} = excluded.${k}`).join(', ')
    // Produkt, ktory wrocil do sklepu, przestaje byc znikniety — inaczej raz oznaczony
    // wiersz zostawalby wycofany na zawsze i cena nie wrocilaby juz do listy.
    + ', zniknal_at = NULL'
    + ' RETURNING id',
  ).get(...wartosci);
  return liczba(wiersz.id);
}

/**
 * Oznacza produkty TEGO kanalu, ktorych biezacy przebieg odczytu nie zobaczyl. Oddaje,
 * ile wierszy oznaczono.
 *
 * ⚠️ NIE KASUJEMY — kasowanie zerwaloby powiazanie z kartą, a karta jest bytem NASZYM
 * i ma przezyc wycofanie produktu ze sprzedazy.
 *
 * ⚠️ Warunek `kanal = ?` jest tu cala izolacja awarii: bez niego przebieg jednego sklepu
 * oznaczalby jako znikniety caly katalog drugiego. `zniknal_at IS NULL` pilnuje, zeby
 * kolejny przebieg nie przestemplowal daty, ktora juz o czyms mowi.
 */
export function oznaczZnikniete(db, kanal, odczytaneAt) {
  const r = db.prepare(
    'UPDATE produkty_sklepowe SET zniknal_at = ?'
    + ' WHERE kanal = ? AND odczytane_at < ? AND zniknal_at IS NULL',
  ).run(odczytaneAt, kanal, odczytaneAt);
  return liczba(r.changes);
}

/**
 * Ile produktow TEGO kanalu lustro trzyma za ZYWE (bez `zniknal_at`).
 *
 * Jedno zapytanie liczace i nic wiecej — sluzy WYLACZNIE hamulcowi pustego odczytu
 * w `services/magazyn-sync.js`, ktory na tej liczbie odroznia „sklep nic nie ma" od „sklep
 * odmowil kodem 200". Osobna funkcja, a nie rozszerzenie `niepowiazaneProdukty`: tamta oddaje
 * WIERSZE i sluzy tworzeniu kart, a hamulec potrzebuje liczby przy KAZDYM przebiegu, takze
 * przy kanale bez ani jednej karty.
 *
 * ⚠️ `zniknal_at IS NULL` jest tu warunkiem NOSNYM. Bez niego kanal wygaszony przed miesiacem
 * (wszystko oznaczone) blokowalby swoj wlasny pusty odczyt na zawsze — a to jest u niego
 * stan ustalony, nie awaria.
 */
export function liczZyweProdukty(db, kanal) {
  const r = db.prepare(
    'SELECT COUNT(*) AS ile FROM produkty_sklepowe WHERE kanal = ? AND zniknal_at IS NULL',
  ).get(kanal);
  return liczba(r.ile);
}

// Biala lista pol karty edytowalnych z panelu. Nazwa kolumny idzie do SQL-a jako TEKST
// (parametrem byc nie moze), wiec to jedyna ochrona przed wstrzyknieciem — i jedyna
// ochrona przed edycja hurtem, ktora „ustawia" pole, o ktorym baza nic nie wie.
const POLA_KARTY = [
  'sku', 'nazwa', 'szerokosc_mm', 'wysokosc_mm', 'kategoria_glowna', 'paczkomat',
  'opis', 'glebokosc_mm', 'waga_g',
];

// Paczkomat ma TRZY stany i pilnuje ich domain/paczkomat.js. Czwarta wartosc w kolumnie
// zepsulaby filtr „bez oznaczenia paczkomatu" — karta z napisem 'moze' nie bylaby ani
// oznaczona, ani nieoznaczona.
const wartoscPola = (pole, wartosc) => (
  pole === 'paczkomat' ? czyPaczkomat({ paczkomat: wartosc }) : (wartosc ?? null)
);

export function utworzKarte(db, karta, { at = teraz() } = {}) {
  if (!karta?.nazwa) throw new Error('utworzKarte: karta bez nazwy');

  const pola = POLA_KARTY.filter((k) => karta[k] !== undefined);
  const kolumny = [...pola, 'utworzony_at', 'zmieniony_at'];
  const wartosci = [...pola.map((k) => wartoscPola(k, karta[k])), at, at];

  const r = db.prepare(
    `INSERT INTO karty_produktow (${kolumny.join(', ')}) VALUES (${kolumny.map(() => '?').join(', ')})`,
  ).run(...wartosci);
  return liczba(r.lastInsertRowid);
}

/**
 * Zapisuje WYLACZNIE wskazane pola karty i stempluje date zmiany.
 *
 * ⚠️ Pole spoza bialej listy konczy sie WYJATKIEM, a nie cichym pominieciem. Ciche
 * pominiecie przy edycji hurtem znaczyloby „zaznaczylem 600 kart, ustawilem kategorie
 * i nic sie nie stalo" — bez jednego komunikatu.
 */
export function zapiszKarte(db, id, zmiany, { at = teraz() } = {}) {
  const pola = Object.keys(zmiany ?? {});
  for (const pole of pola) {
    if (!POLA_KARTY.includes(pole)) throw new Error(`zapiszKarte: nieznane pole „${pole}"`);
  }
  // Pusty zestaw zmian nie ma czego zapisac — i nie ma prawa przestawic `zmieniony_at`,
  // bo nic sie nie zmienilo.
  if (!pola.length) return;

  db.prepare(
    `UPDATE karty_produktow SET ${pola.map((k) => `${k} = ?`).join(', ')}, zmieniony_at = ? WHERE id = ?`,
  ).run(...pola.map((k) => wartoscPola(k, zmiany[k])), at, id);
}

/**
 * Karty o PODANYCH numerach — material edycji hurtem.
 *
 * ⚠️ NUMERY PRZYCHODZA Z ZADANIA HTTP, wiec odsiewamy je TUTAJ, a nie zostawiamy bazie.
 * `Number.isSafeInteger` domyka oba konce: `Number('1e3')` przechodzi przez `isInteger`,
 * a `9999999999999999999999` jest w SQLite FLOATEM i po cichu nie trafia w zaden wiersz.
 *
 * ⚠️ PUSTA LISTA ODDAJE PUSTO. Bramka jest OSTROZNOSCIA NA PRZYSZLOSC, a nie straznikiem,
 * bez ktorego cos dzis przecieka — i tak ma byc opisana. Sprawdzone mutacja (usuniecie tej
 * linii nie zmienia zachowania ani jednego testu): SQLite przyjmuje `IN ()` jako zbior pusty
 * i sam oddaje zero wierszy. Zdanie „bez tego edytowalby caly rejestr" byloby wiec
 * nieprawda — prawdziwym straznikiem pustego zaznaczenia jest odmowa na TRASIE
 * (`HURT_BEZ_ZAZNACZENIA`), i to ona jest przypieta para testow.
 *
 * Bramka zostaje z dwoch powodow: oszczedza `prepare` na zapytaniu, o ktore nie ma sensu
 * pytac, i domyka droge, gdyby ktos kiedys przepisal budowanie warunku tak, ze pusta lista
 * daje BRAK warunku zamiast zbioru pustego.
 *
 * ⚠️ Numery ODRESZTOWANE (`Set`), bo formularz potrafi przyniesc te sama karte dwa razy
 * (dwa pola wyboru o tej samej wartosci), a wtedy plan mialby dwa kroki na jeden wiersz.
 *
 * Kolejnosc alfabetyczna, TA SAMA co na liscie i na ekranie powiazan — podglad ma pokazywac
 * karty w tym porzadku, w ktorym czlowiek ich szuka wzrokiem.
 */
export function kartyPoIdach(db, ids) {
  const numery = [...new Set(
    (ids ?? []).filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number),
  )];
  if (!numery.length) return [];
  return db.prepare(
    `SELECT * FROM karty_produktow WHERE id IN (${numery.map(() => '?').join(', ')})`
    + ' ORDER BY nazwa COLLATE NOCASE ASC, id ASC',
  ).all(...numery).map((w) => ({ ...w }));
}

/**
 * EDYCJA HURTEM: gotowy plan `[{ id, zmiany }]` zapisany w JEDNEJ transakcji.
 * Oddaje liczbe faktycznie zmienionych wierszy.
 *
 * ⚠️⚠️ TRANSAKCJA JEST OBOWIAZKOWA. Czesciowo zapisany zestaw jest GORSZY niz odmowa: blad
 * na trzechsetnej karcie z 645 zostawilby polowe katalogu z nowym wymiarem i polowe ze starym,
 * a ekran nie mialby jak powiedziec, gdzie przebiega granica. Drugie klikniecie „naprawilo by"
 * reszte, wiec rejestr powstalby z dwoch przebiegow i nikt by juz nie wiedzial, ktora karta
 * skad ma wymiar — a z tego wymiaru liczy sie paczka, gabaryt i wymiar w sklepie. To ta sama zasada, co przy
 * `utworzKartyZNiepowiazanych` i `powiazOfertyHurtem`.
 *
 * ⚠️ CALA FUNKCJA JEST SYNCHRONICZNA (zadnego `await`), wiec poller zamowien chodzacy po tym
 * samym polaczeniu nie wejdzie w srodek otwartej transakcji.
 *
 * ⚠️ BIALA LISTA SPRAWDZANA PRZED `BEGIN`, a nie w trakcie: pole, o ktorym baza nic nie wie,
 * ma odmowic CALOSCI, zanim cokolwiek sie zacznie. Wyjatek, a nie ciche pominiecie — ciche
 * znaczyloby „zaznaczylem 600 kart, ustawilem kategorie i nic sie nie stalo", bez slowa.
 *
 * ⚠️ ZEGAR PYTANY RAZ NA PRZEBIEG. 645 kart z jednego klikniecia dostaje JEDEN znacznik —
 * po nim i tylko po nim da sie potem powiedziec „to sa te z tamtego przycisku" i cofnac
 * pomylke masowa.
 */
export function zastosujHurtem(db, plan, { at = teraz() } = {}) {
  const kroki = (plan ?? []).filter((k) => k && Object.keys(k.zmiany ?? {}).length);
  for (const { zmiany } of kroki) {
    for (const pole of Object.keys(zmiany)) {
      if (!POLA_KARTY.includes(pole)) throw new Error(`zastosujHurtem: nieznane pole „${pole}"`);
    }
  }
  // Pusty plan nie otwiera transakcji i nie przestawia zadnej daty — nic sie nie zmienilo.
  if (!kroki.length) return 0;

  // Jedno zapytanie na KSZTALT planu, a nie na wiersz: przy 645 kartach o tym samym
  // komplecie kolumn `prepare` wykonalby sie 645 razy zamiast raz.
  const zapytania = new Map();
  const zapytanie = (pola) => {
    const klucz = pola.join(',');
    if (!zapytania.has(klucz)) {
      zapytania.set(klucz, db.prepare(
        `UPDATE karty_produktow SET ${pola.map((k) => `${k} = ?`).join(', ')}, zmieniony_at = ? WHERE id = ?`,
      ));
    }
    return zapytania.get(klucz);
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    let zmienione = 0;
    for (const { id, zmiany } of kroki) {
      const pola = Object.keys(zmiany);
      const r = zapytanie(pola).run(...pola.map((k) => wartoscPola(k, zmiany[k])), at, id);
      zmienione += liczba(r.changes);
    }
    db.exec('COMMIT');
    return zmienione;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * WSZYSTKIE numery, ktore sa juz czyjas tozsamoscia — nasze i te ZYJACE W SKLEPACH.
 * Oddaje `Map` „numer wielkimi literami" → „skad go znamy".
 *
 * ⚠️⚠️ OBA ZBIORY, I TO JEST CALA TRESC TEJ FUNKCJI. `karty.sku` ma `UNIQUE`, wiec o nasze
 * numery baza upomni sie sama; o 218 numerow zyjacych w sklepach (184 na sklepie B, 115 na
 * sklep A — zmierzone 2026-08-12) NIE UPOMNI SIE NIKT. Numer nadany karcie w panelu
 * jedzie w Zadaniu 15 do sklepu — jesli tam juz jest, to jest CUDZEGO produktu.
 *
 * ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU NADAL TRZYMA SWOJ NUMER (brak warunku `zniknal_at IS NULL`,
 * inaczej niz na liscie magazynu). Wiersz zostaje w lustrze, bo powiazanie ma przezyc
 * wycofanie ze sprzedazy, a produkt potrafi WROCIC — numer oddany w miedzyczasie komus
 * innemu wrocilby wtedy jako duplikat w cudzym sklepie.
 *
 * ⚠️ KLUCZ WIELKIMI LITERAMI, choc `UNIQUE` w SQLite jest czuly na wielkosc (BINARY). Sklep,
 * ktory ma „pd10", odrzuci nasze „PD10" jako duplikat, a nasza baza przepuscilaby oba jako
 * rozne numery. Ostrozniej znaczy tutaj: WIECEJ wykrytych kolizji, nigdy mniej.
 *
 * ⚠️ OPIS ZRODLA JEST CZESCIA ODPOWIEDZI, nie ozdoba. „Numer zajety" bez zdania, PRZEZ CO,
 * nie daje sie z niczym zrobic — a przy 965 wierszach czlowiek nie ma jak tego sam odszukac.
 * Kolejnosc jawna, zeby przy tym samym numerze po obu stronach zrodlo pokazane czlowiekowi
 * bylo POWTARZALNE, a nie zalezne od planu zapytania.
 *
 * ⚠️⚠️ `pomijajProduktyKart` SLUZY WYLACZNIE PRZEJECIU NUMERU ZE SKLEPU
 * (`domain/przejecie-sku.js`) i bez niego tamten ekran nie dzialalby NIGDY: numer, ktory karta
 * ma PRZEJAC, zyje w lustrze — czyli `zajeteSku` widzialoby go jako zajety przez produkt TEGO
 * SAMEJ karty i kazde przejecie odbijaloby sie o wlasne odbicie. Pomijamy WYLACZNIE produkty
 * wskazanych kart; nasze numery z rejestru (`karty.sku`) i wszystkie pozostale produkty
 * zostaja, bo one nadal sa cudza tozsamoscia.
 *
 * ⚠️ GENERATOR SKU WOLA TE FUNKCJE BEZ ARGUMENTU i tak ma zostac: numery WYDAWANE musza omijac
 * takze te ze sklepow. Domyslna pusta lista jest wiec zachowaniem, nie brakiem.
 */
export function zajeteSku(db, { pomijajProduktyKart = [] } = {}) {
  const zajete = new Map();
  const dodaj = (sku, skad) => {
    const klucz = String(sku ?? '').trim().toUpperCase();
    if (klucz && !zajete.has(klucz)) zajete.set(klucz, skad);
  };

  for (const w of db.prepare(
    "SELECT id, nazwa, sku FROM karty_produktow WHERE sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY id",
  ).all()) {
    dodaj(w.sku, `karta „${w.nazwa}" (#${w.id})`);
  }

  // ⚠️ NUMERY KART ODSIEWANE TAK SAMO, JAK W `kartyPoIdach`: identyfikatory przychodza
  // z zadania HTTP, a `IN` sklejane jest z tekstu. Wartosc, ktora nie jest bezpieczna liczba
  // calkowita, nie ma prawa dojsc do SQL-a.
  const pomijane = [...new Set(
    (pomijajProduktyKart ?? [])
      .filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number),
  )];
  // ⚠️ `karta_id IS NULL OR karta_id NOT IN (...)`: produkt NIEPOWIAZANY z zadna karta ma
  // zostac. `NOT IN` na kolumnie nullowalnej sam z siebie odsiewa NULL-e (porownanie z NULL
  // nie jest prawdziwe), czyli bez tego warunku znikneloby 1241 numerow niepowiazanych.
  const gdzie = pomijane.length
    ? ` AND (karta_id IS NULL OR karta_id NOT IN (${pomijane.map(() => '?').join(', ')}))`
    : '';

  for (const p of db.prepare(
    'SELECT kanal, nazwa, sku_sklepu FROM produkty_sklepowe'
    + " WHERE sku_sklepu IS NOT NULL AND TRIM(sku_sklepu) <> ''"
    + `${gdzie} ORDER BY kanal, id`,
  ).all(...pomijane)) {
    dodaj(p.sku_sklepu, `${p.kanal} — „${p.nazwa}"`);
  }

  return zajete;
}

/**
 * NADANIE SKU HURTEM: gotowy plan `[{ id, sku }]` zapisany w JEDNEJ transakcji.
 * Oddaje `{ nadane: [id], nieaktualne: [id] }`.
 *
 * ⚠️⚠️ WARUNEK „SKU JEST PUSTE" W SAMYM `UPDATE` TO STRAZNIK STANU NIEAKTUALNEGO, nie ozdoba
 * i nie druga kopia reguly z generatora. Regula wyzej rozstrzyga, KTORE karty numerowac;
 * ten warunek pilnuje, zeby miedzy jednym a drugim NIKT nie stracil numeru, ktory zdobyl
 * w miedzyczasie z karty albo z drugiej karty przegladarki. Numer raz nadany jedzie do sklepu
 * i staje sie tozsamoscia produktu — ciche przenumerowanie jest tu najgorszym mozliwym
 * skutkiem. Karta, ktora „nie weszla", wraca w `nieaktualne` i MA BYC POKAZANA
 * (niezmiennik 4.13a: pominiete wracaja z powodem).
 *
 * ⚠️⚠️ TRANSAKCJA JEST OBOWIAZKOWA. Czesciowo ponumerowany katalog jest GORSZY niz odmowa:
 * blad na trzechsetnej karcie z 965 zostawilby polowe rejestru z numerami, a drugie
 * klikniecie dolozylo by reszte z INNEGO ciagu — i nikt by juz nie wiedzial, ktora karta
 * skad ma numer. To ta sama zasada, co przy `zastosujHurtem` i `utworzKartyZNiepowiazanych`.
 *
 * ⚠️ DUPLIKATU W PLANIE NIE SPRAWDZAMY TUTAJ I JEST TO DECYZJA: kolizje wykrywa generator
 * PRZED pokazaniem podgladu (razem z numerami zyjacymi w sklepach, o ktorych baza nic nie
 * wie), a ostatnia linia obrony jest `UNIQUE` na kolumnie — odbity duplikat cofa CALY zapis.
 * Trzecia bramka w srodku dodalaby wylacznie trzecie miejsce do rozjechania sie.
 *
 * ⚠️ CALA FUNKCJA JEST SYNCHRONICZNA (zadnego `await`), wiec poller zamowien chodzacy po tym
 * samym polaczeniu nie wejdzie w srodek otwartej transakcji. Zegar pytany RAZ NA PRZEBIEG:
 * 965 numerow z jednego klikniecia dostaje JEDEN znacznik — po nim i tylko po nim da sie
 * potem powiedziec „to sa te z tamtego przycisku".
 */
export function nadajSku(db, plan, { at = teraz() } = {}) {
  const kroki = (plan ?? []).filter((k) => k && k.sku !== null && k.sku !== undefined);
  const nadane = [];
  const nieaktualne = [];
  if (!kroki.length) return { nadane, nieaktualne };

  db.exec('BEGIN IMMEDIATE');
  try {
    const zapytanie = db.prepare(
      'UPDATE karty_produktow SET sku = ?, zmieniony_at = ?'
      + " WHERE id = ? AND (sku IS NULL OR TRIM(sku) = '')",
    );
    for (const { id, sku } of kroki) {
      const r = zapytanie.run(sku, at, id);
      (liczba(r.changes) ? nadane : nieaktualne).push(id);
    }
    db.exec('COMMIT');
    return { nadane, nieaktualne };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Wiaze produkt sklepowy z kartą (albo rozlacza, gdy `kartaId` jest pusty).
 *
 * Jedna kolumna zamiast tabeli posredniej — dzieki temu regula „jeden produkt nalezy
 * najwyzej do JEDNEJ karty" wynika z KSZTALTU BAZY.
 *
 * ⚠️ KARTY, KTOREJ NIE MA, PILNUJE `wymagajKarty`, A NIE KLUCZ OBCY. Kolumna `karta_id` doszla migracja
 * addytywna (PRZ-090), a nowego klucza obcego na istniejacej tabeli kontrola migracji nie przepuszcza.
 */
export function powiazProdukt(db, produktSklepowyId, kartaId) {
  if (kartaId !== null && kartaId !== undefined) wymagajKarty(db, kartaId);
  db.prepare('UPDATE produkty_sklepowe SET karta_id = ? WHERE id = ?')
    .run(kartaId ?? null, produktSklepowyId);
}

/** Odmowa powiazania z karta, ktorej nie ma — zamiast cichego wiersza wskazujacego w proznie. */
function wymagajKarty(db, kartaId) {
  if (!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(kartaId)) {
    throw new Error(`Nie ma karty produktu ${kartaId} — powiązanie odrzucone.`);
  }
}

// ⚠️⚠️ CZTERY BRAKI JAKO WYRAZENIA SQL — JEDNA DEFINICJA KAZDEGO, uzywana w CZTERECH
// miejscach naraz: filtr `brak=…`, kolumna `liczba_brakow` wiersza listy, sortowanie 'braki'
// i zliczenia kafli nad tabela. Kafel PROWADZI do listy, wiec druga kopia ktoregokolwiek
// wyrazenia znaczylaby „kafel mowi 217, lista pokazuje 214" — bez jednego bledu i bez
// szansy zgadniecia, ktora liczba klamie.
//
// ⚠️ ALIAS `w.` JEST CZESCIA KONTRAKTU: te wyrazenia wklejamy do OBU zapytan listy, a oba
// nazywaja tabele kart `karty w` (patrz `kartyZKanalami`).
// ⚠️ Z TRIM, tak samo jak `nadajSku` i `bezSku` w `domain/przejecie-sku.js`: SKU z samych
// spacji to brak, nie numer — spojnosc z reszta modulu, inaczej „komplet" tutaj i „nadaj
// numer" na karcie przeczylyby sobie o tym samym karcie.
const BRAK_SKU_SQL = "(w.sku IS NULL OR TRIM(w.sku) = '')";
// Polowiczny wymiar to nadal brak: do ciecia potrzebne sa OBA (niezmiennik 4.23).
const BRAK_WYMIAROW_SQL = '(w.szerokosc_mm IS NULL OR w.wysokosc_mm IS NULL)';
const BRAK_KATEGORII_SQL = "(w.kategoria_glowna IS NULL OR w.kategoria_glowna = '')";
// ⚠️ Wartosci stanow z domain/paczkomat.js interpolowane RAZ przy starcie procesu. To stale
// APLIKACJI, a nie dane z zadania HTTP — i inaczej niz przy dawnym `nieoznaczony()` to
// wyrazenie idzie takze do SELECT-a i do ORDER BY, gdzie parametry zapytania nie siegaja.
// Czwarty stan nadal wymaga zmiany wylacznie w domenie.
const BRAK_PACZKOMATU_SQL = `(w.paczkomat IS NULL OR w.paczkomat NOT IN (${
  [...PACZKOMAT_WARTOSCI].map((v) => `'${v}'`).join(', ')}))`;
const LICZBA_BRAKOW_SQL = `((CASE WHEN ${BRAK_SKU_SQL} THEN 1 ELSE 0 END)`
  + ` + (CASE WHEN ${BRAK_WYMIAROW_SQL} THEN 1 ELSE 0 END)`
  + ` + (CASE WHEN ${BRAK_KATEGORII_SQL} THEN 1 ELSE 0 END)`
  + ` + (CASE WHEN ${BRAK_PACZKOMATU_SQL} THEN 1 ELSE 0 END))`;

// Biala lista sortowania: klucz z adresu → WYRAZENIE SQL. Klucze sa dwojakie, bo widok
// mowi „wysokosc", a schemat „wysokosc_mm" — obie postacie maja dzialac, zeby odnosnik
// z naglowka tabeli nie zalezal od tego, ktora nazwe ktos akurat wpisal.
//
// `NULLIF(...,'')` przy kolumnach tekstowych: pusty napis to ten sam brak co NULL, wiec ma
// wypasc na koniec razem z nim (patrz `NULLS LAST` nizej).
const SORTOWANIE = {
  nazwa: 'w.nazwa COLLATE NOCASE',
  sku: "NULLIF(w.sku, '') COLLATE NOCASE",
  szerokosc: 'w.szerokosc_mm',
  szerokosc_mm: 'w.szerokosc_mm',
  wysokosc: 'w.wysokosc_mm',
  wysokosc_mm: 'w.wysokosc_mm',
  kategoria: "NULLIF(w.kategoria_glowna, '') COLLATE NOCASE",
  kategoria_glowna: "NULLIF(w.kategoria_glowna, '') COLLATE NOCASE",
  paczkomat: 'w.paczkomat',
  // KOLEJKA ROBOTY: malejaco daje na czele karty, przy ktorych jest najwiecej do zrobienia.
  // Wyrazenie NIGDY nie jest NULL-em (suma czterech CASE-ow), wiec `NULLS LAST` nizej jest
  // przy nim martwe, a nie szkodliwe.
  braki: LICZBA_BRAKOW_SQL,
};
const SORTOWANIE_DOMYSLNE = 'nazwa';

// ⚠️ TA SAMA LISTA WYSTAWIONA NA ZEWNATRZ — dla naglowka tabeli magazynu, ktory buduje
// odnosniki sortujace. Druga lista w trasie rozjechalaby sie z ta CICHO: naglowek
// oferowalby klucz, ktorego to zapytanie nie zna, zapytanie wracaloby do sortowania
// domyslnego, a kolumna dalej pokazywalaby sie jako aktywna. Nikt by tego nie zauwazyl
// poza kims, kto sprawdzi kolejnosc wierszy.
export const SORTOWANIE_KART = Object.freeze(Object.keys(SORTOWANIE));

// ⚠️ Znaki wieloznaczne LIKE. Bez ucieczki fraza „%" oddawalaby CALY katalog, a wlasciciel
// czytalby to jako wynik wyszukiwania. `\` jako znak ucieczki deklarujemy w SQL-u (ESCAPE).
const uciekniecieLike = (s) => s.replace(/[\\%_]/gu, (z) => `\\${z}`);

/**
 * Warunki listy kart — budowane RAZ i uzyte w OBU zapytaniach (karty i ich produkty),
 * zeby drugie zapytanie nie mialo szansy rozjechac sie z pierwszym.
 *
 * ⚠️ ZASADA NADRZEDNA: filtr, ktorego nie rozumiemy, oddaje PUSTO, a nie wszystko.
 * Po filtrze braków idzie zaznaczenie calej listy i edycja hurtem — cicho zignorowany
 * filtr znaczylby hurtowa zmiane na calym katalogu zamiast na dwudziestu brakach.
 */
function warunkiKart({ fraza, filtry = {} }) {
  const czesci = ['1 = 1'];
  const params = [];

  const f = String(fraza ?? '').trim();
  if (f) {
    // Wielkosc liter: LIKE w SQLite jest nieczuly na nia w zakresie ASCII. Polskie znaki
    // diakrytyczne pozostaja czule — „Ćma" nie znajdzie sie po „ćma". Swiadome ograniczenie
    // silnika, nie przeoczenie: fraza dziala po ASCII, reszte lapie fragment nazwy.
    czesci.push("(w.nazwa LIKE ? ESCAPE '\\' OR w.sku LIKE ? ESCAPE '\\')");
    const wzorzec = `%${uciekniecieLike(f)}%`;
    params.push(wzorzec, wzorzec);
  }

  // KANAL i ZAKRES CENY opisuja TEN SAM produkt, dlatego siedza w jednym EXISTS: „sklep B od
  // 100 zl" ma nie pokazywac karty, ktora w sklepie B kosztuje 20 zl, a setke przekracza dopiero
  // na Allegro.
  //
  // ⚠️ `zniknal_at IS NULL` — produkt wycofany ze sklepu NIE jest juz obecnoscia w kanale.
  // Wiersz zostaje w bazie (powiazanie ma przezyc), ale jego cena przestaje twierdzic,
  // ze karta da sie tam kupic.
  //
  // ⚠️ ALIAS `pf` (nie `p`!) JEST CZESCIA KONTRAKTU TEGO BUILDERA. `gdzie` z tej funkcji
  // wklejamy do DWOCH zapytan w `kartyZKanalami` — a drugie z nich juz ma wlasny alias `p`
  // (`SELECT p.* FROM produkty_sklepowe p WHERE ... AND p.karta_id IN (SELECT w.id FROM karty_produktow
  // w WHERE ${gdzie})`). Gdyby ten EXISTS uzywal tez `p`, SQLite rozwiazalby go poprawnie
  // (najglebszy zakres wygrywa), wiec dzis dziala — ale to mina: kolejny warunek dopisany
  // tutaj z mysla o „zewnetrznym" `p`, albo usuniety alias z podzapytania, zaczalby po cichu
  // znaczyc co innego, bez bledu skladni i bez czerwonego testu na malych danych.
  const { kanal, cenaOd, cenaDo, kategoria, paczkomat, brak } = filtry;
  if (kanal || cenaOd != null || cenaDo != null) {
    const pod = ['pf.karta_id = w.id', 'pf.zniknal_at IS NULL'];
    if (kanal) { pod.push('pf.kanal = ?'); params.push(kanal); }
    if (cenaOd != null) { pod.push('pf.cena_gr >= ?'); params.push(Number(cenaOd)); }
    if (cenaDo != null) { pod.push('pf.cena_gr <= ?'); params.push(Number(cenaDo)); }
    czesci.push(`EXISTS (SELECT 1 FROM produkty_sklepowe pf WHERE ${pod.join(' AND ')})`);
  }

  // ⚠️ KATEGORIA SZUKA WE WSZYSTKICH KATEGORIACH PRODUKTU, nie tylko w `karty.kategoria_glowna`.
  // Kolumna pokazuje glowna, bo w kolumnie miesci sie jedna — ale filtrowanie WYLACZNIE po
  // glownej gubiloby produkt, ktory jest w „Aplikacjach" jako czwartej z siedmiu (sklep A
  // ma typowo 5–7 kategorii na produkt). To rozroznienie jest tez tym, co pozwala ustawiac
  // kategorie glowna HURTEM: przefiltruj po kategorii, zaznacz wszystko, ustaw.
  //
  // ⚠️ ROZSTRZYGNIECIE: filtr jest NADZBIOREM — `karty.kategoria_glowna` ALBO kategorie
  // produktow w lustrze, nigdy tylko jedno. Karta, ktorej wlasciciel RECZNIE ustawil
  // kategorie glowna (hurtem, wlasnie przez ten filtr), a ktora nie ma jeszcze powiazanego
  // produktu w lustrze — albo ktorej jedyny produkt zniknal ze sklepu, albo ktora istnieje
  // tylko na Allegro poza lustrem — ma sie NADAL znalezc. Filtr sluzy do znajdowania rzeczy:
  // falszywie pominiety wiersz jest gorszy niz wiersz nadmiarowy, zwlaszcza ze karta
  // niewidoczna w tym filtrze nie da sie nim oznaczyc kategoria glowna hurtem.
  //
  // ⚠️ `json_valid` z CASE, a nie warunkiem obok: `json_each` na popsutym napisie RZUCA
  // bledem, ktory polozylby CALA liste. Lustro bierze sie z cudzego API, wiec jedna
  // popsuta wartosc jest kwestia czasu, a nie hipoteza.
  if (kategoria) {
    czesci.push(
      '(w.kategoria_glowna = ?'
      + ' OR EXISTS (SELECT 1 FROM produkty_sklepowe pk WHERE pk.karta_id = w.id'
      + ' AND pk.zniknal_at IS NULL AND EXISTS (SELECT 1 FROM json_each('
      + "CASE WHEN json_valid(pk.kategorie_json) THEN pk.kategorie_json ELSE '[]' END"
      + ') jk WHERE jk.value = ?)))',
    );
    params.push(kategoria, kategoria);
  }

  // Trzy stany paczkomatu. Lista wartosci idzie z domain/paczkomat.js — dodanie czwartego
  // stanu nie wymaga poprawki tutaj. „Nieoznaczony" to DOKLADNIE to samo wyrazenie, ktorego
  // uzywa kolumna `liczba_brakow`, kafel i sortowanie (patrz `BRAK_PACZKOMATU_SQL`).
  if (paczkomat) {
    if (PACZKOMAT_WARTOSCI.has(paczkomat)) { czesci.push('w.paczkomat = ?'); params.push(paczkomat); }
    else if (paczkomat === 'nieoznaczone') czesci.push(BRAK_PACZKOMATU_SQL);
    else czesci.push('1 = 0');
  }

  if (brak) {
    if (brak === 'sku') czesci.push(BRAK_SKU_SQL);
    else if (brak === 'wymiary') czesci.push(BRAK_WYMIAROW_SQL);
    else if (brak === 'kategoria') czesci.push(BRAK_KATEGORII_SQL);
    else if (brak === 'paczkomat') czesci.push(BRAK_PACZKOMATU_SQL);
    // ⚠️ PIATA POZYCJA NIE JEST BRAKIEM, tylko druga strona tej samej monety: karty,
    // ktorym NICZEGO nie brakuje. Kafel postepu prowadzi wlasnie tutaj, wiec liczba
    // w kaflu i dlugosc tej listy MUSZA wychodzic z tego samego wyrazenia.
    else if (brak === 'komplet') czesci.push(`${LICZBA_BRAKOW_SQL} = 0`);
    else czesci.push('1 = 0');
  }

  return { gdzie: czesci.join(' AND '), params };
}

/**
 * Lista kart z cenami czterech kanalow, gotowa do wyrenderowania jednym przebiegiem.
 *
 * ⚠️ DWA ZAPYTANIA NA CALA LISTE, NIGDY JEDNO NA KARTE. Zapytanie „per karta" przy tysiacu
 * kart to tysiac zapytan na KAZDE otwarcie ekranu — usterka niewidoczna na bazie
 * testowej i zabojcza na produkcyjnej.
 *
 * ⚠️ Dlaczego DWA, a nie jedno ze zlaczeniem: `SELECT w.*, p.*` podmienialoby po cichu
 * `nazwa` karty `nazwa` produktu (obie kolumny nazywaja sie tak samo, pozniejsza wygrywa),
 * a wypisanie kilkunastu aliasow rozjezdzaloby sie z kazda nowa kolumna lustra. Oba
 * zapytania niosa TE SAME warunki (jeden builder, te same parametry), wiec rozjechac sie
 * nie moga.
 */
export function kartyZKanalami(db, { fraza, filtry, sort, kier } = {}) {
  const { gdzie, params } = warunkiKart({ fraza, filtry });

  // Nierozpoznane sortowanie WRACA DO DOMYSLNEGO, a nie oddaje pusto — w odroznieniu od
  // filtrow. Kolejnosc nie zaweza zbioru, wiec literowka w adresie ma pokazac liste,
  // a nie pusty ekran.
  //
  // ⚠️ `SORTOWANIE[sort] ?? domyslne` TO NIE JEST BIALA LISTA. `SORTOWANIE` to zwykly
  // literal obiektu, wiec dziedziczy z `Object.prototype` — `sort` rowne 'constructor',
  // 'toString', 'valueOf' albo 'hasOwnProperty' ODDAJE FUNKCJE (nie `undefined`), `??` jej
  // nie zlapie, a do ORDER BY trafia `function Object() { [native code] }`, czyli
  // `SqliteError` i 500 zamiast listy. `Object.hasOwn` sprawdza WYLACZNIE WLASNOSC
  // wlasna wiersza, nigdy lancuch prototypow — to jest tu jedyna wlasciwa biala lista.
  const wyrazenie = Object.hasOwn(SORTOWANIE, sort)
    ? SORTOWANIE[sort]
    : SORTOWANIE[SORTOWANIE_DOMYSLNE];
  const kierunek = String(kier).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const karty = db.prepare(
    // `NULLS LAST` w OBU kierunkach: brak wartosci nie jest ani najmniejszy, ani najwiekszy
    // — to brak. Tysiac kart bez SKU na czele listy sortowanej po SKU nie odpowiada na
    // zadne pytanie; od szukania brakow jest filtr braków. `w.id` na koncu daje kolejnosc
    // powtarzalna miedzy odswiezeniami przy remisie.
    // `liczba_brakow` jedzie TYM SAMYM wyrazeniem, co filtr i kafel — wiersz listy nie ma
    // prawa twierdzic czego innego niz zawezenie, ktore go na te liste wpuscilo.
    `SELECT w.*, ${LICZBA_BRAKOW_SQL} AS liczba_brakow FROM karty_produktow w`
    + ` WHERE ${gdzie} ORDER BY ${wyrazenie} ${kierunek} NULLS LAST, w.id ASC`,
  ).all(...params);
  if (!karty.length) return [];

  const produkty = db.prepare(
    'SELECT p.* FROM produkty_sklepowe p'
    + ` WHERE p.zniknal_at IS NULL AND p.karta_id IN (SELECT w.id FROM karty_produktow w WHERE ${gdzie})`
    // Po `p.id` rosnaco, bo przy dwoch wariantach tego samego kanalu wygrywa pierwszy —
    // wybor ma byc TEN SAM przy kazdym odswiezeniu, a nie zalezny od planu zapytania.
    + ' ORDER BY p.id ASC',
  ).all(...params);

  // ⚠️ `kanaly` MUSI byc bez prototypu. `p.kanal` pochodzi z danych sklepu (lustro cudzego
  // API) — kanal o nazwie 'constructor' albo 'toString' na literale `{}` nie ustawilby
  // wlasnej wlasnosci, tylko po cichu odczytal/nadpisal metode z `Object.prototype`,
  // dokladnie ten sam wzorzec co przy bialej liscie sortowania wyzej.
  const wiersze = karty.map((w) => ({ ...w, kanaly: Object.create(null) }));
  const poId = new Map(wiersze.map((w) => [w.id, w]));
  for (const p of produkty) {
    const wiersz = poId.get(p.karta_id);
    if (!wiersz) continue;
    if (!wiersz.kanaly[p.kanal]) wiersz.kanaly[p.kanal] = { ...p };
  }
  return wiersze;
}

/**
 * Ile roboty zostalo — liczby do kafli nad tabela magazynu.
 *
 * ⚠️ LICZY PO CALYM KATALOGU, a nie po przefiltrowanej liscie. Kafel odpowiada na pytanie
 * „ile jeszcze zostalo", wiec liczba zalezna od akurat ustawionego zawezenia znaczylaby co
 * innego przy kazdym klknieciu — a kafel jest odnosnikiem, czyli sam to zawezenie ustawia.
 *
 * ⚠️ KAZDY SKLADNIK TO TO SAMO WYRAZENIE, ktorego uzywa filtr i kolumna `liczba_brakow`
 * (stale `BRAK_*_SQL` na gorze sekcji). Osobne zapytanie z wlasna kopia warunku dawaloby
 * kafel „bez SKU: 217" prowadzacy do listy z 214 wierszami.
 *
 * ⚠️ `doPrzejecia` to PODZBIOR `bezSku`, a nie osobny brak: karta bez NASZEGO numeru, ktorego
 * ZYWY produkt ma juz wlasny numer w sklepie — jest wiec co przejac (domain/przejecie-sku.js).
 * Bez warunku o numerze sklepu ten kafel powtarzalby „bez SKU" i nie odpowiadal na nic.
 *
 * ⚠️ `COALESCE`, bo `SUM` na PUSTEJ tabeli oddaje NULL, a nie zero. Widok wypisalby to jako
 * puste miejsce w kaflu — czyli jak awaria odczytu, a nie jak „nic nie zostalo".
 *
 * @returns {{razem: number, bezSku: number, doPrzejecia: number, bezWymiarow: number,
 *            bezKategorii: number, bezPaczkomatu: number, komplet: number}}
 */
export function zliczeniaBrakow(db) {
  return db.prepare(
    'SELECT COUNT(*) AS razem'
    + `, COALESCE(SUM(CASE WHEN ${BRAK_SKU_SQL} THEN 1 ELSE 0 END), 0) AS bezSku`
    + `, COALESCE(SUM(CASE WHEN ${BRAK_SKU_SQL} AND EXISTS (SELECT 1 FROM produkty_sklepowe pz`
    + " WHERE pz.karta_id = w.id AND pz.zniknal_at IS NULL AND pz.sku_sklepu IS NOT NULL AND pz.sku_sklepu != '')"
    + ' THEN 1 ELSE 0 END), 0) AS doPrzejecia'
    + `, COALESCE(SUM(CASE WHEN ${BRAK_WYMIAROW_SQL} THEN 1 ELSE 0 END), 0) AS bezWymiarow`
    + `, COALESCE(SUM(CASE WHEN ${BRAK_KATEGORII_SQL} THEN 1 ELSE 0 END), 0) AS bezKategorii`
    + `, COALESCE(SUM(CASE WHEN ${BRAK_PACZKOMATU_SQL} THEN 1 ELSE 0 END), 0) AS bezPaczkomatu`
    + `, COALESCE(SUM(CASE WHEN ${LICZBA_BRAKOW_SQL} = 0 THEN 1 ELSE 0 END), 0) AS komplet`
    + ' FROM karty_produktow w',
  ).get();
}

/**
 * Ile produktow lustra czeka jeszcze na karte — i ile z tego jest ofertami Allegro.
 *
 * ⚠️ TEN SAM ZBIOR, CO `niepowiazaneProdukty`: zywe (`zniknal_at IS NULL`) i bez karty.
 * Kafel prowadzi na ekran zakladania kart, wiec nie ma prawa obiecywac roboty przy
 * wierszach, ktorych tamten ekran w ogole nie pokaze.
 *
 * ⚠️ OFERTY ALLEGRO WYDZIELONE, bo to INNA robota: oferty karty nie zakladaja (4.27) —
 * dobiera sie je RECZNIE do kart, ktore juz istnieja. Zliczone razem z produktami sklepu
 * kazalyby czlowiekowi szukac na ekranie zakladania kart czegos, czego tam nie ma.
 *
 * Lista kont z konfiguracji instancji jest wiązana parametrami SQL.
 * i nie nazwy wpisane tutaj z reki. Trzecie konto dopisane w domenie ma sie policzyc samo.
 *
 * @returns {{pominiete: number, ofertyAllegro: number}}
 */
export function zliczeniaNiepowiazanych(db, kanalyAllegro) {
  wymagajListyKanalow(kanalyAllegro);
  const konta = [...kanalyAllegro];
  return db.prepare(
    'SELECT COUNT(*) AS pominiete'
    + `, COALESCE(SUM(CASE WHEN kanal IN (${konta.map(() => '?').join(', ')}) THEN 1 ELSE 0 END), 0) AS ofertyAllegro`
    + ' FROM produkty_sklepowe WHERE karta_id IS NULL AND zniknal_at IS NULL',
  ).get(...konta);
}

/**
 * Nazwy kategorii, po ktorych da sie filtrowac — do pola wyboru nad tabela magazynu.
 *
 * ⚠️ LISTA Z BAZY, A NIE ZE STALEJ. Kategorie doklada SKLEP, bez pytania nas o zdanie (ta sama
 * asymetria, co przy metodach platnosci na liscie zamowien: kanaly dokladamy MY, bramki
 * platnosci sklep). Wpisana na sztywno lista milczaco przestalaby byc kompletem.
 *
 * ⚠️ I DLATEGO POLE WYBORU, A NIE POLE TEKSTOWE. Filtr kategorii dopasowuje CALA nazwe
 * (`= ?`), a nazw jest kilkaset i nikt ich nie pamieta — reczne wpisanie „Lampy wiszace"
 * zamiast „Lampy wiszące" oddaje pusty ekran, czyli dokladnie ten obraz, ktory znaczy
 * „nie ma takich kart". Wybor z listy tego stanu nie ma jak wyprodukowac.
 *
 * ⚠️ NADZBIOR, dokladnie ten sam co w filtrze (`warunkiKart`): kategoria glowna NASZEJ
 * karty ALBO kategorie produktow w lustrze. Gdyby lista pokazywala tylko jedno ze zrodel,
 * czesc pozycji filtru bylaby nieosiagalna z ekranu, a czesc wynikow nieosiagalna z listy.
 *
 * ⚠️⚠️ `pk.karta_id IS NOT NULL` I NIE WOLNO GO STAD ZDJAC, choc wyglada na zbedne zawezenie
 * („przeciez ta kategoria JEST w lustrze, czemu jej nie ma na liscie?"). Filtr chodzi po
 * produktach POWIAZANYCH z kartą (`EXISTS (… WHERE pk.karta_id = w.id …)`), wiec kategoria
 * wystepujaca WYLACZNIE u produktow niepowiazanych jest pozycja, ktorej filtr nie ma jak
 * trafic — wybranie jej oddaje pusta tabele, czyli dokladnie ten obraz („nie ma takich
 * kart"), dla ktorego to pole wyboru w ogole powstalo. Wracalby tedy drzwiami, w ktorych
 * literowki popelnic sie nie da.
 *
 * I nie jest to stan krancowy. Po „Odczytaj katalogi" lustro ma wszystko, co przyslal sklep,
 * a karty powstaja dopiero z OSOBNEGO klikniecia — nowa kategoria sklepu byla wiec widoczna
 * natychmiast, a trafialna dopiero po utworzeniu kart. Czesc produktow nie dostanie karty
 * NIGDY (~26 wariantow bez rozmiaru i zaslepki, ktorych `powodPominiecia` nie powiaze —
 * Zadanie 8), wiec kategoria wystepujaca tylko u nich bylaby martwa pozycja bez konca.
 *
 * ⚠️ NAPRAWIAMY LISTE, A NIE FILTR. Poszerzenie filtru o produkty niepowiazane zmienialoby
 * ZNACZENIE filtru i dotykaloby rozstrzygniecia z Zadania 4 (nadzbior: `karty.kategoria_glowna`
 * ALBO kategorie produktow w lustrze) — a wynik tego filtru ma opisywac KARTY, nie zawartosc
 * lustra. Lista pozycji ma byc DOKLADNIE zbiorem osiagalnym przez filtr.
 *
 * ⚠️ `json_valid` z CASE i `jk.type = 'text'`: `json_each` na popsutym napisie RZUCA bledem,
 * ktory polozylby caly ekran, a liczba w tablicy kategorii weszlaby do pola wyboru jako
 * wartosc, ktorej porownanie z kolumna TEXT nigdy nie bedzie prawdziwe.
 */
export function kategorieDoFiltra(db) {
  return db.prepare(
    'SELECT DISTINCT k FROM ('
    + "  SELECT NULLIF(TRIM(w.kategoria_glowna), '') AS k FROM karty_produktow w"
    + '  UNION'
    + "  SELECT NULLIF(TRIM(jk.value), '') AS k FROM produkty_sklepowe pk, json_each("
    + "    CASE WHEN json_valid(pk.kategorie_json) THEN pk.kategorie_json ELSE '[]' END"
    + "  ) jk WHERE pk.zniknal_at IS NULL AND pk.karta_id IS NOT NULL AND jk.type = 'text'"
    + ') WHERE k IS NOT NULL ORDER BY k COLLATE NOCASE',
  ).all().map((w) => w.k);
}

/**
 * Produkty sklepowe, z ktorych nie powstala jeszcze karta — material dla tworzenia hurtem.
 *
 * Produkt znikniety NIE wchodzi: zakladanie karty dla czegos, czego w sklepie juz nie ma,
 * doklada rejestrowi wiersz bez zadnego zastosowania.
 */
export function niepowiazaneProdukty(db) {
  return db.prepare(
    'SELECT * FROM produkty_sklepowe WHERE karta_id IS NULL AND zniknal_at IS NULL ORDER BY id ASC',
  ).all().map((p) => ({ ...p }));
}

/**
 * Tworzenie kart HURTEM z niepowiazanych produktow — obsluga przycisku „Utworz karty
 * z niepowiazanych". Oddaje `{ utworzone, pominiete: [{ id, powod }] }`.
 *
 * Regula, CO staje sie karta i CO ta karta niesie, siedzi w `domain/karta-z-produktu.js` —
 * tutaj zostaje wylacznie przebieg po bazie. `powodPominiecia` jest JEDYNA bramka: gdyby obok
 * niej stal drugi warunek, ekran „pominiete" pokazywalby inny zbior niz ten, ktory faktycznie
 * odpadl, a to jest jedyne miejsce, gdzie wlasciciel widzi, czego panel nie tknal.
 *
 * ⚠️ TRANSAKCJA JEST OBOWIAZKOWA i nie chodzi tu tylko o czas. Po pierwsze, ~980 wstawien
 * w autocommicie to ~980 osobnych transakcji WAL z wlasnym fsync — zmierzone przy odczycie
 * katalogu: 3000 wierszy to 3,7 s wobec 222 ms w transakcji. Po drugie i wazniejsze: blad
 * w polowie zostawilby POLOWE rejestru — czesc produktow powiazana, czesc nie — a drugie
 * klikniecie dolozyloby karty tylko do reszty, wiec rejestr powstalby z dwoch roznych
 * przebiegow i nikt by juz nie wiedzial, ktora karta skad jest.
 *
 * ⚠️ ODCZYT JEST W SRODKU TRANSAKCJI, nie przed nia: poller zamowien chodzi po TYM SAMYM
 * polaczeniu, a lista przeczytana przed `BEGIN` moglaby juz nie opisywac tego, co zapisujemy.
 * Cala funkcja jest SYNCHRONICZNA (zadnego `await`), wiec petla zdarzen nie wejdzie w srodek.
 *
 * ⚠️ Zegar pytany RAZ NA PRZEBIEG. ~980 kart z jednego klikniecia ma jeden znacznik — po nim
 * i tylko po nim da sie potem powiedziec „to sa te z tamtego przycisku" i cofnac pomylke masowa.
 */
export function utworzKartyZNiepowiazanych(db, { teraz: kiedy = teraz, kanalySklepow } = {}) {
  wymagajListyKanalow(kanalySklepow);
  const at = typeof kiedy === 'function' ? kiedy() : kiedy;

  db.exec('BEGIN IMMEDIATE');
  try {
    const pominiete = [];
    let utworzone = 0;

    for (const produkt of niepowiazaneProdukty(db)) {
      const powod = powodPominiecia(produkt, kanalySklepow);
      if (powod) {
        pominiete.push({ id: produkt.id, powod });
        continue;
      }
      const kartaId = utworzKarte(db, kartaZProduktu(produkt), { at });
      // Powiazanie w TEJ SAMEJ transakcji, co wstawienie karty. Rozdzielone zostawialoby
      // przy awarii karte-sierote, ktorej nie widac w zadnym filtrze braków i ktora przy
      // nastepnym kliknieciu dostaje blizniaka.
      powiazProdukt(db, produkt.id, kartaId);
      utworzone += 1;
    }

    db.exec('COMMIT');
    return { utworzone, pominiete };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ================================================================================
// EKRAN POWIAZAN OFERT ALLEGRO Z KARTAMI PRODUKTOW
//
// ⚠️⚠️ DLACZEGO OSOBNE ZAPYTANIA, A NIE ROZSZERZENIE `niepowiazaneProdukty`. Tamta funkcja
// sluzy TWORZENIU kart z produktow sklepowych i jest sparowana z `powodPominiecia` —
// oferty Allegro odpadaja jej CELOWO (447 z 473 pominietych). Tutaj jest dokladnie odwrotny
// zbior i odwrotna praca: karta JUZ ISTNIEJE (powstala z katalogu sklepu), a oferte trzeba
// do niej DOBRAC recznie, bo `external` jest na Allegro puste we wszystkich ofertach,
// a nazwy sa sprzedazowe.
//
// Oferty wybiera jawna lista skonfigurowanych kont, nigdy prefiks nazwy kanału.

/**
 * Oferty Allegro, ktore nie maja jeszcze karty — material ekranu powiazan.
 *
 * ⚠️ Kolejnosc ALFABETYCZNA i nieczula na wielkosc liter, a nie „po id". Czlowiek przeglada
 * 447 wierszy wzrokiem i szuka po nazwie; kolejnosc odczytu z Allegro nie znaczy dla niego
 * nic. `p.id` na koncu daje rozstrzygniecie powtarzalne przy dwoch ofertach o tej samej nazwie.
 */
// Pusta lista niczego nie wybiera; nazwy kanałów wiążemy parametrami SQL.
export function niepowiazaneOfertyAllegro(db, kanaly) {
  wymagajListyKanalow(kanaly);
  if (!kanaly.length) return [];
  const warunek = `p.kanal IN (${kanaly.map(() => '?').join(', ')}) AND p.zniknal_at IS NULL`;
  return db.prepare(
    `SELECT p.* FROM produkty_sklepowe p WHERE ${warunek} AND p.karta_id IS NULL`
    + ' ORDER BY p.nazwa COLLATE NOCASE ASC, p.id ASC',
  ).all(...kanaly).map((p) => ({ ...p }));
}

/**
 * Oferty Allegro JUZ powiazane, razem z nazwa i SKU karty — material do odpiecia.
 *
 * ⚠️ NAZWA KARTY JEDZIE ZLACZENIEM, a nie drugim zapytaniem na wiersz: przy setkach powiazan
 * „jedno zapytanie na wiersz" to setki zapytan na kazde otwarcie ekranu (ta sama zasada, co
 * przy `kartyZKanalami`). Kolumny wypisane z ALIASAMI, a nie `p.*, w.*`: obie tabele maja
 * kolumne `nazwa`, wiec przy gwiazdce pozniejsza podmienialaby wczesniejsza po cichu.
 */
export function powiazaneOfertyAllegro(db, kanaly) {
  wymagajListyKanalow(kanaly);
  if (!kanaly.length) return [];
  const warunek = `p.kanal IN (${kanaly.map(() => '?').join(', ')}) AND p.zniknal_at IS NULL`;
  return db.prepare(
    'SELECT p.id AS id, p.kanal AS kanal, p.nazwa AS nazwa, p.karta_id AS karta_id,'
    + ' w.nazwa AS karta_nazwa, w.sku AS karta_sku'
    + ' FROM produkty_sklepowe p JOIN karty_produktow w ON w.id = p.karta_id'
    + ` WHERE ${warunek}`
    + ' ORDER BY p.nazwa COLLATE NOCASE ASC, p.id ASC',
  ).all(...kanaly).map((p) => ({ ...p }));
}

/**
 * Karty jako kandydaci do powiazania — nazwa, SKU i wymiary, czyli to, czym rozstrzyga sie
 * wybor (`domain/dopasowanie-ofert.js` liczy z nazwy i wymiarow, czlowiek patrzy na SKU).
 *
 * ⚠️ WYBRANE KOLUMNY, NIE `SELECT *`. Ta lista jedzie do liczenia propozycji dla KAZDEJ
 * z 447 ofert i do jednej wspolnej listy podpowiedzi w HTML-u; `opis` (mediana 143 znaki
 * razy ~965 kart) nie sluzy tam niczemu poza puchnieciem pamieci i strony.
 *
 * ⚠️ Zwraca PUSTO, gdy rejestr kart jest pusty — i to jest STAN DZISIEJSZY produkcji,
 * a nie przypadek krancowy: zakladanie kart to osobny przycisk. Ekran ma wtedy powiedziec,
 * ze najpierw trzeba zalozyc karty (patrz `web/routes/magazyn.js`).
 */
export function kartyDoPowiazania(db) {
  return db.prepare(
    'SELECT id, nazwa, sku, szerokosc_mm, wysokosc_mm FROM karty_produktow'
    + ' ORDER BY nazwa COLLATE NOCASE ASC, id ASC',
  ).all().map((w) => ({ ...w }));
}

/**
 * Zatwierdzenie HURTEM: wiele par (oferta → karta) w JEDNEJ transakcji.
 * Oddaje `{ powiazane: [idOferty], nieaktualne: [idOferty] }`.
 *
 * ⚠️⚠️ WARUNEK `karta_id IS NULL` W UPDATE TO STRAZNIK STANU NIEAKTUALNEGO, nie ozdoba.
 * Panel nie ma JavaScriptu, wiec formularz z 447 wierszami zyje w karcie tak dlugo, jak
 * dlugo jest ona otwarta. Druga karta, przycisk Wstecz albo powtorzone wyslanie tego samego
 * formularza przynosza pare, ktora ktos w miedzyczasie rozstrzygnal INACZEJ — bezwarunkowy
 * UPDATE nadpisalby tamten wybor po cichu i bez sladu. Oferta, ktora „nie weszla", wraca
 * w `nieaktualne` i ma byc POKAZANA (niezmiennik 4.13a: pominiete wracaja z powodem).
 * Skutek uboczny i pozadany: powtorne wyslanie tego samego formularza nie robi juz nic.
 *
 * ⚠️ `zniknal_at IS NULL` z tego samego powodu, co na liscie: oferta wycofana z Allegro
 * w trakcie pracy nad ekranem nie jest robota do wykonania.
 *
 * ⚠️ TRANSAKCJA. Blad na dziesiatej parze z czterdziestu zostawilby dziewiec powiazan
 * i trzydziesci jeden bez — a drugie klikniecie dolozyloby reszte, wiec rejestr powstalby
 * z dwoch roznych przebiegow i nikt by juz nie wiedzial, ktora oferta skad jest. Cala
 * funkcja jest SYNCHRONICZNA (zadnego `await`), wiec poller zamowien chodzacy po tym samym
 * polaczeniu nie wejdzie w srodek.
 */
export function powiazOfertyHurtem(db, pary, kanaly) {
  wymagajListyKanalow(kanaly);
  const powiazane = [];
  const nieaktualne = [];
  const warunekKanalu = kanaly.length ? `kanal IN (${kanaly.map(() => '?').join(', ')})` : '0 = 1';

  db.exec('BEGIN IMMEDIATE');
  try {
    const zapytanie = db.prepare(
      'UPDATE produkty_sklepowe SET karta_id = ?'
      + ` WHERE id = ? AND ${warunekKanalu} AND karta_id IS NULL AND zniknal_at IS NULL`,
    );
    for (const { produktId, kartaId } of pary ?? []) {
      wymagajKarty(db, kartaId);
      const r = zapytanie.run(kartaId, produktId, ...kanaly);
      (liczba(r.changes) ? powiazane : nieaktualne).push(produktId);
    }
    db.exec('COMMIT');
    return { powiazane, nieaktualne };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Odpiecie oferty Allegro od karty. Oddaje `true`, gdy cos faktycznie odpieto.
 *
 * ⚠️⚠️ WARUNEK KANALU JEST TU CALA OCHRONA. Bez niego ta operacja odpinalaby DOWOLNY wiersz
 * lustra po numerze — takze produkt SKLEPOWY, ktorego powiazanie z karta te karte ZBUDOWALO
 * („Utwórz karty z niepowiązanych"). Karta zostalaby wtedy sierota: bez ceny, bez zdjecia, bez
 * kategorii i bez sladu, co ja osierocilo. Ekran powiazan mowi wylacznie o ofertach Allegro
 * i tylko je wolno mu ruszac.
 *
 * ⚠️ `zniknal_at` NIE jest tu warunkiem — celowo, w odroznieniu od wiazania. Odpiecie jest
 * COFANIEM pomylki, a pomylke trzeba dac sie cofnac takze wtedy, gdy oferty juz nie ma
 * w sprzedazy; blokada zostawialaby karte przypieta do czegos, czego nikt juz nie widzi.
 */
export function odepnijOferte(db, produktSklepowyId, kanaly) {
  wymagajListyKanalow(kanaly);
  const warunekKanalu = kanaly.length ? `kanal IN (${kanaly.map(() => '?').join(', ')})` : '0 = 1';
  const r = db.prepare(
    `UPDATE produkty_sklepowe SET karta_id = NULL WHERE id = ? AND ${warunekKanalu}`,
  ).run(produktSklepowyId, ...kanaly);
  return liczba(r.changes) > 0;
}

// ================================================================================
// JEDNA KARTA PRODUKTU

/**
 * Jedna karta po numerze — albo `null`, gdy takiej nie ma.
 *
 * ⚠️ NUMER PRZYCHODZI Z ADRESU HTTP, wiec sprawdzamy go TUTAJ, a nie zostawiamy bazie:
 * `/magazyn/abc` ma dac czytelna odmowe, a nie wyjatek wiazania parametru.
 *
 * ⚠️⚠️ SAME CYFRY, a nie „co da sie przerobic na liczbe". `Number('1e3')` to 1000 i przechodzi
 * przez `Number.isInteger` — czyli ta sama karta mialaby DWA rozne adresy, a odnosnik z listy
 * i adres w zakladce przestalyby byc tym samym miejscem. `Number.isSafeInteger` domyka drugi
 * koniec: `Number('9999999999999999999999')` to 1e22, ktore w SQLite jest FLOATEM i po cichu
 * nie trafia w zaden wiersz.
 */
export function kartaPoId(db, id) {
  if (!/^\d+$/u.test(String(id))) return null;
  const numer = Number(id);
  if (!Number.isSafeInteger(numer)) return null;
  return db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(numer) ?? null;
}

/**
 * Wszystkie produkty i oferty przypiete do karty — material ekranu karty.
 *
 * ⚠️ PRODUKT ZNIKNIETY ZE SKLEPU ZOSTAJE NA LISCIE (bez `zniknal_at IS NULL`), w odroznieniu
 * od listy magazynu. Tam kolumna kanalu mowi „da sie tam dzis kupic", a tu ekran karty odpowiada
 * na pytanie „co jest do tej karty przypiete" — wiersz ukryty wygladalby jak powiazanie,
 * ktore samo zniknelo, i nikt by go nie odpial ani nie odzyskal.
 *
 * Kolejnosc po kanale, a potem po numerze wiersza: ta sama karta ma pokazywac swoje produkty
 * w tej samej kolejnosci przy kazdym odswiezeniu, takze po odczycie katalogow.
 */
export function produktyKarty(db, kartaId) {
  const numer = Number(kartaId);
  if (!Number.isInteger(numer)) return [];
  return db.prepare(
    'SELECT * FROM produkty_sklepowe WHERE karta_id = ? ORDER BY kanal ASC, id ASC',
  ).all(numer).map((p) => ({ ...p }));
}

/**
 * Produkty sklepowe WIELU kart naraz — material przejecia numeru ze sklepu i podgladu
 * zapisu do sklepow. Wiersze wracaja CALE, z `karta_id` przy kazdym.
 *
 * ⚠️ OSOBNA FUNKCJA, A NIE PETLA PO `produktyKarty`: oba ekrany dotykaja setek kart naraz
 * (278 przy przejeciu, 965 przy nadaniu numerow), a `prepare` na wiersz to setki zapytan
 * zamiast jednego.
 *
 * ⚠️⚠️ BEZ WARUNKU `zniknal_at IS NULL` — inaczej niz na liscie magazynu, i jest to tresc,
 * nie przeoczenie. Produkt wycofany ze sprzedazy NADAL TRZYMA SWOJ NUMER (ta sama zasada, co
 * w `zajeteSku`), wiec karta z jednym produktem wycofanym o numerze „PD10" i jednym zywym
 * o numerze „B-KOP-118" NIE JEST jednoznaczna — a bez tego wiersza wygladalaby na
 * jednoznaczna i panel przejalby numer za czlowieka. Zapis do sklepu odsiewa znikniete
 * OSOBNO (`domain/zapis-do-sklepu.js`), bo tam pytanie jest inne: nie „jaki numer istnieje",
 * tylko „gdzie wolno pisac".
 *
 * ⚠️ Numery odsiewane tak samo, jak w `kartyPoIdach` — przychodza z zadania HTTP, a `IN`
 * sklejane jest z tekstu.
 */
export function produktyKart(db, ids) {
  const numery = [...new Set(
    (ids ?? []).filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number),
  )];
  if (!numery.length) return [];
  return db.prepare(
    `SELECT * FROM produkty_sklepowe WHERE karta_id IN (${numery.map(() => '?').join(', ')})`
    // Kolejnosc jawna: opis rozbieznosci wymienia numery po kolei, a czlowiek ma zobaczyc
    // ten sam ekran przy podgladzie i przy zatwierdzeniu.
    + ' ORDER BY kanal ASC, id ASC',
  ).all(...numery).map((p) => ({ ...p }));
}

/**
 * Przestawia W LUSTRZE numer produktu, ktory WLASNIE pojechal do sklepu.
 *
 * ⚠️⚠️ WYLACZNIE KOLUMNA `sku_sklepu` I ANI JEDNA WIECEJ. Kuszace bylo puszczenie tego przez
 * `zapiszProduktSklepowy` — i skasowaloby `karta_id`, czyli powiazanie karty z produktem,
 * cala reczna prace wlasciciela (patrz komentarz przy `KOLUMNY_LUSTRA`). Z tego samego powodu
 * nie ruszamy `odczytane_at`: ta kolumna mowi, kiedy sklep byl CZYTANY, a my wlasnie
 * PISALISMY. Przestawiona udawalaby odczyt, ktorego nie bylo, i `oznaczZnikniete` liczyloby
 * po niej granice.
 *
 * ⚠️ WOLANE WYLACZNIE PO ZAPISIE, KTORY SIE UDAL. Lustro ma dogonic sklep tylko w tym, co
 * sklep faktycznie przyjal — inaczej panel twierdzilby, ze numer stoi w sklepie, a nie stoi.
 *
 * Bez tego kolejny podglad zapisu pokazywalby te sama zmiane jeszcze raz i zapraszal do
 * drugiego zapisu do sklepu, ktory sprzedaje.
 */
export function zapiszSkuSklepu(db, { kanal, produkt_id: produktId, wariant_id: wariantId }, sku) {
  const r = db.prepare(
    'UPDATE produkty_sklepowe SET sku_sklepu = ?'
    + ' WHERE kanal = ? AND produkt_id = ? AND wariant_id = ?',
  ).run(sku, kanal, idTekstem(produktId), idTekstem(wariantId));
  return liczba(r.changes);
}

/**
 * Karta trzymajaca TO SKU — do sprawdzenia przed zapisem. Oddaje `{ id, nazwa }` albo `null`.
 *
 * ⚠️ PYTAMY PRZED ZAPISEM, CHOC KOLUMNA JEST `UNIQUE` — i to nie jest druga bramka obok
 * pierwszej. Baza odbija duplikat wyjatkiem `SqliteError: UNIQUE constraint failed`, czyli
 * pieciusetka zamiast zdania o tym, KTORA karta to SKU trzyma. Baza dalej jest tu ostatecznym
 * strażnikiem (wyscig dwoch kart konczy sie na niej), a to zapytanie sluzy WYLACZNIE temu,
 * zeby czlowiek dostal odpowiedz, z ktora da sie cos zrobic.
 */
export function kartaZeSku(db, sku) {
  const s = String(sku ?? '').trim();
  if (!s) return null;
  return db.prepare('SELECT id, nazwa FROM karty_produktow WHERE sku = ?').get(s) ?? null;
}

/**
 * Produkty, z ktorych karta NIE powstanie, razem z powodem — material dla ekranu „pominiete".
 *
 * Liczone TA SAMA para funkcji, co przy tworzeniu, i z tego samego zapytania: ekran ma
 * pokazywac dokladnie to, co przycisk pominal, a nie „wszystko, co akurat nie ma karty".
 * Wiersz wraca CALY (nazwa, kanal, adres, zdjecia), bo bez nich lista nie mowi, o czym mowi.
 */
export function produktyPominiete(db, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  const lista = [];
  for (const produkt of niepowiazaneProdukty(db)) {
    const powod = powodPominiecia(produkt, kanalySklepow);
    if (powod) lista.push({ ...produkt, powod });
  }
  return lista;
}

// =====================================================================================
// SZUKANIE PRODUKTU DO ZAMOWIENIA TELEFONICZNEGO (21.08.2026)
//
// ⚠️ TO NIE JEST LISTA MAGAZYNU. Tamta (`kartyZKanalami`) opisuje KARTY i ich obecnosc
// w czterech kanalach — sluzy do porzadkowania katalogu. Ta oddaje POZYCJE JEDNEGO
// CENNIKA, gotowe do dopisania do zamowienia, i wlasnie dlatego kanaly allegrowe nie maja
// jak sie tu dostac: kanal przychodzi juz przefiltrowany przez domene
// (domain/magazyn-do-zamowienia.js), a zapytanie i tak pyta o jeden.
//
// ⚠️ SZUKAMY PO WSZYSTKICH SLOWACH NARAZ, nie po calej frazie. „grzybek 30" ma znalezc
// „Lampa stołowa Grzybek ceramiczna 30cm" — przy telefonie operator wpisuje dwa slowa
// z pamieci, a nie dokladny poczatek nazwy. Kazde slowo to osobny LIKE spiety AND-em,
// bo to jest ta sama roznica, co miedzy szukaniem uzytecznym a pustym ekranem.
//
// ⚠️ `zniknal_at IS NULL` — produkt wycofany ze sklepu nie ma prawa sie pokazac. Cena
// nieistniejacego produktu to najgorszy rodzaj podpowiedzi: wyglada na prawdziwa.
// =====================================================================================
const SLOWA_MAX = 6;

export function szukajDoZamowienia(db, { fraza, kanal, limit = 20 } = {}) {
  const slowa = String(fraza ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, SLOWA_MAX);
  if (slowa.length === 0) return [];

  const czesci = ['kanal = ?', 'zniknal_at IS NULL'];
  const params = [String(kanal)];
  for (const slowo of slowa) {
    czesci.push("(nazwa LIKE ? ESCAPE '\\' OR sku_sklepu LIKE ? ESCAPE '\\')");
    const wzorzec = `%${uciekniecieLike(slowo)}%`;
    params.push(wzorzec, wzorzec);
  }

  // Produkty Z CENA ida pierwsze: bezcenowy wiersz i tak nie da sie dodac jednym
  // kliknieciem, wiec spychanie go na dol jest uczciwsze niz mieszanie z reszta.
  return db.prepare(`
    SELECT kanal, produkt_id, wariant_id, nazwa, sku_sklepu, cena_gr, rozmiar_tekst,
           miniatura, adres, status_publikacji
    FROM produkty_sklepowe
    WHERE ${czesci.join(' AND ')}
    ORDER BY (cena_gr IS NULL) ASC, nazwa ASC, rozmiar_tekst ASC
    LIMIT ?
  `).all(...params, Number(limit) || 20);
}

/**
 * JEDEN produkt po pelnym kluczu lustra — to z niego czyta sie cene przy dopisywaniu
 * pozycji.
 *
 * ⚠️ PELNA TROJKA (kanal, produkt, wariant), nie sam identyfikator. Ten sam produkt stoi
 * w kilku kanalach po roznych cenach, a `UNIQUE` w lustrze jest wlasnie na tej trojce —
 * szukanie po samym `produkt_id` oddaloby cene z przypadkowego cennika.
 */
export function produktDoZamowienia(db, { kanal, produkt_id: produktId, wariant_id: wariantId }) {
  return db.prepare(`
    SELECT kanal, produkt_id, wariant_id, nazwa, sku_sklepu, cena_gr, rozmiar_tekst, status_publikacji
    FROM produkty_sklepowe
    WHERE kanal = ? AND produkt_id = ? AND wariant_id = ? AND zniknal_at IS NULL
  `).get(String(kanal), String(produktId), String(wariantId ?? '')) ?? null;
}

/** Kiedy ostatnio czytalismy katalog tego sklepu — ekran ma powiedziec, jak swieze sa ceny. */
export function odczytKatalogu(db, kanal) {
  return db.prepare('SELECT MAX(odczytane_at) AS kiedy FROM produkty_sklepowe WHERE kanal = ?')
    .get(String(kanal))?.kiedy ?? null;
}
