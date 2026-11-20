// Zapytania magazynu: lustro sklepow (`produkty_sklepowe`) i nasz rejestr kart (`karty`).
//
// Na tej warstwie stoi caly modul — odczyt katalogow, tworzenie kart, lista i filtry —
// wiec kazda cicha usterka rozejdzie sie po wszystkim. Trzy rzeczy, ktore ten plik chroni:
//   (1) POWIAZANIE karty z produktem jest RECZNA PRACA wlasciciela i nie ma prawa zginac
//       przy odczycie sklepu (patrz `zapiszProduktSklepowy`);
//   (2) nazwa kolumny sortowania i nazwa kolumny zapisu nie moga trafic do SQL-a
//       z zapytania HTTP (biale listy nizej — parametru w `ORDER BY` zwiazac sie nie da);
//   (3) filtr, ktorego nie rozumiemy, NIE POSZERZA zbioru (patrz `warunkiKart`).
import { idBrakuParametru } from '../../domena/magazyn-filtry.js';
import { wymagajListyKanalow } from '../../domena/lista-kanalow.js';
import { kartaZProduktu, powodPominiecia } from '../../domena/karta-z-produktu.js';
import { POLA_ZASTANE } from '../../domena/zrodla-pol.js';
import { dekodujEncje } from '../../domena/slowniki-kart.js';
import { PROBLEMY_ILOSCI } from '../../domena/ilosc-kanalu.js';
import { przelacznikStanow, stanyKart, zuzycieProduktuOdGranicy } from './stany-magazynowe.js';
import { kartyWgStanu } from './niski-stan.js';
import { czyFiltrStanu } from '../../domena/niski-stan.js';
import { zapiszPrzepiecie } from './oferty-kanalow.ts';
import { zapiszCeneZakupu } from './ceny-zakupu.js';
import { ustawWartoscKarty, wyczyscWartoscKarty } from './parametry-kart.js';
import { dzienWarszawa } from '../../domena/format-daty.js';

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
  'nazwa',
  'sku_sklepu',
  'cena_gr',
  'kategorie_json',
  'zdjecia_json',
  'adres',
  // ⚠️ ADRES MINIATURY JEST KOLUMNA LUSTRA, nie nasza — sklep, ktory przeliczyl zdjecia
  // na nowo albo zmienil rozmiar miniatury, ma zostac ODWZOROWANY, a nie przemilczany.
  // Stad `DO UPDATE SET`, tak samo jak przy nazwie i cenie. To odroznia te kolumne od
  // `karta_id` i `zniknal_at`, ktorych ta lista dotykac nie moze.
  'miniatura',
  'rozmiar_tekst',
  'kategoria_glowna_zrodla',
  'opis_zrodlowy',
  'status_publikacji',
  // ⚠️ ATRYBUTY WARIANTU SA KOLUMNA LUSTRA, nie nasza. Wlasciciel, ktory przemianowal wartosc
  // atrybutu w sklepie („Mosiądz" → „Mosiadz"), ma zobaczyc nowa wartosc po odczycie —
  // stad `DO UPDATE SET`, tak samo jak przy nazwie i cenie. Zbior kart, ktore juz powstaly,
  // to nie zmienia: `karta_id` tej listy NIE DOTYKA i dotykac nie moze (patrz wyzej).
  'atrybuty_json',
  // Wymiary i waga, ktore podaje sklep (z jednostka) — kolumny lustra, przepisywane przy kazdym odczycie.
  'wymiary_json',
  'waga_tekst',
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
  const wiersz = db
    .prepare(
      `INSERT INTO produkty_sklepowe (${kolumny.join(', ')})` +
        ` VALUES (${kolumny.map(() => '?').join(', ')})` +
        ' ON CONFLICT (kanal, produkt_id, wariant_id) DO UPDATE SET ' +
        KOLUMNY_LUSTRA.map((k) => `${k} = excluded.${k}`).join(', ') +
        // Produkt, ktory wrocil do sklepu, przestaje byc znikniety — inaczej raz oznaczony
        // wiersz zostawalby wycofany na zawsze i cena nie wrocilaby juz do listy.
        ', zniknal_at = NULL' +
        ' RETURNING id',
    )
    .get(...wartosci);
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
  const r = db
    .prepare(
      'UPDATE produkty_sklepowe SET zniknal_at = ?' + ' WHERE kanal = ? AND odczytane_at < ? AND zniknal_at IS NULL',
    )
    .run(odczytaneAt, kanal, odczytaneAt);
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
  const r = db
    .prepare('SELECT COUNT(*) AS ile FROM produkty_sklepowe WHERE kanal = ? AND zniknal_at IS NULL')
    .get(kanal);
  return liczba(r.ile);
}

/**
 * Produkty TEGO kanalu powiazane z karta: `produkt_id` → zapisana miniatura (albo `null`).
 * Material odczytu szkicow w `services/magazyn-sync.js`.
 *
 * ⚠️ BEZ WZGLEDU NA `zniknal_at`. Produkt powiazany, ktory kiedys dostal `zniknal_at` tylko
 * dlatego, ze byl szkicem, ma przy nastepnym odczycie wrocic do zycia — z warunkiem
 * `zniknal_at IS NULL` nikt by juz o niego sklepu nie zapytal.
 *
 * Miniatura jedzie razem z id, bo szkic nie wystepuje w Store API: bez zapisanej wartosci
 * odczyt wpisalby w miejsce istniejacej miniatury pusta.
 */
export function powiazaneProduktyKanalu(db, kanal) {
  const wiersze = db
    .prepare(
      'SELECT produkt_id, MAX(miniatura) AS miniatura FROM produkty_sklepowe' +
        ' WHERE kanal = ? AND karta_id IS NOT NULL GROUP BY produkt_id ORDER BY produkt_id',
    )
    .all(kanal);
  return new Map(wiersze.map((w) => [String(w.produkt_id), w.miniatura ?? null]));
}

/**
 * Ile zywych ofert ma lustro kanalu i ile z nich ma SKU (`sku_sklepu` niepuste po `trim`). Import wiaze karty
 * wylacznie po SKU, wiec konto z ofertami i bez ani jednego SKU nie dostanie z niego zadnych powiazan —
 * ekran importu ma wtedy odeslac do recznych powiazan. Jedno zapytanie na ekran.
 */
export function ofertySkuKanalu(db, kanal) {
  const r = db
    .prepare(
      'SELECT COUNT(*) AS razem,' +
        " COALESCE(SUM(CASE WHEN TRIM(COALESCE(sku_sklepu, '')) <> '' THEN 1 ELSE 0 END), 0) AS z_sku" +
        ' FROM produkty_sklepowe WHERE kanal = ? AND zniknal_at IS NULL',
    )
    .get(kanal);
  return { razem: liczba(r.razem), zSku: liczba(r.z_sku) };
}

// Biala lista pol karty edytowalnych z panelu. Nazwa kolumny idzie do SQL-a jako TEKST
// (parametrem byc nie moze), wiec to jedyna ochrona przed wstrzyknieciem — i jedyna
// ochrona przed edycja hurtem, ktora „ustawia" pole, o ktorym baza nic nie wie.
const POLA_KARTY = [
  'opis_sekcje_json',
  'sku',
  'nazwa',
  'szerokosc_mm',
  'wysokosc_mm',
  'kategoria_glowna',
  'opis',
  'glebokosc_mm',
  'waga_g',
  // Pola z migracji 0011 (API v1 i ekran karty). Edycja hurtem ma WLASNA, wezsza liste
  // (`domena/magazyn-hurt.js`) — dopisanie tutaj nie wlacza tych pol do hurtu ani do przenoszenia ze sklepu.
  'cena_gr',
  'stawka_vat',
  'ean',
  'wycofana',
  // Marka ze słownika marek (migracja 0016); poza hurtem, jak pola wyżej.
  'marka',
  // Informacja o bezpieczeństwie (JSON TEXT/ATTACHMENTS) — zapisuje ją wyłącznie osobna trasa sekcji GPSR karty;
  // formularz karty, hurt i API mają własne listy pól bez niej, więc ich zapis nie dotyka załączników.
  'informacja_bezpieczenstwa',
  // Próg niskiego stanu (migracja 0021) — zapisuje go osobna trasa sekcji stanu karty, nie formularz danych karty.
  'prog_niskiego_stanu',
];

// Próg niskiego stanu pilnujemy tutaj, a nie CHECK-iem w bazie: strażnik migracji nie pozwala dokładać ograniczeń
// do istniejącej tabeli. Wszystkie zapisy kart (karta, hurt, tworzenie) idą przez tę funkcję, więc ujemny próg albo
// napis z formularza, który ominął parser, kończy się wyjątkiem zamiast wartością, której ostrzeżenie nie zrozumie.
const progDoZapisu = (wartosc) => {
  if (wartosc == null) return null;
  if (Number.isSafeInteger(wartosc) && wartosc >= 0) return wartosc;
  throw new Error(`zapis karty: próg niskiego stanu „${wartosc}" nie jest liczbą całkowitą od 0 w górę`);
};
const wartoscPola = (pole, wartosc) => (pole === 'prog_niskiego_stanu' ? progDoZapisu(wartosc) : (wartosc ?? null));

// Porównanie zgodne z typem kolumny SQLite, bez parsowania tekstowych JSON-ów.
const POLA_LICZBOWE = [
  'szerokosc_mm',
  'wysokosc_mm',
  'glebokosc_mm',
  'waga_g',
  'cena_gr',
  'wycofana',
  'prog_niskiego_stanu',
];
const doPorownania = (pole, wartosc) => {
  const w = wartoscPola(pole, wartosc);
  return w === null ? null : POLA_LICZBOWE.includes(pole) ? Number(w) : String(w);
};
const zmienionePola = (db, id, zmiany) => {
  const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
  return karta ? Object.keys(zmiany).filter((pole) => doPorownania(pole, zmiany[pole]) !== karta[pole]) : [];
};
function oznaczReczne(db, id, pola, zrodlo, at) {
  const reczne = (p) =>
    POLA_ZASTANE.includes(p) || p === 'opis_sekcje_json' || p === 'marka' || p === 'informacja_bezpieczenstwa';
  for (const pole of pola.filter(reczne)) {
    db.prepare(
      `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
      zrodlo = excluded.zrodlo, reczne = 1, zmieniono_at = excluded.zmieniono_at`,
    ).run(id, pole, zrodlo, at);
  }
}

export function utworzKarte(db, karta, { at = teraz(), zrodlo = null } = {}) {
  if (!karta?.nazwa) throw new Error('utworzKarte: karta bez nazwy');

  const pola = POLA_KARTY.filter((k) => karta[k] !== undefined);
  const kolumny = [...pola, 'utworzony_at', 'zmieniony_at'];
  const wartosci = [...pola.map((k) => wartoscPola(k, karta[k])), at, at];

  const r = db
    .prepare(`INSERT INTO karty_produktow (${kolumny.join(', ')}) VALUES (${kolumny.map(() => '?').join(', ')})`)
    .run(...wartosci);
  const id = liczba(r.lastInsertRowid);
  if (zrodlo === 'reczne') oznaczReczne(db, id, pola, zrodlo, at);
  return id;
}

/**
 * Zapisuje WYLACZNIE wskazane pola karty i stempluje date zmiany.
 *
 * ⚠️ Pole spoza bialej listy konczy sie WYJATKIEM, a nie cichym pominieciem. Ciche
 * pominiecie przy edycji hurtem znaczyloby „zaznaczylem 600 kart, ustawilem kategorie
 * i nic sie nie stalo" — bez jednego komunikatu.
 */
export function zapiszKarte(db, id, zmiany, { at = teraz(), zrodlo = 'reczne' } = {}) {
  const pola = Object.keys(zmiany ?? {});
  for (const pole of pola) {
    if (!POLA_KARTY.includes(pole)) throw new Error(`zapiszKarte: nieznane pole „${pole}"`);
  }
  // Pusty zestaw zmian nie ma czego zapisac — i nie ma prawa przestawic `zmieniony_at`,
  // bo nic sie nie zmienilo.
  if (!pola.length) return;

  // SAVEPOINT działa także wewnątrz transakcji trasy API.
  db.exec('SAVEPOINT zapis_karty');
  try {
    const zmienione = zmienionePola(db, id, zmiany);
    if (zmienione.length) {
      db.prepare(
        `UPDATE karty_produktow SET ${zmienione.map((k) => `${k} = ?`).join(', ')}, zmieniony_at = ? WHERE id = ?`,
      ).run(...zmienione.map((k) => wartoscPola(k, zmiany[k])), at, id);
      oznaczReczne(db, id, zmienione, zrodlo, at);
    }
    db.exec('RELEASE zapis_karty');
  } catch (e) {
    db.exec('ROLLBACK TO zapis_karty');
    db.exec('RELEASE zapis_karty');
    throw e;
  }
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
  const numery = [...new Set((ids ?? []).filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number))];
  if (!numery.length) return [];
  return db
    .prepare(
      `SELECT * FROM karty_produktow WHERE id IN (${numery.map(() => '?').join(', ')})` +
        ' ORDER BY nazwa COLLATE NOCASE ASC, id ASC',
    )
    .all(...numery)
    .map((w) => ({ ...w }));
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
export function zastosujHurtem(db, plan, { at = teraz(), zrodlo = 'reczne', kto = null } = {}) {
  const kroki = (plan ?? []).filter(
    (k) => k && (Object.keys(k.zmiany ?? {}).length || k.cenaZakupu || Object.keys(k.parametry ?? {}).length),
  );
  for (const { zmiany = {} } of kroki) {
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
      zapytania.set(
        klucz,
        db.prepare(
          `UPDATE karty_produktow SET ${pola.map((k) => `${k} = ?`).join(', ')}, zmieniony_at = ? WHERE id = ?`,
        ),
      );
    }
    return zapytania.get(klucz);
  };

  // Zapis marki może już mieć transakcję wspólną z dopisaniem jej do słownika.
  const wlasnaTransakcja = !db.isTransaction;
  if (wlasnaTransakcja) db.exec('BEGIN IMMEDIATE');
  try {
    let zmienione = 0;
    for (const { id, zmiany = {}, cenaZakupu, parametry = {} } of kroki) {
      // Wyjątek od „hurt zmienia tylko kolumny karty”: cena zakupu ma własną tabelę z historią.
      // Zapis w tej samej transakcji (odmowa cofa oba) i bez `zmieniony_at` karty — cena zakupu
      // nie wychodzi do API, więc jej zmiana nie może kazać klientom API pobierać kart od nowa.
      let ruszona = false;
      if (cenaZakupu) {
        zapiszCeneZakupu(db, id, cenaZakupu, { zrodlo: 'hurt', kto, at });
        ruszona = true;
      }
      const pola = zmienionePola(db, id, zmiany);
      if (pola.length) {
        const r = zapytanie(pola).run(...pola.map((k) => wartoscPola(k, zmiany[k])), at, id);
        oznaczReczne(db, id, pola, zrodlo, at);
        if (liczba(r.changes)) ruszona = true;
      }
      // Parametry własne mają własną tabelę (autor i data przy każdej wartości), więc — jak cena
      // zakupu — nie przestawiają `zmieniony_at` karty. Wartość sprawdza ponownie warstwa
      // parametrów; odmowa przerywa CAŁY przebieg, bo podgląd obiecał zapis wszystkich kart.
      for (const [parametrId, wartosc] of Object.entries(parametry)) {
        const r =
          wartosc === null
            ? wyczyscWartoscKarty(db, id, parametrId)
            : ustawWartoscKarty(db, id, parametrId, wartosc, { at, kto });
        if (r.blad) throw new Error(`zastosujHurtem: ${r.blad}`);
        if (r.zmieniono) ruszona = true;
      }
      // Liczymy KARTY, nie zapisy: cena i stawka na jednej karcie to jedna zmieniona karta.
      if (ruszona) zmienione += 1;
    }
    if (wlasnaTransakcja) db.exec('COMMIT');
    return zmienione;
  } catch (e) {
    if (wlasnaTransakcja) db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * WSZYSTKIE numery, ktore sa juz czyjas tozsamoscia — nasze i te ZYJACE W SKLEPACH.
 * Oddaje `Map` „numer wielkimi literami" → „skad go znamy".
 *
 * ⚠️⚠️ OBA ZBIORY, I TO JEST CALA TRESC TEJ FUNKCJI. `karty.sku` ma `UNIQUE`, wiec o nasze
 * numery baza upomni sie sama; o setki numerów żyjących w sklepach NIE UPOMNI SIE NIKT.
 * Numer nadany karcie w panelu jedzie do sklepu — jesli tam juz jest, to jest CUDZEGO produktu.
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
 * nie daje sie z niczym zrobic — a przy setkach wierszy czlowiek nie ma jak tego sam odszukac.
 * Kolejnosc jawna, zeby przy tym samym numerze po obu stronach zrodlo pokazane czlowiekowi
 * bylo POWTARZALNE, a nie zalezne od planu zapytania.
 *
 * ⚠️⚠️ `pomijajProduktyKart` SLUZY WYLACZNIE PRZEJECIU NUMERU ZE SKLEPU
 * (`domena/przejecie-sku.js`) i bez niego tamten ekran nie dzialalby NIGDY: numer, ktory karta
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
    const klucz = String(sku ?? '')
      .trim()
      .toUpperCase();
    if (klucz && !zajete.has(klucz)) zajete.set(klucz, skad);
  };

  for (const w of db
    .prepare("SELECT id, nazwa, sku FROM karty_produktow WHERE sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY id")
    .all()) {
    dodaj(w.sku, `karta „${w.nazwa}" (#${w.id})`);
  }

  // ⚠️ NUMERY KART ODSIEWANE TAK SAMO, JAK W `kartyPoIdach`: identyfikatory przychodza
  // z zadania HTTP, a `IN` sklejane jest z tekstu. Wartosc, ktora nie jest bezpieczna liczba
  // calkowita, nie ma prawa dojsc do SQL-a.
  const pomijane = [
    ...new Set((pomijajProduktyKart ?? []).filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number)),
  ];
  // ⚠️ `karta_id IS NULL OR karta_id NOT IN (...)`: produkt NIEPOWIAZANY z zadna karta ma
  // zostac. `NOT IN` na kolumnie nullowalnej sam z siebie odsiewa NULL-e (porownanie z NULL
  // nie jest prawdziwe), czyli bez tego warunku znikneloby 1241 numerow niepowiazanych.
  const gdzie = pomijane.length
    ? ` AND (karta_id IS NULL OR karta_id NOT IN (${pomijane.map(() => '?').join(', ')}))`
    : '';

  for (const p of db
    .prepare(
      'SELECT kanal, nazwa, sku_sklepu FROM produkty_sklepowe' +
        " WHERE sku_sklepu IS NOT NULL AND TRIM(sku_sklepu) <> ''" +
        `${gdzie} ORDER BY kanal, id`,
    )
    .all(...pomijane)) {
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
 * (reguła: pominięte wracają z powodem).
 *
 * ⚠️⚠️ TRANSAKCJA JEST OBOWIAZKOWA. Czesciowo ponumerowany katalog jest GORSZY niz odmowa:
 * blad w polowie setek kart zostawilby polowe rejestru z numerami, a drugie
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
 * Setki numerow z jednego klikniecia dostaja JEDEN znacznik — po nim i tylko po nim da sie
 * potem powiedziec „to sa te z tamtego przycisku".
 */
export function nadajSku(db, plan, { at = teraz() } = {}) {
  const kroki = (plan ?? []).filter((k) => k && k.sku !== null && k.sku !== undefined);
  const nadane = [];
  const nieaktualne = [];
  if (!kroki.length) return { nadane, nieaktualne };

  // Import wola to wewnatrz WLASNEJ transakcji (lustro + karty + SKU razem albo nic); zagniezdzony
  // `BEGIN` rzucilby blad, a ROLLBACK tutaj cofnalby cudza prace — wtedy zostawiamy ja wolajacemu.
  const wlasna = !db.isTransaction;
  if (wlasna) db.exec('BEGIN IMMEDIATE');
  try {
    const zapytanie = db.prepare(
      'UPDATE karty_produktow SET sku = ?, zmieniony_at = ?' + " WHERE id = ? AND (sku IS NULL OR TRIM(sku) = '')",
    );
    for (const { id, sku } of kroki) {
      const r = zapytanie.run(sku, at, id);
      (liczba(r.changes) ? nadane : nieaktualne).push(id);
    }
    if (wlasna) db.exec('COMMIT');
    return { nadane, nieaktualne };
  } catch (e) {
    if (wlasna) db.exec('ROLLBACK');
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
 * addytywna, a nowego klucza obcego na istniejacej tabeli kontrola migracji nie przepuszcza.
 */
export function powiazProdukt(db, produktSklepowyId, kartaId, { konto = null } = {}) {
  if (kartaId !== null && kartaId !== undefined) wymagajKarty(db, kartaId);
  const stara =
    db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(produktSklepowyId)?.karta_id ?? null;
  // Pierwsze wiązanie (stara = null) nie mierzy zużycia — import i „Utwórz karty”
  // wiążą setki produktów.
  // Ślad i tak powstaje, gdy oferta miała sprzedaż, bo mierzymy tylko przy przepięciu albo odpięciu.
  wSavepoincie(db, 'powiaz_produkt', () =>
    przeniesPowiazanie(
      db,
      produktSklepowyId,
      kartaId ?? null,
      () => {
        db.prepare('UPDATE produkty_sklepowe SET karta_id = ? WHERE id = ?').run(kartaId ?? null, produktSklepowyId);
        // Przepięcie z karty na inną (albo odpięcie) zeruje `tresc_pobrana_at` — oferta wraca do kolejki
        // „Pobierz treść i zdjęcia ofert". Tylko wtedy, bo pierwsze wiązanie (stara = null) działa też
        // na bazie sprzed migracji rdzen/0012.
        if (stara !== null && String(stara) !== String(kartaId ?? '')) {
          db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = NULL WHERE id = ?').run(produktSklepowyId);
        }
        return true;
      },
      { konto, mierz: stara !== null },
    ),
  );
}

// ================================================================================
// PRZEPIĘCIE OFERTY — rejestr, podgląd, ślad
//
// Lustro (`produkty_sklepowe.karta_id`) i rejestr (`oferty_kanalow.karta_id`) mówią o tej samej ofercie.
// Przepięcie zmienia OBA w jednej transakcji (rejestr ma pierwszeństwo przy liczeniu stanu — `kartyLustraZ`),
// inaczej stan nadal zdejmowałby się ze starej karty. Odpięcie nie może wyzerować `karta_id` rejestru
// (NOT NULL), więc wyłącza wysyłkę ilości (`ilosc_z_oms = 0`) i zapisuje problem `brak-karty`.
// Przy włączonych stanach sprzedaż od granicy przechodzi z ofertą; ile — zapisuje ślad `stany_przepiecia`.

const maTabeleM = (db, nazwa) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));
const maKolumne = (db, tabela, kolumna) =>
  Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(tabela, kolumna));

/** Przełącznik stanów, gdy stany są włączone; `null` przy wyłączonych albo bazie bez tabeli przełącznika. */
function stanyWlaczone(db) {
  if (!maTabeleM(db, 'magazyn_przelaczenia')) return null;
  const przelacznik = przelacznikStanow(db);
  return przelacznik.wlaczone ? przelacznik : null;
}

/** SAVEPOINT działa w transakcji i poza nią — `powiazProdukt` woła się z obu miejsc. */
function wSavepoincie(db, nazwa, fn) {
  db.exec(`SAVEPOINT ${nazwa}`);
  try {
    const wynik = fn();
    db.exec(`RELEASE ${nazwa}`);
    return wynik;
  } catch (e) {
    db.exec(`ROLLBACK TO ${nazwa}`);
    db.exec(`RELEASE ${nazwa}`);
    throw e;
  }
}

/**
 * Rejestr idzie za lustrem: tylko wiersze przejęte (`pochodzenie = 'przejeta'`) — oferta wystawiona z OMS-u
 * (`'oms'`) należy do karty, z której powstała. Identyfikator wariantu Woo to `produkt/wariant`; dopasowanie
 * dokładne, więc przepięcie wariantu nie rusza rodzica ani innych wariantów.
 */
function przeniesWRejestrze(db, produkt, naKarte, at) {
  if (!maTabeleM(db, 'oferty_kanalow')) return;
  const idZewnetrzne = produkt.wariant_id ? `${produkt.produkt_id}/${produkt.wariant_id}` : String(produkt.produkt_id);
  if (naKarte !== null) {
    db.prepare(
      `UPDATE oferty_kanalow SET karta_id = ?, zmieniono_at = ?
      WHERE kanal = ? AND id_zewnetrzne = ? AND pochodzenie = 'przejeta' AND karta_id <> ?`,
    ).run(naKarte, at, produkt.kanal, idZewnetrzne, naKarte);
    // Ponowne powiązanie po odpięciu: `brak-karty` stawiamy tylko przy fladze 1, więc wracamy do wysyłki z OMS-u;
    // pierwszą wysyłkę i tak pilnuje próg skoku (`skokIlosci` w domena/ilosc-kanalu.js).
    if (maKolumne(db, 'oferty_kanalow', 'ilosc_z_oms')) {
      db.prepare(
        `UPDATE oferty_kanalow SET ilosc_z_oms = 1, ilosc_problem_json = NULL, zmieniono_at = ?
        WHERE kanal = ? AND id_zewnetrzne = ? AND pochodzenie = 'przejeta' AND ilosc_z_oms = 0
          AND json_extract(ilosc_problem_json, '$.kod') = 'brak-karty'`,
      ).run(at, produkt.kanal, idZewnetrzne);
    }
    return;
  }
  if (!maKolumne(db, 'oferty_kanalow', 'ilosc_z_oms')) return;
  db.prepare(
    `UPDATE oferty_kanalow SET ilosc_z_oms = 0, ilosc_problem_json = ?, zmieniono_at = ?
    WHERE kanal = ? AND id_zewnetrzne = ? AND pochodzenie = 'przejeta' AND ilosc_z_oms = 1`,
  ).run(JSON.stringify({ ...PROBLEMY_ILOSCI['brak-karty'], od: at }), at, produkt.kanal, idZewnetrzne);
}

/**
 * Wspólny tok przepięcia: `zmienLustro()` robi właściwą zmianę lustra i oddaje, czy coś zmieniło.
 * Dopiero potem rejestr i ślad — w tej samej transakcji, co wołający.
 */
function przeniesPowiazanie(db, produktSklepowyId, naKarte, zmienLustro, { konto = null, mierz = true } = {}) {
  const produkt = db
    .prepare('SELECT id, kanal, produkt_id, wariant_id, karta_id FROM produkty_sklepowe WHERE id = ?')
    .get(produktSklepowyId);
  const przelacznik = produkt ? stanyWlaczone(db) : null;
  const przed = przelacznik && mierz ? zuzycieProduktuOdGranicy(db, produkt.produkt_id, przelacznik) : null;
  const zmieniono = zmienLustro();
  if (!zmieniono || !produkt) return zmieniono;
  const zKarty = produkt.karta_id === null ? null : liczba(produkt.karta_id);
  if (zKarty === naKarte) return zmieniono;
  const at = teraz();
  przeniesWRejestrze(db, produkt, naKarte, at);
  if (!przed || !maTabeleM(db, 'stany_przepiecia')) return zmieniono;
  const po = zuzycieProduktuOdGranicy(db, produkt.produkt_id, przelacznik);
  const roznica = (id) => (id === null ? 0 : Math.abs((po.get(id) ?? 0) - (przed.get(id) ?? 0)));
  const iloscWstecz = Math.max(roznica(zKarty), roznica(naKarte));
  if (zKarty === null && iloscWstecz === 0) return zmieniono;
  zapiszPrzepiecie(
    db,
    {
      kanal: produkt.kanal,
      produktId: String(produkt.produkt_id),
      wariantId: produkt.wariant_id ? String(produkt.wariant_id) : null,
      zKarty,
      naKarte,
      iloscWstecz,
      kontoLogin: konto?.login ?? null,
    },
    { teraz: at },
  );
  return zmieniono;
}

/**
 * Podgląd przepięć przy włączonych stanach: jak zmieni się stan kart, gdy zamówienia od granicy
 * przejdą z ofertą. Nic nie zapisuje — zmiana lustra żyje tylko w SAVEPOINT, który cofamy.
 * `null` przy wyłączonych stanach.
 * `zmiany`: `[{ produktSklepowyId, naKarte }]` (`naKarte = null` — odpięcie).
 */
export function podgladPrzepiec(db, zmiany) {
  const przelacznik = stanyWlaczone(db);
  if (!przelacznik) return null;
  const przed = stanyKart(db, przelacznik).stany;
  db.exec('SAVEPOINT podglad_przepiecia');
  let po;
  try {
    const zmien = db.prepare('UPDATE produkty_sklepowe SET karta_id = ? WHERE id = ?');
    for (const { produktSklepowyId, naKarte } of zmiany ?? []) zmien.run(naKarte ?? null, produktSklepowyId);
    po = stanyKart(db, przelacznik).stany;
  } finally {
    db.exec('ROLLBACK TO podglad_przepiecia');
    db.exec('RELEASE podglad_przepiecia');
  }
  const stan = (mapa, id) => mapa.get(id)?.stan ?? 0;
  const ids = [...new Set([...przed.keys(), ...po.keys()])]
    .filter((id) => stan(przed, id) !== stan(po, id))
    .sort((a, b) => a - b);
  const nazwa = db.prepare('SELECT nazwa FROM karty_produktow WHERE id = ?');
  return {
    granica: przelacznik.granica,
    karty: ids.map((kartaId) => ({
      kartaId,
      nazwa: nazwa.get(kartaId)?.nazwa ?? `#${kartaId}`,
      przed: stan(przed, kartaId),
      po: stan(po, kartaId),
    })),
  };
}

/** Odmowa powiazania z karta, ktorej nie ma — zamiast cichego wiersza wskazujacego w proznie. */
function wymagajKarty(db, kartaId) {
  if (!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(kartaId)) {
    throw new Error(`Nie ma karty produktu ${kartaId} — powiązanie odrzucone.`);
  }
}

// ⚠️⚠️ BRAKI JAKO WYRAZENIA SQL — JEDNA DEFINICJA KAZDEGO, uzywana w CZTERECH
// miejscach naraz: filtr `brak=…`, kolumna `liczba_brakow` wiersza listy, sortowanie 'braki'
// i zliczenia kafli nad tabela. Kafel PROWADZI do listy, wiec druga kopia ktoregokolwiek
// wyrazenia znaczylaby „kafel mowi 217, lista pokazuje 214" — bez jednego bledu i bez
// szansy zgadniecia, ktora liczba klamie.
//
// ⚠️ ALIAS `w.` JEST CZESCIA KONTRAKTU: te wyrazenia wklejamy do OBU zapytan listy, a oba
// nazywaja tabele kart `karty w` (patrz `kartyZKanalami`).
// ⚠️ Z TRIM, tak samo jak `nadajSku` i `bezSku` w `domena/przejecie-sku.js`: SKU z samych
// spacji to brak, nie numer — spojnosc z reszta modulu, inaczej „komplet" tutaj i „nadaj
// numer" na karcie przeczylyby sobie o tym samym karcie.
const BRAK_SKU_SQL = "(w.sku IS NULL OR TRIM(w.sku) = '')";
// Polowiczny wymiar to nadal brak: do ciecia potrzebne sa OBA (reguła: oba wymiary albo żaden).
const BRAK_WYMIAROW_SQL = '(w.szerokosc_mm IS NULL OR w.wysokosc_mm IS NULL)';
// Kategorie z encjami HTML (lustro sklepu: „DIY &amp;amp; Craft") porownujemy
// po zdekodowaniu — ta sama `dekodujEncje` co przy zapisie kart, zarejestrowana raz
// na polaczenie jako deterministyczna funkcja SQL (lista pozycji filtru i sam filtr).
const DEKODUJ_SQL = 'oms_dekoduj_encje';
const zDekodowaniem = new WeakSet();
function zarejestrujDekodowanie(db) {
  // Opakowanie polaczenia bez `function` (np. licznik zapytan w testach): funkcja zyje na
  // polaczeniu pod spodem, wiec rejestrujemy tylko tam, gdzie sie da.
  if (zDekodowaniem.has(db) || typeof db.function !== 'function') return;
  db.function(DEKODUJ_SQL, { deterministic: true }, (napis) => (napis == null ? null : dekodujEncje(napis)));
  zDekodowaniem.add(db);
}

const BRAK_KATEGORII_SQL = "(w.kategoria_glowna IS NULL OR w.kategoria_glowna = '')";
const BRAK_ZDJECIA_SQL = 'NOT EXISTS (SELECT 1 FROM zdjecia_kart z WHERE z.karta_id = w.id)';
// json_valid w CASE: json_array_length na popsutym napisie RZUCA i wywraca całą listę
// (jak przy filtrze kategorii niżej).
const BRAK_OPISU_SQL =
  "(w.opis_sekcje_json IS NULL OR COALESCE(CASE WHEN json_valid(w.opis_sekcje_json) THEN json_array_length(w.opis_sekcje_json, '$.sekcje') END, 0) = 0)";
// Brak wartości parametru na karcie = brak wiersza w `karty_parametry` (pusty zapis kasuje wiersz).
// Aliasy `kpar`/`ppar` są własne tych wyrażeń, żeby nie zasłaniać `pk`/`pf` z filtrów niżej.
const BEZ_WARTOSCI_SQL =
  'NOT EXISTS (SELECT 1 FROM karty_parametry kpar WHERE kpar.karta_id = w.id AND kpar.parametr_id = ?)';
// Każdy WYMAGANY parametr własny bez wartości to osobny brak. Korelowane podzapytanie na karcie
// trafia w klucz główny `karty_parametry (karta_id, parametr_id)`, a parametrów firma ma najwyżej
// kilkadziesiąt — tysiąc kart liczy się bez skanu wartości.
const BRAKI_PARAMETROW_SQL =
  '(SELECT COUNT(*) FROM parametry_kart ppar WHERE ppar.wymagany = 1 AND NOT EXISTS' +
  ' (SELECT 1 FROM karty_parametry kpar WHERE kpar.karta_id = w.id AND kpar.parametr_id = ppar.id))';
const LICZBA_BRAKOW_SQL =
  `((CASE WHEN ${BRAK_SKU_SQL} THEN 1 ELSE 0 END)` +
  ` + (CASE WHEN ${BRAK_WYMIAROW_SQL} THEN 1 ELSE 0 END)` +
  ` + (CASE WHEN ${BRAK_KATEGORII_SQL} THEN 1 ELSE 0 END)` +
  ` + ${BRAKI_PARAMETROW_SQL}` +
  ` + (CASE WHEN ${BRAK_ZDJECIA_SQL} THEN 1 ELSE 0 END)` +
  ` + (CASE WHEN ${BRAK_OPISU_SQL} THEN 1 ELSE 0 END))`;

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
  marka: "NULLIF(w.marka, '') COLLATE NOCASE",
  cena: 'w.cena_gr',
  // KOLEJKA ROBOTY: malejaco daje na czele karty, przy ktorych jest najwiecej do zrobienia.
  // Wyrazenie NIGDY nie jest NULL-em (suma CASE-ow), wiec `NULLS LAST` nizej jest
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
 * Filtr parametru własnego. Typ czytamy z bazy, a nie z adresu: zawężenie hurtu przychodzi bez
 * listy definicji, a lista na ekranie i hurt muszą trafić w TE SAME karty.
 * „Bez wartości” = brak wiersza w `karty_parametry`. Liczba porównywana przez CAST, bo wartość
 * leży jako napis kanoniczny (`7.5`) — porównanie napisów dałoby „60” > „100”.
 */
function warunekParametru({ parametr, pw, pod, pdo, pbez }, czesci, params) {
  if (parametr == null) return;
  const id = Number(parametr);
  if (!Number.isSafeInteger(id) || id <= 0) {
    czesci.push('1 = 0');
    return;
  }
  if (pbez) {
    czesci.push(`EXISTS (SELECT 1 FROM parametry_kart WHERE id = ?) AND ${BEZ_WARTOSCI_SQL}`);
    params.push(id, id);
    return;
  }
  let warunek =
    'EXISTS (SELECT 1 FROM karty_parametry kpar JOIN parametry_kart ppar ON ppar.id = kpar.parametr_id' +
    ' WHERE kpar.karta_id = w.id AND kpar.parametr_id = ?';
  params.push(id);
  if (pw != null) {
    // Tekst: „zawiera”; lista i liczba: dokładna wartość kanoniczna.
    warunek += " AND (CASE ppar.typ WHEN 'tekst' THEN kpar.wartosc LIKE ? ESCAPE '\\' ELSE kpar.wartosc = ? END)";
    params.push(`%${uciekniecieLike(String(pw))}%`, String(pw));
  }
  if (pod != null) {
    warunek += " AND ppar.typ = 'liczba' AND CAST(kpar.wartosc AS REAL) >= ?";
    params.push(Number(pod));
  }
  if (pdo != null) {
    warunek += " AND ppar.typ = 'liczba' AND CAST(kpar.wartosc AS REAL) <= ?";
    params.push(Number(pdo));
  }
  czesci.push(`${warunek})`);
}

/**
 * Warunki listy kart — budowane RAZ i uzyte w OBU zapytaniach (karty i ich produkty),
 * zeby drugie zapytanie nie mialo szansy rozjechac sie z pierwszym.
 *
 * ⚠️ ZASADA NADRZEDNA: filtr, ktorego nie rozumiemy, oddaje PUSTO, a nie wszystko.
 * Po filtrze braków idzie zaznaczenie calej listy i edycja hurtem — cicho zignorowany
 * filtr znaczylby hurtowa zmiane na calym katalogu zamiast na dwudziestu brakach.
 */
function warunkiKart({ fraza, filtry = {}, kanalyErli = [] }) {
  const czesci = ['1 = 1'];
  const params = [];
  if (filtry.oferty != null) {
    const istnieje = 'EXISTS (SELECT 1 FROM oferty_kanalow ok WHERE ok.karta_id = w.id';
    if (filtry.oferty === 'bez') czesci.push(`NOT ${istnieje})`);
    else if (filtry.oferty === 'z') czesci.push(`${istnieje})`);
    else if (filtry.oferty === 'problem')
      czesci.push(
        `${istnieje} AND (ok.stan IN ('problem', 'blad') OR ok.blad IS NOT NULL OR ok.problemy_json <> '[]'))`,
      );
    else czesci.push('1 = 0');
  }

  const f = String(fraza ?? '').trim();
  if (f) {
    // Wielkosc liter: LIKE w SQLite jest nieczuly na nia w zakresie ASCII. Polskie znaki
    // diakrytyczne pozostaja czule — „Ćma" nie znajdzie sie po „ćma". Swiadome ograniczenie
    // silnika, nie przeoczenie: fraza dziala po ASCII, reszte lapie fragment nazwy.
    czesci.push("(w.nazwa LIKE ? ESCAPE '\\' OR w.sku LIKE ? ESCAPE '\\' OR w.ean LIKE (? || '%') ESCAPE '\\')");
    const frazaLike = uciekniecieLike(f);
    const wzorzec = `%${frazaLike}%`;
    params.push(wzorzec, wzorzec, frazaLike);
  }

  // KANAL i ZAKRES CENY opisuja TEN SAM produkt, dlatego siedza w jednym EXISTS: „sklep B od
  // 100 zl" ma nie pokazywac karty, ktora w sklepie B kosztuje 20 zl, a setke przekracza dopiero
  // na Allegro.
  //
  // ⚠️ `zniknal_at IS NULL` — produkt wycofany ze sklepu NIE jest juz obecnoscia w kanale.
  // Wiersz zostaje w bazie (powiazanie ma przezyc), ale jego cena przestaje twierdzic,
  // ze karta da sie tam kupic.
  //
  // ⚠️ Szkic (`status_publikacji = 'draft'`) tez nie jest obecnoscia: kupujacy go nie widzi,
  // tak samo jak oferty Allegro spoza ACTIVE. Warunek jest wspolny dla wszystkich kanalow,
  // bo Allegro wartosci 'draft' nie uzywa.
  //
  // ⚠️ ALIAS `pf` (nie `p`!) JEST CZESCIA KONTRAKTU TEGO BUILDERA. `gdzie` z tej funkcji
  // wklejamy do DWOCH zapytan w `kartyZKanalami` — a drugie z nich juz ma wlasny alias `p`
  // (`SELECT p.* FROM produkty_sklepowe p WHERE ... AND p.karta_id IN (SELECT w.id FROM karty_produktow
  // w WHERE ${gdzie})`). Gdyby ten EXISTS uzywal tez `p`, SQLite rozwiazalby go poprawnie
  // (najglebszy zakres wygrywa), wiec dzis dziala — ale to mina: kolejny warunek dopisany
  // tutaj z mysla o „zewnetrznym" `p`, albo usuniety alias z podzapytania, zaczalby po cichu
  // znaczyc co innego, bez bledu skladni i bez czerwonego testu na malych danych.
  const { kanal, cenaOd, cenaDo, kategoria, marka, brak } = filtry;
  if (marka) {
    czesci.push('w.marka = ?');
    params.push(marka);
  }
  // ⚠️ KONTO ERLI NIE MA LUSTRA — jego cena i obecnosc to AKTYWNA oferta z rejestru (`ok`, nie
  // `p`/`pf`, z tego samego powodu co alias nizej). Cena: odczytana z ERLI, a bez odczytu wyslana —
  // ta sama, ktora pokazuje kolumna. Oferta w innym stanie nie jest w sprzedazy, wiec nie zaweza.
  const cenaErli = 'COALESCE(ok.odczyt_cena_gr, ok.wyslana_cena_gr)';
  const ofertaErli = (warunekKanalu, paramsKanalu) => {
    const pod = ['ok.karta_id = w.id', warunekKanalu, "ok.stan = 'aktywna'"];
    const p = [...paramsKanalu];
    if (cenaOd != null) {
      pod.push(`${cenaErli} >= ?`);
      p.push(Number(cenaOd));
    }
    if (cenaDo != null) {
      pod.push(`${cenaErli} <= ?`);
      p.push(Number(cenaDo));
    }
    return { sql: `EXISTS (SELECT 1 FROM oferty_kanalow ok WHERE ${pod.join(' AND ')})`, params: p };
  };
  if (kanal && kanalyErli.includes(kanal)) {
    const erli = ofertaErli('ok.kanal = ?', [kanal]);
    czesci.push(erli.sql);
    params.push(...erli.params);
  } else if (kanal || cenaOd != null || cenaDo != null) {
    const pod = ['pf.karta_id = w.id', 'pf.zniknal_at IS NULL', "COALESCE(pf.status_publikacji, '') != 'draft'"];
    if (kanal) {
      pod.push('pf.kanal = ?');
      params.push(kanal);
    }
    if (cenaOd != null) {
      pod.push('pf.cena_gr >= ?');
      params.push(Number(cenaOd));
    }
    if (cenaDo != null) {
      pod.push('pf.cena_gr <= ?');
      params.push(Number(cenaDo));
    }
    const lustro = `EXISTS (SELECT 1 FROM produkty_sklepowe pf WHERE ${pod.join(' AND ')})`;
    // Zakres ceny bez kanalu obejmuje wszystkie kolumny listy — takze konta ERLI.
    if (!kanal && kanalyErli.length) {
      const erli = ofertaErli(`ok.kanal IN (${kanalyErli.map(() => '?').join(', ')})`, kanalyErli);
      czesci.push(`(${lustro} OR ${erli.sql})`);
      params.push(...erli.params);
    } else {
      czesci.push(lustro);
    }
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
  //
  // ⚠️ Porownanie PO ZDEKODOWANIU encji HTML po obu stronach (`DEKODUJ_SQL`,
  // ta sama funkcja co `kategorieDoFiltra`) — „DIY & Craft" trafia w karte z ta kategoria
  // i w produkt lustra z „DIY &amp;amp; Craft". Funkcje SQL rejestruje `kartyZKanalami`.
  if (kategoria) {
    czesci.push(
      `(${DEKODUJ_SQL}(w.kategoria_glowna) = ?` +
        ' OR EXISTS (SELECT 1 FROM produkty_sklepowe pk WHERE pk.karta_id = w.id' +
        ' AND pk.zniknal_at IS NULL AND EXISTS (SELECT 1 FROM json_each(' +
        "CASE WHEN json_valid(pk.kategorie_json) THEN pk.kategorie_json ELSE '[]' END" +
        `) jk WHERE ${DEKODUJ_SQL}(jk.value) = ?)))`,
    );
    const szukana = dekodujEncje(kategoria);
    params.push(szukana, szukana);
  }

  warunekParametru(filtry, czesci, params);

  if (brak) {
    const brakParametru = idBrakuParametru(brak);
    if (brak === 'sku') czesci.push(BRAK_SKU_SQL);
    else if (brak === 'wymiary') czesci.push(BRAK_WYMIAROW_SQL);
    else if (brak === 'kategoria') czesci.push(BRAK_KATEGORII_SQL);
    // „bez: <parametr>” tylko dla WYMAGANEGO — to ta sama definicja braku, co w `LICZBA_BRAKOW_SQL`.
    // Nieobowiązkowy albo nieistniejący daje pusto (zawężenie hurtu przychodzi bez sprawdzenia listy).
    else if (brakParametru !== null) {
      czesci.push(`EXISTS (SELECT 1 FROM parametry_kart WHERE id = ? AND wymagany = 1) AND ${BEZ_WARTOSCI_SQL}`);
      params.push(brakParametru, brakParametru);
    } else if (brak === 'zdjecie') czesci.push(BRAK_ZDJECIA_SQL);
    else if (brak === 'opis') czesci.push(BRAK_OPISU_SQL);
    // Bez ceny zakupu OBOWIĄZUJĄCEJ DZIŚ (ta sama reguła „od <= dzień” co w ceny-zakupu.js):
    // karta tylko z przyszłą ceną też jest „bez ceny” — dziś nie da się z niej policzyć marży.
    // Celowo NIE w `LICZBA_BRAKOW_SQL`: cena zakupu nie jest warunkiem kompletu karty.
    else if (brak === 'cena_zakupu') {
      czesci.push('NOT EXISTS (SELECT 1 FROM ceny_zakupu_kart cz WHERE cz.karta_id = w.id AND cz.obowiazuje_od <= ?)');
      params.push(dzienWarszawa(new Date().toISOString()));
    }
    // ⚠️ KOMPLET NIE JEST BRAKIEM, tylko druga strona tej samej monety: karty,
    // ktorym NICZEGO nie brakuje. Kafel postepu prowadzi wlasnie tutaj, wiec liczba
    // w kaflu i dlugosc tej listy MUSZA wychodzic z tego samego wyrazenia.
    else if (brak === 'komplet') czesci.push(`${LICZBA_BRAKOW_SQL} = 0`);
    else czesci.push('1 = 0');
  }

  return { gdzie: czesci.join(' AND '), params };
}

// Kolumny tabeli z aliasem, bez wskazanych. Nazwy z `PRAGMA table_info`, czyli ze schematu,
// nie z zadania — bezpieczne do wklejenia w SELECT; cudzyslow i tak, na wypadek slowa kluczowego.
function kolumnyBez(db, tabela, alias, pomin) {
  return db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(tabela)
    .map((k) => String(k.name))
    .filter((nazwa) => !pomin.includes(nazwa))
    .map((nazwa) => `${alias}."${nazwa.replaceAll('"', '""')}"`)
    .join(', ');
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
 *
 * `kolumny: 'lista'` — wiersze dla ekranu listy, bez opisow karty i produktu: to najwieksze
 * kolumny katalogu, a lista ich nie pokazuje. Pelne wiersze (domyslnie) dla akcji hurtowych,
 * eksportu i karty. Kolumny wyliczone z tabeli z POMINIECIEM opisow, a nie wypisane wprost —
 * nowa kolumna karty ma trafic na liste sama, jak przy `w.*`.
 */
export function kartyZKanalami(db, { fraza, filtry, sort, kier, kolumny, limit = null, kanalyErli = [] } = {}) {
  if (filtry?.kategoria) zarejestrujDekodowanie(db);
  const warunki = warunkiKart({ fraza, filtry, kanalyErli });
  const wgStanu = czyFiltrStanu(filtry?.stan);
  const zrodlo = wgStanu ? 'karty_produktow w JOIN json_each(?) stan ON w.id = stan.value' : 'karty_produktow w';
  const gdzie = filtry?.stan && !wgStanu ? '1 = 0' : warunki.gdzie;
  const params = wgStanu
    ? [JSON.stringify(kartyWgStanu(db, filtry.stan)), ...warunki.params]
    : filtry?.stan
      ? []
      : warunki.params;
  const bezOpisow = kolumny === 'lista';
  const kolumnyKart = bezOpisow ? kolumnyBez(db, 'karty_produktow', 'w', ['opis', 'opis_sekcje_json']) : 'w.*';
  const kolumnyProduktow = bezOpisow ? kolumnyBez(db, 'produkty_sklepowe', 'p', ['opis_zrodlowy']) : 'p.*';

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
  const wyrazenie = Object.hasOwn(SORTOWANIE, sort) ? SORTOWANIE[sort] : SORTOWANIE[SORTOWANIE_DOMYSLNE];
  const kierunek = String(kier).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // Klucz elementu JSON odpowiada pozycji karty na liście ułożonej rosnąco po stanie.
  const kolejnosc =
    wgStanu && !Object.hasOwn(SORTOWANIE, sort) ? 'stan.key ASC' : `${wyrazenie} ${kierunek} NULLS LAST`;

  const karty = db
    .prepare(
      // `NULLS LAST` w OBU kierunkach: brak wartosci nie jest ani najmniejszy, ani najwiekszy
      // — to brak. Tysiac kart bez SKU na czele listy sortowanej po SKU nie odpowiada na
      // zadne pytanie; od szukania brakow jest filtr braków. `w.id` na koncu daje kolejnosc
      // powtarzalna miedzy odswiezeniami przy remisie.
      // `liczba_brakow` jedzie TYM SAMYM wyrazeniem, co filtr i kafel — wiersz listy nie ma
      // prawa twierdzic czego innego niz zawezenie, ktore go na te liste wpuscilo.
      `SELECT ${kolumnyKart}, ${LICZBA_BRAKOW_SQL} AS liczba_brakow FROM ${zrodlo}` +
        ` WHERE ${gdzie} ORDER BY ${kolejnosc}, w.id ASC` +
        (limit === null ? '' : ' LIMIT ?'),
    )
    .all(...(limit === null ? params : [...params, limit]));
  if (!karty.length) return [];

  // Przy podpowiedziach lustro i oferty pobieramy tylko dla kart, które zmieściły się w limicie.
  const wyborKart = limit === null ? `SELECT w.id FROM ${zrodlo} WHERE ${gdzie}` : 'SELECT value FROM json_each(?)';
  const parametryKart = limit === null ? params : [JSON.stringify(karty.map((w) => w.id))];
  const produkty = db
    .prepare(
      `SELECT ${kolumnyProduktow} FROM produkty_sklepowe p` +
        ` WHERE p.zniknal_at IS NULL AND COALESCE(p.status_publikacji, '') != 'draft'` +
        ` AND p.karta_id IN (${wyborKart})` +
        // Szkic nie jest obecnoscia: bez tego warunku karta pokazalaby komorke kanalu z cena
        // produktu, ktorego kupujacy nie widzi.
        // Po `p.id` rosnaco, bo przy dwoch wariantach tego samego kanalu wygrywa pierwszy —
        // wybor ma byc TEN SAM przy kazdym odswiezeniu, a nie zalezny od planu zapytania.
        ' ORDER BY p.id ASC',
    )
    .all(...parametryKart);

  // ⚠️ `kanaly` MUSI byc bez prototypu. `p.kanal` pochodzi z danych sklepu (lustro cudzego
  // API) — kanal o nazwie 'constructor' albo 'toString' na literale `{}` nie ustawilby
  // wlasnej wlasnosci, tylko po cichu odczytal/nadpisal metode z `Object.prototype`,
  // dokladnie ten sam wzorzec co przy bialej liscie sortowania wyzej.
  const oferty = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oferty_kanalow'").get()
    ? db
        .prepare(
          `SELECT karta_id, kanal, stan, blad, odczyt_cena_gr, wyslana_cena_gr FROM oferty_kanalow WHERE karta_id IN (${wyborKart}) ORDER BY kanal, id`,
        )
        .all(...parametryKart)
    : [];
  const wiersze = karty.map((w) => ({ ...w, kanaly: Object.create(null), oferty: [] }));
  const poId = new Map(wiersze.map((w) => [w.id, w]));
  for (const o of oferty) poId.get(o.karta_id)?.oferty.push(o);
  for (const p of produkty) {
    const wiersz = poId.get(p.karta_id);
    if (!wiersz) continue;
    if (!wiersz.kanaly[p.kanal]) wiersz.kanaly[p.kanal] = { ...p };
  }
  return wiersze;
}

/**
 * W ktorych kanalach (lustro sklepow) karty sa DOSTEPNE — material kolumny
 * „Kanały” listy magazynu. JEDNO zapytanie dla calej strony (numery kart jada jednym
 * parametrem JSON, bez limitu zmiennych SQLite i bez N+1). Dostepny = wiersz lustra z ta
 * karta i pustym `zniknal_at`; dla kanalow z `kanalyZeStatusem` (Allegro — rozpoznaje wolajacy
 * po typie z definicji kanalow) dodatkowo `status_publikacji = 'ACTIVE'` (INACTIVE, ENDED
 * odpadaja). Szkic sklepu (`status_publikacji = 'draft'`) odpada w kazdym kanale — kupujacy go
 * nie widzi; brak statusu (wiersz sprzed jego odczytu) liczy sie jako dostepnosc.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly (number|string)[]} kartaIds
 * @param {{ kanalyZeStatusem?: readonly string[] }} [opcje]
 * @returns {{ karta_id: number, kanal: string }[]}
 */
export function kanalyDostepnosciKart(db, kartaIds, { kanalyZeStatusem = [] } = {}) {
  if (!kartaIds.length) return [];
  return /** @type {any[]} */ (
    db
      .prepare(
        'SELECT DISTINCT karta_id, kanal FROM produkty_sklepowe' +
          " WHERE zniknal_at IS NULL AND COALESCE(status_publikacji, '') != 'draft'" +
          ' AND karta_id IN (SELECT value FROM json_each(?))' +
          " AND (kanal NOT IN (SELECT value FROM json_each(?)) OR status_publikacji = 'ACTIVE')",
      )
      .all(JSON.stringify(kartaIds.map(Number)), JSON.stringify([...kanalyZeStatusem]))
  );
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
 * ZYWY produkt ma juz wlasny numer w sklepie — jest wiec co przejac (domena/przejecie-sku.js).
 * Bez warunku o numerze sklepu ten kafel powtarzalby „bez SKU" i nie odpowiadal na nic.
 *
 * ⚠️ `COALESCE`, bo `SUM` na PUSTEJ tabeli oddaje NULL, a nie zero. Widok wypisalby to jako
 * puste miejsce w kaflu — czyli jak awaria odczytu, a nie jak „nic nie zostalo".
 *
 * @returns {{razem: number, bezSku: number, doPrzejecia: number, bezWymiarow: number,
 *            bezKategorii: number, komplet: number}}
 */
export function zliczeniaBrakow(db) {
  return db
    .prepare(
      'SELECT COUNT(*) AS razem' +
        `, COALESCE(SUM(CASE WHEN ${BRAK_SKU_SQL} THEN 1 ELSE 0 END), 0) AS bezSku` +
        `, COALESCE(SUM(CASE WHEN ${BRAK_SKU_SQL} AND EXISTS (SELECT 1 FROM produkty_sklepowe pz` +
        " WHERE pz.karta_id = w.id AND pz.zniknal_at IS NULL AND pz.sku_sklepu IS NOT NULL AND pz.sku_sklepu != '')" +
        ' THEN 1 ELSE 0 END), 0) AS doPrzejecia' +
        `, COALESCE(SUM(CASE WHEN ${BRAK_WYMIAROW_SQL} THEN 1 ELSE 0 END), 0) AS bezWymiarow` +
        `, COALESCE(SUM(CASE WHEN ${BRAK_KATEGORII_SQL} THEN 1 ELSE 0 END), 0) AS bezKategorii` +
        `, COALESCE(SUM(CASE WHEN ${BRAK_ZDJECIA_SQL} THEN 1 ELSE 0 END), 0) AS bezZdjecia` +
        `, COALESCE(SUM(CASE WHEN ${BRAK_OPISU_SQL} THEN 1 ELSE 0 END), 0) AS bezOpisu` +
        `, COALESCE(SUM(CASE WHEN ${LICZBA_BRAKOW_SQL} = 0 THEN 1 ELSE 0 END), 0) AS komplet` +
        ' FROM karty_produktow w',
    )
    .get();
}

/**
 * Ile produktow lustra czeka jeszcze na karte — i ile z tego jest ofertami Allegro.
 *
 * ⚠️ TEN SAM ZBIOR, CO `niepowiazaneProdukty`: zywe (`zniknal_at IS NULL`) i bez karty.
 * Kafel prowadzi na ekran zakladania kart, wiec nie ma prawa obiecywac roboty przy
 * wierszach, ktorych tamten ekran w ogole nie pokaze.
 *
 * ⚠️ OFERTY ALLEGRO WYDZIELONE, bo to INNA robota: oferty karty nie zakladaja
 * (reguła: oferta nie zakłada karty) —
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
  return db
    .prepare(
      'SELECT COUNT(*) AS pominiete' +
        `, COALESCE(SUM(CASE WHEN kanal IN (${konta.map(() => '?').join(', ')}) THEN 1 ELSE 0 END), 0) AS ofertyAllegro` +
        ' FROM produkty_sklepowe WHERE karta_id IS NULL AND zniknal_at IS NULL' +
        " AND COALESCE(status_publikacji, '') != 'draft'",
    )
    .get(...konta);
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
 * NIGDY (warianty bez rozmiaru i zaslepki, ktorych `powodPominiecia` nie powiaze),
 * wiec kategoria wystepujaca tylko u nich bylaby martwa pozycja bez konca.
 *
 * ⚠️ NAPRAWIAMY LISTE, A NIE FILTR. Poszerzenie filtru o produkty niepowiazane zmienialoby
 * ZNACZENIE filtru i dotykaloby rozstrzygniecia o nadzbiorze (`karty.kategoria_glowna`
 * ALBO kategorie produktow w lustrze) — a wynik tego filtru ma opisywac KARTY, nie zawartosc
 * lustra. Lista pozycji ma byc DOKLADNIE zbiorem osiagalnym przez filtr.
 *
 * ⚠️ `json_valid` z CASE i `jk.type = 'text'`: `json_each` na popsutym napisie RZUCA bledem,
 * ktory polozylby caly ekran, a liczba w tablicy kategorii weszlaby do pola wyboru jako
 * wartosc, ktorej porownanie z kolumna TEXT nigdy nie bedzie prawdziwe.
 *
 * ⚠️ Obie strony zlaczenia ida przez `dekodujEncje` (funkcja SQL `DEKODUJ_SQL`)
 * PRZED `DISTINCT` — inaczej „DIY & Craft" z karty i „DIY &amp;amp; Craft" z lustra staly
 * w polu wyboru obok siebie. Dekodowanie w SQL, a nie w JS po zapytaniu, bo filtr
 * (`warunkiKart`) musi porownywac TA SAMA funkcja, a tam wartosci z `json_each` sa tylko
 * w SQL; jedno wywolanie na kategorie (tysiace kart × kilka kategorii) to milisekundy.
 */
export function kategorieDoFiltra(db) {
  zarejestrujDekodowanie(db);
  return db
    .prepare(
      'SELECT DISTINCT k FROM (' +
        `  SELECT NULLIF(TRIM(${DEKODUJ_SQL}(w.kategoria_glowna)), '') AS k FROM karty_produktow w` +
        '  UNION' +
        `  SELECT NULLIF(TRIM(${DEKODUJ_SQL}(jk.value)), '') AS k FROM produkty_sklepowe pk, json_each(` +
        "    CASE WHEN json_valid(pk.kategorie_json) THEN pk.kategorie_json ELSE '[]' END" +
        "  ) jk WHERE pk.zniknal_at IS NULL AND pk.karta_id IS NOT NULL AND jk.type = 'text'" +
        ') WHERE k IS NOT NULL ORDER BY k COLLATE NOCASE',
    )
    .all()
    .map((w) => w.k);
}

/** Marki występujące na kartach — dokładnie wartości osiągalne przez filtr marki. */
export function markiDoFiltra(db) {
  return db
    .prepare(
      "SELECT DISTINCT marka FROM karty_produktow WHERE marka IS NOT NULL AND marka != ''" +
        ' ORDER BY marka COLLATE NOCASE',
    )
    .all()
    .map((w) => w.marka);
}

/**
 * Produkty sklepowe, z ktorych nie powstala jeszcze karta — material dla tworzenia hurtem.
 *
 * Produkt znikniety NIE wchodzi: zakladanie karty dla czegos, czego w sklepie juz nie ma,
 * doklada rejestrowi wiersz bez zadnego zastosowania. Szkic tez nie wchodzi: karta dla
 * produktu, ktorego sklep nie pokazuje, zasmieca rejestr tak samo.
 */
export function niepowiazaneProdukty(db) {
  return db
    .prepare(
      'SELECT * FROM produkty_sklepowe WHERE karta_id IS NULL AND zniknal_at IS NULL' +
        " AND COALESCE(status_publikacji, '') != 'draft' ORDER BY id ASC",
    )
    .all()
    .map((p) => ({ ...p }));
}

/**
 * Tworzenie kart HURTEM z niepowiazanych produktow — obsluga przycisku „Utworz karty
 * z niepowiazanych". Oddaje `{ utworzone, pominiete: [{ id, powod }] }`.
 *
 * Regula, CO staje sie karta i CO ta karta niesie, siedzi w `domena/karta-z-produktu.js` —
 * tutaj zostaje wylacznie przebieg po bazie. `powodPominiecia` jest JEDYNA bramka: gdyby obok
 * niej stal drugi warunek, ekran „pominiete" pokazywalby inny zbior niz ten, ktory faktycznie
 * odpadl, a to jest jedyne miejsce, gdzie wlasciciel widzi, czego panel nie tknal.
 *
 * ⚠️ TRANSAKCJA JEST OBOWIAZKOWA i nie chodzi tu tylko o czas. Po pierwsze, setki wstawien
 * w autocommicie to setki osobnych transakcji WAL z wlasnym fsync — zmierzone przy odczycie
 * katalogu: kilka tysięcy wierszy to sekundy wobec setek milisekund w transakcji.
 * Po drugie i wazniejsze: blad w polowie zostawilby POLOWE rejestru — czesc produktow
 * powiazana, czesc nie — a drugie klikniecie dolozyloby karty tylko do reszty, wiec rejestr
 * powstalby z dwoch roznych przebiegow i nikt by juz nie wiedzial, ktora karta skad jest.
 *
 * ⚠️ ODCZYT JEST W SRODKU TRANSAKCJI, nie przed nia: poller zamowien chodzi po TYM SAMYM
 * polaczeniu, a lista przeczytana przed `BEGIN` moglaby juz nie opisywac tego, co zapisujemy.
 * Cala funkcja jest SYNCHRONICZNA (zadnego `await`), wiec petla zdarzen nie wejdzie w srodek.
 *
 * ⚠️ Zegar pytany RAZ NA PRZEBIEG. Setki kart z jednego klikniecia maja jeden znacznik — po nim
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
 * setki wierszy wzrokiem i szuka po nazwie; kolejnosc odczytu z Allegro nie znaczy dla niego
 * nic. `p.id` na koncu daje rozstrzygniecie powtarzalne przy dwoch ofertach o tej samej nazwie.
 */
// Pusta lista niczego nie wybiera; nazwy kanałów wiążemy parametrami SQL.
export function niepowiazaneOfertyAllegro(db, kanaly) {
  wymagajListyKanalow(kanaly);
  if (!kanaly.length) return [];
  const warunek = `p.kanal IN (${kanaly.map(() => '?').join(', ')}) AND p.zniknal_at IS NULL`;
  return db
    .prepare(
      `SELECT p.* FROM produkty_sklepowe p WHERE ${warunek} AND p.karta_id IS NULL` +
        ' ORDER BY p.nazwa COLLATE NOCASE ASC, p.id ASC',
    )
    .all(...kanaly)
    .map((p) => ({ ...p }));
}

/**
 * Ile ofert Allegro czeka na powiazanie, BEZ zakonczonych — liczba przy wejsciu z listy magazynu.
 *
 * ⚠️ Jedno `COUNT`, nie dlugosc listy: lista niesie setki wierszy z `p.*`, a tu chodzi o liczbe.
 * Oferta bez znanego statusu liczy sie (ukrywamy tylko ENDED), tak samo jak na ekranie powiazan.
 */
export function liczbaNiepowiazanychOfertAllegro(db, kanaly) {
  wymagajListyKanalow(kanaly);
  if (!kanaly.length) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM produkty_sklepowe p WHERE p.kanal IN (${kanaly.map(() => '?').join(', ')})` +
        " AND p.zniknal_at IS NULL AND p.karta_id IS NULL AND p.status_publikacji IS NOT 'ENDED'",
    )
    .get(...kanaly).n;
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
  return db
    .prepare(
      'SELECT p.id AS id, p.kanal AS kanal, p.nazwa AS nazwa, p.karta_id AS karta_id,' +
        ' w.nazwa AS karta_nazwa, w.sku AS karta_sku, p.status_publikacji AS status_publikacji' +
        ' FROM produkty_sklepowe p JOIN karty_produktow w ON w.id = p.karta_id' +
        ` WHERE ${warunek}` +
        ' ORDER BY p.nazwa COLLATE NOCASE ASC, p.id ASC',
    )
    .all(...kanaly)
    .map((p) => ({ ...p }));
}

/**
 * Karty jako kandydaci do powiazania — nazwa, SKU i wymiary, czyli to, czym rozstrzyga sie
 * wybor (`domena/dopasowanie-ofert.js` liczy z nazwy i wymiarow, czlowiek patrzy na SKU).
 *
 * ⚠️ WYBRANE KOLUMNY, NIE `SELECT *`. Ta lista jedzie do liczenia propozycji dla KAZDEJ
 * z setek ofert i do jednej wspolnej listy podpowiedzi w HTML-u; `opis` (ponad sto znakow
 * razy setki kart) nie sluzy tam niczemu poza puchnieciem pamieci i strony.
 *
 * ⚠️ Zwraca PUSTO, gdy rejestr kart jest pusty — i to jest STAN DZISIEJSZY produkcji,
 * a nie przypadek krancowy: zakladanie kart to osobny przycisk. Ekran ma wtedy powiedziec,
 * ze najpierw trzeba zalozyc karty (patrz `web/routes/magazyn.js`).
 */
export function kartyDoPowiazania(db) {
  return db
    .prepare(
      'SELECT id, nazwa, sku, szerokosc_mm, wysokosc_mm, wycofana FROM karty_produktow' +
        ' ORDER BY nazwa COLLATE NOCASE ASC, id ASC',
    )
    .all()
    .map((w) => ({ ...w }));
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
 * w `nieaktualne` i ma byc POKAZANA (reguła: pominięte wracają z powodem).
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
export function powiazOfertyHurtem(db, pary, kanaly, { konto = null } = {}) {
  wymagajListyKanalow(kanaly);
  const powiazane = [];
  const nieaktualne = [];
  const warunekKanalu = kanaly.length ? `kanal IN (${kanaly.map(() => '?').join(', ')})` : '0 = 1';

  db.exec('BEGIN IMMEDIATE');
  try {
    const zapytanie = db.prepare(
      'UPDATE produkty_sklepowe SET karta_id = ?' +
        ` WHERE id = ? AND ${warunekKanalu} AND karta_id IS NULL AND zniknal_at IS NULL`,
    );
    for (const { produktId, kartaId } of pary ?? []) {
      wymagajKarty(db, kartaId);
      const ok = przeniesPowiazanie(
        db,
        produktId,
        liczba(kartaId),
        () => liczba(zapytanie.run(kartaId, produktId, ...kanaly).changes) > 0,
        { konto },
      );
      (ok ? powiazane : nieaktualne).push(produktId);
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
export function odepnijOferte(db, produktSklepowyId, kanaly, { konto = null } = {}) {
  wymagajListyKanalow(kanaly);
  const warunekKanalu = kanaly.length ? `kanal IN (${kanaly.map(() => '?').join(', ')})` : '0 = 1';
  return wSavepoincie(db, 'odepnij_oferte', () =>
    przeniesPowiazanie(
      db,
      produktSklepowyId,
      null,
      () =>
        liczba(
          db
            .prepare(
              `UPDATE produkty_sklepowe SET karta_id = NULL, tresc_pobrana_at = NULL WHERE id = ? AND ${warunekKanalu}`,
            )
            .run(produktSklepowyId, ...kanaly).changes,
        ) > 0,
      { konto },
    ),
  );
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
  return db
    .prepare('SELECT * FROM produkty_sklepowe WHERE karta_id = ? ORDER BY kanal ASC, id ASC')
    .all(numer)
    .map((p) => ({ ...p }));
}

/**
 * Produkty sklepowe WIELU kart naraz — material przejecia numeru ze sklepu i podgladu
 * zapisu do sklepow. Wiersze wracaja CALE, z `karta_id` przy kazdym.
 *
 * ⚠️ OSOBNA FUNKCJA, A NIE PETLA PO `produktyKarty`: oba ekrany dotykaja setek kart naraz
 * (przy przejeciu i przy nadaniu numerow), a `prepare` na wiersz to setki zapytan
 * zamiast jednego.
 *
 * ⚠️⚠️ BEZ WARUNKU `zniknal_at IS NULL` — inaczej niz na liscie magazynu, i jest to tresc,
 * nie przeoczenie. Produkt wycofany ze sprzedazy NADAL TRZYMA SWOJ NUMER (ta sama zasada, co
 * w `zajeteSku`), wiec karta z jednym produktem wycofanym o numerze „PD10" i jednym zywym
 * o numerze „B-KOP-118" NIE JEST jednoznaczna — a bez tego wiersza wygladalaby na
 * jednoznaczna i panel przejalby numer za czlowieka. Zapis do sklepu odsiewa znikniete
 * OSOBNO (`domena/zapis-do-sklepu.js`), bo tam pytanie jest inne: nie „jaki numer istnieje",
 * tylko „gdzie wolno pisac".
 *
 * ⚠️ Numery odsiewane tak samo, jak w `kartyPoIdach` — przychodza z zadania HTTP, a `IN`
 * sklejane jest z tekstu.
 */
export function produktyKart(db, ids) {
  const numery = [...new Set((ids ?? []).filter((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0).map(Number))];
  if (!numery.length) return [];
  return db
    .prepare(
      `SELECT * FROM produkty_sklepowe WHERE karta_id IN (${numery.map(() => '?').join(', ')})` +
        // Kolejnosc jawna: opis rozbieznosci wymienia numery po kolei, a czlowiek ma zobaczyc
        // ten sam ekran przy podgladzie i przy zatwierdzeniu.
        ' ORDER BY kanal ASC, id ASC',
    )
    .all(...numery)
    .map((p) => ({ ...p }));
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
  const r = db
    .prepare('UPDATE produkty_sklepowe SET sku_sklepu = ?' + ' WHERE kanal = ? AND produkt_id = ? AND wariant_id = ?')
    .run(sku, kanal, idTekstem(produktId), idTekstem(wariantId));
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
 * Szukajka karty dla SKU wiersza importu kanału. Najpierw `karty_produktow.sku`
 * (`kartaZeSku`); brak → karta POWIĄZANYCH wierszy lustra o tym samym `sku_sklepu` (po JS `trim()`, jak
 * w imporcie), bo karta założona dawniej z produktu kanału SKU nie ma. Liczą się najpierw wiersze żywe;
 * dopiero gdy żywych nie ma — zniknięte. Różne karty → `{ kilka: true }` (nie zgadujemy).
 * Lustro czytane RAZ na plan (mapa w pamięci) — zapytanie na wiersz dawało koszt kwadratowy.
 * Szukajka oddaje `{ karta: { id } }`, `{ kilka: true }` albo `null`.
 */
export function szukajkaKartDoImportu(db) {
  const poSku = new Map();
  for (const w of db
    .prepare(
      'SELECT p.sku_sklepu, p.karta_id, p.zniknal_at FROM produkty_sklepowe p JOIN karty_produktow k ON k.id = p.karta_id',
    )
    .iterate()) {
    const s = String(w.sku_sklepu ?? '').trim();
    if (!s) continue;
    let wpis = poSku.get(s);
    if (!wpis) {
      wpis = { zywe: new Set(), znikniete: new Set() };
      poSku.set(s, wpis);
    }
    (w.zniknal_at === null || w.zniknal_at === undefined ? wpis.zywe : wpis.znikniete).add(Number(w.karta_id));
  }
  return (sku) => {
    const s = String(sku ?? '').trim();
    if (!s) return null;
    const zSku = kartaZeSku(db, s);
    if (zSku) return { karta: zSku };
    const wpis = poSku.get(s);
    if (!wpis) return null;
    const karty = wpis.zywe.size ? wpis.zywe : wpis.znikniete;
    if (karty.size > 1) return { kilka: true };
    return { karta: { id: [...karty][0] } };
  };
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
// SZUKANIE PRODUKTU DO ZAMOWIENIA TELEFONICZNEGO
//
// ⚠️ TO NIE JEST LISTA MAGAZYNU. Tamta (`kartyZKanalami`) opisuje KARTY i ich obecnosc
// w czterech kanalach — sluzy do porzadkowania katalogu. Ta oddaje POZYCJE JEDNEGO
// CENNIKA, gotowe do dopisania do zamowienia, i wlasnie dlatego kanaly allegrowe nie maja
// jak sie tu dostac: kanal przychodzi juz przefiltrowany przez domene
// (domena/magazyn-do-zamowienia.js), a zapytanie i tak pyta o jeden.
//
// ⚠️ SZUKAMY PO WSZYSTKICH SLOWACH NARAZ, nie po calej frazie. „grzybek 30" ma znalezc
// „Lampa stołowa Grzybek ceramiczna 30cm" — przy telefonie operator wpisuje dwa slowa
// z pamieci, a nie dokladny poczatek nazwy. Kazde slowo to osobny LIKE spiety AND-em,
// bo to jest ta sama roznica, co miedzy szukaniem uzytecznym a pustym ekranem.
//
// ⚠️ `zniknal_at IS NULL` — produkt wycofany ze sklepu nie ma prawa sie pokazac. Cena
// nieistniejacego produktu to najgorszy rodzaj podpowiedzi: wyglada na prawdziwa.
// Szkic w sklepie tez nie: kupujacy go nie widzi, wiec to nie jest oferta kanalu.
// =====================================================================================
const SLOWA_MAX = 6;

export function szukajDoZamowienia(db, { fraza, kanal, limit = 20 } = {}) {
  const slowa = String(fraza ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, SLOWA_MAX);
  if (slowa.length === 0) return [];

  const czesci = ['kanal = ?', 'zniknal_at IS NULL', "COALESCE(status_publikacji, '') != 'draft'"];
  const params = [String(kanal)];
  for (const slowo of slowa) {
    czesci.push("(nazwa LIKE ? ESCAPE '\\' OR sku_sklepu LIKE ? ESCAPE '\\')");
    const wzorzec = `%${uciekniecieLike(slowo)}%`;
    params.push(wzorzec, wzorzec);
  }

  // Produkty Z CENA ida pierwsze: bezcenowy wiersz i tak nie da sie dodac jednym
  // kliknieciem, wiec spychanie go na dol jest uczciwsze niz mieszanie z reszta.
  return db
    .prepare(
      `
    SELECT kanal, produkt_id, wariant_id, nazwa, sku_sklepu, cena_gr, rozmiar_tekst,
           miniatura, adres, status_publikacji
    FROM produkty_sklepowe
    WHERE ${czesci.join(' AND ')}
    ORDER BY (cena_gr IS NULL) ASC, nazwa ASC, rozmiar_tekst ASC
    LIMIT ?
  `,
    )
    .all(...params, Number(limit) || 20);
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
  return (
    db
      .prepare(
        `
    SELECT kanal, produkt_id, wariant_id, nazwa, sku_sklepu, cena_gr, rozmiar_tekst, status_publikacji
    FROM produkty_sklepowe
    WHERE kanal = ? AND produkt_id = ? AND wariant_id = ? AND zniknal_at IS NULL
      AND COALESCE(status_publikacji, '') != 'draft'
  `,
      )
      .get(String(kanal), String(produktId), String(wariantId ?? '')) ?? null
  );
}

/** Kiedy ostatnio czytalismy katalog tego sklepu — ekran ma powiedziec, jak swieze sa ceny. */
export function odczytKatalogu(db, kanal) {
  return (
    db.prepare('SELECT MAX(odczytane_at) AS kiedy FROM produkty_sklepowe WHERE kanal = ?').get(String(kanal))?.kiedy ??
    null
  );
}
