import { transport } from '../../integracje/transport.js';
// Jedyne miejsce w OMS, ktore robi HTTP do sklepu.
import { miniaturyZeStoreApi } from '../../domena/miniatury.js';

export function createWooClient({ baseUrl, ck, cs, fetchImpl, http = transport({ fetchImpl }) }) {
  const auth = 'Basic ' + Buffer.from(`${ck}:${cs}`).toString('base64');

  async function strzal(sciezka, opcje = {}) {
    let res;
    try {
      res = await http(`${baseUrl}/wp-json/wc/v3${sciezka}`, {
        ...opcje,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth, ...(opcje.headers || {}) },
      });
    } catch (e) {
      throw new Error(`Sklep nieosiągalny: ${e.message}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    const powod = dane?.message || 'brak powodu';
    // Komunikat NIE zawiera ck/cs — sekret nie ma prawa trafic do logu.
    if (res.status === 401) throw new Error(`Sklep odrzucił klucz REST: ${powod}`);
    if (!res.ok) throw new Error(`Sklep odpowiedział ${res.status}: ${powod}`);
    return { dane, res };
  }

  async function pobierzZamowienia({ modifiedAfter = null, page = 1 } = {}) {
    const p = new URLSearchParams({
      orderby: 'modified', order: 'asc', status: 'any',
      per_page: '50', page: String(page),
    });
    // Anulowanie zamowienia tez jest zmiana — dlatego status=any, nie processing.
    // dates_are_gmt: bez tego Woo interpretuje modified_after w czasie LOKALNYM sklepu,
    // a przy przejsciu na czas zimowy przesuwa okno o godzine i zamowienia znikaja na zawsze
    // (kursor zostaje "przed" nimi, ale Woo liczy inaczej niz my). UTC po obu stronach usuwa problem.
    if (modifiedAfter) {
      p.set('modified_after', modifiedAfter);
      p.set('dates_are_gmt', 'true');
    }
    const { dane, res } = await strzal(`/orders?${p.toString()}`);
    // Odpowiedz 200, ktora NIE jest tablica, wygladalaby jak "brak nowych zamowien" —
    // a to dokladnie ten failure mode, przed ktorym poller ma chronic. Lepiej glosno
    // wywalic przebieg, niz cicho udawac ze sklep nie ma nic nowego.
    if (!Array.isArray(dane)) {
      const opis = dane === null ? 'pustą odpowiedź (nie JSON)' : JSON.stringify(dane).slice(0, 300);
      throw new Error(`Sklep zwrócił niespodziewaną odpowiedź zamiast listy zamówień: ${opis}`);
    }
    const stron = Number(res.headers?.get?.('X-WP-TotalPages') || 1) || 1;
    return { zamowienia: dane, stron };
  }

  /**
   * Zamowienia w oknie DAT ZLOZENIA, rosnaco — wylacznie do jednorazowego importu historii.
   *
   * ⚠️ TO NIE JEST DRUGA WERSJA `pobierzZamowienia`. Tamta czyta po dacie MODYFIKACJI, bo
   * poller ma dowiedziec sie o KAZDEJ zmianie. Import historii czyta po dacie ZLOZENIA, bo
   * zbior ma stac w miejscu przez caly przebieg: sklep dotknal 01.08.2026 calego archiwum
   * naraz (zamowienia z 2019, 2020 i 2024 dostaly `date_modified_gmt` w tej samej sekundzie),
   * wiec okno po modyfikacji potrafi sie zmienic w trakcie stronicowania — i strona 40
   * pokazalaby wtedy co innego niz strona 39 oczekiwala.
   *
   * ⚠️ `after`/`before` w Woo sa OSTRE po obu stronach (`>` i `<`). Wolajacy podaje granice
   * z zapasem doby, a wlasciwe odciecie robi sie po `dzien` (czas warszawski) — filtr jedzie
   * w GMT, wiec sam nie umie odciac po dobie warszawskiej.
   *
   * ⚠️⚠️ `perPage = 100` I NIE ZMNIEJSZAC „ZEBY BYLO DELIKATNIEJ" — pomiar na produkcji
   * 2026-08-27 mowi cos odwrotnego niz intuicja. Koszt zapytania jest w PRZEWAZAJACEJ CZESCI
   * staly (rozruch WordPressa + WooCommerce + autoryzacja), a nie proporcjonalny do liczby
   * zamowien: 10 zamowien = 3,3 s (32 kB), 100 zamowien = 6,5 s (330 kB). Czyli 100 zamowien
   * kosztuje dwa razy tyle co 10, a nie dziesiec razy. Zmniejszenie strony do 10 zamienia
   * 86 rozruchow na 850 i wydluza caly import z ~9 do ~47 minut — WIECEJ pracy serwera, nie
   * mniej. Powtorzone zapytanie kosztuje tyle samo (6 488 ms), wiec nie ma tu zadnego cache'u,
   * ktory mialby to zamortyzowac. Strona w glebi listy NIE jest drozsza (zmierzone na
   * stronach 1/20/45/70/84: 5 675–6 065 ms), wiec nie ma urwiska na koncu przebiegu.
   */
  async function pobierzZamowieniaZakresu({ after, before, page = 1, perPage = 100 } = {}) {
    const p = new URLSearchParams({
      orderby: 'date', order: 'asc', status: 'any', dates_are_gmt: 'true',
      per_page: String(perPage), page: String(page), after, before,
    });
    const { dane, res } = await strzal(`/orders?${p.toString()}`);
    if (!Array.isArray(dane)) {
      const opis = dane === null ? 'pustą odpowiedź (nie JSON)' : JSON.stringify(dane).slice(0, 300);
      throw new Error(`Sklep zwrócił niespodziewaną odpowiedź zamiast listy zamówień: ${opis}`);
    }
    return {
      zamowienia: dane,
      stron: Number(res.headers?.get?.('X-WP-TotalPages') || 1) || 1,
      razem: Number(res.headers?.get?.('X-WP-Total') || 0) || 0,
    };
  }

  // Twarda granica: sklep, ktory zglosi absurdalne X-WP-TotalPages (blad wtyczki, zle
  // policzony filtr), zapetlilby odczyt na godziny. Lepiej wywalic przebieg glosno.
  const MAX_STRON = 200;

  // Jedna petla paginacji dla produktow i wariantow — druga kopia tej logiki to ta sama
  // klasa bledu, co druga kopia regul kursora.
  async function pobierzWszystkieStrony(sciezka, parametry, coTo) {
    const wszystko = [];
    let strona = 1;
    let stron = 1;
    let zapowiedziano = null;
    do {
      // Parametry ida z KAZDYM zadaniem, nie tylko z pierwszym. Doklejenie filtrow
      // wylacznie do strony 1 sciagneloby szkice na stronach 2-7 i zameldowalo sukces.
      const p = new URLSearchParams({ ...parametry, per_page: '100', page: String(strona) });
      const { dane, res } = await strzal(`${sciezka}?${p.toString()}`);
      // 200 z ciałem, ktore NIE jest tablica, wygladaloby jak "sklep nie ma nic" — a to
      // dokladnie ten failure mode, przed ktorym odczyt ma chronic.
      if (!Array.isArray(dane)) {
        const opis = dane === null ? 'pustą odpowiedź (nie JSON)' : JSON.stringify(dane).slice(0, 300);
        throw new Error(`Sklep zwrócił niespodziewaną odpowiedź zamiast listy ${coTo}: ${opis}`);
      }
      wszystko.push(...dane);
      // Oczekiwana liczba pozycji z PIERWSZEJ strony: gdyby naglowki przestaly przychodzic
      // w trakcie odczytu, wziecie jej z ostatniej strony skasowaloby kontrole dokladnie
      // w tym scenariuszu, przed ktorym ma bronic.
      if (strona === 1) {
        const total = Number(res.headers?.get?.('X-WP-Total'));
        zapowiedziano = Number.isFinite(total) && total > 0 ? total : null;
      }
      stron = Number(res.headers?.get?.('X-WP-TotalPages') || 1) || 1;
      if (stron > MAX_STRON) {
        throw new Error(`Sklep zgłosił ${stron} stron ${coTo} (limit ${MAX_STRON}) — przerywam odczyt, żeby się nie zapętlić.`);
      }
      strona += 1;
    } while (strona <= stron);
    // Uciety odczyt (proxy zjadlo naglowki X-WP-*, sklep oddal je tylko na pierwszej stronie)
    // wyglada jak sukces, a potem sync oznacza brakujace pozycje jako zniknal_at — czyli
    // jest nieodrozninalny od "sklep stracil pol katalogu". Lepiej wywalic przebieg.
    // Wiecej niz zapowiedziano przepuszczamy: przy orderby=id&order=asc pozycja dodana
    // w trakcie odczytu dokleja sie na koncu. Kosztem jest falszywy alarm, gdy cos w
    // trakcie odczytu zniknie — swiadomie wolimy glosny falszywy alarm od cichej straty.
    if (zapowiedziano !== null && wszystko.length < zapowiedziano) {
      throw new Error(`Odczyt ${coTo} urwał się: sklep zapowiedział ${zapowiedziano} pozycji, a zebraliśmy ${wszystko.length}. Nie oddaję niepełnej listy, bo brakujące pozycje wyglądałyby jak usunięte ze sklepu.`);
    }
    return wszystko;
  }

  // status=publish JAWNIE: REST v3 domyslnie oddaje `any`, a sklep A ma setki szkicow
  // (produkty techniczne przeniesione do sklepu B). Bez tego magazyn zalozylby karty-duchy.
  // orderby=id&order=asc: stabilna kolejnosc miedzy stronami, inaczej zmiana w sklepie
  // w trakcie odczytu przesuwa okno i wiersz wpada dwa razy albo znika.
  const pobierzWszystkieProdukty = () =>
    pobierzWszystkieStrony('/products', { status: 'publish', orderby: 'id', order: 'asc' }, 'produktów');

  const pobierzWarianty = (produktId) =>
    pobierzWszystkieStrony(`/products/${produktId}/variations`, { orderby: 'id', order: 'asc' }, 'wariantów');

  // ——— STORE API: ADRESY MINIATUR ———————————————————————————————————————————
  //
  // ⚠️⚠️ INNY ZASÓB NIŻ CAŁA RESZTA TEGO PLIKU. REST v3 (`/wp-json/wc/v3`) NIE ODDAJE adresu
  // miniatury — przy zdjęciu jest wyłącznie `src` oryginału. Store API oddaje przy każdym
  // zdjęciu gotowe `thumbnail`, w rozmiarze, który TEN sklep naprawdę wygenerował. To dlatego
  // panel przestaje zgadywać rozmiar z nazwy pliku (patrz `domain/miniatury.js`).
  //
  // ⚠️ BEZ UWIERZYTELNIANIA, I TO CELOWO. Store API jest publicznym katalogiem sklepu i klucza
  // REST nie zna. Doklejony `Authorization` byłby sekretem wysłanym pod zasób, który go nie
  // potrzebuje — a przy przekierowaniu pojechałby razem z nim. Stąd `strzalStore`, a nie
  // `strzal`: ten drugi wpisuje nagłówek i prefiks `/wc/v3` na sztywno.
  //
  // ⚠️ STORE API POKAZUJE WYŁĄCZNIE PRODUKTY OPUBLIKOWANE (szkiców nie widać). Nie jest to
  // usterka ani utrata danych: magazyn i tak czyta katalog z `status=publish`, więc oba
  // zbiory się pokrywają.
  const STORE_API = '/wp-json/wc/store/v1/products';

  async function strzalStore(parametry) {
    const p = new URLSearchParams({ ...parametry });
    let res;
    try {
      res = await http(`${baseUrl}${STORE_API}?${p.toString()}`, {
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      throw new Error(`Sklep nieosiągalny: ${e.message}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    if (!res.ok) throw new Error(`Sklep odpowiedział ${res.status}: ${dane?.message || 'brak powodu'}`);
    return { dane, res };
  }

  /**
   * MAPA `id produktu` → `adres miniatury` dla całego katalogu sklepu.
   *
   * ⚠️ RZUCA przy odmowie sklepu i nie zamienia jej po cichu w pustą mapę. Decyzję „to tylko
   * miniatury, odczyt katalogu ma się udać" podejmuje `services/magazyn-sync.js` — tam, gdzie
   * widać cały przebieg. Klient milczący o 503 zamieniłby awarię sklepu w „ten sklep nie ma
   * miniatur", czyli w stan nieodróżnialny od poprawnego.
   *
   * Paginacja i twarda granica stron — te same, co przy katalogu; ta sama pętla, bo druga
   * kopia reguł paginacji to ta sama klasa błędu, co druga kopia reguł kursora.
   */
  async function pobierzMiniatury() {
    const wszystkie = [];
    let strona = 1;
    let stron = 1;
    do {
      // `orderby=id&order=asc`: stabilna kolejność między stronami — bez niej zmiana
      // w sklepie w trakcie odczytu przesuwa okno i produkt wpada dwa razy albo znika.
      const { dane, res } = await strzalStore({
        per_page: '100', page: String(strona), orderby: 'id', order: 'asc',
      });
      // 200 z ciałem, które NIE jest tablicą (HTML WAF-a, strona trybu konserwacji,
      // `rest_no_route` na sklepie bez Store API) wygląda jak „sklep nie ma miniatur".
      // Rzucamy, żeby przebieg mógł to ZAPISAĆ W LOGU — a nie udawać, że wszystko gra.
      if (!Array.isArray(dane)) {
        const opis = dane === null ? 'pustą odpowiedź (nie JSON)' : JSON.stringify(dane).slice(0, 300);
        throw new Error(`Store API sklepu oddało coś innego niż listę produktów: ${opis}`);
      }
      wszystkie.push(...dane);
      stron = Number(res.headers?.get?.('X-WP-TotalPages') || 1) || 1;
      if (stron > MAX_STRON) {
        throw new Error(`Store API zgłosiło ${stron} stron (limit ${MAX_STRON}) — przerywam odczyt miniatur, żeby się nie zapętlić.`);
      }
      strona += 1;
    } while (strona <= stron);
    // Regula „ktore pole jest miniatura" siedzi w DOMENIE, zeby dalo sie ja sprawdzic
    // bez sieci — klient odpowiada wylacznie za HTTP i paginacje.
    return miniaturyZeStoreApi(wszystkie);
  }

  // Ustawienie sklepu (np. woocommerce_dimension_unit) — oddajemy samą wartość, bo
  // wywołujący potrzebuje jednostki, nie opisu pola z panelu.
  async function ustawienieSklepu(id, grupa = 'products') {
    const { dane } = await strzal(`/settings/${grupa}/${id}`);
    // Ciche `undefined` zamiast jednostki wymiaru konczy sie produktem 70 mm zamiast
    // 70 cm wyslanym do sklepu — cicho i za pieniadze. Pusty napis jest poprawna
    // wartoscia (np. separator tysiecy), brak napisu nie jest.
    if (typeof dane?.value !== 'string') {
      // strzal przy niezdatnym JSON-ie ustawia dane = null, nigdy undefined — stad bez
      // galezi na undefined; JSON.stringify zawsze odda tu napis (choćby "null").
      const opis = JSON.stringify(dane).slice(0, 300);
      throw new Error(`Ustawienie ${id} ze sklepu nie ma wartości będącej napisem — przyszło: ${opis}`);
    }
    return dane.value;
  }

  // ——— PRODUKT: ODCZYT I ZAPIS POD KONKRETNA SCIEZKA ——————————————————————————
  //
  // ⚠️⚠️ SCIEZKA ROZSTRZYGA RODZIC vs WARIANT: `products/944/variations/1091` to WARIANT,
  // `products/944` to rodzic. Zapis SKU na rodzica produktu wariantowego jest w WooCommerce
  // LEGALNY I CICHY — odpowie 200, a numer nie pojawi sie tam, gdzie zyje cena. Sklada ja
  // `domain/zapis-do-sklepu.js`; klient jej NIE WYMYSLA i nie poprawia.
  //
  // ⚠️⚠️ BIALA LISTA KSZTALTU SCIEZKI. `produkty_sklepowe.produkt_id` jest kolumna TEKSTOWA
  // (bo identyfikator Allegro przychodzi napisem), a ta wartosc laduje wprost w adresie HTTP
  // metody PUT. Smiec w niej („900/../orders/5") trafilby w zupelnie inny zasob REST-a —
  // i to zasob, ktory panel ma prawo modyfikowac. Odmawiamy PRZED wyslaniem czegokolwiek.
  // Ten sam warunek stoi drugi raz w domenie, i ma stac: tam chroni ekran, tu adres.
  const SCIEZKA_PRODUKTU = /^products\/\d+(\/variations\/\d+)?$/u;

  function sprawdzSciezke(sciezka) {
    const s = String(sciezka ?? '');
    if (!SCIEZKA_PRODUKTU.test(s)) {
      throw new Error(`Ścieżka „${s}" nie jest adresem produktu ani wariantu `
        + '(products/{id} albo products/{id}/variations/{id}) — nie wysyłam pod nią niczego.');
    }
    return s;
  }

  /**
   * ⚠️⚠️ ODMOWA MA WYNIKAC Z POZYTYWNEGO ROZPOZNANIA PRODUKTU, A NIE Z BRAKU POLA.
   *
   * ZNALEZIONE W RECENZJI 12.08.2026 (Critical) i zmierzone na atrapie: `strzal` robi
   * `try { dane = await res.json(); } catch { dane = null; }` i rzuca WYLACZNIE przy
   * `!res.ok`. Odpowiedz 200 z cialem, ktorego nie rozumiemy — HTML WAF-a, strona trybu
   * konserwacji, JSON o innym ksztalcie — dawala wiec `dane = null`, czyli `wSklepie?.sku`
   * rowne `undefined`, czyli dla reguly „produkt NIE MA numeru". I PUT szedl, nadpisujac
   * tozsamosc produktu, ktory numer MIAL. Zdanie „nieudany odczyt = odmowa" bylo prawda
   * WYLACZNIE dla odczytow, ktore RZUCAJA.
   *
   * ⚠️⚠️ NAJGORSZE BYLO TO, ZE NADZOR CZLOWIEKA TEGO NIE LAPAL: ekran pokazywal wtedy
   * „poszło", identycznie jak przy zapisie udanym. A pierwsze uruchomienie to moment,
   * w ktorym ktos zwykle grzebie przy sklepie — czyli najbardziej prawdopodobna chwila
   * na tryb konserwacji albo challenge WAF-a.
   *
   * Dlatego odpowiedz musi byc JEDNOCZESNIE: obiektem (i NIE tablica), z obecnym kluczem
   * `sku` bedacym napisem (obecnosc klucza jest sygnalem, ze to produkt, a nie cokolwiek
   * innego; pusty napis jest legalnym stanem „produkt bez numeru"), oraz o identyfikatorze
   * ZGODNYM z tym, o ktory pytalismy. Cokolwiek innego RZUCA — a `wyslijDoSklepow` zamienia
   * to swoim `catch`-em w odmowe per produkt.
   */
  function rozpoznanyProdukt(dane, sciezka) {
    const czym = (x) => (x === null ? 'null' : JSON.stringify(x)?.slice(0, 200) ?? typeof x);
    // ⚠️ `Array.isArray` osobno: tablica jest obiektem, a `Object.hasOwn([], 'sku')` oddaje
    // po prostu `false` — bez tego warunku komunikat mowilby „brak pola sku" o czyms,
    // co produktem w ogole nie jest.
    if (dane === null || typeof dane !== 'object' || Array.isArray(dane)) {
      throw new Error(`Sklep nie oddał produktu ${sciezka}: odpowiedź nie jest obiektem `
        + `(${czym(dane)}). Kod 200 z ciałem, którego nie rozumiem — tryb konserwacji, WAF `
        + 'albo strona logowania hostingu. NIE zapisuję, bo nie wiem, czy produkt ma numer.');
    }
    if (!Object.hasOwn(dane, 'sku') || typeof dane.sku !== 'string') {
      throw new Error(`Sklep nie oddał produktu ${sciezka}: w odpowiedzi nie ma pola „sku" `
        + 'będącego napisem. Brak tego pola to NIE JEST „produkt bez numeru" — to odpowiedź, '
        + 'której nie rozpoznaję, więc nie zapisuję.');
    }
    // ⚠️ ZGODNOSC IDENTYFIKATORA: przekierowanie, cache albo wtyczka potrafia oddac INNY
    // produkt. Bariera sprawdzona na cudzym wierszu jest gorsza niz jej brak, bo wyglada
    // na spelniona. Dla wariantu porownujemy identyfikator WARIANTU (ostatni czlon sciezki)
    // — to on jest tym zasobem, pod ktory pojdzie PUT.
    const oczekiwany = sciezka.split('/').pop();
    if (String(dane.id ?? '') !== String(oczekiwany)) {
      throw new Error(`Sklep oddał produkt o identyfikatorze „${dane.id}", a pytałem o `
        + `„${oczekiwany}" (${sciezka}). Nie sprawdzam bariery na cudzym produkcie.`);
    }
    return dane;
  }

  // Stan produktu W SKLEPIE, czytany TUZ PRZED zapisem. ⚠️ To jest bariera przed nadpisaniem
  // cudzego SKU, a nie optymalizacja: lustro (`produkty_sklepowe`) jest swieze wylacznie na
  // moment ostatniego klikniecia „Odczytaj katalogi", a ten chodzi z przycisku.
  // ⚠️ `async`, a nie zwykla strzalka: straznik sciezki RZUCA, a metoda klienta ma zawsze
  // oddawac obietnice — wolajacy lapie awarie jednej pozycji `catch`-em przy `await`
  // (services/magazyn-zapis.js), a synchroniczny wyjatek wyleciałby obok tej izolacji.
  const pobierzProdukt = async (sciezka) => {
    const s = sprawdzSciezke(sciezka);
    const { dane } = await strzal(`/${s}`);
    return rozpoznanyProdukt(dane, s);
  };

  /**
   * Zapis pol produktu albo wariantu. ⚠️ WOLAJACY PODAJE KOMPLET POL i tylko one jada —
   * panel wysyla WYLACZNIE `sku` i `dimensions` (niezmiennik modulu magazynu), a klient nie
   * dokleja niczego od siebie.
   *
   * ⚠️ PUT, nie POST: POST na `/products` ZALOZYLBY nowy produkt.
   */
  const zapiszProdukt = async (sciezka, pola) =>
    strzal(`/${sprawdzSciezke(sciezka)}`, { method: 'PUT', body: JSON.stringify(pola ?? {}) })
      .then(({ dane }) => dane);

  const dodajNotatke = (id, tresc) =>
    strzal(`/orders/${id}/notes`, { method: 'POST', body: JSON.stringify({ note: tresc, customer_note: false }) })
      .then(({ dane }) => dane);

  const ustawStatus = (id, status) =>
    strzal(`/orders/${id}`, { method: 'PUT', body: JSON.stringify({ status }) })
      .then(({ dane }) => dane);

  return {
    pobierzZamowienia, pobierzZamowieniaZakresu,
    pobierzWszystkieProdukty, pobierzWarianty, pobierzMiniatury, ustawienieSklepu,
    pobierzProdukt, zapiszProdukt, dodajNotatke, ustawStatus,
  };
}
