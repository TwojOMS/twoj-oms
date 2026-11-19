// E4.12 — odczyt kanałów, otwarcie i zatwierdzenie ilości. Żadna trasa nie zapisuje do kanału.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  przelacznikStanow,
  migawkaStanow,
  stanKontynuacji,
  zapiszOtwarciaHurtem,
  kartyLustraZ,
  zamowieniaOdGranicy,
} from '../../oms/db/stany-magazynowe.js';
import { propozycjaOtwarcia, skrotZatwierdzenia, iloscDlaKanalu } from '../../domena/ilosc-kanalu.js';
import { zapiszZatwierdzenieStanow } from '../../oms/db/oferty-kanalow.ts';
import { kartaPozycji } from '../../domena/stany-magazynowe.js';
import { pobierzOfertyReczne } from './services/przejecie-ofert-erli.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';

const CZAS_PODGLADU = 30 * 60_000;
// N4: kilka podglądów naraz wystarczy; każdy trzyma tylko surowe odczyty kart, bez wyliczonych kanałów.
const MAKS_PODGLADOW = 5;
const objeta = (o) => o.tryb === 'zarzadzana' || (o.tryb === 'obserwowana' && o.ilosc_z_oms);
const oferty = (db) => db.prepare('SELECT * FROM oferty_kanalow ORDER BY id').all();
const bufory = (db) => db.prepare('SELECT klucz, bufor_szt FROM oferty_ustawienia_kont ORDER BY klucz').all();
const skrot = (db, migawka) =>
  skrotZatwierdzenia({
    oferty: oferty(db),
    migawka,
    maxRuchId: db.prepare('SELECT COALESCE(MAX(id), 0) id FROM ruchy_magazynowe').get().id,
    bufory: bufory(db),
  });

// Wszystkie powiązania, także obserwowane bez flagi: źródło otwarcia nie oznacza objęcia synchronizacją.
function powiazania(db) {
  const lista = db
    .prepare(
      'SELECT id, kanal, produkt_id, wariant_id, karta_id FROM produkty_sklepowe WHERE karta_id IS NOT NULL ORDER BY id',
    )
    .all();
  for (const o of oferty(db)) {
    const [produkt, wariant = ''] = String(o.id_zewnetrzne).split('/');
    if (!lista.some((p) => p.kanal === o.kanal && p.produkt_id === produkt && String(p.wariant_id ?? '') === wariant))
      lista.push({ id: null, kanal: o.kanal, produkt_id: produkt, wariant_id: wariant, karta_id: o.karta_id });
  }
  return lista;
}

// D56: efektywne pozycje tylko tej karty i tego konta. Domena odfiltruje statusy i czas odczytu.
// Jedno zapytanie o pozycje, z górnym ograniczeniem czasu najpóźniejszego odczytu.
function sprzedaz(db, granica, doChwili) {
  const lustro = kartyLustraZ(db);
  const wynik = new Map();
  for (const { zamowienie: z, pozycje } of zamowieniaOdGranicy(db, granica, { doChwili })) {
    for (const p of pozycje) {
      const karta = kartaPozycji(p, z.sklep, lustro);
      if (karta?.kartaId == null) continue;
      const klucz = JSON.stringify([z.sklep, karta.kartaId]);
      if (!wynik.has(klucz)) wynik.set(klucz, []);
      wynik.get(klucz).push({
        ilosc: Number(p.ilosc),
        zlozonoAt: z.utworzone_at,
        status: z.status_woo,
        anulowane: Boolean(z.anulowane || z.anulowane_recznie),
      });
    }
  }
  return wynik;
}

const najpozniejszyOdczyt = (kanaly) =>
  new Date(Math.max(Date.now(), ...kanaly.map((k) => Date.parse(k.odczytanoAt)).filter(Number.isFinite))).toISOString();
const powodPominiecia = (k) =>
  k.zywa === false
    ? 'oferta nieaktywna (zakończona, szkic lub zarchiwizowana)'
    : k.manage_stock === false || k.manage_stock === 'parent'
      ? 'kanał nie prowadzi własnego stanu'
      : null;

// Jedna karta: źródłem są tylko oferty żywe i prowadzące stan; reszta jest pokazana, ale nie wlicza się do minimum.
function zlozWiersz(karta, kanaly, granica) {
  const zrodla = kanaly.filter((k) => k.zywa !== false);
  const niepelne = zrodla.some(
    (k) => !k.kanal || (k.manage_stock !== false && k.manage_stock !== 'parent' && !Number.isFinite(k.odczyt)),
  );
  const propozycja = propozycjaOtwarcia({ kanaly: zrodla, granica });
  const bezZamowien = ({ zamowienia: _zamowienia, ...odczyt }) => odczyt;
  const poza = kanaly
    .filter((k) => k.kanal && powodPominiecia(k))
    .map((k) => ({ ...bezZamowien(k), powod: powodPominiecia(k) }));
  return {
    ...karta,
    ilosc: niepelne ? null : propozycja.ilosc,
    kanaly: [...propozycja.kanaly.map(bezZamowien), ...poza],
    surowe: kanaly.map(bezZamowien),
  };
}

/** @param {any} app @param {{ db: any, sklepy?: Record<string, any>, kontaAllegro?: () => any[], kontaErli?: () => any[] }} opcje */
export function registerStanyOtwarcie(app, { db, sklepy = {}, kontaAllegro = () => [], kontaErli = () => [] }) {
  const sekret = randomBytes(32);
  // Dane podglądu otwarcia żyją tylko w pamięci procesu (restart unieważnia też sekret); podpis niesie id, skrót i czas.
  const podgladyOtwarcia = new Map();
  const zapamietajPodglad = (dane) => {
    for (const [id, w] of podgladyOtwarcia) if (Date.now() - w.czas > CZAS_PODGLADU) podgladyOtwarcia.delete(id);
    while (podgladyOtwarcia.size >= MAKS_PODGLADOW) podgladyOtwarcia.delete(podgladyOtwarcia.keys().next().value);
    const id = randomBytes(16).toString('hex');
    const czas = Math.min(
      Date.now(),
      ...dane.wiersze.flatMap((w) => (w.surowe ?? []).map((k) => Date.parse(k.odczytanoAt))).filter(Number.isFinite),
    );
    const skrot = createHash('sha256').update(JSON.stringify(dane)).digest('hex');
    podgladyOtwarcia.set(id, { dane, skrot, czas: Date.now() });
    return { id, skrot, czas };
  };
  const mac = (tekst) => createHmac('sha256', sekret).update(tekst).digest('hex');
  const podpisz = (req, rodzaj, dane = {}) => {
    const tekst = Buffer.from(
      JSON.stringify({
        ...dane,
        rodzaj,
        login: req.konto?.login,
        przelaczenieId: przelacznikStanow(db).przelaczenieId,
        czas: dane.czas ?? Date.now(),
      }),
    ).toString('base64url');
    return `${tekst}.${mac(tekst)}`;
  };
  const sprawdz = (req, rodzaj) => {
    const [tekst, podpis, nadmiar] = String(req.body?.podglad ?? '').split('.');
    if (
      nadmiar ||
      !tekst ||
      !/^[a-f0-9]{64}$/.test(podpis ?? '') ||
      !timingSafeEqual(Buffer.from(podpis), Buffer.from(mac(tekst)))
    )
      return null;
    try {
      const dane = JSON.parse(Buffer.from(tekst, 'base64url').toString());
      return dane.rodzaj === rodzaj &&
        dane.login === req.konto?.login &&
        dane.przelaczenieId === przelacznikStanow(db).przelaczenieId &&
        Date.now() >= dane.czas &&
        Date.now() - dane.czas <= CZAS_PODGLADU
        ? dane
        : null;
    } catch {
      return null;
    }
  };
  const odmowa = (reply, kod, tekst) =>
    stronaOdmowy(reply, kod, tekst, {
      tytul: 'Stany magazynowe',
      wroc: '/magazyn/stany/otwarcie',
      napisWroc: 'Wróć do stanu otwarcia',
    });
  const dostep = (req, reply) => {
    if (req.konto?.admin !== true) return odmowa(reply, 403, 'Tylko administrator może zatwierdzać stany.');
    if (!przelacznikStanow(db).wlaczone) return reply.code(303).redirect('/magazyn/ustawienia');
    return null;
  };
  // Allegro: ACTIVE; ENDED ze znacznikiem OMS; ENDED przy 0 bez znacznika = wyprzedana przez Allegro (D55, D56),
  // chyba że ta karta ma na tym koncie ofertę ACTIVE — wtedy zakończona jest stara. ENDED przy > 0 bez znacznika: ręcznie.
  const zywaAllegro = (oferta, p, kartaMaAktywna) => {
    const status = oferta?.publication?.status;
    if (status === 'ACTIVE') return true;
    if (status !== 'ENDED') return false;
    try {
      const w = db
        .prepare('SELECT wyslane_pola_json j FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?')
        .get(p.kanal, p.produkt_id);
      if (JSON.parse(w?.j ?? 'null')?.zakonczonaPrzezOms) return true;
    } catch {
      return false;
    }
    return oferta?.stock?.available === 0 && !kartaMaAktywna;
  };
  const skrotPowiazan = () =>
    createHash('sha256')
      .update(JSON.stringify(powiazania(db)))
      .digest('hex');
  const karty = () => db.prepare('SELECT id, nazwa, sku FROM karty_produktow ORDER BY id').all();
  const pokazOtwarcie = (req, reply, wiersze = [], bledy = [], zrodlo = 'kanaly') =>
    reply.view('magazyn-stany-otwarcie.ejs', {
      title: 'Stan otwarcia z kanałów',
      szerokosc: 'formularz',
      wiersze,
      bledy,
      kontynuacja: Boolean(stanKontynuacji(db)),
      zapisano: Number(req.query?.zapisano) || 0,
      pominieto: Number(req.query?.pominieto) || 0,
      wynik: req.query?.zapisano !== undefined,
      podglad: wiersze.length
        ? podpisz(
            req,
            'otwarcie',
            zapamietajPodglad({
              zrodlo,
              powiazania: skrotPowiazan(),
              wiersze: wiersze.map(({ kanaly: _kanaly, ...w }) => w),
            }),
          )
        : null,
    });

  app.get('/magazyn/stany/otwarcie', async (req, reply) => dostep(req, reply) || pokazOtwarcie(req, reply));

  app.post('/magazyn/stany/otwarcie/odczytaj', async (req, reply) => {
    const brak = dostep(req, reply);
    if (brak) return brak;
    const przelaczenie = przelacznikStanow(db);
    const powiazane = powiazania(db);
    const odczyty = new Map();
    const bledy = [];
    const klucz = (p) => JSON.stringify([p.kanal, p.produkt_id, String(p.wariant_id ?? '')]);
    const zapamietaj = (p, odczyt, prowadzi, typ, zywa) => {
      const at = new Date().toISOString();
      const ilosc = Number.isSafeInteger(odczyt) ? odczyt : null;
      odczyty.set(klucz(p), {
        kanal: typ,
        konto: p.kanal,
        odczyt: ilosc,
        manage_stock: prowadzi,
        zywa,
        odczytanoAt: at,
      });
      if (p.id !== null)
        db.prepare(
          `UPDATE produkty_sklepowe SET ilosc_kanalu = ?, stan_prowadzony = ?, ilosc_odczytana_at = ? WHERE id = ?`,
        ).run(
          ilosc,
          prowadzi === true ? 'tak' : prowadzi === false ? 'nie' : prowadzi === 'parent' ? 'rodzic' : null,
          at,
          p.id,
        );
    };
    for (const kanal of [...new Set(powiazane.map((p) => p.kanal))]) {
      const produkty = powiazane.filter((p) => p.kanal === kanal);
      try {
        const woo = sklepy[kanal];
        const allegro = kontaAllegro().find((k) => k.klucz === kanal);
        const erli = kontaErli().find((k) => k.klucz === kanal);
        if (woo) {
          const proste = produkty.filter((p) => !p.wariant_id);
          const wynik = proste.length
            ? await woo.pobierzStany([...new Set(proste.map((p) => Number(p.produkt_id)))])
            : [];
          for (const p of proste) {
            const w = wynik.find((w) => String(w.id) === p.produkt_id);
            zapamietaj(p, w?.stock_quantity, w?.manage_stock, 'woo', w ? w.status === 'publish' : undefined);
          }
          for (const rodzic of [...new Set(produkty.filter((p) => p.wariant_id).map((p) => p.produkt_id))]) {
            const warianty = produkty.filter((p) => p.produkt_id === rodzic && p.wariant_id);
            const lista = await woo.pobierzStanyWariantow(Number(rodzic), [
              ...new Set(warianty.map((p) => Number(p.wariant_id))),
            ]);
            for (const p of warianty) {
              const w = lista.find((w) => String(w.id) === String(p.wariant_id));
              zapamietaj(p, w?.stock_quantity, w?.manage_stock, 'woo', w ? w.status === 'publish' : undefined);
            }
          }
        } else if (allegro) {
          const znalezione = new Map();
          // Klient sam pobiera wszystkie strony i odmawia niepełnej odpowiedzi.
          const wynik = await allegro.klient.ofertyKonta({ offset: 0 });
          if (!Array.isArray(wynik?.oferty)) throw new Error('Niepoprawny odczyt Allegro.');
          for (const w of wynik.oferty) znalezione.set(String(w.id), w);
          const aktywneKarty = new Set(
            produkty
              .filter((p) => znalezione.get(p.produkt_id)?.publication?.status === 'ACTIVE')
              .map((p) => Number(p.karta_id)),
          );
          for (const p of produkty) {
            const w = znalezione.get(p.produkt_id);
            zapamietaj(
              p,
              w?.stock?.available,
              true,
              'allegro',
              w ? zywaAllegro(w, p, aktywneKarty.has(Number(p.karta_id))) : undefined,
            );
          }
        } else if (erli) {
          const wynik = await pobierzOfertyReczne(erli);
          if (wynik.limit) throw new Error('Przekroczony limit odczytu ERLI.');
          for (const p of produkty) {
            const w = wynik.produkty.find((w) => w.externalId === p.produkt_id);
            zapamietaj(p, w?.stock, true, 'erli', w ? !w.archived : undefined);
          }
        } else throw new Error('Brak klienta kanału.');
      } catch {
        bledy.push(`Nie udało się odczytać konta ${kanal}. Odczytaj ponownie.`);
      }
    }
    if (
      przelacznikStanow(db).przelaczenieId !== przelaczenie.przelaczenieId ||
      JSON.stringify(powiazania(db)) !== JSON.stringify(powiazane)
    )
      return odmowa(reply, 409, 'Stany lub powiązania zmieniono podczas odczytu. Odczytaj ponownie.');
    const sprzedane = sprzedaz(db, przelaczenie.granica, najpozniejszyOdczyt([...odczyty.values()]));
    const ruchy = new Map(
      db
        .prepare(
          `SELECT karta_id, SUM(ilosc) suma FROM ruchy_magazynowe
      WHERE julianday(utworzono_at) >= julianday(?) AND rodzaj <> 'otwarcie' GROUP BY karta_id`,
        )
        .all(przelaczenie.granica)
        .map((w) => [Number(w.karta_id), Number(w.suma)]),
    );
    const wiersze = karty().map((k) => {
      const zrodla = powiazane.filter((p) => Number(p.karta_id) === Number(k.id));
      const kanaly = zrodla.map((p) => ({
        ...odczyty.get(klucz(p)),
        zamowienia: sprzedane.get(JSON.stringify([p.kanal, Number(k.id)])) ?? [],
      }));
      return { ...zlozWiersz(k, kanaly, przelaczenie.granica), ruchy: ruchy.get(Number(k.id)) ?? 0 };
    });
    return pokazOtwarcie(req, reply, wiersze, bledy);
  });

  app.post('/magazyn/stany/otwarcie/kontynuuj', async (req, reply) => {
    const brak = dostep(req, reply);
    if (brak) return brak;
    const poprzedni = stanKontynuacji(db);
    if (!poprzedni) return odmowa(reply, 409, 'Brak poprzedniego stanu do kontynuacji.');
    const wiersze = karty()
      .filter((k) => poprzedni.znane.has(Number(k.id)))
      .map((k) => ({ ...k, ilosc: Math.max(0, poprzedni.stany.get(Number(k.id))?.stan ?? 0), kanaly: [] }));
    return pokazOtwarcie(req, reply, wiersze, [], 'kontynuacja');
  });

  app.post('/magazyn/stany/otwarcie/zapisz', async (req, reply) => {
    const brak = dostep(req, reply);
    if (brak) return brak;
    const podpis = sprawdz(req, 'otwarcie');
    const zapamietany = podpis && podgladyOtwarcia.get(podpis.id);
    if (!zapamietany || zapamietany.skrot !== podpis.skrot || zapamietany.dane.powiazania !== skrotPowiazan())
      return odmowa(reply, 409, 'Podgląd otwarcia wygasł lub zmieniono powiązania. Odczytaj ponownie.');
    const dane = zapamietany.dane;
    let wiersze = dane.wiersze;
    if (dane.zrodlo === 'kanaly') {
      // Zamówienie złożone przed odczytem mogło trafić do bazy dopiero po nim: przelicz okno [granica, odczyt].
      const granica = przelacznikStanow(db).granica;
      const sprzedane = sprzedaz(db, granica, najpozniejszyOdczyt(dane.wiersze.flatMap((w) => w.surowe)));
      const nowe = dane.wiersze.map((w) => ({
        ...zlozWiersz(
          { id: w.id, nazwa: w.nazwa, sku: w.sku },
          w.surowe.map((k) => ({ ...k, zamowienia: sprzedane.get(JSON.stringify([k.konto, Number(w.id)])) ?? [] })),
          granica,
        ),
        ruchy: w.ruchy,
      }));
      const zmienione = nowe.filter((w, i) => w.ilosc !== dane.wiersze[i].ilosc).length;
      if (zmienione) {
        reply.code(409);
        return pokazOtwarcie(req, reply, nowe, [
          `Po odczycie doszły zamówienia złożone przed nim (zmienione propozycje: ${zmienione}). Nic nie zapisano — sprawdź nowe wartości i zapisz ponownie.`,
        ]);
      }
      wiersze = nowe;
    }
    const zapisy = [];
    for (const w of wiersze) {
      const wartosc = req.body?.[`ilosc_${w.id}`];
      if (wartosc === undefined || wartosc === '') continue;
      if (typeof wartosc !== 'string' || !/^\d+$/.test(wartosc) || !Number.isSafeInteger(Number(wartosc)))
        return odmowa(reply, 400, 'Wpisz ilość jako liczbę całkowitą ≥ 0.');
      zapisy.push({
        kartaId: Number(w.id),
        ilosc: Number(wartosc),
        zrodlo:
          dane.zrodlo === 'kontynuacja'
            ? 'kontynuacja'
            : (w.kanaly ?? [])
                .filter((k) => !k.powod)
                .map((k) => k.konto)
                .join(', ') || 'ręcznie',
        konto: req.konto,
      });
    }
    if (!zapisy.length) return odmowa(reply, 400, 'Zatwierdź co najmniej jedną wartość otwarcia.');
    // Import sprzed E4 może mieć sam ruch, bez wiersza stany_otwarcia. Takie otwarcie też pozostaje bez zmian.
    const starszeOtwarcia = new Set(
      db
        .prepare(
          `SELECT karta_id FROM ruchy_magazynowe
      WHERE rodzaj = 'otwarcie' AND julianday(utworzono_at) >= julianday(?)`,
        )
        .all(przelacznikStanow(db).granica)
        .map((w) => Number(w.karta_id)),
    );
    const doZapisu = zapisy.filter((z) => !starszeOtwarcia.has(z.kartaId));
    let wynik;
    try {
      wynik = zapiszOtwarciaHurtem(db, doZapisu);
    } catch {
      return odmowa(
        reply,
        409,
        'Nic nie zapisano: karty zmieniły się w trakcie zapisu (np. karta została usunięta). Odczytaj ponownie.',
      );
    }
    const pominieto = wynik.pominieto + zapisy.length - doZapisu.length;
    return reply.code(303).redirect(`/magazyn/stany/otwarcie?zapisano=${wynik.zapisano}&pominieto=${pominieto}`);
  });

  app.get('/magazyn/stany/kanaly/podglad', async (req, reply) => {
    const brak = dostep(req, reply);
    if (brak) return brak;
    const migawka = migawkaStanow(db);
    const wszystkie = oferty(db).filter(objeta);
    const konta = new Map();
    const bufor = new Map(bufory(db).map((w) => [w.klucz, Number(w.bufor_szt)]));
    const lustro = db
      .prepare('SELECT kanal, produkt_id, wariant_id, ilosc_kanalu, ilosc_odczytana_at FROM produkty_sklepowe')
      .all();
    for (const o of wszystkie) {
      if (!konta.has(o.kanal))
        konta.set(o.kanal, { konto: o.kanal, obnizki: 0, podwyzki: 0, bezZmian: 0, doZera: 0, blokady: 0 });
      const licznik = konta.get(o.kanal);
      const cel = iloscDlaKanalu({
        migawka: { ...migawka, zatwierdzenie: { przelaczenieId: migawka.przelaczenieId } },
        kartaId: Number(o.karta_id),
        tryb: o.tryb,
        iloscZOms: o.ilosc_z_oms,
        bufor: bufor.get(o.kanal) ?? 0,
      }).ilosc;
      const [produkt, wariant = ''] = String(o.id_zewnetrzne).split('/');
      const p = lustro.find(
        (p) => p.kanal === o.kanal && p.produkt_id === produkt && String(p.wariant_id ?? '') === wariant,
      );
      const odczyt =
        p && (!o.odczytano_at || Date.parse(p.ilosc_odczytana_at) >= Date.parse(o.odczytano_at))
          ? p.ilosc_kanalu
          : (o.odczyt_ilosc_kanalu ?? o.odczyt_ilosc);
      let wstrzymuje = false;
      try {
        wstrzymuje = Boolean(JSON.parse(o.ilosc_problem_json)?.wstrzymuje);
      } catch {
        wstrzymuje = true;
      }
      if (cel === null || odczyt === null || wstrzymuje) licznik.blokady++;
      else if (cel < odczyt) licznik.obnizki++;
      else if (cel > odczyt) licznik.podwyzki++;
      else licznik.bezZmian++;
      if (cel === 0) licznik.doZera++;
    }
    return reply.view('magazyn-stany-podglad.ejs', {
      title: 'Podgląd stanów w kanałach',
      szerokosc: 'tabela',
      konta: [...konta.values()],
      bezKarty: migawka.bezKarty,
      bezStanu: wszystkie.filter((o) => !migawka.znane.has(Number(o.karta_id))).length,
      podglad: podpisz(req, 'zatwierdzenie', { skrot: skrot(db, migawka) }),
      zatwierdzono: Boolean(migawka.zatwierdzenie),
    });
  });

  app.post('/magazyn/stany/kanaly/zatwierdz', async (req, reply) => {
    const brak = dostep(req, reply);
    if (brak) return brak;
    const dane = sprawdz(req, 'zatwierdzenie');
    const migawka = migawkaStanow(db);
    if (!dane || dane.skrot !== skrot(db, migawka))
      return odmowa(reply, 409, 'Podgląd wygasł albo zmieniły się stany, oferty lub bufory. Otwórz podgląd ponownie.');
    const bezStanu = oferty(db)
      .filter(objeta)
      .filter((o) => !migawka.znane.has(Number(o.karta_id))).length;
    if (bezStanu) return odmowa(reply, 409, `Najpierw ustal stan otwarcia: ${bezStanu} ofert bez znanego stanu.`);
    if (!migawka.zatwierdzenie)
      zapiszZatwierdzenieStanow(db, {
        przelaczenieId: migawka.przelaczenieId,
        zatwierdzil: req.konto.login,
        ofert: oferty(db).filter(objeta).length,
        skrot: dane.skrot,
      });
    return reply.code(303).redirect('/magazyn/stany/kanaly/podglad');
  });
}
