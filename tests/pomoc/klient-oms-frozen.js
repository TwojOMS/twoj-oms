// Jedyne miejsce w panelu, ktore robi HTTP do OMS-u (wzorzec: src/shop/offers.js).
export function createOmsClient({ baseUrl, user, pass, fetchImpl = fetch }) {
  const autoryzacja = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  async function zadanie(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Accept: 'application/json',
          Authorization: autoryzacja,
          // ⚠️ OMS ma ochrone CSRF sprawdzajaca zgodnosc Origin z Host i odrzuca KAZDY
          // POST bez tego naglowka. Podajemy wlasne, prawdziwe zrodlo. Nic to nie
          // oslabia: przegladarka Origin podrobic nie moze.
          Origin: baseUrl,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // Komunikat MUSI mowic, ze nic sie nie stalo — inaczej czlowiek nie wie, czy klikac
      // ponownie. Przy zerwaniu PO stronie OMS-u ratuje nas 409 (idempotencja).
      throw new Error(`OMS nieosiągalny — zamówienie NIE powstało: ${e.message}`);
    }
    let dane = null;
    try { dane = await res.json(); } catch { dane = null; }
    return { res, dane, powod: dane?.powod ?? 'brak powodu' };
  }

  function sprawdzLogin(res) {
    // 401 to konfiguracja, nie awaria zamowienia — i naprawa jest zupelnie inna.
    // Hasla NIE cytujemy nigdzie w komunikacie.
    if (res.status === 401) throw new Error('OMS odrzucił login panelu — sprawdź OMS_USER i OMS_PASS.');
  }

  async function createFromCard(payload) {
    const { res, dane, powod } = await zadanie('POST', '/api/zamowienia-z-karty', payload);
    sprawdzLogin(res);
    // 409 NIE jest bledem: zamowienie z tej karty juz istnieje, a my chcemy jego numer.
    // To ta sama sytuacja, co zerwana odpowiedz przy pierwszej probie.
    if (res.status === 409) {
      if (dane?.id == null || !dane?.numer) throw new Error('OMS zgłosił duplikat, ale nie oddał numeru zamówienia.');
      return { id: Number(dane.id), numer: String(dane.numer), konflikt: true };
    }
    if (!res.ok) throw new Error(`OMS odrzucił zamówienie (${res.status}): ${powod}`);
    if (dane?.id == null || !dane?.numer) throw new Error('OMS nie oddał numeru zamówienia.');
    return { id: Number(dane.id), numer: String(dane.numer), konflikt: false };
  }

  async function getForCard(kartaId) {
    const { res, dane, powod } = await zadanie('GET', `/api/zamowienia-z-karty/${encodeURIComponent(kartaId)}`);
    // 404 to stan ISTOTNY, ale nie wyjatkowy: zamowienie skasowano w OMS-ie. Rozstrzyga
    // wolajacy (services/oms-orders.js), bo tylko on wie, czy karta ma juz `oms_id`.
    if (res.status === 404) return null;
    sprawdzLogin(res);
    if (!res.ok) throw new Error(`OMS nie oddał stanu zamówienia (${res.status}): ${powod}`);
    return {
      id: Number(dane.id), numer: String(dane.numer),
      oplacone: Boolean(dane.oplacone), anulowane: Boolean(dane.anulowane),
      kwotaBrutto: dane.kwotaBrutto ?? null,
    };
  }

  /**
   * Zamowienie OMS-u odpowiadajace zamowieniu ZE SKLEPU — tor auto.
   *
   * Zastepuje dopasowanie przez Apilo. Klient placi w sklepie, OMS zaciaga zamowienie
   * (co 2 minuty), a panel pyta o nie numerem sklepowym i czyta `oplacone`.
   *
   * ⚠️ NAZWA SKLEPU JEST WYMAGANA I ODRZUCAMY JEJ BRAK U SIEBIE. Numer zamowienia NIE jest
   * unikalny miedzy sklepami — szkicownia.pl i PRO numeruja niezaleznie, wiec `28060` moze
   * istniec w obu. Zapytanie bez sklepu moze wiec dostac cudze zamowienie, a karta podpieta
   * do cudzego zamowienia to ta sama klasa bledu, ktora zlikwidowalo przejscie z dopasowania
   * po adresie e-mail na numer oferty. Odmowa PRZED wyjsciem w siec jest tansza niz poleganie
   * na tym, ze druga strona zawsze bedzie pilnowac.
   */
  async function getByShopOrder(numer, sklep) {
    if (!String(sklep || '').trim()) throw new Error('Brak nazwy sklepu — nie pytam OMS-u o numer bez sklepu.');
    const sciezka = `/api/zamowienia/po-numerze/${encodeURIComponent(numer)}?sklep=${encodeURIComponent(sklep)}`;
    const { res, dane, powod } = await zadanie('GET', sciezka);

    // 404 to STAN NORMALNY, nie awaria: poller panelu chodzi co 10 minut, a OMS zaciaga
    // ze sklepu co 2 — miedzy zlozeniem zamowienia a jego pojawieniem sie w OMS-ie jest okno.
    if (res.status === 404) return null;
    sprawdzLogin(res);
    // 409 = kilka zamowien o tym numerze mimo podanego sklepu. RZUCAMY, bo „wez pierwsze"
    // znaczy tu „podepnij losowe zamowienie do karty klienta".
    if (!res.ok) throw new Error(`OMS nie oddał zamówienia ${numer} (${res.status}): ${powod}`);
    if (dane?.id == null) throw new Error('OMS nie oddał numeru zamówienia.');

    return {
      id: Number(dane.id),
      numer: String(dane.numer),
      sklep: dane.sklep ?? null,
      oplacone: Boolean(dane.oplacone),
      anulowane: Boolean(dane.anulowane),
      kwotaBrutto: dane.kwotaBrutto ?? null,
      indywidualne: Boolean(dane.indywidualne),
    };
  }

  /**
   * Wystawienie faktury proforma do zamówienia w OMS-ie.
   *
   * ⚠️ TO JEST ZDARZENIE, NIE ODCZYT. Po drugiej stronie zużywa się NUMER Z SERII, a
   * poprzednia proforma tego zamówienia zostaje UNIEWAŻNIONA (świadoma decyzja OMS-u:
   * proforma nie jest dokumentem księgowym i wolno ją wystawić ponownie, ale dwie ważne
   * naraz to klient płacący według starej kwoty). Wołający ma o tym wiedzieć — stąd nazwa
   * `wystaw…`, a nie `pobierz…`.
   *
   * OMS nie ma i nie dostanie mailera: tutaj kończy się na numerze i adresie pliku.
   * Mailuje PANEL.
   */
  async function wystawProforme(zamowienieId) {
    const { res, dane, powod } = await zadanie('POST', `/api/zamowienia/${encodeURIComponent(zamowienieId)}/proforma`);
    sprawdzLogin(res);
    // 503 to KONFIGURACJA OMS-u (brak OMS_PROFORMY_*), nie awaria tego zamówienia —
    // naprawa jest zupełnie inna i komunikat ma to powiedzieć wprost.
    if (res.status === 503) {
      throw new Error('OMS nie ma skonfigurowanych proform (OMS_PROFORMY_*) — dokument NIE powstał.');
    }
    // Odmowa operatorska z OMS-u („zamówienie jest anulowane", „wyszłaby na 0,00 zł") jest
    // jedyną rzeczą, z której człowiek dowie się, czemu dokumentu nie ma. Idzie w całości.
    if (!res.ok) throw new Error(`OMS nie wystawił proformy (${res.status}): ${powod}`);
    if (dane?.id == null || !dane?.numer || !dane?.pdfUrl) {
      // Niepełna odpowiedź jest GORSZA od błędu: bez `pdfUrl` panel nie ma czego pobrać,
      // a numer zapisałby na karcie — karta twierdziłaby, że dokument jest, a maila nie
      // dałoby się złożyć.
      throw new Error('OMS nie oddał kompletu danych proformy (potrzebne id, numer i pdfUrl).');
    }
    return { id: Number(dane.id), numer: String(dane.numer), pdfUrl: String(dane.pdfUrl) };
  }

  // Ścieżka pliku proformy przychodzi Z ODPOWIEDZI OMS-u i dlatego jej kształt sprawdzamy
  // U SIEBIE, przed wyjściem w sieć.
  //
  // ⚠️ Nie chodzi o złośliwy OMS, tylko o to, że każde żądanie tego klienta niesie nagłówek
  // `Authorization` z hasłem panelu. Adres bezwzględny (albo `//host/…`, który przeglądarki
  // i `fetch` czytają jako inny host) oddałby to hasło komuś innemu — wystarczy pomyłka
  // w konfiguracji albo pośrednik po drodze. Ta sama zasada, co przy wymaganiu `sklep`
  // w `getByShopOrder`: odmowa u siebie jest tańsza niż liczenie na drugą stronę.
  const SCIEZKA_PDF = /^\/api\/proformy\/\d+\/pdf$/;

  /** Bajty wystawionej proformy — do wklejenia w maila jako załącznik. */
  async function pobierzProformePdf(pdfUrl) {
    const sciezka = String(pdfUrl ?? '');
    if (!SCIEZKA_PDF.test(sciezka)) {
      throw new Error(`OMS podał nieoczekiwaną ścieżkę pliku proformy („${sciezka}") — nie pobieram.`);
    }
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${sciezka}`, {
        method: 'GET',
        headers: { Accept: 'application/pdf', Authorization: autoryzacja, Origin: baseUrl },
      });
    } catch (e) {
      throw new Error(`OMS nieosiągalny przy pobieraniu proformy: ${e.message}`);
    }
    sprawdzLogin(res);
    if (!res.ok) {
      // Powód czytamy dopiero na błędzie — przy 200 odpowiedź to bajty PDF-a, nie JSON.
      let powod = `HTTP ${res.status}`;
      try { powod = (await res.json())?.powod ?? powod; } catch { /* nie JSON — zostaje kod */ }
      throw new Error(`OMS nie oddał pliku proformy: ${powod}`);
    }
    const bajty = Buffer.from(await res.arrayBuffer());
    // Zero bajtów to nie jest dokument. Mail z pustym załącznikiem wygląda dla klienta
    // jak uszkodzony plik, a dla nas jak wysłana proforma.
    if (bajty.length === 0) throw new Error('OMS oddał pusty plik proformy (zero bajtów) — nie wkładam tego do maila.');
    return bajty;
  }

  /**
   * Dane dostawy i dokumentu — dla strony akceptacji projektu, ktora pokazuje je klientowi
   * do ostatniego sprawdzenia.
   *
   * ⚠️ PYTAMY PO ID ZAMOWIENIA, nie po karcie. Zamowienie z toru automatycznego nie ma
   * `karta_id` (zaciagnal je poller OMS-u ze sklepu), a to wlasnie ono najczesciej ma
   * adres, ktorego panel u siebie nie trzyma.
   *
   * `null` przy 404 to stan mozliwy do obsluzenia: zamowienie skasowane w OMS-ie albo karta
   * z `oms_id` po restore'cie bazy. Strona akceptacji pokazuje wtedy samo podziekowanie —
   * gorszy od braku danych bylby tylko pusty naglowek „Dane do wysyłki".
   */
  async function getDostawa(zamowienieId) {
    const { res, dane, powod } = await zadanie('GET', `/api/zamowienia/${encodeURIComponent(zamowienieId)}/dostawa`);
    if (res.status === 404) return null;
    sprawdzLogin(res);
    if (!res.ok) throw new Error(`OMS nie oddał danych dostawy (${res.status}): ${powod}`);
    return {
      adres: dane?.adres ?? null,
      metoda: dane?.metoda ?? null,
      punkt: dane?.punkt ?? null,
      punktOpis: dane?.punktOpis ?? null,
      dokument: dane?.dokument === 'faktura' ? 'faktura' : 'paragon',
      faktura: dane?.faktura ?? null,
    };
  }


  /**
   * „Klient zaakceptował projekt" → zamowienie w OMS-ie przechodzi do W REALIZACJI (22.08.2026).
   *
   * Do tego dnia panel przesuwal tylko WLASNA karte, a zamowienie w OMS-ie zostawalo
   * w statusie „Indywidualne", dopoki czlowiek nie kliknal belki statusu. Ta sama
   * informacja wprowadzana dwa razy — a rozjazd nie dawal o sobie znac niczym.
   *
   * ⚠️ ODDAJE POWOD ODMOWY ZAMIAST RZUCAC przy `409`. OMS odmawia, gdy zamowienie jest
   * juz wyslane, anulowane albo ma zwrot — to nie jest awaria, tylko stan, w ktorym
   * przestawienie statusu byloby SZKODLIWE. Wolajacy zapisuje powod w logu karty i idzie
   * dalej: akceptacja klienta jest faktem niezaleznym od tego, co dzieje sie po tamtej stronie.
   */
  async function oznaczWRealizacji(zamowienieId) {
    const { res, dane, powod } = await zadanie('POST', `/api/zamowienia/${encodeURIComponent(zamowienieId)}/w-realizacji`);
    if (res.status === 404) return { zmienione: false, powod: 'OMS nie zna tego zamówienia (404).' };
    sprawdzLogin(res);
    if (res.status === 409) return { zmienione: false, powod: powod || 'OMS odmówił zmiany statusu.' };
    if (!res.ok) throw new Error(`OMS nie zmienił statusu (${res.status}): ${powod}`);
    return { zmienione: true, numer: dane?.numer ?? null, status: dane?.status ?? null };
  }

  /**
   * Stan wysylki zamowienia — dla pollera, ktory przenosi fakt „wyslane" na karte panelu.
   *
   * ⚠️ PYTAMY PO ID ZAMOWIENIA (jak `getDostawa`), nie po karcie: zamowienie toru auto
   * nie ma `karta_id` po stronie OMS-u, a wysylka dotyczy go tak samo.
   *
   * `null` przy 404 = zamowienie skasowane w OMS-ie. Rozstrzyga wolajacy
   * (services/oms-orders.js) — tak samo jak przy odczycie wplaty.
   */
  async function getStanWysylki(zamowienieId) {
    const { res, dane, powod } = await zadanie('GET', `/api/zamowienia/${encodeURIComponent(zamowienieId)}/stan-wysylki`);
    if (res.status === 404) return null;
    sprawdzLogin(res);
    if (!res.ok) throw new Error(`OMS nie oddał stanu wysyłki (${res.status}): ${powod}`);
    return {
      id: Number(dane.id), numer: String(dane.numer),
      wyslane: Boolean(dane.wyslane), wyslaneAt: dane.wyslaneAt ?? null,
      anulowane: Boolean(dane.anulowane),
    };
  }

  return { createFromCard, getForCard, getByShopOrder, getDostawa, wystawProforme, pobierzProformePdf, oznaczWRealizacji, getStanWysylki };
}
