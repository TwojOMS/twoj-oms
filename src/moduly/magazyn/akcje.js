// Port frozen 5b9cd765: 1127–1500, 1662–1765, 1910–2008.
export function registerAkcjeMagazynu(app, { db, magazyn, sklepy, pomoc, karta }) {
  const { kartyZKanalami, niepowiazaneOfertyAllegro, powiazaneOfertyAllegro, kartyDoPowiazania, powiazOfertyHurtem, odepnijOferte, kartaPoId, produktyKarty, zapiszKarte, kartyPoIdach, zastosujHurtem, zajeteSku, nadajSku, produktyKart, polecenieZFormularza, zmianyHurtem, polaDoPrzeniesienia, proponujSku, przejeciaZeSklepu, propozycje, KANALY_ALLEGRO, wartosciPol, adresKanalu, BEZ_SKLEPOW, BEZ_SKLEPOW_ODMOWA, BEZ_KART, SORTOWANIE_POWIAZAN, SORTOWANIE_POWIAZAN_DOMYSLNE, napis, kanalAllegro, paryZFormularza, wierszOferty, pozycjaListy, adresPowiazan, linkiPowiazan, ukrytePowiazan, pole, zmianyZFormularza, bezpiecznyWroc, adresKarty, numeryZaznaczone, filtryZawezenia, zakresHurtu, HURT_BEZ_ZAZNACZENIA, HURT_BEZ_ZMIANY } = pomoc;
  const { ekranKarty, brakKarty } = karta;
  function ekranHurtu(reply, {
    plan = [], zakres, zawezenie, polaFormularza = [], blad = null, wynik = null, kod = 200,
  }) {
    return reply.code(kod).view('magazyn-hurt.ejs', {
      title: 'Magazyn — edycja hurtem',
      // ⚠️ DECYZJA CZLOWIEKA („70", „nie") jedzie dalej ukrytymi polami; jej SKUTEK („z 30
      // na 70") liczy sie od nowa przy zatwierdzeniu i nigdy nie jedzie stad.
      polaDoPrzeniesienia: polaFormularza,
      // Liczba liczona z PLANU, a nie z zaznaczenia: karta, ktora juz ma te wartosc, nie jest
      // zmiana i nie ma prawa podbijac obietnicy ekranu.
      ile: wynik ? wynik.zmienione : plan.length,
      plan,
      wynik,
      blad,
      // Zakres i zawezenie wracaja na ekran, zeby przycisk „popraw zaznaczenie" prowadzil
      // do TEJ SAMEJ listy, z ktorej czlowiek przyszedl (niezmiennik 4.13b).
      zakres,
      adresPowrotu: zawezenie ? `/magazyn?${zawezenie}` : '/magazyn',
    });
  }

  /**
   * Wspolna droga obu trns hurtu. `zapisz` rozstrzyga, czy to podglad, czy zatwierdzenie.
   *
   * ⚠️⚠️ KOLEJNOSC SPRAWDZEN JEST CZESCIA OCHRONY. Najpierw rozumiemy TRESC (bo napis,
   * ktorego nie rozumiemy, odmawia calosci — takze podgladu, zeby nikt nie ogladal zgadnietego
   * zestawu), potem pytamy o ZBIOR. Zapytanie do bazy nie ma sie wykonac dla zadania, ktore
   * i tak odrzucamy.
   */
  function hurtem(req, reply, { zapisz }) {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);

    const zakres = zakresHurtu(pole(req.body, 'zakres'));
    const zawezenie = pole(req.body, 'zawezenie') ?? '';
    const polaFormularza = polaDoPrzeniesienia(req.body);
    const odmowa = (blad) => ekranHurtu(reply, {
      zakres, zawezenie, polaFormularza, blad, kod: 400,
    });

    // ⚠️ ODMOWA JEST CALOSCIOWA: jedno pole, ktorego nie rozumiemy, wstrzymuje CALY zapis,
    // a nie „to, co dalo sie odczytac". Przy 645 kartach nikt by juz nie odtworzyl, ktora
    // polowa weszla.
    const { polecenie, blad } = polecenieZFormularza(req.body);
    if (blad) return odmowa(blad);
    // Puste polecenie to NIE jest „skasuj wszystko" — to jest brak decyzji.
    if (!Object.keys(polecenie).length) return odmowa(HURT_BEZ_ZMIANY);

    // ⚠️⚠️ ZBIOR. Zaznaczenie MUSI byc jawne: puste `zaznaczone` nie ma prawa znaczyc
    // „wszystkie" — to najkrotsza droga do nadpisania calego rejestru jednym kliknieciem.
    let karty;
    if (zakres === 'pasujace') {
      // ⚠️ TO SAMO ZAPYTANIE, CO LISTA — razem z regula „filtr, ktorego nie rozumiemy, oddaje
      // PUSTO". Cicho zignorowany filtr znaczylby hurtowa zmiane na CALYM katalogu zamiast
      // na 645 brakach.
      const filtry = filtryZawezenia(zawezenie);
      karty = kartyZKanalami(db, { fraza: filtry.fraza, filtry });
    } else {
      const numery = numeryZaznaczone(req.body?.zaznaczone);
      if (!numery.length) return odmowa(HURT_BEZ_ZAZNACZENIA);
      karty = kartyPoIdach(db, numery);
    }

    // ⚠️⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZATWIERDZENIE, za kazdym razem ze stanu BIEZACEGO.
    // Gdyby zatwierdzenie przepisywalo gotowy zestaw z ukrytego pola, odczyt katalogow albo
    // druga karta miedzy jednym a drugim zmienilyby zbior po cichu.
    const plan = zmianyHurtem(karty, polecenie);
    if (!zapisz) return ekranHurtu(reply, { plan, zakres, zawezenie, polaFormularza });

    // Jedna transakcja i JEDEN znacznik czasu na caly przebieg (db/magazyn.js).
    const zmienione = zastosujHurtem(db, plan);
    return ekranHurtu(reply, { zakres, zawezenie, polaFormularza, wynik: { zmienione } });
  }

  // ⚠️⚠️ TA TRASA NICZEGO NIE ZAPISUJE. Podglad jest obowiazkowy i jest osobna trasa wlasnie
  // po to, zeby „zapisz" nie dalo sie wywolac przez pomylke w polu formularza.
  app.post('/magazyn/hurt', async (req, reply) => hurtem(req, reply, { zapisz: false }));

  // ⚠️ ZATWIERDZENIE JEST PRZYCISKIEM, NIE SKUTKIEM UBOCZNYM WEJSCIA NA STRONE. Renderuje
  // wynik zamiast przekierowywac (ta sama zasada, co przy „Utwórz karty z niepowiązanych"
  // i przy fakturach hurtem): ekran wyniku jest jedynym miejscem, w ktorym widac, co panel
  // faktycznie ruszyl.
  app.post('/magazyn/hurt/zatwierdz', async (req, reply) => hurtem(req, reply, { zapisz: true }));

  // ——— GENERATOR SKU ——————————————————————————————————————————————————————————
  //
  // PO CO TO JEST (zmierzone na produkcji 2026-08-12): 965 kart bez SKU. Numer nadany tutaj
  // pojedzie w Zadaniu 15 do produkcyjnych sklepow i stanie sie TOZSAMOSCIA produktu.
  //
  // ⚠️⚠️ TA SAMA DROGA, CO PRZY EDYCJI HURTEM, I ANI JEDNEJ WLASNEJ REGULY WIECEJ: podglad
  // (`/magazyn/sku-podglad`) wylacznie liczy i pokazuje, zapisuje dopiero
  // `/magazyn/sku-zapisz`, zbior liczony jest PONOWNIE przy zatwierdzeniu, a formularz
  // podgladu niesie DECYZJE (wzorzec i numery kart), nigdy gotowych numerow SKU.
  //
  // ⚠️⚠️ KOLIZJA WSTRZYMUJE CALOSC. Pozycja, ktorej numer juz do kogos nalezy, nie ma prawa
  // ani zostac zapisana, ani po cichu wypasc z zestawu — a „zapisalem 964 z 965" jest przy
  // tej skali zdaniem, po ktorym nikt nie odtworzy, ktorego karty brakuje.
  //
  // ⚠️ ANI JEDNEGO ZADANIA DO SKLEPU CZY ALLEGRO. Numery jada do sklepow w Zadaniu 15,
  // z wlasnym podgladem — tutaj powstaja wylacznie w naszym rejestrze.

  const SKU_BEZ_ZAZNACZENIA = 'Nie zaznaczono ani jednej karty, więc nie nadałem żadnego '
    + 'numeru. Zaznacz karty na liście albo kliknij przycisk „dla wszystkich pasujących" — stoi przy tej samej akcji i podaje, ilu kart dotyczy.';
  const SKU_WZORZEC_DWA_RAZY = 'Wzorzec numeru przyszedł dwa razy — nie wiem, którego użyć. '
    + 'Nic nie nadałem.';
  const SKU_KOLIZJA = 'Nie nadałem ANI JEDNEGO numeru: co najmniej jeden z proponowanych jest '
    + 'już zajęty. Numer, który żyje w sklepie, jest tożsamością cudzego produktu — a zapis '
    + 'połowy zestawu zostawiłby katalog ponumerowany do połowy, bez śladu, gdzie przebiega '
    + 'granica. Popraw wzorzec i pokaż podgląd jeszcze raz.';
  const SKU_NIEAKTUALNY = 'nie nadałem — ta karta zdobyła numer w międzyczasie';

  // Ekran skladany w JEDNYM miejscu i uzywany przez OBIE trasy: podglad i wynik. Dwie kopie
  // rozjechalyby sie po cichu, a wynik ma pokazywac DOKLADNIE ten sam ksztalt, ktory czlowiek
  // widzial przed kliknieciem.
  function ekranSku(reply, {
    pozycje = [], ileKolizji = 0, juzMaja = 0, wzorzec = '', zawezenie = '',
    blad = null, wynik = null, kod = 200,
  }) {
    return reply.code(kod).view('magazyn-sku.ejs', {
      title: 'Magazyn — nadanie SKU',
      // ⚠️ DECYZJA CZLOWIEKA (wzorzec) jedzie dalej ukrytym polem; jej SKUTEK (numery) liczy
      // sie od nowa przy zatwierdzeniu i nigdy nie jedzie stad.
      wzorzec,
      pozycje,
      ileKolizji,
      juzMaja,
      // Liczba z tego, co FAKTYCZNIE weszlo — a przy podgladzie z dlugosci listy propozycji.
      ile: wynik ? wynik.nadane : pozycje.length,
      wynik,
      blad,
      // ⚠️ PRZYCISK ZAPISU ISTNIEJE WYLACZNIE, GDY JEST CO ZAPISAC I NIC NIE KOLIDUJE — ale
      // to jest UPRZEJMOSC, nie zabezpieczenie: trasa zapisujaca liczy zestaw PONOWNIE
      // i sama odmawia przy kolizji.
      mozna: Boolean(pozycje.length) && !ileKolizji && !wynik,
      adresPowrotu: zawezenie ? `/magazyn?${zawezenie}` : '/magazyn',
    });
  }

  /**
   * Wspolna droga obu trns generatora. `zapisz` rozstrzyga, czy to podglad, czy nadanie.
   *
   * ⚠️⚠️ NAJPIERW ZBIOR, POTEM WZORZEC — ODWROTNIE NIZ PRZY EDYCJI HURTEM, i to nie jest
   * niekonsekwencja. Tam tresc formularza znaczy to samo niezaleznie od zaznaczenia; tutaj
   * LEGALNOSC wzorca zalezy od tego, ILU kart dotyczy: `LMP-B` jest poprawnym numerem
   * dla jednej karty i katastrofa dla dwustu (ten sam numer dwiescie razy). Rozstrzyga
   * o tym `proponujSku`, wiec musi najpierw wiedziec, co numerujemy.
   */
  function generujSku(req, reply, { zapisz }) {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);

    const zakres = zakresHurtu(pole(req.body, 'zakres'));
    const zawezenie = pole(req.body, 'zawezenie') ?? '';
    const wzorzec = pole(req.body, 'wzorzec');
    const odmowa = (blad, reszta = {}) => ekranSku(reply, {
      zawezenie, wzorzec: wzorzec ?? '', blad, kod: 400, ...reszta,
    });

    // Pole przyslane DWA RAZY wraca z Fastify jako TABLICA. Odsiewa ja `pole` do `null`,
    // a tu odrozniamy „przyszlo dwa razy" od „nie przyszlo wcale": to sa dwie rozne pomylki
    // i dwa rozne zdania.
    if (Object.hasOwn(req.body ?? {}, 'wzorzec') && wzorzec === null) {
      return odmowa(SKU_WZORZEC_DWA_RAZY);
    }

    // ⚠️⚠️ ZBIOR MUSI BYC JAWNY. Puste `zaznaczone` nie ma prawa znaczyc „wszystkie" —
    // to najkrotsza droga do ponumerowania calego rejestru jednym kliknieciem.
    let karty;
    if (zakres === 'pasujace') {
      // ⚠️ TO SAMO ZAPYTANIE, CO LISTA — razem z regula „filtr, ktorego nie rozumiemy, oddaje
      // PUSTO". Cicho zignorowany filtr znaczylby numerowanie CALEGO katalogu zamiast
      // 965 brakow.
      const filtry = filtryZawezenia(zawezenie);
      karty = kartyZKanalami(db, { fraza: filtry.fraza, filtry });
    } else {
      const numery = numeryZaznaczone(req.body?.zaznaczone);
      if (!numery.length) return odmowa(SKU_BEZ_ZAZNACZENIA);
      karty = kartyPoIdach(db, numery);
    }

    // ⚠️⚠️ ZAJETE NUMERY CZYTANE Z OBU ZBIOROW I ZA KAZDYM RAZEM OD NOWA (`zajeteSku`):
    // `karty.sku` ORAZ 218 numerow zyjacych w sklepach, o ktorych `UNIQUE` nic nie wie.
    // ⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZAPIS, za kazdym razem ze stanu BIEZACEGO — miedzy
    // jednym a drugim mogl wejsc odczyt katalogow albo drugi operator.
    let propozycje;
    try {
      propozycje = proponujSku(karty, wzorzec, zajeteSku(db));
    } catch (e) {
      // ⚠️ KOMUNIKAT GENERATORA JEST ZDANIEM DLA CZLOWIEKA i idzie na ekran wprost — trasa
      // nie ma drugiej kopii tej reguly, wiec nie ma jak sie z nia rozjechac.
      return odmowa(e.message);
    }

    // Ile kart zaznaczenie objelo, a generator ich NIE RUSZYL, bo maja juz numer. Liczba
    // jawna, a nie cisza: „zaznaczylem 300, dostales 250" musi byc widoczne na ekranie.
    const juzMaja = karty.filter((w) => String(w.sku ?? '').trim()).length;
    const ileKolizji = propozycje.filter((p) => p.kolizja).length;
    const wspolne = { juzMaja, ileKolizji, wzorzec: wzorzec ?? '', zawezenie };
    // Widok niczego nie liczy: uwaga przy wierszu i jej charakter skladaja sie TUTAJ.
    const doWidoku = (dodatkowa = () => null) => propozycje.map((p) => ({
      id: p.id,
      nazwa: p.nazwa,
      sku: p.sku,
      uwaga: p.kolizja ?? dodatkowa(p),
      zla: Boolean(p.kolizja),
    }));

    if (!zapisz) return ekranSku(reply, { ...wspolne, pozycje: doWidoku() });

    // ⚠️⚠️ KOLIZJA WSTRZYMUJE CALY ZAPIS, takze pozycje bezkolizyjne. Kolizja jest tu jedyna
    // rzecza, ktora oddziela numer NASZ od numeru CUDZEGO produktu — a odmowa calosciowa jest
    // ta sama zasada, ktora obowiazuje edycje hurtem: polowiczny zapis zostawia rejestr
    // w stanie, o ktorym ekran nie umie powiedziec prawdy.
    if (ileKolizji) {
      return odmowa(SKU_KOLIZJA, { ...wspolne, pozycje: doWidoku() });
    }

    // Jedna transakcja i JEDEN znacznik czasu na caly przebieg (db/magazyn.js).
    const { nadane, nieaktualne } = nadajSku(db, propozycje.map(({ id, sku }) => ({ id, sku })));
    const nieweszly = new Set(nieaktualne);
    return ekranSku(reply, {
      ...wspolne,
      pozycje: doWidoku((p) => (nieweszly.has(p.id) ? SKU_NIEAKTUALNY : null)),
      // ⚠️ NIEAKTUALNE MAJA BYC POKAZANE (niezmiennik 4.13a): karta, ktora numeru nie dostala,
      // bo zdobyla go w miedzyczasie, to CO INNEGO niz karta pominieta — i tylko po tej
      // roznicy widac, ze bariera w `UPDATE` zadzialala.
      wynik: { nadane: nadane.length, nieaktualne: nieaktualne.length },
    });
  }

  // ⚠️⚠️ TA TRASA NICZEGO NIE ZAPISUJE. Podglad jest obowiazkowy i jest osobna trasa wlasnie
  // po to, zeby „nadaj" nie dalo sie wywolac przez pomylke w polu formularza.
  app.post('/magazyn/sku-podglad', async (req, reply) => generujSku(req, reply, { zapisz: false }));

  // ⚠️ NADANIE JEST PRZYCISKIEM, NIE SKUTKIEM UBOCZNYM WEJSCIA NA STRONE. Renderuje wynik
  // zamiast przekierowywac: ekran wyniku jest jedynym miejscem, w ktorym widac komplet
  // nadanych numerow i to, czego panel nie tknal.
  app.post('/magazyn/sku-zapisz', async (req, reply) => generujSku(req, reply, { zapisz: true }));

  // ——— PRZEJECIE NUMERU ZE SKLEPU ——————————————————————————————————————————————
  //
  // PO CO TO JEST (zmierzone na produkcji 2026-08-12): 278 kart — czwarta czesc katalogu —
  // nie ma NASZEGO numeru, a ich produkt MA wlasny numer w sklepie. Generator SKU ich nie
  // przejmuje i nie ma jak: on wydaje numery NOWE i poprawnie omija zajete, ale zostawia
  // ROZBIEZNOSC (rejestr milczy, sklep ma numer).
  //
  // ⚠️⚠️ TO JEST BARIERA PRZED ZAPISEM DO SKLEPU, a nie wygoda. Karta bez numeru, ktorego
  // produkt numer ma, po nadaniu numeru z generatora pojechalby do sklepu i NADPISAL numer
  // bedacy tozsamoscia produktu — cicho i bez „cofnij".
  //
  // ⚠️⚠️ TA SAMA DROGA, CO PRZY GENERATORZE: podglad (`/magazyn/przejmij-podglad`) wylacznie
  // liczy i pokazuje, zapisuje dopiero `/magazyn/przejmij-zapisz`, zbior liczony jest
  // PONOWNIE przy zatwierdzeniu, a formularz podgladu niesie WYLACZNIE numery kart —
  // nigdy gotowych numerow SKU.
  //
  // ⚠️ ANI JEDNEGO ZADANIA DO SKLEPU. Numer bierze sie z LUSTRA, bo tylko o nim wiemy, ze
  // odpowiada temu, co czlowiek widzial na liscie. Swiezosc lustra jest tu przyjetym kosztem:
  // przejecie zapisuje wylacznie do NASZEGO rejestru i niczego w sklepie nie rusza.

  const PRZEJECIE_BEZ_ZAZNACZENIA = 'Nie zaznaczono ani jednej karty, więc nie przejąłem '
    + 'żadnego numeru. Zaznacz karty na liście albo kliknij przycisk „dla wszystkich pasujących" — stoi przy tej samej akcji i podaje, ilu kart dotyczy.';
  const PRZEJECIE_KOLIZJA = 'Nie przejąłem ANI JEDNEGO numeru: co najmniej jeden z nich jest '
    + 'już zajęty — przez inną kartę produktu albo przez drugą kartę z tego samego zestawu. Numer '
    + 'w sklepie jest tożsamością JEDNEGO produktu, a przejęcie połowy zestawu zostawiłoby '
    + 'rejestr rozjechany ze sklepem bez śladu, gdzie przebiega granica. Rozstrzygnij kolizje '
    + 'na kartach produktów i pokaż podgląd jeszcze raz.';
  const PRZEJECIE_NIEAKTUALNY = 'nie przejąłem — ta karta zdobyła numer w międzyczasie';

  // Etykieta znacznika przy wierszu. ⚠️ LICZY SIE TUTAJ, nie w widoku: „rozbieznosc"
  // i „kolizja" to dwie rozne odpowiedzi i dwa rozne skutki (kolizja wstrzymuje CALY zapis),
  // wiec widok nie ma prawa ich mylic ani nazywac po swojemu.
  const ZNACZNIKI_PRZEJECIA = Object.freeze({
    kolizja: 'kolizja',
    rozbieznosc: 'rozbieżność',
  });

  // Ekran skladany w JEDNYM miejscu i uzywany przez OBIE trasy: podglad i wynik. Dwie kopie
  // rozjechalyby sie po cichu, a wynik ma pokazywac DOKLADNIE ten sam ksztalt, ktory czlowiek
  // widzial przed kliknieciem.
  function ekranPrzejecia(reply, {
    pozycje = [], juzMaja = 0, zawezenie = '', blad = null, wynik = null, kod = 200,
  }) {
    const gotowe = pozycje.filter((p) => p.sku);
    const ileKolizji = pozycje.filter((p) => p.rodzaj === 'kolizja').length;
    const ileRozbieznosci = pozycje.filter((p) => p.rodzaj === 'rozbieznosc').length;
    return reply.code(kod).view('magazyn-przejecie.ejs', {
      title: 'Magazyn — przejęcie numerów ze sklepu',
      pozycje: pozycje.map((p) => ({
        ...p,
        // ⚠️ WIDOK NICZEGO NIE ROZSTRZYGA: etykieta znacznika przychodzi policzona,
        // a nieznany rodzaj daje `null`, a nie napis „undefined" przy wierszu.
        znacznik: Object.hasOwn(ZNACZNIKI_PRZEJECIA, p.rodzaj) ? ZNACZNIKI_PRZEJECIA[p.rodzaj] : null,
      })),
      // Numery kart, ktore pojada w formularzu zatwierdzenia — WYLACZNIE gotowe.
      doZatwierdzenia: gotowe.map((p) => p.id),
      ile: wynik ? wynik.przejete : gotowe.length,
      ileKolizji,
      ileRozbieznosci,
      juzMaja,
      wynik,
      blad,
      // ⚠️ PRZYCISK ISTNIEJE, GDY JEST CO PRZEJAC I NIC NIE KOLIDUJE — ale to UPRZEJMOSC,
      // nie zabezpieczenie: trasa zapisujaca liczy zestaw PONOWNIE i sama odmawia.
      mozna: Boolean(gotowe.length) && !ileKolizji && !wynik,
      adresPowrotu: zawezenie ? `/magazyn?${zawezenie}` : '/magazyn',
    });
  }

  /** Wspolna droga obu trns przejecia. `zapisz` rozstrzyga, czy to podglad, czy nadanie. */
  function przejmijSku(req, reply, { zapisz }) {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);

    const zakres = zakresHurtu(pole(req.body, 'zakres'));
    const zawezenie = pole(req.body, 'zawezenie') ?? '';

    // ⚠️⚠️ ZBIOR MUSI BYC JAWNY. Puste `zaznaczone` nie ma prawa znaczyc „wszystkie".
    let karty;
    if (zakres === 'pasujace') {
      const filtry = filtryZawezenia(zawezenie);
      karty = kartyZKanalami(db, { fraza: filtry.fraza, filtry });
    } else {
      const numery = numeryZaznaczone(req.body?.zaznaczone);
      if (!numery.length) {
        return ekranPrzejecia(reply, { zawezenie, blad: PRZEJECIE_BEZ_ZAZNACZENIA, kod: 400 });
      }
      karty = kartyPoIdach(db, numery);
    }

    const idy = karty.map((w) => w.id);
    // ⚠️⚠️ ZAJETE NUMERY BEZ PRODUKTOW TYCH KART. Numer, ktory karta ma PRZEJAC, zyje
    // w lustrze — bez pominiecia kazde przejecie odbijaloby sie o wlasne odbicie i ekran
    // meldowalby 278 kolizji z niczym.
    // ⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZAPIS, za kazdym razem ze stanu BIEZACEGO.
    const pozycje = przejeciaZeSklepu(
      karty,
      produktyKart(db, idy),
      zajeteSku(db, { pomijajProduktyKart: idy }),
    );

    // Ile kart zaznaczenie objelo, a przejecie ich NIE RUSZYLO, bo maja juz numer.
    const juzMaja = karty.filter((w) => String(w.sku ?? '').trim()).length;
    const wspolne = { juzMaja, zawezenie };

    if (!zapisz) return ekranPrzejecia(reply, { ...wspolne, pozycje });

    // ⚠️⚠️ KOLIZJA WSTRZYMUJE CALY ZAPIS, takze pozycje bezkolizyjne — ta sama zasada, co
    // w generatorze SKU. ROZBIEZNOSC NIE WSTRZYMUJE I TO NIE JEST NIEKONSEKWENCJA: kolizja
    // mowi „ten numer jest czyjas tozsamoscia" (dotyczy CUDZEGO wiersza), a rozbieznosc
    // „nie wiem, ktory z numerow tej karty jest jej numerem" — i dotyczy WYLACZNIE jej.
    if (pozycje.some((p) => p.rodzaj === 'kolizja')) {
      return ekranPrzejecia(reply, { ...wspolne, pozycje, blad: PRZEJECIE_KOLIZJA, kod: 400 });
    }

    // Jedna transakcja i JEDEN znacznik czasu na caly przebieg — a warunek „SKU jest puste"
    // w samym `UPDATE` pilnuje, ze karta, ktora numer zdobyla w miedzyczasie, nie zostanie
    // przenumerowana (db/magazyn.js: nadajSku).
    const { nadane, nieaktualne } = nadajSku(db, pozycje.filter((p) => p.sku)
      .map(({ id, sku }) => ({ id, sku })));
    const nieweszly = new Set(nieaktualne);
    return ekranPrzejecia(reply, {
      ...wspolne,
      pozycje: pozycje.map((p) => (nieweszly.has(p.id)
        ? { ...p, uwaga: PRZEJECIE_NIEAKTUALNY, zla: true, rodzaj: 'nieaktualny' }
        : p)),
      wynik: { przejete: nadane.length, nieaktualne: nieaktualne.length },
    });
  }

  // ⚠️⚠️ TA TRASA NICZEGO NIE ZAPISUJE. Podglad jest obowiazkowy i jest osobna trasa wlasnie
  // po to, zeby „przejmij" nie dalo sie wywolac przez pomylke w polu formularza.
  app.post('/magazyn/przejmij-podglad', async (req, reply) => przejmijSku(req, reply, { zapisz: false }));

  // ⚠️ PRZEJECIE JEST PRZYCISKIEM, NIE SKUTKIEM UBOCZNYM WEJSCIA NA STRONE. Renderuje wynik
  // zamiast przekierowywac: ekran wyniku jest jedynym miejscem, w ktorym widac komplet
  // przejetych numerow i to, czego panel nie tknal.
  app.post('/magazyn/przejmij-zapisz', async (req, reply) => przejmijSku(req, reply, { zapisz: true }));
  function ekranPowiazan(req, reply, wynik = null) {
    const karty = kartyDoPowiazania(db);
    // ⚠️ ROZSTRZYGNIECIE WLASCICIELA: przy zerze kart ekran MOWI, od czego zaczac,
    // zamiast pokazac pusta tabele albo sie wywalic. Wzorzec: `pusta-strona.ejs`.
    if (!karty.length) return reply.view('pusta-strona.ejs', BEZ_KART);

    const filtry = {
      fraza: napis(req.query?.fraza),
      kanal: kanalAllegro(req.query?.kanal),
    };
    const sort = Object.hasOwn(SORTOWANIE_POWIAZAN, req.query?.sort)
      ? req.query.sort : SORTOWANIE_POWIAZAN_DOMYSLNE;
    const kier = String(req.query?.kier ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';
    // ⚠️ Z ADRESU ALBO Z CIALA: ten ekran renderuja trzy trasy — GET (odczyt i wlasna
    // nawigacja) oraz dwa POST-y (wiazanie hurtem i odpiecie), a formularz oddaje adres
    // ukrytym polem. `bezpiecznyWroc` oddaje `null` dla wartosci spoza magazynu.
    const wroc = bezpiecznyWroc(req.query?.wroc ?? req.body?.wroc);

    const szukane = filtry.fraza ? filtry.fraza.toLowerCase() : null;
    const wiersze = niepowiazaneOfertyAllegro(db)
      .filter((o) => (!filtry.kanal || o.kanal === filtry.kanal))
      .filter((o) => (!szukane || String(o.nazwa ?? '').toLowerCase().includes(szukane)))
      .map((o) => wierszOferty(o, karty));

    const porzadek = SORTOWANIE_POWIAZAN[sort];
    // `w.id` na koncu daje kolejnosc powtarzalna miedzy odswiezeniami przy remisie.
    wiersze.sort((a, b) => (kier === 'desc' ? porzadek(b, a) : porzadek(a, b)) || (a.id - b.id));

    return reply.view('magazyn-powiazania.ejs', {
      title: 'Magazyn — powiązania',
      wiersze,
      // JEDNA lista podpowiedzi na CALA strone (rozstrzygniecie 3).
      pozycjeListy: karty.map(pozycjaListy),
      juzPowiazane: powiazaneOfertyAllegro(db)
        .map((p) => ({ ...p, etykietaKanalu: adresKanalu(p.kanal) })),
      wynik,
      // Adres, stan aktywnosci i strzalka KAZDEGO naglowka sortujacego — policzone tutaj,
      // bo widok w tym module niczego nie rozstrzyga.
      sortowanie: linkiPowiazan(sort, kier, filtry, wroc),
      // Formularze GET niosa nawzajem swoje wartosci ukrytymi polami — inaczej klikniecie
      // „Filtruj" gubiloby fraze, a wpisanie frazy gubiloby filtr konta (niezmiennik 4.13b).
      filtry,
      wartosciPol: { fraza: filtry.fraza ?? '' },
      ukryteWFiltrach: ukrytePowiazan(filtry, { sort, kier, wroc }, ['kanal']),
      ukryteWSzukajce: ukrytePowiazan(filtry, { sort, kier, wroc }, ['fraza']),
      filtrowane: Boolean(filtry.fraza || filtry.kanal),
      adresBezFiltrow: adresPowiazan({}, { sort, kier, wroc }),
      // Powrot na zawezony magazyn (4.13d). Czytany RAZ, w tej funkcji — bo renderuja ja
      // TRZY trasy (odczyt, wiazanie hurtem, odpiecie) i osobny odczyt w kazdej z nich
      // rozjechalby sie po cichu przy pierwszej zmianie.
      adresPowrotu: wroc ?? '/magazyn',
      kanalyDoFiltra: KANALY_ALLEGRO.map((klucz) => ({ klucz, etykieta: adresKanalu(klucz) })),
    });
  }

  app.get('/magazyn/powiazania', async (req, reply) => {
    if (!magazyn) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    // ⚠️ TA TRASA WYLACZNIE CZYTA. Ani jednego zapisu — patrz naglowek sekcji.
    return ekranPowiazan(req, reply);
  });

  // ⚠️ ZATWIERDZENIE HURTEM JEST PRZYCISKIEM, NIE SKUTKIEM UBOCZNYM. Renderuje wynik zamiast
  // przekierowywac (ta sama zasada, co przy „Utwórz karty z niepowiązanych" i przy nadaniu
  // zbiorczym): ekran wyniku jest jedynym miejscem, w ktorym widac, czego panel NIE tknal.
  app.post('/magazyn/powiazania', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);

    const karty = kartyDoPowiazania(db);
    // ⚠️⚠️ OBIE LISTY, A NIE SAME NIEPOWIAZANE — i to jest cala droga dla stanu
    // nieaktualnego. Formularz z 447 wierszami zyje w karcie dlugo; oferta, ktora ktos
    // powiazal w drugiej karcie, JUZ NIE JEST niepowiazana. Gdybysmy szukali jej wylacznie
    // wsrod niepowiazanych, wypadlaby jako „nie ma jej w lustrze" (nieprawda — jest,
    // i jest powiazana z czyms innym) albo zniknelaby po cichu. Tak dochodzi do warstwy
    // zapisu, tam odbija sie od warunku `karta_id IS NULL` i wraca z wlasnym powodem.
    const oferty = [...niepowiazaneOfertyAllegro(db), ...powiazaneOfertyAllegro(db)];
    const { pary, pominiete } = paryZFormularza(req.body, oferty, karty);
    const { powiazane, nieaktualne } = powiazOfertyHurtem(db, pary);

    // ⚠️ NIEAKTUALNE MAJA WLASNY POWOD, a nie wspolny worek „nie udało się". Oferta, ktorej
    // nie ruszylismy, bo ktos ja powiazal w drugiej karcie, to CO INNEGO niz oferta,
    // ktorej karty nie rozpoznalismy — i tylko przy pierwszej z nich nie ma nic do poprawy.
    const poNazwie = new Map(oferty.map((o) => [o.id, o.nazwa]));
    for (const id of nieaktualne) {
      pominiete.push({
        nazwa: poNazwie.get(id) ?? `oferta #${id}`,
        powod: 'nie ruszyłem jej — ktoś ją powiązał w międzyczasie albo zniknęła z Allegro',
      });
    }

    return ekranPowiazan(req, reply, { powiazane: powiazane.length, pominiete });
  });

  // ⚠️⚠️ WIAZANIE JEST ODWRACALNE (rozstrzygniecie wlasciciela). Bez tej trasy pomylka
  // w hurcie byla nie do cofniecia z panelu — a hurtem pomylka jest hurtowa. Warunek kanalu
  // stoi w `odepnijOferte`: ta trasa nie ma prawa odpiac produktu SKLEPOWEGO, bo to jego
  // powiazanie ZBUDOWALO karte.
  app.post('/magazyn/powiazania/odepnij', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const id = Number(req.body?.id);
    const odpieto = Number.isInteger(id) && odepnijOferte(db, id);
    return ekranPowiazan(req, reply, odpieto
      ? { odpiete: 1, powiazane: 0, pominiete: [] }
      : { odpiete: 0, powiazane: 0, pominiete: [{ nazwa: `oferta #${req.body?.id}`, powod: 'nie ma czego odpiąć' }] });
  });
  app.post('/magazyn/:id', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);

    const { zmiany, blad } = zmianyZFormularza(db, karta, req.body);
    // ⚠️ ODMOWA NIE ZAPISUJE NICZEGO i wraca CALA karta z otwartym formularzem. 400, bo
    // zadanie faktycznie odrzucilismy — strona z komunikatem i kodem 200 twierdzilaby,
    // ze wszystko poszlo dobrze.
    if (blad) return ekranKarty(req, reply, { karta, blad, kod: 400 });

    zapiszKarte(db, karta.id, zmiany);
    // 303, a nie 302: po POST-cie przegladarka ma pojsc GET-em, zeby odswiezenie strony
    // nie proponowalo powtorzenia zapisu.
    // ⚠️ `wroc` Z ADRESU TEGO ZADANIA (Zadanie 6) — formularz karty POSTuje pod adres akcji,
    // ktory JUZ niesie `?wroc=…` (patrz `adresKarty` przekazany widokowi), wiec query string
    // przezywa POST tak samo, jak przy kazdym innym POST-cie tej karty.
    return reply.code(303).redirect(adresKarty(karta.id, { wroc: bezpiecznyWroc(req.query.wroc) }));
  });

  /**
   * Dopisanie oferty Allegro do karty.
   *
   * ⚠️⚠️ WYLACZNIE OFERTY ALLEGRO, I TO JEST ROZSTRZYGNIECIE, A NIE NIEDOROBKA. Odpiac wolno
   * tylko oferte (produkt SKLEPOWY zbudowal karte — patrz `odepnijOferte`), wiec produkt
   * sklepowy przypiety z karty bylby juz NIE DO ODPIECIA: pomylka jednego klikniecia
   * zostawalaby na zawsze. Bariera nie jest tu pisana od nowa — `powiazOfertyHurtem` niesie
   * JUZ komplet warunkow (`kanal LIKE 'allegro%'`, `karta_id IS NULL`, `zniknal_at IS NULL`)
   * i to on jest jedynym miejscem, w ktorym te warunki zyja.
   *
   * ⚠️ `karta_id IS NULL` jest tu straznikiem stanu NIEAKTUALNEGO: oferta przypieta w drugiej
   * karcie nie ma prawa zostac po cichu przepieta — bez tego ten sam produkt trafilby do
   * dwoch kart, a stan, wymiar i waga paczki liczylyby sie z niewlasciwej karty.
   */
  app.post('/magazyn/:id/powiaz', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);

    const produktId = Number(req.body?.produktSklepowyId);
    if (!Number.isInteger(produktId)) {
      return ekranKarty(req, reply, {
        karta, kod: 400, blad: 'Nie rozpoznałem oferty do przypięcia — nic nie przypiąłem.',
      });
    }

    const { powiazane } = powiazOfertyHurtem(db, [{ produktId, kartaId: karta.id }]);
    if (!powiazane.length) {
      // ⚠️ ODMOWA MOWI, CO SIE STALO. „Nie udało się" zostawiloby czlowieka z pytaniem,
      // czy to jego pomylka, czy usterka panelu — a to sa trzy rozne stany i kazdy ma
      // inne wyjscie.
      return ekranKarty(req, reply, {
        karta,
        kod: 409,
        blad: 'Nie przypiąłem tej pozycji: albo należy już do innej karty produktu, albo zniknęła '
          + 'z Allegro, albo jest produktem sklepowym — a produkty sklepowe wiąże '
          + '„Utwórz karty z niepowiązanych", nie karta produktu.',
      });
    }
    // ⚠️ `wroc` z adresu TEGO zadania — formularz „Przypnij" POSTuje pod `adresPowiaz`,
    // ktory JUZ niesie `?wroc=…` (Zadanie 6; patrz komentarz przy jego skladaniu w
    // `ekranKarty` — doklejenie na piechote za `adresKarty` wsadzaloby `/powiaz` w srodek
    // wartosci parametru).
    return reply.code(303).redirect(adresKarty(karta.id, { wroc: bezpiecznyWroc(req.query.wroc) }));
  });

  /**
   * Odpiecie oferty od TEJ karty.
   *
   * ⚠️⚠️ PRODUKTU SKLEPOWEGO ODPIAC NIE WOLNO — bariera stoi w `odepnijOferte` (warunek
   * kanalu) i nie ma jej tu drugiej. Karta osierocona przez odpiecie produktu, ktory ja
   * zbudowal, zostalaby bez ceny, bez zdjecia, bez kategorii i bez sladu, co ja osierocilo.
   *
   * ⚠️ NAJPIERW SPRAWDZAMY, CZY OFERTA W OGOLE NALEZY DO TEJ KARTY. `odepnijOferte` zna
   * kanal, ale nie zna karty, na ktorej stoimy — bez tego warunku zadanie z numerem cudzej
   * oferty odpinaloby ja od CUDZEJ karty, a na tej karcie nie widac by tego bylo wcale.
   */
  app.post('/magazyn/:id/odepnij', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const karta = kartaPoId(db, req.params.id);
    if (!karta) return brakKarty(reply, req.params.id);

    const produktId = Number(req.body?.produktSklepowyId);
    const nasz = produktyKarty(db, karta.id).some((p) => p.id === produktId);
    const odpieto = nasz && odepnijOferte(db, produktId);
    if (!odpieto) {
      return ekranKarty(req, reply, {
        karta,
        kod: 409,
        blad: nasz
          ? 'Tego odpiąć nie mogę: produkt ze sklepu zbudował tę kartę i odpięcie zostawiłoby '
            + 'kartę bez ceny, zdjęć i kategorii. Odpinać wolno wyłącznie oferty Allegro.'
          : 'Nie ma czego odpiąć — ta pozycja nie jest przypięta do tej karty.',
      });
    }
    // ⚠️ `wroc` z adresu TEGO zadania — formularz „Odepnij" POSTuje pod `adresOdepnij`,
    // ktory JUZ niesie `?wroc=…` (Zadanie 6, ta sama pulapka sklejania, co przy `powiaz`).
    return reply.code(303).redirect(adresKarty(karta.id, { wroc: bezpiecznyWroc(req.query.wroc) }));
  });
}
