import { pobierzZamowienie, dopiszLog, zapiszNadpisaniaWysylki, zapiszNadpisaniaFaktury, przywrocDaneZeSklepu, dodajPozycjeReczna, zapiszPozycjeReczna, usunPozycjeReczna, zapiszNadpisaniaPozycji } from '../../oms/db/zamowienia.js';
import { przeliczKwoteRecznego } from '../../oms/db/zamowienia-reczne.js';
import { DOSTAWY, parsujNoweZamowienie, skopiujFaktureDoWysylki, wstawPozycjeDoFormularza } from '../../domena/nowe-zamowienie.js';
import ejs from 'ejs';
import { join } from 'node:path';
import { komunikatDlaOperatora, bladOperatora } from '../../domena/bledy.js';
import { cennikDlaZamowienia, pozycjaZProduktu } from '../../domena/magazyn-do-zamowienia.js';
import { szukajDoZamowienia, produktDoZamowienia } from '../../oms/db/magazyn.js';
import { adresZeSklepu, POLA_ADRESU_RECZNE } from '../../domena/adres-odbiorcy.js';
import { daneFaktury, daneFakturyZeSklepu, POLA_FAKTURY_RECZNE } from '../../domena/dane-faktury.js';
import { nadpisaniaPoZapisie } from '../../domena/dane-reczne.js';
import { parsujNowaPozycje, parsujEdycjePozycji, roznicePozycji, ustawNadpisaniePozycji, parsujHurtPozycji, ustawWMapie, jakoTablica } from '../../domena/pozycje-reczne.js';
import { KLUCZ_WYSYLKI, parsujEdycjeWysylki, rozniceWysylki, wysylkaZeSklepu } from '../../domena/wysylka-kwota.js';
import { odczytajNadpisania } from '../../domena/dane-reczne.js';
import { nipDoZapytania, komunikatAwariiGus } from '../../domena/gus.js';
import { wstawKlientaDoFormularza } from '../../domena/klient-staly.js';
import { parsujRabat } from '../../domena/rabat.js';
import { klientPoKluczu } from '../../oms/db/klienci.js';
import { zmienUstalenia, rabatKontraktowy } from './services/rabat.js';
import { czyNipUe } from '../../domena/wdt.js';
import { zalozZamowienieReczne } from './services/zamowienie-reczne.js';
import { przypiszDoOkresu } from '../faktury/services/okres.js';
import {teraz,AKCJA_ALLEGRO_PROBA,allegroWymagaOdpytania,miniaturyEkranu,ktoKlikal,sprzedawcaSpecyfikacji,daneKarty,KATALOG_WIDOKOW,fragment} from './wspolne.js';
export function registerReczneRoutes(app, kontekst) {
const {db,config,poller,nadanie,faktura,proforma,kurierzy,gus,syncSklep,wiadomosci,przesylkiAllegro,stanyKanalow,zdrowie,fakturaAllegro,fakturaHurtem,doczytanieKsef,powrotKarty,adresPowrotuNaKarte,wczytajListe,statusyDlaKarty,OKNO_OSTRZEZEN_PRZESYLEK_DNI,zbierzOstrzezenia,wyborWiadomosci,daneWiadomosci,renderujKarte,renderujNowe,magazynEkranu,niesiePolaFormularza,opisZmian,kopiujDaneFakturyDoWysylki,pozycjaZadania,zWynikami,magazynDlaKarty,cennikiInstalacji}=kontekst;
app.get('/zamowienia/nowe', async (req, reply) => renderujNowe(reply));
app.post('/zamowienia/nowe', async (req, reply) => {
    // ⚠️ CALY FORMULARZ PARSUJEMY PRZED PIERWSZYM ZAPISEM DO BAZY. Odmowa w polowie
    // (np. na trzeciej pozycji) zostawilaby zamowienie z nadanym numerem, bez pozycji
    // i bez ani jednego sladu, ze cos poszlo nie tak — a numeru nie da sie zwolnic.
    let dane;
    let okresId = null;
    // ⚠️ ZEGAR ODCZYTANY RAZ, NA CALA TRASE (recenzja koncowa galezi, D4). Do 2026-08-03
    // okres liczyl sie z `new Date().toISOString()` TUTAJ, a `utworzone_at` wpisywalo
    // `utworzZamowienieReczne` z WLASNEGO odczytu chwile pozniej — dwa niezalezne zegary.
    // Na przelomie miesiaca (a przy sprzedazy telefonicznej to sie zdarza) zamowienie
    // trafialo do LIPCOWEGO okresu z SIERPNIOWA data zlozenia, czyli na fakture nie tego
    // miesiaca, ktory widnieje na zamowieniu. Jedna wartosc idzie w OBA miejsca.
    const znacznik = new Date().toISOString();
    try {
      dane = parsujNoweZamowienie(req.body ?? {});
      // ⚠️ KOLEJNOSC W TEJ TRASIE, zeby nikt jej nie przestawial na chybil trafil.
      // Okres (Zadanie 5) i oplata (Zadanie 4B) sa od siebie NIEZALEZNE, ale ich miejsca
      // w trasie juz nie:
      //   • OKRES idzie PRZED zalozeniem zamowienia, bo jako jedyny potrafi ODMOWIC
      //     (zamkniety miesiac). Odmowa po zalozeniu zostawialaby zamowienie z nadanym,
      //     nieodwracalnym numerem, bez okresu — czyli po cichu poza rozliczeniem;
      //   • OPLATA idzie PO pozycjach, bo prog darmowej dostawy liczy sie od wartosci towaru.
      //
      // ⚠️ DATA ZLOZENIA, nie wysylki: zamowienie przyjete 31 lipca nalezy do LIPCA, choćby
      // wyszlo 2 sierpnia. Ekran zakladania nie ma pola na date — zamowienie powstaje w chwili
      // rozmowy z klientem, wiec „teraz" JEST data zlozenia. TEN SAM `znacznik` wpisze nizej
      // `utworzZamowienieReczne` w `utworzone_at` — to jedna wartosc, nie dwa odczyty zegara.
      okresId = przypiszDoOkresu({
        db,
        nip: dane.nip,
        dataZlozenia: znacznik,
        // Hurt jedzie do siedziby klienta i dostaje fakture od razu, z terminem — poza
        // okresem miesiecznym (spec §3). Operator zaznacza to w formularzu.
        hurt: dane.hurt,
      });
    } catch (e) {
      dopiszLog(db, null, { akcja: 'zamowienie.reczne', wynik: `BŁĄD: ${e.message}` });
      // Odmowa ODDAJE FORMULARZ Z POWROTEM. Goly komunikat na pustej stronie kasowalby
      // wszystko, co operator wpisal przy sluchawce — a to jest ekran uzywany dokladnie
      // wtedy, gdy klient czeka na linii.
      return renderujNowe(reply.code(400), { formularz: req.body ?? {}, blad: komunikatDlaOperatora(e) });
    }

    // ⚠️ ZAPISY TEZ MUSZA BYC OSLONIETE, nie tylko parsowanie (ustalenie recenzji 2026-08-01
    // — poprzednia wersja tej trasy to miala, przebudowa zgubila). SQLITE_BUSY w trakcie
    // nocnego `VACUUM INTO` albo pelny dysk daloby surowy 500 Fastify: operator traci CALY
    // wpisany formularz, a w dzienniku nie ma po tym sladu.
    let id;
    let oplata = null;
    try {
      // ⚠️ CALA SEKWENCJA ZAKLADANIA SIEDZI W services/zamowienie-reczne.js i to NIE JEST
      // kosmetyka. Kolejnosc krokow jest o pieniadze (oplata po pozycjach, kwota po
      // oplacie), a ta sama sekwencja jest potrzebna trasie API („Dodaj do OMS" z panelu
      // indywidualnego). Przepisana drugi raz zostalaby przepisana blednie — obie trasy
      // wolaja JEDNA funkcje.
      //
      // `znacznik` to ten sam odczyt zegara, ktory rozstrzygnal okres wyzej (D4) — funkcja
      // wpisze go w `utworzone_at`.
      ({ id, oplata } = zalozZamowienieReczne({ db, dane, znacznik, okresId }));
    } catch (e) {
      // ⚠️ Zamowienie moglo juz powstac (numer nadany, pozycji brak) — tego nie da sie
      // wycofac, bo `utworzZamowienieReczne` domyka wlasna transakcje. Dlatego komunikat
      // MOWI O TYM WPROST zamiast udawac, ze nic sie nie stalo: pol-zalozone zamowienie
      // czeka na liscie i operator ma je dokonczyc, a nie zakladac drugie.
      // Numer wewnetrzny pol-zalozonego zamowienia niesie SAM WYJATEK (patrz
      // services/zamowienie-reczne.js): destrukturyzacja wyzej przy wyjatku NIE WYKONUJE SIE
      // wcale, wiec `id` jest tutaj zawsze puste — a operator ma sie dowiedziec, ze zamowienie
      // mimo bledu powstalo. `null`, gdy wyjatek padl PRZED nadaniem numeru.
      id = e.zamowienieId ?? null;
      dopiszLog(db, id, { akcja: 'zamowienie.reczne', wynik: `BŁĄD ZAPISU: ${e.message}` });
      return renderujNowe(reply.code(500), {
        formularz: req.body ?? {},
        blad: `${komunikatDlaOperatora(e)}${id ? ` Zamówienie zdążyło powstać (nr wewnętrzny ${id}) — sprawdź je na liście i dokończ tam, zamiast zakładać drugie.` : ''}`,
      });
    }

    dopiszLog(db, id, {
      akcja: 'zamowienie.reczne',
      wynik: `Ręcznie (${ktoKlikal(req)}): zamówienie założone ręcznie — `
        + `${DOSTAWY[req.body?.dostawa] ?? dane.metoda_wysylki}, ${dane.metoda_platnosci}, `
        + `${dane.pozycje.length} poz., koszt dostawy ${dane.koszt_dostawy_brutto} zł.`
        // Oplata doklejona przez PANEL, nie przez czlowieka — dziennik musi umiec
        // odpowiedziec, skad na fakturze wzial sie wiersz, ktorego operator nie wpisywal.
        + (oplata ? ` Doklejono „${oplata.nazwa}" ${(oplata.kwotaGr / 100).toFixed(2)} zł (rozliczenie zbiorcze).` : ''),
    });
    return reply.redirect(`/zamowienia/${id}`);
  });
app.post('/zamowienia/nowe/kopiuj-do-wysylki', async (req, reply) => (
    renderujNowe(reply, { formularz: skopiujFaktureDoWysylki(req.body ?? {}) })
  ));
app.post('/zamowienia/nowe/klient', async (req, reply) => {
    const klucz = String(req.body?.klient_klucz ?? '').trim();
    const klient = klucz ? klientPoKluczu(db, klucz) : null;
    if (!klient) {
      return renderujNowe(reply.code(400), {
        formularz: req.body ?? {},
        blad: klucz
          ? `Nie ma w bazie klienta „${klucz}" — wybierz go z listy albo dopisz na ekranie Klienci.`
          : 'Nie wybrano klienta — rozwiń listę i wskaż, o kogo chodzi.',
      });
    }
    // Dziennik BEZ zamowienia (`null`), tak samo jak przy GUS-ie: zamowienia jeszcze nie ma,
    // a slad ma zostac — to on tlumaczy pozniej, skad na fakturze wzial sie ten adres.
    dopiszLog(db, null, {
      akcja: 'klient.wstaw',
      wynik: `Ręcznie (${ktoKlikal(req)}): wstawiono dane stałego klienta `
        + `„${klient.nazwa}" (${klient.klucz}) do formularza nowego zamówienia — nic jeszcze nie zapisano.`,
    });
    return renderujNowe(reply, {
      formularz: wstawKlientaDoFormularza(req.body ?? {}, klient),
      klientWybrany: klient,
    });
  });
app.get('/zamowienia/nowe/magazyn/wyniki', async (req, reply) => {
    const stan = magazynEkranu(req);
    const wyniki = stan.fraza
      ? zWynikami(szukajDoZamowienia(db, { fraza: stan.fraza, kanal: stan.cennik }))
      : null;
    return fragment(reply, '_magazyn-wyniki-nowe.ejs', { magazyn: { ...stan, wyniki } });
  });
app.post('/zamowienia/nowe/magazyn', async (req, reply) => {
    const stan = magazynEkranu(req);
    const wyniki = stan.fraza ? zWynikami(szukajDoZamowienia(db, { fraza: stan.fraza, kanal: stan.cennik })) : null;
    return renderujNowe(reply, { formularz: req.body ?? {}, magazyn: { ...stan, wyniki } });
  });
app.post('/zamowienia/nowe/magazyn/dodaj', async (req, reply) => {
    const stan = magazynEkranu(req);
    // ⚠️ WYNIKI WROCILY JAKO ROWNOLEGLE TABLICE, a przycisk powiedzial, KTORY wiersz
    // wybrano. Powtorzenie szukania i wziecie n-tego wyniku byloby tanszym kodem i drozszym
    // bledem: miedzy wyswietleniem listy a klikiem katalog mogl zostac odczytany na nowo,
    // a wtedy `wybrany` wskazuje inny produkt — czyli inna cene, po cichu.
    const nr = Number(req.body?.wybrany);
    const zTablicy = (pole) => jakoTablica(req.body?.[pole])[nr];
    // ⚠️ Kanal z formularza i tak przechodzi przez domene (cennikDlaZamowienia w `magazynEkranu`
    // wyzej rozstrzyga cennik), a tutaj sluzy wylacznie temu, zeby odczytac WLASCIWY wiersz
    // lustra. Allegro odbije sie w `pozycjaZProduktu`.
    const produkt = Number.isInteger(nr) && nr >= 0
      ? produktDoZamowienia(db, {
        kanal: zTablicy('mag_kanal') ?? stan.cennik,
        produkt_id: zTablicy('mag_produkt_id'),
        wariant_id: zTablicy('mag_wariant_id'),
      })
      : null;

    let pozycja;
    try {
      // ⚠️ TU rabat MUSI przyjsc z formularza — zamowienia jeszcze nie ma, wiec nie ma go
      // gdzie przeczytac. Pole jest widoczne na ekranie („Ustalenia handlowe"), wiec podmiana
      // wartosci w HTML-u nie daje niczego, czego operator nie moglby zrobic wprost.
      // `parsujRabat` odbije smiec komunikatem, ktory ODDAJE FORMULARZ — patrz nizej.
      pozycja = pozycjaZProduktu(produkt, zTablicy('mag_ilosc'), {
        cenniki: cennikiInstalacji,
        rabatProcent: parsujRabat(req.body?.rabat_procent),
        // Klient WDT rozpoznany po NIP-ie fakturowym Z FORMULARZA (pole `f_nip` wypełnia
        // „Wstaw dane klienta" — zamówienia jeszcze nie ma, więc nie ma go gdzie czytać):
        // cena z magazynu wchodzi wtedy od razu po ÷1,23 (zgłoszenie właściciela 26.08).
        // Ta sama reguła, która wybierze stawkę faktury — pas nad pozycjami mówi o tym wprost.
        wdt: czyNipUe(req.body?.f_nip),
      });
    } catch (e) {
      // Odmowa ODDAJE FORMULARZ Z POWROTEM razem z wynikami szukania — inaczej operator
      // traci przy sluchawce wszystko, co wpisal, przez jeden produkt bez ceny.
      const wyniki = stan.fraza ? zWynikami(szukajDoZamowienia(db, { fraza: stan.fraza, kanal: stan.cennik })) : null;
      return renderujNowe(reply.code(400), {
        formularz: req.body ?? {},
        magazyn: { ...stan, wyniki },
        blad: komunikatDlaOperatora(e),
      });
    }

    const formularz = wstawPozycjeDoFormularza(req.body ?? {}, pozycja);
    const wyniki = stan.fraza ? zWynikami(szukajDoZamowienia(db, { fraza: stan.fraza, kanal: stan.cennik })) : null;
    return renderujNowe(reply, { formularz, magazyn: { ...stan, wyniki, dodano: pozycja } });
  });
app.post('/zamowienia/nowe/gus', async (req, reply) => {
    const formularz = req.body ?? {};
    const odmowa = (tekst, rodzaj = 'blad') => renderujNowe(reply, { formularz, komunikatGus: { rodzaj, tekst } });

    if (!gus) return odmowa('GUS nie jest skonfigurowany (brak GUS_KLUCZ) — wpisz dane ręcznie.');

    let nip;
    try {
      nip = nipDoZapytania(formularz.f_nip);
    } catch (e) {
      return odmowa(komunikatDlaOperatora(e));
    }

    let firma = null;
    try {
      firma = await gus.firmaPoNip(nip);
    } catch (e) {
      // Awaria GUS-u NIE MOZE wywalic ekranu razem z tym, co operator zdazyl wpisac —
      // ta sama zasada, co przy odpytywaniu DPD o status. Pelna tresc do logu.
      dopiszLog(db, null, { akcja: 'dane.gus', wynik: `BŁĄD: ${e.message}` });
      return odmowa(komunikatAwariiGus(e));
    }

    if (!firma) {
      dopiszLog(db, null, { akcja: 'dane.gus', wynik: `GUS: nie znaleziono firmy o NIP ${nip}.` });
      return odmowa(`GUS nie zna firmy o NIP ${nip}. Sprawdź numer albo wpisz dane ręcznie.`, 'brak');
    }

    dopiszLog(db, null, {
      akcja: 'dane.gus',
      wynik: `GUS (${ktoKlikal(req)}): pobrano „${firma.firma}" (NIP ${firma.nip ?? nip}, REGON ${firma.regon ?? '—'}) `
        + '— dane WSTAWIONE DO FORMULARZA nowego zamówienia, nic jeszcze nie zapisano.',
    });
    return renderujNowe(reply, {
      formularz,
      daneZGus: firma,
      komunikatGus: {
        rodzaj: 'ok',
        tekst: `GUS: ${firma.firma}${firma.regon ? ` (REGON ${firma.regon})` : ''}. `
          + 'Sprawdź dane i załóż zamówienie — dopóki tego nie zrobisz, nic się nie zmieniło.',
      },
    });
  });
function zapisDanych(sciezka, obsluga) {
    app.post(`/zamowienia/:id/dane/${sciezka}`, async (req, reply) => {
      const id = Number(req.params.id);
      const z = pobierzZamowienie(db, id);
      if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
      let kotwica = '';
      try {
        kotwica = obsluga(id, z, req) ?? '';
      } catch (e) {
        dopiszLog(db, id, { akcja: `dane.${sciezka}`, wynik: `BŁĄD: ${e.message}` });
        return reply.code(400).send(`Nie udało się zapisać danych: ${komunikatDlaOperatora(e)}`);
      }
      return reply.redirect(adresPowrotuNaKarte(req, id, {
        kotwica: kotwica.replace(/^#/, '') || null,
      }));
    });
  }
zapisDanych('wysylka', (id, z, req) => {
    if (!niesiePolaFormularza(req.body, POLA_ADRESU_RECZNE)) {
      throw bladOperatora('Żądanie nie niosło ani jednego pola formularza — panel niczego nie zmienił.');
    }
    const nadpisania = nadpisaniaPoZapisie(z.dostawa_reczna_json, adresZeSklepu(z), req.body ?? {}, POLA_ADRESU_RECZNE);
    zapiszNadpisaniaWysylki(db, id, nadpisania);
    dopiszLog(db, id, {
      akcja: 'dane.wysylka',
      wynik: `Ręcznie (${ktoKlikal(req)}): dane do wysyłki poprawione ręcznie — ${opisZmian(nadpisania)}.`,
    });
  });
zapisDanych('faktura', (id, z, req) => {
    // Samo pole wyboru nie wystarczy: przy odznaczonym „chce fakturę" urwane żądanie byłoby
    // nie do odróżnienia od pustego, więc pytamy o pola tekstowe, tak samo jak wyżej.
    if (!niesiePolaFormularza(req.body, POLA_FAKTURY_RECZNE)) {
      throw bladOperatora('Żądanie nie niosło ani jednego pola formularza — panel niczego nie zmienił.');
    }
    const nadpisania = nadpisaniaPoZapisie(z.klient_reczny_json, daneFakturyZeSklepu(z), req.body ?? {}, POLA_FAKTURY_RECZNE);
    // Pole wyboru: przegladarka przysyla je TYLKO gdy zaznaczone, wiec brak klucza znaczy
    // „odznaczone", a nie „nie tknieto". Zapisujemy nadpisanie wylacznie wtedy, gdy decyzja
    // czlowieka rozni sie od tego, co wnioskuje sklep — inaczej samo otwarcie i zapisanie
    // formularza zamrazaloby przelacznik na zawsze.
    const zaznaczone = req.body?.chce_fakture !== undefined ? 1 : 0;
    const przelacznik = zaznaczone === (z.chce_fakture ? 1 : 0) ? null : zaznaczone;
    zapiszNadpisaniaFaktury(db, id, nadpisania, przelacznik);
    // ⚠️⚠️ RABAT UMOWNY PO ZAPISIE NIP-U (23.08.2026). Stawka klienta kontraktowego nie moze
    // zalezec od tego, czy operator kliknal „Wstaw dane klienta" — dwa z trzech sierpniowych
    // zamowien klienta hurtowego stanely przez to po cenie katalogowej.
    //
    // ⚠️ NIP CZYTAMY PO ZAPISIE i EFEKTYWNY (`daneFaktury(pobierzZamowienie(...))`), nigdy
    // kolumne `z.nip`: reczna poprawka NIP-u lezy w nadpisaniach i wygrywa dopiero przy
    // odczycie — a poprawia sie go WLASNIE wtedy, gdy sklep przyslal zly albo gdy zamowienie
    // zakladano bez niego. Czytanie `z` sprzed zapisu znaczyloby, ze wpisanie NIP-u nie
    // zapala niczego przy pierwszym zapisie, tylko przy drugim.
    const poZapisie = pobierzZamowienie(db, id);
    const kontrakt = rabatKontraktowy(db, daneFaktury(poZapisie).nip);
    if (kontrakt.decyzja(poZapisie.rabat_procent) === 'ustaw') {
      const wynik = zmienUstalenia(db, id, {
        b2b: poZapisie.b2b,
        termin_platnosci: poZapisie.termin_platnosci,
        rabat_procent: kontrakt.stawka.procent,
      });
      dopiszLog(db, id, {
        akcja: 'rabat.kontraktowy',
        wynik: `Rabat ${kontrakt.stawka.procent}% z umowy klienta nałożony po zapisaniu NIP-u:`
          + ` przecenionych pozycji ${wynik?.zmienione ?? 0}`
          + `${wynik?.pominiete?.length ? `, pominiętych (cena wpisana ręcznie) ${wynik.pominiete.length}` : ''}.`,
      });
    }
    dopiszLog(db, id, {
      akcja: 'dane.faktura',
      wynik: `Ręcznie (${ktoKlikal(req)}): dane do faktury poprawione ręcznie — ${opisZmian(nadpisania)}`
        + `${przelacznik === null ? '' : `; „klient chce fakturę" ustawione ręcznie na ${przelacznik ? 'TAK' : 'NIE'}`}.`,
    });

    // ⚠️ DRUGI PRZYCISK ZATWIERDZAJACY („Zapisz i skopiuj do wysylki"), tym samym wzorcem
    // co „Nadaj i drukuj" na ekranie nadania: wlasna tozsamosc w polu `zatwierdzenie`,
    // a nie druga trasa i nie drugi formularz (formularza w formularzu HTML nie ma).
    //
    // ⚠️ ZAMOWIENIE CZYTAMY PONOWNIE — to nie jest ostroznosc, tylko warunek poprawnosci.
    // `z` w tej domknieciu pochodzi sprzed `zapiszNadpisaniaFaktury`, wiec kopiowanie z niego
    // przepisaloby na paczke adres SPRZED edycji: operator poprawia ulice na fakturze,
    // klika ten przycisk i dostaje paczke pod stary adres, bez ani jednego komunikatu.
    if (req.body?.zatwierdzenie !== 'zapisz_i_kopiuj') return undefined;
    const swiezy = pobierzZamowienie(db, id);
    try {
      kopiujDaneFakturyDoWysylki(id, swiezy, req);
    } catch (e) {
      // Dane do faktury JUZ SA ZAPISANE — komunikat musi to powiedziec wprost, inaczej
      // operator wpisze je drugi raz albo uzna, ze nic sie nie stalo.
      throw bladOperatora(`Dane do faktury zapisane, ale nie udało się przepisać ich do wysyłki: ${e.message}`);
    }
    return '#wysylka';
  });
zapisDanych('przywroc', (id, z, req) => {
    przywrocDaneZeSklepu(db, id);
    dopiszLog(db, id, {
      akcja: 'dane.przywroc',
      wynik: `Ręcznie (${ktoKlikal(req)}): ręczne poprawki danych klienta skasowane — rządzi sklep.`,
    });
  });
function zapisPozycji(sciezka, obsluga) {
    app.post(`/zamowienia/:id/pozycje/:klucz/${sciezka}`, async (req, reply) => {
      const cel = pozycjaZadania(req, reply);
      if (!cel) return reply;
      try {
        obsluga(cel, req);
      } catch (e) {
        dopiszLog(db, cel.id, { akcja: `pozycja.${sciezka}`, wynik: `BŁĄD: ${e.message}` });
        return reply.code(400).send(`Nie udało się zapisać pozycji: ${komunikatDlaOperatora(e)}`);
      }
      return reply.redirect(adresPowrotuNaKarte(req, cel.id));
    });
  }
app.post('/zamowienia/:id/pozycje/zapisz', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

    let mapa = odczytajNadpisania(z.pozycje_reczne_json);
    const reczneDoZapisu = [];
    const zmienione = [];
    try {
      for (const w of parsujHurtPozycji(req.body)) {
        // Klucz spoza tego zamowienia POMIJAMY PO CICHU. Poller przenumerowuje pozycje co
        // dwie minuty, wiec formularz otwarty przed synchronizacja moze celowac w wiersz,
        // ktorego juz nie ma. Odmowa calosci skasowalaby wtedy prace operatora z powodu,
        // na ktory nie ma zadnego wplywu.
        // ⚠️ WIERSZ WYSYLKI JEDZIE TYM SAMYM FORMULARZEM (07.08.2026, prosba wlasciciela:
        // „wysylka powinna byc edytowalna tak samo jak produkty"). Nie ma go w `z.pozycje`
        // — jest wierszem TABELI, nie pozycja zamowienia — wiec bez tego rozgalezienia
        // wpadlby ponizej w „klucz spoza tego zamowienia" i zostal POMINIETY PO CICHU:
        // operator poprawialby cene dostawy, klikal „Zapisz pozycje" i nie dostawal ani
        // zmiany, ani bledu.
        //
        // Nadpisanie ladzie w TEJ SAMEJ mapie i w tym samym jednym zapisie, co pozycje
        // (domain/wysylka-kwota.js: KLUCZ_WYSYLKI) — inaczej istnialby stan posredni,
        // w ktorym pozycje sie zapisaly, a wysylka nie.
        if (w.klucz === KLUCZ_WYSYLKI) {
          // Wiersz sklepowy liczony RAZ i podany obu funkcjom: parser rozstrzyga po nim
          // dopuszczalnosc zera (darmowa dostawa), a `rozniceWysylki` — czy cokolwiek sie
          // zmienilo. Dwa osobne wywolania moglyby sie rozjechac.
          const wysylkaSklepu = wysylkaZeSklepu(z);
          const nadpisanieWysylki = rozniceWysylki(wysylkaSklepu, parsujEdycjeWysylki(w, wysylkaSklepu));
          mapa = ustawWMapie(mapa, KLUCZ_WYSYLKI, nadpisanieWysylki);
          if (Object.keys(nadpisanieWysylki).length) zmienione.push('Wysyłka');
          continue;
        }
        const p = z.pozycje.find((x) => x.klucz === w.klucz);
        if (!p) continue;
        if (p.reczna) {
          // parsujNowaPozycje, a nie parsujEdycjePozycji: wiersz wlasny potrzebuje TAKZE
          // sumy linii. SKU zostaje nietkniete — edycja go nie obejmuje.
          reczneDoZapisu.push({ id: p.id, pozycja: parsujNowaPozycje({ ...w, sku: p.sku }) });
          zmienione.push(p.nazwa);
          continue;
        }
        const nadpisania = roznicePozycji(p.sklep, parsujEdycjePozycji(w, p.sklep));
        mapa = ustawWMapie(mapa, p.klucz, nadpisania);
        if (Object.keys(nadpisania).length) zmienione.push(p.sklep.nazwa);
      }
    } catch (e) {
      dopiszLog(db, id, { akcja: 'pozycje.zapisz', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zapisać pozycji: ${komunikatDlaOperatora(e)}`);
    }

    // Dopiero TERAZ baza. Wszystko wyzej moglo jeszcze odmowic bez sladu.
    for (const r of reczneDoZapisu) zapiszPozycjeReczna(db, id, r.id, r.pozycja);
    zapiszNadpisaniaPozycji(db, id, Object.keys(mapa).length ? mapa : null);
    // Bariera arytmetyczna zamowienia RECZNEGO liczy sie z pozycji (kwoty nie narzuca zaden
    // sklep) — bez przeliczenia tutaj zapis wielu wierszy naraz zostawialby kwote nieaktualna.
    // Dla zamowien sklepowych to wywolanie jest no-op (patrz warunek w przeliczKwoteRecznego).
    przeliczKwoteRecznego(db, id);
    dopiszLog(db, id, {
      akcja: 'pozycje.zapisz',
      wynik: `Ręcznie (${ktoKlikal(req)}): zapisane pozycje — `
        + `${zmienione.length ? `zmienione: ${zmienione.join(', ')}` : 'bez zmian wobec sklepu'}. `
        + 'Kwota zamówienia w sklepie NIE ZMIENIA SIĘ.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'pozycje' }));
  });
app.get('/zamowienia/:id/magazyn/wyniki', async (req, reply) => {
    const z = pobierzZamowienie(db, Number(req.params.id));
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    return fragment(reply, '_magazyn-wyniki-karta.ejs', {
      magazyn: magazynDlaKarty(req, z), z, powrot: powrotKarty(req),
    });
  });
app.post('/zamowienia/:id/pozycje/z-magazynu', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

    const cennik = cennikDlaZamowienia({ sklepZamowienia: z.sklep, wybrany: req.body?.kanal }, cennikiInstalacji);
    // ⚠️ CENA CZYTA SIE Z LUSTRA, NIE Z FORMULARZA. Ekran podaje wylacznie „co i ile"
    // (kanal, produkt, wariant, ilosc) — pole z cena w HTML-u da sie podmienic, a to sa
    // pieniadze, ktore klient zaplaci.
    const produkt = produktDoZamowienia(db, {
      kanal: cennik, produkt_id: req.body?.produkt_id, wariant_id: req.body?.wariant_id,
    });

    let pozycja;
    try {
      // ⚠️ RABAT BIERZE SIE Z ZAMOWIENIA, NIE Z FORMULARZA — z tego samego powodu, co cena
      // z lustra: pole w HTML-u da sie podmienic, a rabat jest mnoznikiem tej ceny.
      // WDT z NIP-u nabywcy ZAMOWIENIA (daneFaktury — z reczna poprawka wlacznie): cena
      // z magazynu wchodzi po ÷1,23, ta sama regula co przy zakladaniu i na fakturze.
      pozycja = pozycjaZProduktu(produkt, req.body?.ilosc, {
        cenniki: cennikiInstalacji,
        rabatProcent: z.rabat_procent ?? 0,
        wdt: czyNipUe(daneFaktury(z).nip),
      });
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }

    dodajPozycjeReczna(db, id, pozycja);
    // Ta sama linijka, co przy pozycji wpisanej z reki: zamowienie RECZNE nie ma kwoty
    // narzuconej przez sklep, wiec bez przeliczenia dopisana pozycja roslaby tylko w tabeli.
    przeliczKwoteRecznego(db, id);
    dopiszLog(db, id, {
      akcja: 'pozycja.z-magazynu',
      wynik: `Ręcznie (${ktoKlikal(req)}): dopisana z magazynu pozycja „${pozycja.nazwa}", `
        + `${pozycja.ilosc} szt. po ${pozycja.cena_brutto} zł brutto = ${pozycja.brutto_linii} zł `
        + `(cennik ${cennikiInstalacji.nazwy[cennik]}`
        // Rabat trafia do dziennika WYLACZNIE wtedy, gdy jakis byl — inaczej „rabat 0%"
        // staloby przy kazdej pozycji kazdego zamowienia i przestaloby cokolwiek znaczyc.
        + `${z.rabat_procent ? `, cena katalogowa ${pozycja.cena_katalogowa} zł, rabat ${z.rabat_procent}%` : ''}). `
        + 'Kwota zamówienia w sklepie NIE ZMIENIA SIĘ — rośnie kwota oczekiwana od klienta.',
    });

    // Wracamy DO WYNIKOW, z ta sama fraza i cennikiem: przy telefonie klient dokłada
    // „i jeszcze ten mniejszy", a szukanie od nowa po każdej pozycji byłoby karą za to,
    // że zamówienie ma więcej niż jedną linię.
    const parametry = new URLSearchParams({ edytuj: 'pozycje' });
    const powrot = powrotKarty(req);
    if (powrot !== '/') parametry.set('powrot', powrot);
    if (req.body?.fraza) parametry.set('magazyn', String(req.body.fraza));
    parametry.set('cennik', cennik);
    return reply.redirect(`/zamowienia/${id}?${parametry.toString()}#pozycje`);
  });
app.post('/zamowienia/:id/pozycje', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let pozycja;
    try {
      pozycja = parsujNowaPozycje(req.body);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    dodajPozycjeReczna(db, id, pozycja);
    // Zamowienie RECZNE nie ma kwoty narzuconej przez sklep — bez przeliczenia tutaj
    // dopisana pozycja rosla by tylko w tabeli, a `kwota_brutto` zostawaloby przy '0.00'.
    przeliczKwoteRecznego(db, id);
    dopiszLog(db, id, {
      akcja: 'pozycja.dodana',
      wynik: `Ręcznie (${ktoKlikal(req)}): dopisana pozycja „${pozycja.nazwa}", `
        + `${pozycja.ilosc} szt. po ${pozycja.cena_brutto} zł brutto = ${pozycja.brutto_linii} zł. `
        + 'Kwota zamówienia w sklepie NIE ZMIENIA SIĘ — rośnie kwota oczekiwana od klienta.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
zapisPozycji('przywroc', ({ id, z, p }, req) => {
    if (p.reczna) {
      throw bladOperatora('Pozycja dopisana ręcznie nie ma czego przywracać ze sklepu — sklep o niej nie wie.');
    }
    zapiszNadpisaniaPozycji(db, id, ustawNadpisaniePozycji(z.pozycje_reczne_json, p.klucz, {}));
    dopiszLog(db, id, {
      akcja: 'pozycja.przywroc',
      wynik: `Ręcznie (${ktoKlikal(req)}): ręczne poprawki pozycji „${p.sklep.nazwa}" skasowane — rządzi sklep.`,
    });
  });
app.post('/zamowienia/:id/wysylka/kwota/przywroc', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    zapiszNadpisaniaPozycji(db, id, ustawNadpisaniePozycji(z.pozycje_reczne_json, KLUCZ_WYSYLKI, {}));
    // Zamowienie RECZNE liczy kwote z pozycji i wysylki — bez przeliczenia zostaloby
    // z kwota sprzed cofniecia poprawki (patrz przeliczKwoteRecznego; dla sklepowych no-op).
    przeliczKwoteRecznego(db, id);
    dopiszLog(db, id, {
      akcja: 'wysylka.kwota.przywroc',
      wynik: `Ręcznie (${ktoKlikal(req)}): ręczna poprawka kwoty wysyłki skasowana — rządzi sklep.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'pozycje' }));
  });
zapisPozycji('usun', ({ id, p }, req) => {
    const usunieta = usunPozycjeReczna(db, id, p.id);
    // Zamowienie RECZNE liczy kwote z pozycji — usuniecie musi ja zmniejszyc, inaczej
    // panel dalej pokazywalby dlug klienta za pozycje, ktorej juz na karcie nie ma.
    przeliczKwoteRecznego(db, id);
    dopiszLog(db, id, {
      akcja: 'pozycja.usunieta',
      wynik: `Ręcznie (${ktoKlikal(req)}): usunięta pozycja dopisana ręcznie „${usunieta.nazwa}", `
        + `${usunieta.ilosc} szt. po ${usunieta.cena_brutto} zł = ${usunieta.brutto_linii} zł.`,
    });
  });
}
