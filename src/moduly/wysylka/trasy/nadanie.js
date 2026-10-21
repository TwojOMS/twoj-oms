import { pobierzZamowienie, dopiszLog, oznaczWyslane, znajdzZamowieniaPoNumerze, ustawZamowienieZrodlowe } from '../../../oms/db/zamowienia.js';
import { zamowienieZGrupa } from '../../../oms/db/scalenia.js'; // PRZ-101.04: paczka głównego = pozycje całej grupy

import { nastepnaKolejnosc, zarejestrujPrzesylkeReczna } from '../db/przesylki.js';

import { wstawEtykieteDoKolejki } from '../services/kolejka-po-nadaniu.js';

import { mozliwaKolejnaPaczka } from '../../../domena/przesylka-stan.js';

import { powodBrakuGotowosciNadania } from '../../../domena/gotowosc-nadania.js';

import { wymagaWyboruKuriera, kurierzyDoWyboru, metodaNadania, nadanieDaZpl } from '../../../domena/kurier-nadania.js';

import { metodaWysylki, czyPobranie, kwotaPobrania, punktOdbioru } from '../../../domena/wysylka.js';

import { domyslnyRozmiarWiersza, polaWiersza, paczkaWiersza } from '../../../domena/nadanie-hurtem.js';

import { createNadanieHurtem } from '../services/nadanie-hurtem.js';

import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';

import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';

import { wybraneZListy, podzielDoNadania } from '../../../domena/masowe.js';

import { kurierWpisuRecznego } from '../../../oms/kurierzy/index.js';

import { powiazaniaDosylki } from '../../../domena/dosylka.js';

import { adresKanalu } from '../../../domena/kanaly.js';

import { komunikatDlaOperatora, bladOperatora } from '../../../domena/bledy.js';

import { adresOdbiorcy, brakujacePolaAdresu } from '../../../domena/adres-odbiorcy.js';

import { parsujAdresOdbiorcy } from '../../../domena/adres-formularza.js';

import { parsujPaczke, parsujPaczkeInpost, GABARYTY_PACZKOMATU } from '../../../domena/paczka.js';

import { profilGabarytuAllegro, parsujGabarytAllegro } from '../../../domena/gabaryty-allegro.js';

import { wolnoNadacZOms } from '../../../domena/allegro-wysylka.js';

import { odczytajSzablony } from '../../../domena/szablony-paczek.js';

import { wczytajUstawienia } from '../../../oms/db/ustawienia.js';

import { domyslnaPaczka } from '../../../domena/ustawienia-panelu.js';

import { parsujNadpisanieKwotyPobrania } from '../../../domena/pobranie-nadania.js';

import { wierszePozycji } from '../../../domena/tabela-pozycji.js';

import { odnosnikPozycji } from '../../../domena/link-pozycji.js';
import { czytajStawkeDomyslna } from '../../faktury/db/stawka-vat.js';

import { ktoKlikal } from '../../zamowienia/lista.js';

export function registerNadanieRoutes(app, { db, nadanie, kurierzy = {}, wczytajListe, miniaturyEkranu, config, syncSklep }) {

const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje);

const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);

// PRZ-070 (właściciel 14.10.2026): hurt nadaje wszystkie metody karty. Pętla, budżet czasu i druk
// mieszkają w usłudze (services/nadanie-hurtem.js) — trasa parsuje, pyta Allegro i renderuje.
const nadanieHurtem = nadanie ? createNadanieHurtem({ db, nadanie }) : null;

// Żywy odczyt usługi Allegro dla wiersza hurtu — TA SAMA para wywołań, co na ekranie nadania
// karty (`pobierzMetodeDostawy` + `wolnoNadacZOms`), na PEŁNYM wierszu z bazy, nie z listy.
// ⚠️ Usługa MUSI pochodzić z żywego odczytu: Allegro nie podbija `updatedAt` przy zmianach
// w zamówieniu, więc kopia w bazie bywa nieświeża z definicji (allegro-wysylka.js).
// Nigdy nie rzuca: awaria dotyczy wiersza, a reszta partii ma się wyrenderować.
const uslugaAllegro = async (z) => {
  const NIE_MOZNA = 'Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.';
  if (!kurierzy.allegro_wza?.pobierzMetodeDostawy) return { blad: NIE_MOZNA };
  const pelne = pobierzZamowienie(db, z.id);
  let id;
  try {
    id = await kurierzy.allegro_wza.pobierzMetodeDostawy(pelne);
  } catch {
    return { blad: NIE_MOZNA };
  }
  if (!id) return { blad: 'Allegro nie podało identyfikatora usługi dostawy.' };
  const zgoda = wolnoNadacZOms(pelne, { deliveryMethodIdZywy: id });
  if (!zgoda.wolno) return { blad: zgoda.powod };
  return { deliveryMethodId: id, usluga: zgoda.usluga };
};

// Suma pobrań liczona w groszach na całkowitych — złotówki jako ułamki zgubiłyby grosz
// przy kilkunastu paczkach, a ta liczba ma się zgadzać z tym, co kurier odda.
const groszeZ = (k) => Math.round(Number(String(k ?? '').replace(',', '.')) * 100);

app.post('/zamowienia/masowe/nadaj-podglad', async (req, reply) => {
    const wybrane = wybraneZListy(wczytajListe([].concat(req.body?.id ?? [])), req.body?.id);
    const { doNadania, pominiete, uwagi } = podzielDoNadania(wybrane);
    const ustawieniaPaczek = wczytajUstawienia(db);
    // ⚠️ Z USTAWIEN, nie ze stalej modulu (17.08.2026). Podglad musi pokazywac DOKLADNIE
    // to, co pojedzie do kuriera po zatwierdzeniu — a trasa zatwierdzajaca czyta to samo zrodlo.
    const szablony = odczytajSzablony(ustawieniaPaczek);
    const wiersze = [];
    const odpadle = [];
    for (const z of doNadania) {
      let deliveryMethodId = null;
      let droga = z.rodzajFormularza === 'paczkomat' ? `Paczkomat InPost — ${punktOdbioru(z)}` : 'DPD umowa własna';
      if (z.rodzajFormularza === 'wza') {
        const u = await uslugaAllegro(z);
        if (u.blad) {
          odpadle.push({ id: z.id, numer: z.numer, powod: u.blad });
          continue;
        }
        deliveryMethodId = u.deliveryMethodId;
        droga = `Wysyłam z Allegro — ${u.usluga}`;
      }
      wiersze.push({
        id: z.id,
        numer: z.numer,
        // Decyzja właściciela 14.10 (po obejrzeniu ekranu): zamiast odbiorcy — CO jedzie w paczce,
        // bo rozmiar wybiera się pod zawartość. TE SAME wiersze, co na karcie i ekranie nadania
        // (wierszePozycji), bez wysyłki i sumy; SKU zaślepki oferty wygaszone jak tam.
        produkty: wierszePozycji(zamowienieZGrupa(db, z), { stawkaDomyslna: czytajStawkeDomyslna(db) }).filter((w) => !w.wysylka && !w.podsumowanie)
          .map((w) => ({ ilosc: w.ilosc, nazwa: w.nazwa, sku: w.skuDoPokazania })),
        droga,
        deliveryMethodId,
        rozmiar: domyslnyRozmiarWiersza({ rodzaj: z.rodzajFormularza, deliveryMethodId, szablony }),
        pobranie: czyPobranie(z) ? (kwotaPobrania(z) ?? '?') : null,
        pobranieAllegro: czyPobranie(z) && z.rodzajFormularza === 'wza',
      });
    }
    const sumaGr = wiersze.filter((w) => w.pobranie && w.pobranie !== '?').reduce((s, w) => s + groszeZ(w.pobranie), 0);
    return reply.view('masowe-nadaj.ejs', {
      wiersze,
      pominiete: [...pominiete, ...odpadle],
      // Recenzja D8 (P3-3): uwagi tylko dla wierszy, które naprawdę pójdą — wiersz odbity przy
      // żywym odczycie Allegro nie może stać naraz w „Pominięte" i w „Warte oka".
      uwagi: uwagi.filter((u) => wiersze.some((w) => w.id === u.id)),
      szablony,
      sumaPobran: sumaGr ? (sumaGr / 100).toFixed(2) : null,
      paczka: nadanie ? domyslnaPaczka(ustawieniaPaczek) : null,
      nazwaSzablonu: szablony.szablony.find((s) => s.id === szablony.domyslnyId).nazwa,
      nadawanieDziala: Boolean(nadanie),
      // Adres powrotu jedzie DALEJ ukrytym polem formularza zatwierdzenia — inaczej ekran
      // podgladu zjadalby zawezenie po drodze i ekran wyniku nie mialby juz czym odeslac.
      powrot: bezpiecznyPowrotNaListe(req.body?.powrot, config.definicje),
    });
  });

app.post('/zamowienia/masowe/nadaj', async (req, reply) => {
    // Moment PRZYJŚCIA żądania — budżet partii mierzy czekanie człowieka, a człowiek czeka
    // także przez sekundy odczytu listy i pytań do Allegro (services/nadanie-hurtem.js).
    const start = Date.now();
    if (!nadanie) return reply.code(503).send('Nadawanie nie jest skonfigurowane (brak danych DPD).');
    const wybrane = wybraneZListy(wczytajListe([].concat(req.body?.id ?? [])), req.body?.id);
    // Podzial liczony PONOWNIE, a nie przepisany z ekranu podgladu: miedzy podgladem
    // a zatwierdzeniem poller mogl przyniesc anulowanie, a formularz przyniosly identyfikatory,
    // nie decyzje. Ta sama zasada, co przy numerze kolejnym paczki na ekranie pojedynczego
    // nadania — panel nie ufa temu, co wrocilo z przegladarki, w sprawach nieodwracalnych.
    const { doNadania, pominiete } = podzielDoNadania(wybrane);

    // ⚠️⚠️ RAZ NA CALA PACZKE ZAMOWIEN, PRZED PETLA. Odczyt w petli znaczylby, ze zmiana
    // ustawienia w trakcie nadawania hurtem rozdziela partie na paczki o dwoch roznych
    // gabarytach — a nadania nie da sie cofnac. Od PRZ-070 rozmiar wybiera czlowiek w wierszu
    // podgladu, ale z TEGO zestawu szablonow: szablon spoza niego odbija wiersz (paczkaWiersza).
    const szablony = odczytajSzablony(wczytajUstawienia(db));
    const drukowac = req.body?.zatwierdzenie === 'nadaj_i_drukuj';

    const doPetli = [];
    const odpadle = [];
    for (const z of doNadania) {
      let deliveryMethodId = null;
      if (z.rodzajFormularza === 'wza') {
        const u = await uslugaAllegro(z);
        if (u.blad) {
          odpadle.push({ id: z.id, numer: z.numer, powod: u.blad });
          continue;
        }
        // Usługa z ekranu MUSI być tą z tej chwili — inaczej człowiek zatwierdził inny przewóz
        // (inny gabaryt, inna cena) niż ten, który panel by kupił. Adapter sprawdza to drugi raz.
        if (String(req.body?.[`usluga_${z.id}`] ?? '') !== u.deliveryMethodId) {
          odpadle.push({ id: z.id, numer: z.numer, powod: 'Usługa dostawy Allegro zmieniła się — odśwież podgląd nadania.' });
          continue;
        }
        deliveryMethodId = u.deliveryMethodId;
      }
      const { paczka, blad } = paczkaWiersza({
        rodzaj: z.rodzajFormularza, deliveryMethodId, pola: polaWiersza(req.body, z.id), szablony,
      });
      if (blad) {
        odpadle.push({ id: z.id, numer: z.numer, powod: blad });
        continue;
      }
      doPetli.push({ z, paczka });
    }

    // Awaria jednej paczki nie zatrzymuje pozostałych — pilnuje tego usługa, nie trasa.
    const wynik = await nadanieHurtem.nadajWiele(doPetli, { start, drukowac });

    // ⚠️ Po nadaniu NIE przekierowujemy nigdy, nawet gdy wszystko poszlo — inaczej niz przy
    // statusie wyzej. Numery listow przewozowych sa jedynym potwierdzeniem operacji, ktorej
    // nie da sie ani powtorzyc, ani cofnac; wyrzucenie ich przekierowaniem znaczyloby, ze
    // jedynym sladem zostaje wpis w tabeli `log`, ktorej zaden ekran nie renderuje.
    return reply.view('masowe-wynik.ejs', {
      tytul: 'Nadanie zbiorcze',
      udane: wynik.udane,
      // Nadanie nie przekierowuje NIGDY (wyzej), ale odnosnik „Wroc do listy" na ekranie
      // wyniku ma odsylac tam, skad operator przyszedl — tak samo, jak po zmianie statusu.
      powrot: bezpiecznyPowrotNaListe(req.body?.powrot, config.definicje),
      pominiete: [
        ...pominiete,
        ...odpadle,
        ...wynik.nieudane,
        ...wynik.nietkniete.map((n) => ({ ...n, powod: 'nie nadano — skończył się czas partii; zaznacz i nadaj ponownie' })),
      ],
      // Nadanie nie odsyla statusu, wiec ta sekcja jest tu z definicji pusta — ale szablon
      // ma dostawac komplet pol z KAZDEJ trasy, a nie zgadywac po `typeof`.
      niedoslane: [],
      etykietaUdanych: 'Nadano — list przewozowy',
    });
  });

app.post('/zamowienia/:id/dosylka', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');

    const numer = String(req.body?.numer_zrodlowy ?? '').trim();
    let zrodloweId = null;
    try {
      if (numer) {
        // Pole niesie numer WIDOCZNY dla operatora (`R/2026/003` albo numer sklepowy) — ten
        // sam, ktory stoi na karcie i na liscie — a NIE wewnetrzny `id` z bazy, ktorego
        // nigdzie na ekranie nie ma.
        const trafienia = znajdzZamowieniaPoNumerze(db, numer);
        if (trafienia.length === 0) {
          throw bladOperatora(
            `Nie ma zamówienia o numerze „${numer}" — sprawdź numer zamówienia pierwotnego `
            + 'albo zostaw pole puste.',
          );
        }
        // Numery sklepowe i numery serii recznej to dwie rozne przestrzenie (patrz
        // znajdzZamowieniaPoNumerze) — kolizja jest dzis nieosiagalna, ale wieloznacznosc
        // ma dostac odmowe, a NIE ciche polaczenie z pierwszym z brzegu.
        if (trafienia.length > 1) {
          throw bladOperatora(
            `Numer „${numer}" pasuje do więcej niż jednego zamówienia w bazie — nie da się `
            + 'jednoznacznie wskazać zamówienia pierwotnego. Zgłoś to jako usterkę.',
          );
        }
        [zrodloweId] = trafienia;
        // Zamowienie wskazujace samo siebie pokazywaloby sie na wlasnej karcie jednoczesnie
        // jako pierwotne i jako dosylka — stan bez zadnego sensu, a przy tym zaraza raporty.
        if (zrodloweId === id) {
          throw bladOperatora('Zamówienie nie może być dosyłką do samego siebie.');
        }
        // ⚠️ To samo w DWOCH krokach (A→B, potem B→A) — ustalenie recenzji 2026-08-01.
        // `powiazaniaDosylki` schodzi o jeden poziom, wiec nic sie nie zapetla, ale OBIE
        // karty pokazywalyby to samo zamowienie naraz jako pierwotne i jako dosylke,
        // a raport sprzedazy nie mialby jak rozstrzygnac, ktore jest ktorym.
        if (powiazaniaDosylki(db, id).dosylki.some((d) => d.id === zrodloweId)) {
          throw bladOperatora(
            `Zamówienie „${numer}" jest już dosyłką DO TEGO zamówienia — nie da się powiązać ich `
            + 'w obie strony naraz. Najpierw skasuj tamto powiązanie.',
          );
        }
      }
      ustawZamowienieZrodlowe(db, id, zrodloweId);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'dosylka', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zapisać powiązania: ${komunikatDlaOperatora(e)}`);
    }

    dopiszLog(db, id, {
      akcja: 'dosylka',
      wynik: `Ręcznie (${ktoKlikal(req)}): ${numer
        ? `zamówienie oznaczone jako dosyłka do „${numer}"`
        : 'powiązanie z zamówieniem pierwotnym skasowane'}.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }));
  });

app.post('/zamowienia/:id/przesylki/reczna', async (req, reply) => {
    const id = Number(req.params.id);
    const zam = pobierzZamowienie(db, id);
    if (!zam) return reply.code(404).send('Nie ma takiego zamówienia');
    // Ta trasa nie przechodzi przez wybierzKuriera (nie potrzebuje SKONFIGUROWANEGO klienta —
    // niczego nie nadaje), wiec odmowa dla odbioru osobistego musi stac WPROST — inaczej
    // sprzedaz na miejscu dorobilaby sobie przesylke, ktorej nikt nie nadal.
    // PRZ-101.04: dołączone nie ma własnej paczki — ta sama odmowa, co przy nadaniu.
    if (zam.scalone_do) return reply.code(400).send(powodBrakuGotowosciNadania(zam));
    const metoda = metodaWysylki(zam);
    if (metoda === 'odbior_osobisty') {
      return reply.code(400).send('To zamówienie ma odbiór osobisty — nie ma do niego przesyłki.');
    }
    const numerListu = String(req.body?.numer_listu ?? '').trim();
    const komentarz = String(req.body?.komentarz ?? '').trim();

    let p;
    try {
      // `kolejnosc` liczona TUTAJ i przekazana jawnie — ta sama zasada, co przy nadaniu:
      // funkcja zapisu nigdy nie wylicza numeru sama, a indeks unikalny rozstrzyga wyscig.
      p = zarejestrujPrzesylkeReczna(db, id, {
        kurier: kurierWpisuRecznego(metoda), kolejnosc: nastepnaKolejnosc(db, id), numerListu,
      });
    } catch (e) {
      dopiszLog(db, id, { akcja: 'przesylka.reczna', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zarejestrować przesyłki: ${komunikatDlaOperatora(e)}`);
    }
    // ⚠️ TA droga oznacza zamowienie jako WYSLANE, a nadanie z panelu — NIE. Roznica nie
    // jest niekonsekwencja: tutaj czlowiek stwierdza fakt o paczce, ktora JUZ ZOSTALA
    // nadana poza panelem (jedzie), a tam panel dopiero drukuje etykiete przy pakowaniu.
    // Data zostaje pierwsza — dosylka za zgubiona paczke jej nie przestawi (oznaczWyslane).
    oznaczWyslane(db, id);
    dopiszLog(db, id, {
      akcja: 'przesylka.reczna',
      wynik: `Ręcznie (${ktoKlikal(req)}): paczka nr ${p.kolejnosc} nadana POZA panelem, `
        + `list ${p.numer_listu} — panel niczego nie nadał, tylko odnotował fakt`
        + `${komentarz ? `; ${komentarz}` : ''}.`,
    });
    // Ta droga USTAWIA `wyslane_at`, wiec status w sklepie ma pojsc za nia tak samo, jak po
    // recznej zmianie statusu. Nadanie z panelu (ktore `wyslane_at` NIE ustawia) dalej sklepu
    // nie dotyka — i to jest cala roznica, o ktora chodzilo.
    if (syncSklep) await syncSklep.odeslijStatus(id);
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.get('/zamowienia/:id/nadaj', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    // PRZ-101.04: dołączone nie ma ekranu nadania — paczka jedzie z głównego.
    if (z.scalone_do) return reply.redirect(`/zamowienia/${z.scalone_do}/nadaj`);
    if (!nadanie) return reply.code(503).send('Nadawanie nie jest skonfigurowane (brak danych DPD).');
    const powrot = powrotKarty(req);
    const wspolnyPowrot = {
      powrot,
      adresKarty: adresPowrotuNaKarte(req, id),
      // ⚠️ `wybor` SKLADANY TUTAJ, a nie doklejany `?wybor=1` przez wolajacego: gdy `powrot`
      // jest ustawiony, adres ma juz znak zapytania i doklejenie dalo by drugi — czyli link
      // prowadzacy donikad dokladnie przy powrocie z filtrowanej listy.
      adresNadania: (kurier = null, { wybor = false } = {}) => {
        const parametry = new URLSearchParams();
        if (powrot !== '/') parametry.set('powrot', powrot);
        if (kurier) parametry.set('kurier', kurier);
        if (wybor) parametry.set('wybor', '1');
        const pytanie = parametry.size ? `?${parametry.toString()}` : '';
        return `/zamowienia/${encodeURIComponent(String(id))}/nadaj${pytanie}`;
      },
    };
    // Karta nie prowadzi tu, gdy jakaś paczka wisi w toku albo zawieszona — ale adres da się
    // wpisać z ręki (albo zostać na nim otwartym w drugiej zakładce). Bez tej odmowy ekran
    // pokazywałby komplet danych paczki nr N i zapewniał, że zatwierdzenie ją nada, podczas
    // gdy `rozpocznijPrzesylke` i tak odmówi. Ekran nadania istnieje po to, żeby NIE kłamać.
    if (!mozliwaKolejnaPaczka(z.przesylki)) {
      return reply.code(400).send(
        'Nadanie innej paczki tego zamówienia jeszcze się nie rozstrzygnęło — najpierw domknij tamtą sprawę na karcie zamówienia.',
      );
    }
    // Ten sam powod, co wyzej: ekran nadania nie ma prawa pokazac kompletu pol i obiecac,
    // ze zatwierdzenie nada paczke, skoro `nadanie.nadaj()` i tak odmowi. Paczkomat bez
    // kodu nie ma ADRESU — nie ma dokad tej paczki wyslac.
    // ⚠️ ZAMOWIENIE Z ALLEGRO: NAJPIERW WYBOR KURIERA, DOPIERO POTEM FORMULARZ (2026-08-07).
    //
    // Panel nie zna kuriera dla tego kanalu — paczke nadaje sie etykieta kupiona w panelu
    // Allegro, a nasza umowa wchodzi dopiero przy dosylce albo zamienniku. Do 07.08 ten ekran
    // renderowal wtedy formularz DPD (waga + wymiary 110x75x1) i obiecywal nadanie, ktore
    // `wybierzKuriera` i tak odrzucal — czyli robil DOKLADNIE to, czego ten ekran ma nie
    // robic („ekran nadania istnieje po to, zeby NIE klamac").
    //
    // Krok wyboru jest OSOBNYM RENDEREM, a nie polem przelaczajacym formularz, bo panel nie
    // ma JavaScriptu (poza cena pozycji recznych) — a od kuriera zalezy KSZTALT calego
    // formularza: DPD chce wymiarow, paczkomat gabarytu A/B/C i kodu automatu.
    const wyborKuriera = wymagaWyboruKuriera(z) ? String(req.query?.kurier ?? '').trim() : '';
    const { metoda: metodaUzyta, blad: bladKuriera } = metodaNadania(z, wyborKuriera, { kolejnosc: nastepnaKolejnosc(db, id) });

    // ⚠️⚠️ EKRAN WYBORU ZSZEDL Z DROGI (decyzja właściciela 19.09.2026: „lepiej bez ekranu wyboru —
    // niech idzie od razu odpowiednia opcja"). Do 18.09 stawal przy KAZDYM zamowieniu z Allegro,
    // bo panel nie znal kuriera. Odkad osiem uslug ma droge domyslna przez „Wysylam z Allegro"
    // (niezmiennik 4.105), pytal o rzecz juz rozstrzygnieta — a jego tekst przy okazji ODRADZAL
    // wlasciwa droge, bo opisywal stan sprzed tamtej zmiany.
    //
    // Staje teraz w DWOCH przypadkach i w zadnym innym:
    //  1. gdy panel NIE MA czego zaproponowac (usluga, ktorej slownik nie zna) — pytanie jest
    //     wtedy uczciwe, bo alternatywa byloby zgadywanie;
    //  2. gdy czlowiek POPROSI o niego jawnie (`?wybor=1`) — to jest FURTKA NA DOSYLKE
    //     nasza umowa (brakujacy produkt, zamiennik za zgubiona paczke).
    //
    // ⛔ PUNKT 2 NIE JEST OZDOBA. Ten ekran byl JEDYNYM miejscem, z ktorego dawalo sie wskazac
    // nasza umowe; zdjecie go z drogi bez zostawienia wejscia zabraloby te mozliwosc calkowicie.
    // To ta sama rodzina bledu, co „droga domyslna musi byc na liscie wyboru" (11.08.2026):
    // regula bez dostepnego wejscia po prostu nie istnieje.
    const maDrogeDomyslna = wymagaWyboruKuriera(z) && !metodaNadania(z, '', { kolejnosc: nastepnaKolejnosc(db, id) }).blad;
    const poproszonoOWybor = String(req.query?.wybor ?? '') === '1';
    if (wymagaWyboruKuriera(z) && !wyborKuriera && (!maDrogeDomyslna || poproszonoOWybor)) {
      return reply.view('nadaj-kurier.ejs', {
        z,
        ...wspolnyPowrot,
        // `adresKanalu` NIE jest w defaultContext (web/server.js) — nazwa kanalu skladana
        // w widoku bylaby druga mapa etykiet obok domain/kanaly.js.
        kanal: adresKanalu(z.sklep, config.definicje),
        kolejnosc: nastepnaKolejnosc(db, id),
        kurierzy: kurierzyDoWyboru(z, nastepnaKolejnosc(db, id)),
        // ⚠️ Rozstrzyga TRESC OSTRZEZENIA na tym ekranie: przy usludze, ktora umiemy kupic
        // u Allegro, nasza umowa jest odstepstwem; przy nieznanej — jedyna droga panelu.
        // Liczone z drogi domyslnej, nie z listy przyciskow, bo to ona mowi, co zrobi
        // zatwierdzenie bez wskazania.
        maWza: maDrogeDomyslna,
        // Sam fakt, ze przy pobraniu na paczce nr 1 zostaje jeden kurier, jest dla operatora
        // niezrozumialy bez powodu — a powod jest o pieniadze (patrz kurier-nadania.js).
        tylkoDpdPrzezPobranie: Boolean(z.pobranie) && nastepnaKolejnosc(db, id) === 1,
      });
    }
    // Wskazanie spoza listy (stara karta, adres z reki) odbija sie TU, a nie po wypelnieniu
    // formularza — ta sama zasada, co przy braku kodu paczkomatu nizej.
    if (bladKuriera) return reply.code(400).send(bladKuriera);

    const brakDoNadania = powodBrakuGotowosciNadania(z, metodaUzyta);
    if (brakDoNadania) return reply.code(400).send(brakDoNadania);
    let deliveryMethodIdAllegro = null;
    if (['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne'].includes(metodaUzyta)) {
      if (!kurierzy.allegro_wza?.pobierzMetodeDostawy) {
        return reply.code(503).send('Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.');
      }
      try {
        deliveryMethodIdAllegro = await kurierzy.allegro_wza.pobierzMetodeDostawy(z);
      } catch {
        return reply.code(503).send('Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.');
      }
      if (!deliveryMethodIdAllegro) {
        return reply.code(400).send('Allegro nie podało identyfikatora usługi dostawy.');
      }
      const zgodaWza = wolnoNadacZOms(z, { deliveryMethodIdZywy: deliveryMethodIdAllegro });
      if (!zgodaWza.wolno) return reply.code(400).send(zgodaWza.powod);
    }
    const adres = adresOdbiorcy(z);
    const ustawieniaPaczek = wczytajUstawienia(db);
    return reply.view('nadaj.ejs', {
      z,
      ...wspolnyPowrot,
      adres,
      // ⚠️ WIDOK ROZGALEZIA SIE PO `metodaUzyta`, NIGDY PO `z.metoda_wysylki` — inaczej
      // paczka do automatu dostalaby pola wymiarow, a formularz nie niosl by ani kodu
      // punktu, ani gabarytu. To jest cala poprawka zgloszenia o paczkomatach z Allegro.
      metodaUzyta,
      // ⚠️ „NADAJ I DRUKUJ" TYLKO TAM, GDZIE BEDZIE ZPL (zgloszenie właściciela 01.09.2026).
      // Regula liczy sie w DOMENIE (kurier-nadania.js: nadanieDaZpl) — widok ma ja tylko
      // pokazac. Przy WzA przycisk wybiera format ZPL JUZ PRZY TWORZENIU przesylki.
      bedzieZpl: nadanieDaZpl(metodaUzyta),
      // Puste dla zamowien spoza Allegro — formularz nie niesie wtedy pola `kurier` w ogole
      // i POST zachowuje sie DOKLADNIE jak dotad.
      kurierWybrany: wyborKuriera,
      // ⚠️ WEJSCIE NA EKRAN WYBORU — jedyna droga do dosylki nasza umowa, odkad ten ekran
      // zszedl z przeplywu. `null` dla zamowien spoza Allegro i dla wskazania recznego
      // (tam widok ma juz wlasny odnosnik „zmień").
      adresWyboruKuriera: maDrogeDomyslna && !wyborKuriera
        ? wspolnyPowrot.adresNadania(null, { wybor: true })
        : null,
      // Ostrzezenie o brakujacych polach MUSI byc widoczne TU, zanim operator w ogole
      // dotknie przycisku — zamowienie zalozone recznie w adminie sklepu potrafi miec
      // calkowicie pusty blok `shipping`.
      brakujacePola: brakujacePolaAdresu(adres),
      // Zadanie 2 (plan „ekran nadania"): zawartosc paczki, TYLKO DO ODCZYTU — TE SAME
      // funkcje, ktorych uzywa karta zamowienia (routes/zamowienia.js, trasa karty), zeby
      // druga kopia reguly nie rozjechala sie z nia przy pierwszej zmianie.
      //
      // ⚠️ DOKLADNIE TEN SAM KSZTALT, CO NA KARCIE — az do nazw pol (`linkProduktu`,
      // `linkProduktuTytul`), bo oba widoki wypisuja te same wiersze. Ten fragment juz raz
      // rozjechal sie z karta: `master` zamienil `adresProduktu(baseUrl, w)` na
      // `odnosnikPozycji(z, w, …)` (dolozenie Allegro), a git scalil to BEZ KONFLIKTU —
      // zostal import z link-pozycji.js i wywolanie skasowanej funkcji tutaj. Jesli kiedys
      // trzeba bedzie to zmienic po raz drugi, zmienia sie OBA miejsca naraz.
      // PRZ-105: netto pozycji stawką domyślną z Ustawień — to samo, co pokazuje karta.
      pozycjeKarty: wierszePozycji(zamowienieZGrupa(db, z), { stawkaDomyslna: czytajStawkeDomyslna(db) }).map((w) => {
        const odnosnik = odnosnikPozycji(z, w, { baseUrl: config.sklepy?.[z.sklep]?.baseUrl ?? null });
        return { ...w, linkProduktu: odnosnik?.adres ?? null, linkProduktuTytul: odnosnik?.tytul ?? null };
      }),
      // TA SAMA droga do miniatury, co na karcie i na liscie — patrz `miniaturyEkranu`.
      miniatura: miniaturyEkranu(db, [z]),
      // ⚠️ Z USTAWIEN (17.08.2026). `nadanie.paczkaDomyslna` jest dzis FALLBACKIEM dla wywolan
      // spoza HTTP — trasa czyta wartosc operatora, bo to ona ma wypelnic formularz.
      paczkaDomyslna: domyslnaPaczka(ustawieniaPaczek),
      szablonyPaczek: odczytajSzablony(ustawieniaPaczek),
      // Wymiary paczkomatu NIE ISTNIEJA — jest tylko litera skrytki (A/B/C). Mapa leci
      // do widoku, zeby litery i wymiary bylo widac RAZEM (jak w formularzu Apilo), a
      // lista dozwolonych liter zyla w JEDNYM miejscu (domain/paczka.js), tym samym,
      // ktore POST nizej uzywa do walidacji.
      gabarytyPaczkomatu: GABARYTY_PACZKOMATU,
      gabarytyAllegro: profilGabarytuAllegro(deliveryMethodIdAllegro),
      deliveryMethodIdAllegro,
      // Numer paczki, ktora ten ekran nada. Formularz go NIESIE (ukryte pole), a trasa POST
      // porownuje z aktualnym stanem bazy — patrz komentarz przy POST nizej. To jest cala
      // ochrona przed podwojnym klknieciem po dopuszczeniu wielu paczek.
      kolejnosc: nastepnaKolejnosc(db, id),
    });
  });

app.post('/zamowienia/:id/nadaj', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    // PRZ-101.04: dołączone — odmowa PRZED formularzem paczki (inaczej odbijałoby się od adresu albo wymiarów).
    if (z.scalone_do) return reply.code(400).send(powodBrakuGotowosciNadania(z));
    if (!nadanie) return reply.code(503).send('Nadawanie nie jest skonfigurowane (brak danych DPD).');
    // Walidacja PRZED dotknieciem kuriera, w tym samym duchu co walidacja kraju/kwoty
    // pobrania w dpd.js: wartosc nieliczbowa albo ujemna dostaje czytelna odmowe, NIGDY
    // cichy powrot do wartosci domyslnej — kurier rozlicza po wadze i gabarycie, wiec to sa
    // realne pieniadze, nie kosmetyka. Ten blad NIE idzie przez `nadanie.nadaj()`: to bledny
    // formularz, a nie awaria kuriera ani decyzja domenowa, wiec nie ma czego zapisywac
    // w logu zamowienia.
    //
    // ⚠️ PACZKOMAT DOSTAJE INNY PARSER (Zadanie 7): InPost nie zna wymiarow, tylko gabaryt
    // A/B/C (domain/paczka.js: parsujPaczkeInpost). Rozgalezienie stoi TUTAJ, jednym `if`-em
    // na metodzie z bazy — DPD ma przejsc przez `parsujPaczke` DOKLADNIE tak, jak dzis,
    // ani jednej zmiany w tamtej sciezce.
    //
    // ⚠️ OD 2026-08-07 PYTAMY O METODE UZYTA, a nie o metode zamowienia — bo przy kanale
    // Allegro kuriera wskazuje czlowiek na ekranie nadania i `allegro_paczkomat` staje sie
    // `inpost_paczkomat` dopiero po tym wskazaniu. Odmowa za brak (albo zly ksztalt)
    // wskazania pada TUTAJ, przed jakimkolwiek parsowaniem paczki: inaczej allegrowy
    // paczkomat przeszedlby przez `parsujPaczke` i poleciał do kuriera jako paczka
    // z wymiarami 110x75x1 cm, ktore nie mieszcza sie w zadnej skrytce.
    // ⚠️ DECYZJA „POBRANIE NA TEJ PACZCE" (04.09.2026) — czytana PRZED wyborem kuriera, bo
    // to ona rozstrzyga, kogo w ogole wolno wskazac (paczkomat bez potwierdzonego inkasa
    // odpada wszedzie tam, gdzie pobranie naprawde jedzie — domain/kurier-nadania.js).
    // Pole ma znaczenie WYLACZNIE przy zamowieniu za pobraniem: przy przedplacie zaznaczenie
    // niczego nie zmienia i nie ma prawa zamienic zamowienia w pobraniowe.
    const pobranieNaTejPaczceZadane = req.body?.pobranie_na_tej_paczce === 'tak';
    const kolejnoscSpodziewana = nastepnaKolejnosc(db, id);
    const pobranieNaTejPaczce = Boolean(z.pobranie)
      && (kolejnoscSpodziewana === 1 || pobranieNaTejPaczceZadane);

    const surowyKurier = String(req.body?.kurier ?? '').trim();
    const { metoda: metodaUzyta, blad: bladKuriera } = metodaNadania(z, surowyKurier, { kolejnosc: kolejnoscSpodziewana });
    if (bladKuriera) return reply.code(400).send(bladKuriera);

    let deliveryMethodIdAllegro = null;
    if (['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne'].includes(metodaUzyta)) {
      if (!kurierzy.allegro_wza?.pobierzMetodeDostawy) {
        return reply.code(503).send('Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.');
      }
      try {
        deliveryMethodIdAllegro = await kurierzy.allegro_wza.pobierzMetodeDostawy(z);
      } catch {
        return reply.code(503).send('Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.');
      }
      if (!deliveryMethodIdAllegro
        || String(req.body?.delivery_method_id_allegro ?? '') !== deliveryMethodIdAllegro) {
        return reply.code(400).send('Usługa dostawy Allegro zmieniła się lub nie jest dostępna. Odśwież ekran nadania.');
      }
      const zgodaWza = wolnoNadacZOms(z, { deliveryMethodIdZywy: deliveryMethodIdAllegro });
      if (!zgodaWza.wolno) return reply.code(400).send(zgodaWza.powod);
    }

    // ⚠️ ŚWIADOMIE NIE MA TU BARIERY „pobranie + paczkomat" — i to jest decyzja, nie
    // przeoczenie. Sklepowe zamowienie paczkomatowe za pobraniem nadaje sie DZIS i ma na to
    // testy (sekcja F w kwota-pobrania-nadania.test.js), wiec odmowa w tym miejscu zabralaby
    // dzialajaca sciezke przy okazji zmiany, ktora jej nie dotyczy. Ostroznosc wobec
    // niepotwierdzonej umowy z InPostem zyje tam, gdzie zyla dotad: na liscie wyboru kuriera
    // (domain/kurier-nadania.js), ktora teraz odsiewa paczkomat takze wtedy, gdy pobranie
    // jedzie na paczce N > 1.

    const gabarytyAllegro = profilGabarytuAllegro(deliveryMethodIdAllegro);
    const { paczka, blad } = metodaUzyta === 'inpost_paczkomat'
      ? parsujPaczkeInpost(req.body)
      : gabarytyAllegro
        ? parsujGabarytAllegro(req.body, deliveryMethodIdAllegro)
        : parsujPaczke(req.body);
    if (blad) return reply.code(400).send(blad);
    if (deliveryMethodIdAllegro) paczka.oczekiwanyDeliveryMethodId = deliveryMethodIdAllegro;

    // Adres odbiorcy Z FORMULARZA — od Zadania „adres edytowalny" operator moze go poprawic
    // na ekranie nadania (zly kod, brak numeru mieszkania, dosylka pod inny adres) i TO,
    // nie zamowienie w sklepie, jest od teraz zrodlem prawdy dla tego, co pojedzie do DPD
    // (patrz domain/adres-formularza.js i kurierzy/dpd.js). Walidacja PRZED dotknieciem
    // DPD, w tym samym duchu co walidacja wagi/wymiarow wyzej: puste pole wymagane
    // (ulica/kod/miasto) to ZAWSZE odmowa, NIGDY ciche przepuszczenie do kuriera — dawniej
    // (adres tylko do odczytu) to samo ostrzezenie w widoku wylacznie podswietlalo pole,
    // NIE blokujac zatwierdzenia.
    const { adres, blad: bladAdresu } = parsujAdresOdbiorcy(req.body);
    if (bladAdresu) return reply.code(400).send(bladAdresu);

    // ⚠️ NUMER KOLEJNY MUSI PRZYJSC Z FORMULARZA i musi byc TYM, ktory panel wystawil na
    // ekranie nadania. Tu nie wolno go wyliczyc z bazy — i to jest cala ochrona przed
    // paczka, ktorej nikt nie chcial:
    //
    //  - gdyby trasa liczyla numer sama, dwa szybkie klikniecia „Nadaj przesylke" dostalyby
    //    numery 1 i 2, przeszly przez indeks bez oporu i wyslaly do DPD DWIE prawdziwe
    //    paczki, ktorych nie da sie cofnac;
    //  - skoro numer przychodzi z formularza, dwa klikniecia niosa TEN SAM numer, wiec
    //    drugie odbija sie tutaj (albo, przy prawdziwym wyscigu, o indeks w bazie).
    //
    // Niezgodnosc znaczy „karte otwarto, gdy paczek bylo mniej" (druga zakladka, przycisk
    // Wstecz). Odpowiadamy czytelna odmowa, NIGDY cichym podstawieniem aktualnego numeru:
    // ciche podstawienie zamienia stara karte w narzedzie do nadawania paczek, o ktorych
    // operator nie wie.
    const surowaKolejnosc = String(req.body?.kolejnosc ?? '').trim();
    const kolejnosc = Number(surowaKolejnosc);
    const spodziewana = nastepnaKolejnosc(db, id);
    if (!surowaKolejnosc || !Number.isInteger(kolejnosc) || kolejnosc !== spodziewana) {
      // Przyslana wartosc wraca na ekran PRZYCIETA: pole ma nosic liczbe, wiec dluzsza
      // tresc to i tak blad, a przepisywanie jej w calosci zamienia komunikat w sciane
      // tekstu, w ktorej nie widac zdania o tym, co zrobic.
      const wPokazie = surowaKolejnosc.slice(0, 20) || '(brak numeru)';
      return reply.code(400).send(
        `Ten formularz dotyczy paczki nr ${wPokazie}, a to zamówienie czeka na paczkę `
        + `nr ${spodziewana} — panel niczego nie nadał. Odśwież kartę zamówienia i otwórz nadanie od nowa.`,
      );
    }

    // Drugi przycisk zatwierdzający na ekranie nadania (nadaj.ejs): „Nadaj i drukuj".
    // `zatwierdzenie` niesie WŁASNĄ tożsamość w każdym przycisku (patrz komentarz w
    // nadaj.ejs) — dokładnie po to, żeby dołożenie tego drugiego przycisku nie wymagało
    // przebudowy tej trasy.
    const drukowac = req.body?.zatwierdzenie === 'nadaj_i_drukuj';
    // Kod paczkomatu Z FORMULARZA — TA SAMA logika co adres tuz wyzej: pole na ekranie
    // nadania pozwala operatorowi poprawic kod tuz przed zatwierdzeniem (klient bywa, ze
    // wpisuje go w uwagach zamiast wybrac w checkoucie), a ta poprawka jest JEDNORAZOWA —
    // leci prosto do InPostu przy TYM nadaniu (kurierzy/inpost.js: punktOdbioru), NIE
    // zapisuje sie do zamowienia. Trwala korekta ma swoje miejsce w „Szczegolach zamowienia"
    // (Zadanie 6, zamowienie.ejs). Puste/nieobecne pole (kazda metoda poza paczkomatem) leci
    // jako `undefined`, zeby DPD dostal DOKLADNIE to, co dostaje dzis — bez czwartego pola
    // w wywolaniu, ktorego jego klient i tak by zignorowal, ale ktore zaciemnia komentarz.
    // ⚠️ `metodaUzyta`, nie `z.metoda_wysylki` (2026-08-07) — z tego samego powodu, co przy
    // parserze paczki wyzej. Bez tego allegrowa paczka wskazana jako paczkomat leciala by
    // do InPostu BEZ kodu automatu z formularza.
    const punktOdbioru = metodaUzyta === 'inpost_paczkomat'
      ? String(req.body?.punkt_odbioru ?? '').trim().toUpperCase()
      : undefined;

    // ⚠️ KWOTA POBRANIA Z FORMULARZA (Z4) — TA SAMA rodzina co adres i kod paczkomatu:
    // poprawka JEDNORAZOWA, lecaca prosto do kuriera przy TYM nadaniu, bez zapisu do
    // zamowienia. Reguly (kiedy pole w ogole istnieje i co znaczy pusta wartosc) siedza
    // w domenie — domain/pobranie-nadania.js — a nie tutaj, bo to sa PIENIADZE i musza
    // dac sie sprawdzic bez sieci i bez bazy.
    //
    // Odmowa pada PRZED dotknieciem kuriera, w tym samym duchu co walidacja wagi i adresu
    // wyzej. ⚠️ Puste pole to ODMOWA, NIGDY „nadaj bez pobrania": DPD po prostu nie
    // wstawilby <cod>, paczka pojechalaby jako przedplacona, kurier nie zainkasowalby ani
    // zlotowki i NIGDZIE nie byloby bledu.
    //
    // Warunki `z.pobranie` i `kolejnosc === 1` przekazujemy JAWNIE, bo poza nimi tego pola
    // na ekranie nie ma — a to, co przyjdzie mimo to, jest zadaniem spreparowanym albo
    // stara karta i ma zostac zignorowane (zamowienie przedplacone nie ma prawa zamienic
    // sie w pobraniowe jednym polem formularza).
    const { kwotaPobrania, blad: bladPobrania } = parsujNadpisanieKwotyPobrania(req.body, {
      pobranie: Boolean(z.pobranie), kolejnosc, pobranieNaTejPaczce,
    });
    if (bladPobrania) return reply.code(400).send(bladPobrania);

    try {
      await nadanie.nadaj(id, paczka, {
        kolejnosc, komentarz: req.body?.komentarz ?? null, adres, punktOdbioru, kwotaPobrania,
        drukowac,
        // Decyzja jedzie DO USLUGI, nie tylko do widoku — dokladnie jak `kurierWybrany`
        // nizej i z tego samego powodu: bariera musi stac tam, gdzie wolaja ja WSZYSCY.
        pobranieNaTejPaczce,
        // Wskazanie jedzie DO USLUGI, a nie tylko do widoku: bariera musi stac tam, gdzie
        // wolaja ja WSZYSCY (takze nadanie zbiorcze i wywolania wsadowe), a nie w trasie.
        kurierWybrany: surowyKurier,
      });
    } catch (e) {
      // Pelny komunikat (z ewentualna sciezka serwera albo stosem sterownika) trafia do
      // logu zamowienia. Na ekran idzie tylko to, co sami napisalismy dla czlowieka.
      dopiszLog(db, id, { akcja: 'nadanie.http', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się nadać przesyłki: ${komunikatDlaOperatora(e)}`);
    }
    // „Nadaj i drukuj" znaczy „nadaj, A ETYKIETĘ WSTAW DO KOLEJKI" — awaria kolejki NIE cofa
    // nadania. Kod wspólny z nadaniem hurtem (PRZ-070): services/kolejka-po-nadaniu.js.
    // Paczka pod numerem, który właśnie przeszedł walidację — nie „ostatnia w tabeli".
    if (drukowac) wstawEtykieteDoKolejki(db, id, kolejnosc, 'Nadaj i drukuj');
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

}
