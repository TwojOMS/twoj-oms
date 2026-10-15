// ZAPIS SKU I WYMIAROW DO SKLEPOW — jedyne miejsce w module magazynu, ktore PISZE do
// produkcyjnego sklepu. Regula „co i gdzie" siedzi w `domain/zapis-do-sklepu.js`, ekran
// w `web/routes/magazyn.js`; tutaj sa wylacznie zapytania i ich izolacja.
//
// ⚠️⚠️ SKLEPY, DO KTORYCH TO PISZE, SPRZEDAJA. Pomylka nie jest literowka na ekranie: SKU jest
// TOZSAMOSCIA produktu (adresy, eksporty, feed do Google), a zapisu NIE DA SIE COFNAC
// z panelu — „cofnij" znaczyloby drugi zapis do sklepu, a panel nie trzyma tego, co bylo.
//
// ⚠️⚠️ IZOLACJA AWARII PER PRODUKT. Jeden produkt, ktory odmowi, nie ma prawa zatrzymac
// reszty ani wywrocic przebiegu — ta sama zasada, co przy nadaniu zbiorczym i przy odczycie
// katalogow. Przy tysiacu produktow przerwanie w polowie zostawia rejestr rozjechany ze
// sklepem i nie wiadomo, w ktorym miejscu.

// Ustawienie sklepu niosace jednostke wymiarow. ⚠️ NAZWA W JEDNYM MIEJSCU: literowka
// w drugiej kopii dalaby „nie znam jednostki" na calym kanale i wygladalaby na awarie sklepu.
import { czyWolnoNadpisac } from '../../../domena/zapis-do-sklepu.js';

const USTAWIENIE_JEDNOSTKI = 'woocommerce_dimension_unit';

const opisBledu = (e) => (typeof e?.message === 'string' && e.message ? e.message : String(e));

const BEZ_KLIENTA = (kanal) => `Kanał „${kanal}" nie ma w panelu skonfigurowanego sklepu, `
  + 'więc nie mam dokąd pisać ani skąd wziąć jednostki wymiarów. Sprawdź zmienne SHOP_* '
  + 'w konfiguracji panelu.';

/**
 * Jednostka wymiarow KAZDEGO z podanych kanalow, czytana ZE SKLEPU.
 *
 * @param {Record<string, {ustawienieSklepu: Function}>} sklepy mapa kanal → klient Woo
 * @param {string[]} kanaly kanaly, o ktore naprawde pytamy
 * @returns {Promise<{jednostki: Record<string,string>, bledy: Record<string,string>}>}
 *
 * ⚠️⚠️ PYTAMY SKLEP, ZAMIAST ZAKLADAC. `woocommerce_dimension_unit` jest ustawieniem sklepu
 * i wlasciciel moze je zmienic bez naszego udzialu; zalozenie „to na pewno centymetry" daje
 * szablon 70 MILIMETROW zamiast 70 cm — cicho i za pieniadze.
 *
 * ⚠️ KANAL BEZ KLIENTA WRACA JAKO BLAD, a nie znika po cichu: cicho pominiety kanal wyglada
 * na ekranie DOKLADNIE tak samo jak kanal, w ktorym nie ma nic do zmiany.
 *
 * ⚠️ AWARIA JEDNEGO KANALU NIE PRZERYWA POZOSTALYCH — ta sama zasada, co w `magazyn-sync.js`.
 *
 * ⚠️ OBA WYNIKI BEZ PROTOTYPU (`Object.create(null)`): nazwa kanalu pochodzi z lustra, czyli
 * z cudzego API, a `bledy.constructor` na literale obiektu nie ustawilby wlasnej wlasnosci,
 * tylko po cichu siegnal do `Object.prototype`.
 */
export async function jednostkiSklepow(sklepy, kanaly) {
  const jednostki = Object.create(null);
  const bledy = Object.create(null);
  // Kanaly ODRESZTOWANE: ten sam kanal wystepuje przy setkach produktow, a jedno zapytanie
  // na produkt to setki zadan do sklepu po jedna i te sama wartosc.
  for (const kanal of new Set(kanaly ?? [])) {
    const klient = Object.hasOwn(sklepy ?? {}, kanal) ? sklepy[kanal] : null;
    if (typeof klient?.ustawienieSklepu !== 'function') {
      bledy[kanal] = BEZ_KLIENTA(kanal);
      continue;
    }
    try {
      jednostki[kanal] = await klient.ustawienieSklepu(USTAWIENIE_JEDNOSTKI);
    } catch (e) {
      bledy[kanal] = `Nie udało się odczytać jednostki wymiarów ze sklepu „${kanal}": `
        + `${opisBledu(e)}. Nie zgaduję jednostki — bez niej nie wyślę wymiarów.`;
    }
  }
  return { jednostki, bledy };
}

/**
 * Wysyla gotowy zestaw zmian do sklepow. Oddaje wynik KAZDEJ pozycji — takze tych, ktore
 * nie poszly.
 *
 * @param {object} p
 * @param {Record<string, {pobierzProdukt: Function, zapiszProdukt: Function}>} p.sklepy
 * @param {Array<{kanal, sciezka, pola, opis}>} p.zmiany zestaw z `domain/zapis-do-sklepu.js`
 * @returns {Promise<Array<{zmiana, ok: boolean, blad: string|null}>>}
 *
 * ⚠️⚠️ ZAKAZ NADPISANIA NIEPUSTEGO SKU SPRAWDZANY NA ZYWO, TUZ PRZED ZAPISEM, A NIE Z LUSTRA.
 * `produkty_sklepowe.sku_sklepu` jest swieze wylacznie na moment ostatniego klikniecia
 * „Odczytaj katalogi", a ten chodzi z PRZYCISKU — lustro bywa tygodniami nieaktualne.
 * Scenariusz, przed ktorym to broni: lustro z poniedzialku pokazuje puste SKU, we wtorek ktos
 * wpisuje numer w WooCommerce, w srode zapis widzi w lustrze pustke i nadpisuje TOZSAMOSC
 * produktu. Odczyt jest wiec czescia zapisu, a nie sprawdzeniem na wszelki wypadek.
 *
 * ⚠️ ODCZYT, KTORY SIE NIE UDAL, ODMAWIA ZAPISU (fail closed). Nie da sie sprawdzic bariery
 * — nie ma zapisu. Odwrotna decyzja („nie wiem, wiec pisze") kasuje cala te ochrone dokladnie
 * w chwili, w ktorej sklep zachowuje sie dziwnie.
 *
 * ⚠️ REGULA POROWNANIA JEST TA SAMA, CO W PODGLADZIE (`czyWolnoNadpisac` z domeny). Druga
 * kopia rozjechalaby sie z pierwsza, a rozjechanie sie AKURAT TEJ reguly konczy sie
 * nadpisaniem tozsamosci produktu.
 *
 * ⚠️ POZYCJE IDA PO KOLEI, nie rownolegle: rownolegly zapis uderzalby setkami zadan naraz
 * w ten sam sklep, ktory w tej chwili obsluguje kupujacych.
 */
export async function wyslijDoSklepow({ sklepy, zmiany } = {}) {
  const wyniki = [];
  for (const zmiana of zmiany ?? []) {
    // ⚠️ `Object.hasOwn`, bo `kanal` pochodzi z lustra (cudze API): 'constructor' na literale
    // obiektu oddalby FUNKCJE zamiast `undefined`.
    const klient = Object.hasOwn(sklepy ?? {}, zmiana?.kanal) ? sklepy[zmiana.kanal] : null;
    if (typeof klient?.zapiszProdukt !== 'function') {
      // ⚠️ ODMOWA, NIE CICHE POMINIECIE: pominiete po cichu wyglada na ekranie tak samo,
      // jak zapisane.
      wyniki.push({ zmiana, ok: false, blad: BEZ_KLIENTA(zmiana?.kanal) });
      continue;
    }

    try {
      // ⚠️ Pytamy DOKLADNIE o ten zasob, pod ktory pojdzie zapis (rodzic albo wariant) —
      // SKU wariantu zyje na wariancie, a rodzic potrafi miec puste.
      const wSklepie = await klient.pobierzProdukt(zmiana.sciezka);
      const wolno = czyWolnoNadpisac(zmiana?.pola?.sku, wSklepie?.sku);
      if (!wolno.wolno) {
        wyniki.push({
          zmiana, ok: false, blad: `${wolno.powod} (sprawdzone w sklepie tuż przed zapisem)`,
        });
        continue;
      }
      await klient.zapiszProdukt(zmiana.sciezka, zmiana.pola);
      wyniki.push({ zmiana, ok: true, blad: null });
    } catch (e) {
      // ⚠️ TRESC BLEDU SKLEPU JEST INFORMACJA, A NIE SZUMEM: „duplikat SKU" mowi dokladnie,
      // co zrobic dalej, a „nie udało się" nie mowi nic.
      wyniki.push({ zmiana, ok: false, blad: opisBledu(e) });
    }
  }
  return wyniki;
}
