// Port frozen 5b9cd765: 1502–1660.
export function registerZapisMagazynu(app, { db, magazyn, sklepy, pomoc, karta }) {
  const { wzoryZKanalami, wzoryPoIdach, produktyWzorow, zapiszSkuSklepu, ocenZapis, jednostkiSklepow, wyslijDoSklepow, adresKanalu, KANALY_SKLEPOW, BEZ_SKLEPOW_ODMOWA, pole, numeryZaznaczone, filtryZawezenia, zakresHurtu } = pomoc;
  // ——— ZAPIS SKU I WYMIAROW DO SKLEPOW ——————————————————————————————————————————
  //
  // ⚠️⚠️ TO JEST JEDYNE MIEJSCE W CALYM MODULE, KTORE PISZE DO SKLEPU, KTORY SPRZEDAJE.
  // Zapis jest NIEODWRACALNY Z PANELU: „cofnij" znaczyloby drugi zapis, a panel nie trzyma
  // tego, co bylo. Dlatego podglad pokazuje STARE → NOWE dla kazdej pozycji, a nie liczbe.
  //
  // ⚠️⚠️ ZESTAW LICZONY PONOWNIE PRZY ZATWIERDZENIU, ta sama funkcja i ten sam stan biezacy —
  // razem z ODCZYTEM JEDNOSTKI ZE SKLEPU. Przepisanie gotowego zestawu z ukrytego pola
  // pozwoliloby wyslac numer, ktorego juz nie ma w rejestrze.
  //
  // ⚠️ PANEL WYSYLA WYLACZNIE SKU I WYMIARY (domain/zapis-do-sklepu.js). Do Allegro nie
  // pisze nic.

  const ZAPIS_BEZ_ZAZNACZENIA = 'Nie zaznaczono ani jednego wzoru, więc nie mam czego wysyłać '
    + 'do sklepów. Zaznacz wzory na liście albo kliknij przycisk „dla wszystkich pasujących" — stoi przy tej samej akcji i podaje, ilu wzorów dotyczy.';

  /**
   * Zestaw zapisu dla podanych wzorow — ZE STANU BIEZACEGO, razem z jednostkami odczytanymi
   * ze sklepow.
   *
   * ⚠️⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZATWIERDZENIE. Druga kopia rozjechalaby sie z pierwsza
   * i ekran obiecywalby co innego, niz robi zapis — a zapisu nie da sie cofnac.
   *
   * ⚠️ KANAL, KTOREGO JEDNOSTKI NIE ZNAMY, NIE JEST POMIJANY PO CICHU: jego produkty wracaja
   * jako WSTRZYMANE z powodem. Cicho pominiety kanal wyglada na ekranie dokladnie tak samo,
   * jak kanal, w ktorym nie ma nic do zmiany.
   */
  async function zestawZapisu(wzory) {
    const produkty = produktyWzorow(db, wzory.map((w) => w.id));
    // O jednostke pytamy WYLACZNIE te kanaly, ktore naprawde wystepuja — i wylacznie
    // sklepowe (do Allegro nie piszemy nic, wiec nie ma po co go budzic).
    const kanaly = produkty.map((p) => p.kanal).filter((k) => KANALY_SKLEPOW.includes(k));
    const { jednostki, bledy } = await jednostkiSklepow(sklepy, kanaly);

    const zmiany = [];
    const wstrzymane = [];
    for (const wzor of wzory) {
      const moje = produkty.filter((p) => p.wzor_id === wzor.id);
      // Kanal z bledem odpada PRZED regula: `ocenZapis` rzuca przy nieznanej jednostce,
      // a to jest awaria kanalu, nie usterka wiersza.
      for (const p of moje.filter((x) => Object.hasOwn(bledy, x.kanal))) {
        wstrzymane.push({
          wzor_id: wzor.id,
          kanal: p.kanal,
          produkt_id: String(p.produkt_id ?? ''),
          wariant_id: String(p.wariant_id ?? ''),
          nazwa: p.nazwa,
          powod: bledy[p.kanal],
        });
      }
      const dobre = moje.filter((x) => !Object.hasOwn(bledy, x.kanal));
      const ocena = ocenZapis(wzor, dobre, jednostki);
      zmiany.push(...ocena.zmiany);
      wstrzymane.push(...ocena.wstrzymane);
    }
    return { zmiany, wstrzymane };
  }

  // Sciezka zapisu jest ADRESEM, pod ktory pojdzie PUT — pokazujemy ja wprost, bo to jedyna
  // rzecz, po ktorej widac roznice miedzy rodzicem a wariantem.
  const pozycjaZapisu = (p, nazwaWzoru) => ({
    ...p,
    nazwaWzoru,
    etykietaKanalu: adresKanalu(p.kanal),
    sciezka: p.sciezka ?? (p.wariant_id
      ? `products/${p.produkt_id}/variations/${p.wariant_id}`
      : `products/${p.produkt_id}`),
  });

  function ekranZapisu(reply, {
    zmiany = [], wstrzymane = [], nazwy = new Map(), zawezenie = '', blad = null,
    wynik = null, kod = 200,
  }) {
    return reply.code(kod).view('magazyn-podglad.ejs', {
      title: 'Magazyn — zapis do sklepów',
      zmiany: zmiany.map((z) => pozycjaZapisu(z, nazwy.get(z.wzor_id) ?? null)),
      wstrzymane: wstrzymane.map((z) => pozycjaZapisu(z, nazwy.get(z.wzor_id) ?? null)),
      ile: zmiany.length,
      ileWstrzymanych: wstrzymane.length,
      wynik,
      blad,
      // ⚠️ FORMULARZ NIESIE NUMERY WZOROW, NIGDY GOTOWYCH ZMIAN. Zestaw liczy sie od nowa.
      doZatwierdzenia: [...new Set(zmiany.map((z) => z.wzor_id))],
      // ⚠️ PRZYCISK ISTNIEJE, GDY JEST CO WYSLAC — to UPRZEJMOSC, nie zabezpieczenie:
      // trasa wysylajaca liczy zestaw PONOWNIE.
      mozna: Boolean(zmiany.length) && !wynik,
      adresPowrotu: zawezenie ? `/magazyn?${zawezenie}` : '/magazyn',
    });
  }

  /** Wzory z zadania — to samo odczytanie zakresu, co przy hurcie i generatorze. */
  function wzoryZZadania(req) {
    const zakres = zakresHurtu(pole(req.body, 'zakres'));
    if (zakres === 'pasujace') {
      const filtry = filtryZawezenia(pole(req.body, 'zawezenie') ?? '');
      return wzoryZKanalami(db, { fraza: filtry.fraza, filtry });
    }
    const numery = numeryZaznaczone(req.body?.zaznaczone);
    if (!numery.length) return null;
    return wzoryPoIdach(db, numery);
  }

  // ⚠️⚠️ TA TRASA NICZEGO NIE WYSYLA. Podglad jest OBOWIAZKOWY i jest osobna trasa wlasnie
  // po to, zeby zapis do zywego sklepu nie dal sie wywolac przez pomylke w polu formularza.
  app.post('/magazyn/podglad-zapisu', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const zawezenie = pole(req.body, 'zawezenie') ?? '';
    const wzory = wzoryZZadania(req);
    if (!wzory) return ekranZapisu(reply, { zawezenie, blad: ZAPIS_BEZ_ZAZNACZENIA, kod: 400 });

    const { zmiany, wstrzymane } = await zestawZapisu(wzory);
    return ekranZapisu(reply, {
      zmiany, wstrzymane, zawezenie, nazwy: new Map(wzory.map((w) => [w.id, w.nazwa])),
    });
  });

  // ⚠️⚠️ TU PANEL PISZE DO SKLEPU, KTORY SPRZEDAJE — jedyne takie miejsce w calym module.
  //
  // ⚠️⚠️ ZESTAW LICZONY PONOWNIE, TA SAMA FUNKCJA I TEN SAM STAN BIEZACY, razem z odczytem
  // jednostki ze sklepu. Formularz podgladu niesie WYLACZNIE numery wzorow: gdyby niosl
  // gotowe zmiany, wyslalby numer, ktorego juz nie ma w rejestrze (drugi operator, druga
  // karta, przejecie numeru w miedzyczasie).
  //
  // ⚠️ RENDERUJE WYNIK, NIGDY NIE PRZEKIEROWUJE. Lista „poszło / nie poszło" jest jedynym
  // swiadectwem operacji, ktorej nie da sie cofnac klknieciem — ta sama zasada, co przy
  // nadaniu zbiorczym, gdzie numery listow zostaja na ekranie.
  app.post('/magazyn/zapisz-do-sklepow', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const zawezenie = pole(req.body, 'zawezenie') ?? '';
    const wzory = wzoryZZadania(req);
    if (!wzory) return ekranZapisu(reply, { zawezenie, blad: ZAPIS_BEZ_ZAZNACZENIA, kod: 400 });

    const { zmiany, wstrzymane } = await zestawZapisu(wzory);
    const wyniki = await wyslijDoSklepow({ sklepy, zmiany });

    // ⚠️ LUSTRO DOGANIA SKLEP WYLACZNIE W TYM, CO SKLEP PRZYJAL, i wylacznie w kolumnie
    // numeru. Bez tego kolejny podglad pokazalby te sama zmiane jeszcze raz i zaprosil do
    // drugiego zapisu; z upsertem calego wiersza — skasowalby powiazanie z wzorem.
    for (const { zmiana, ok } of wyniki) {
      if (ok && zmiana?.pola?.sku) zapiszSkuSklepu(db, zmiana, zmiana.pola.sku);
    }

    const poszlo = wyniki.filter((w) => w.ok).length;
    return ekranZapisu(reply, {
      // Wynik doklejony do TEJ SAMEJ pozycji, ktora czlowiek widzial przed kliknieciem —
      // ekran wyniku ma miec dokladnie ten sam ksztalt, co podglad.
      zmiany: wyniki.map((w) => ({ ...w.zmiana, ok: w.ok, blad: w.blad })),
      wstrzymane,
      zawezenie,
      nazwy: new Map(wzory.map((w) => [w.id, w.nazwa])),
      wynik: { poszlo, nieposzlo: wyniki.length - poszlo },
    });
  });

  // ——— POWIAZANIA OFERT ALLEGRO ————————————————————————————————————————————————
  //
  // ⚠️ Ekran skladany jest w JEDNYM miejscu (`ekranPowiazan`) i uzywany przez TRZY trasy:
  // odczyt, zatwierdzenie hurtem i odpiecie. Trzy osobne kopie tego skladania rozjechalyby
  // sie po cichu — a wynik operacji hurtowej ma pokazywac DOKLADNIE ten sam ekran, ktory
}
