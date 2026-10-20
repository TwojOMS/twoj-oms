import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';

import { odblokujFakture, fakturaSkasowanaWInfakcie } from '../db/faktury.js';

import { zapiszLubOdpusc } from '../../wysylka/services/status-kuriera.js';

import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';

import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';

import {
  wybraneZListy, podzielDoFaktury, powodZaDuzejPartii, wariantFakturyHurtem, ETYKIETA_WARIANTU,
} from '../../../domena/masowe.js';

import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { GDZIE_KLUCZ_INFAKTU } from '../../../domena/konfiguracja-infakt.js';

import { bezpiecznaNazwa } from '../../../domena/pliki.js';

import { adresSprzedawcy } from '../../../domena/adres-sprzedawcy.js';

import { adresOdbiorcy } from '../../../domena/adres-odbiorcy.js';

import { daneFaktury } from '../../../domena/dane-faktury.js';

import { klientPoNip } from '../../../oms/db/klienci.js';

import { dzienWarszawa } from '../../../domena/format-daty.js';

import { modelOswiadczenia } from '../../../domena/oswiadczenie-wywozu.js';

import { zbudujOswiadczenieWywozuPdf } from '../pdf/oswiadczenie-wywozu-pdf.js';

import { przypiszDoOkresu } from '../services/okres.js';

import { wolnoPrzypisac } from '../../../domena/zmiana-okresu.js';

import { przypiszZamowienieDoOkresu } from '../../../oms/db/okresy.js';

import { umowaZbiorcza } from '../../../domena/klient-zbiorczy.js';

import { pobierzOkres } from '../../../oms/db/okresy.js';

import { ktoKlikal } from '../../zamowienia/lista.js';

export function registerDokumentyRoutes(app, { db, config = {}, faktura, fakturaHurtem, proforma, infakt, fakturaAllegro, ksefDoczytanie, wczytajListe, miniaturyEkranu }) {

const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);

const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje);

app.post('/zamowienia/faktury-hurtem/podglad', async (req, reply) => {
    const wybrane = wybraneZListy(wczytajListe([].concat(req.body?.id ?? [])), req.body?.id);
    const { doWystawienia, pominiete } = podzielDoFaktury(wybrane, Date.now(), { okresyWlaczone: reply.locals.modulWlaczony('okresy') });
    const zaDuzo = powodZaDuzejPartii(doWystawienia.length);
    return reply.view('faktury-hurtem-podglad.ejs', {
      doWystawienia: doWystawienia.map((z) => ({
        id: z.id, numer: z.numer, klient: adresOdbiorcy(z).nazwa, kwota: z.kwotaOczekiwanaZl,
        // PRZ-070: od pobrania wariant bywa „przy odbiorze" — ekran mówi to PRZY KAŻDYM
        // dokumencie, bo to jest różnica na papierze, którego się nie poprawia.
        wariant: ETYKIETA_WARIANTU[wariantFakturyHurtem(z).termin] ?? '',
      })),
      pominiete,
      zaDuzo,
      wystawianieDziala: Boolean(fakturaHurtem),
      // Adres powrotu jedzie DALEJ ukrytym polem formularza zatwierdzenia — tak samo, jak
      // przy nadaniu zbiorczym (4.13d). Bez tego ekran podgladu zjadalby zawezenie po drodze.
      powrot: bezpiecznyPowrotNaListe(req.body?.powrot, config.definicje),
    });
  });

app.post('/zamowienia/faktury-hurtem', async (req, reply) => {
    // ⚠️ MOMENT PRZYJSCIA ZADANIA, liczony PRZED odczytem listy i przed podzialem. Budzet
    // uslugi (services/faktura-hurtem.js) ma obejmowac takze te sekundy, bo mierzy CZEKANIE
    // CZLOWIEKA — a czlowiek czeka od chwili klikniecia, nie od pierwszej faktury.
    //
    // ⚠️ SPROSTOWANIE 12.08.2026: stalo tu, ze „60 s kurka HTTP liczy sie wlasnie stad".
    // Zadnego kurka nie ma — `web/server.js` ustawia `requestTimeout: 0` JAWNIE, bo nadanie
    // do paczkomatu trwa okolo 150 s w jednym zadaniu. 60 s w tym module to `LIMIT_ZADANIA_MS`
    // z infakt/client.js, czyli limit WYCHODZACY na pojedyncze wywolanie do inFaktu. Pelne
    // wyjasnienie stoi przy `BUDZET_HURTU_MS` w services/faktura-hurtem.js.
    //
    // Podajemy LICZBE milisekund — `null` albo napis daja tam cicha awarie (patrz docblock
    // `wystawWiele`).
    const start = Date.now();
    if (!fakturaHurtem) return reply.code(503).send(`Wystawianie faktur nie jest skonfigurowane (brak danych inFaktu). ${GDZIE_KLUCZ_INFAKTU}`);
    const wybrane = wybraneZListy(wczytajListe([].concat(req.body?.id ?? [])), req.body?.id);
    // Podzial liczony PONOWNIE, a nie przepisany z ekranu podgladu: miedzy podgladem
    // a zatwierdzeniem klient mogl anulowac zamowienie, a operator z drugiej zakladki
    // wystawic fakture. Formularz przyniosl identyfikatory, nie decyzje.
    const { doWystawienia, pominiete } = podzielDoFaktury(wybrane, Date.now(), { okresyWlaczone: reply.locals.modulWlaczony('okresy') });
    const zaDuzo = powodZaDuzejPartii(doWystawienia.length);
    // ⚠️ ODMOWA JEST TWARDA, a nie samym ukryciem przycisku na ekranie podgladu: miedzy
    // podgladem a zatwierdzeniem operator mogl otworzyc druga zakladke.
    // ⚠️ Adres powrotu czytany RAZ, przed oboma renderami — ekran odmowy (nizej) jest
    // pelnoprawnym wyjsciem z tej akcji i tez musi umiec odeslac tam, skad przyszlo
    // zaznaczenie. Osobny odczyt w kazdej galezi kusi, zeby o jednej zapomniec.
    const powrot = bezpiecznyPowrotNaListe(req.body?.powrot, config.definicje);
    // Prośba właściciela 14.10 (PRZ-070): z wyniku ma się dać wejść w zamówienie — przy błędzie od
    // razu w edycję danych do faktury (np. NIP z przedrostkiem z Allegro). Adres z TEJ SAMEJ
    // funkcji, co karta, z powrotem na zawężoną listę.
    const adresKarty = (id, stan = null, kotwica = null) => adresKartyZamowienia(id, { powrot, stan, kotwica }, config.definicje);
    if (zaDuzo) {
      return reply.view('faktury-hurtem-wynik.ejs', {
        wystawione: [], bledy: [], nietkniete: [], pominiete, zaDuzo, powrot, adresKarty,
      });
    }

    // Pusta partia NIE JEDZIE do uslugi. Wywolanie z pusta lista niczego by nie wystawilo,
    // ale otwieraloby operacje nieodwracalna bez ani jednego zamowienia — a to jest droga,
    // na ktorej „nic sie nie stalo" ma byc widoczne W KODZIE, nie wywnioskowane z tego, ze
    // petla w usludze nie ma po czym chodzic.
    const wynik = doWystawienia.length
      ? await fakturaHurtem.wystawWiele(doWystawienia, { start })
      : { wystawione: [], bledy: [], nietkniete: [] };
    // ⚠️ LOG PRZY KAZDYM ZAMOWIENIU — takze przy nieudanym. To najgrozniejsza akcja
    // w panelu: ekran wyniku oglada sie raz, a pytanie „czy panel w ogole probowal"
    // wraca tygodniami. `zapiszLubOdpusc`, bo awaria zapisu logu nie ma prawa schowac
    // ekranu z numerami faktur, ktore JUZ POWSTALY w inFakcie.
    for (const w of wynik.wystawione) {
      zapiszLubOdpusc(() => dopiszLog(db, w.id, {
        akcja: 'faktura.masowa',
        wynik: `Ręcznie (${ktoKlikal(req)}): wystawiono hurtem ${w.numerFaktury ?? ''}`.trim(),
      }));
    }
    for (const b of wynik.bledy) {
      zapiszLubOdpusc(() => dopiszLog(db, b.id, { akcja: 'faktura.masowa', wynik: `BŁĄD: ${b.powod}` }));
    }
    // Po wystawieniu NIE przekierowujemy nigdy — tak samo, jak po nadaniu. Numery faktur sa
    // jedynym potwierdzeniem operacji, ktorej nie da sie cofnac.
    return reply.view('faktury-hurtem-wynik.ejs', {
      ...wynik, pominiete, zaDuzo: null, powrot, adresKarty,
    });
  });

app.get('/zamowienia/:id/potwierdzenie-wywozu.pdf', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    let bajty;
    try {
      // Adres sprzedawcy TA SAMA regula, co proforma i specyfikacja (adresSprzedawcy);
      // NIP z config.proforma.nip — prefiks PL doklada model.
      const sprzedawca = { ...adresSprzedawcy(config), nip: config?.proforma?.nip ?? null };
      bajty = zbudujOswiadczenieWywozuPdf(modelOswiadczenia(z, {
        sprzedawca, dzis: dzienWarszawa(new Date().toISOString()),
      }));
    } catch (e) {
      zapiszLubOdpusc(() => dopiszLog(db, id, { akcja: 'wdt.wywoz.pdf', wynik: `BŁĄD: ${e.message}` }));
      return reply.code(400).send(`Nie udało się przygotować potwierdzenia wywozu: ${komunikatDlaOperatora(e)}`);
    }
    const nazwaPliku = `potwierdzenie-wywozu-${bezpiecznaNazwa(z.numer ?? String(id))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(bajty);
  });

app.post('/zamowienia/:id/okres', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

    const nip = daneFaktury(z).nip;
    const klient = umowaZbiorcza(klientPoNip(db, nip));
    // `z.faktura` doklada `pobierzZamowienie` — to jest ta sama faktura, ktora widzi karta.
    const zgoda = wolnoPrzypisac({ zamowienie: z, faktura: z.faktura, klient });
    if (!zgoda.wolno) return reply.code(400).send(zgoda.powod);

    let okresId;
    try {
      okresId = przypiszDoOkresu({
        db, nip, dataZlozenia: z.utworzone_at, hurt: z.do_siedziby_klienta,
      });
      przypiszZamowienieDoOkresu(db, okresId, id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'okres.przypisz', wynik: `BŁĄD (${ktoKlikal(req)}): ${e.message}` });
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    // ⚠️ LOG NAZYWA MIESIAC, NIE ID — czytajac „dopisane do okresu 1" za pol roku nikt nie
    // wie, o ktory miesiac chodzi, a ten wpis jest jedynym sladem zmiany. Ten sam ksztalt,
    // co przy odpieciu: oba wpisy stoja obok siebie w logu tego samego zamowienia.
    const o = pobierzOkres(db, okresId);
    const miesiac = o ? `${o.rok}-${String(o.miesiac).padStart(2, '0')}` : `#${okresId}`;
    dopiszLog(db, id, { akcja: 'okres.przypisz', wynik: `dopisane do okresu ${miesiac} (${ktoKlikal(req)})` });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/proforma', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!proforma) return reply.code(503).send('Proformy nie są skonfigurowane.');
    try {
      proforma.wystaw(id);
    } catch (e) {
      // Slad w logu z osobna akcja („proforma.http"), tak jak przy fakturze VAT
      // („faktura.http") — services/proforma.js loguje juz WLASNA akcje („proforma") przy
      // awarii zapisu pliku, ale TA linia ma zlapac KAZDA odmowe, takze te sprzed zapisu
      // (np. `czyWolnoWystawic`), ktorych serwis sam nie loguje.
      dopiszLog(db, id, { akcja: 'proforma.http', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się wystawić proformy: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.get('/proformy/:id/pdf', async (req, reply) => {
    if (!proforma) return reply.code(503).send('Proformy nie są skonfigurowane.');
    const id = Number(req.params.id);
    let wynik;
    try {
      wynik = proforma.pdf(id);
    } catch (e) {
      return reply.code(404).send(komunikatDlaOperatora(e));
    }
    // Numer proformy ma ukosniki („PF/1/08/2026") — w nazwie pliku sa nielegalne
    // na Windowsie, a ten PDF czesto jedzie prosto do drukarki.
    const nazwaPliku = `proforma-${bezpiecznaNazwa(wynik.numer ?? String(id))}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwaPliku}"`)
      .send(wynik.bajty);
  });

app.post('/zamowienia/:id/faktura', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!faktura) return reply.code(503).send(`inFakt nie jest skonfigurowany. ${GDZIE_KLUCZ_INFAKTU}`);
    try {
      // Termin i data wystawienia Z FORMULARZA (domain/termin-platnosci.js). Nierozpoznana
      // wartosc dostaje odmowe TAM, w domenie — tutaj przekazujemy surowo, zeby nie istnialy
      // dwa miejsca decydujace o tym samym.
      //
      // ⚠️ ZADANIE BEZ POLA `termin` idzie STARA DROGA, czyli bez zadnych dat w payloadzie —
      // dokladnie tak, jak panel dzialal do 2026-08-01. To nie jest uprzejmosc dla starych
      // testow: podstawienie tu domyslnego terminu znaczyloby, ze zadanie, ktore o terminie
      // nic nie mowi, po cichu ustawia klientowi date zaplaty.
      // `dataSprzedazy` SUROWO z formularza (`data_sprzedazy`) — walidacja i propozycja
      // siedza w domenie (data-sprzedazy.js, termin-platnosci.js), zeby nie istnialy dwa
      // miejsca decydujace o tym samym (Zadanie 6).
      await faktura.wystaw(id, req.body?.termin === undefined ? null : {
        dataWystawienia: req.body?.data_wystawienia,
        dataSprzedazy: req.body?.data_sprzedazy,
        termin: req.body.termin,
      });
    } catch (e) {
      // Nieudana proba wystawienia MUSI zostawic slad: to najgrozniejsza akcja w panelu,
      // a bez wpisu w logu awaria sieci po stronie inFaktu wygladalaby jak "nic sie nie stalo".
      dopiszLog(db, id, { akcja: 'faktura.http', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się wystawić faktury: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/faktura/odblokuj', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let f;
    try {
      f = odblokujFakture(db, id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'faktura.odblokowanie', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się odblokować faktury: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'faktura.odblokowanie',
      wynik: `Ręcznie (${ktoKlikal(req)}): sprawdzone w inFakcie, dokumentu nie ma — `
        + `rezerwacja z ${f.utworzona_at} (${f.ksef_status}${f.blad_opis ? `: ${f.blad_opis}` : ''}) skasowana.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

app.post('/zamowienia/:id/faktura/skasowana', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let f;
    try {
      f = fakturaSkasowanaWInfakcie(db, id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'faktura.skasowana', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się odnotować skasowania faktury: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'faktura.skasowana',
      wynik: `Ręcznie (${ktoKlikal(req)}): faktura ${f.numer ?? '(bez numeru)'} `
        + `(UUID ${f.infakt_uuid ?? 'brak'}) skasowana ręcznie w inFakcie — panel niczego tam nie kasował, `
        + 'tylko odnotował fakt i zwolnił zamówienie do ponownego wystawienia.',
    });
    // ⚠️ POWROT TAM, SKAD KLIKNIETO (01.09.2026). Od przeniesienia tej akcji na zakladke
    // FAKTURY wolajacy bywa DWOJAKI, a odeslanie na karte zamowienia wyrzucaloby operatora
    // na ekran, ktorego nie ogladal. ⚠️ WYLACZNIE SCIEZKA WZGLEDNA — parametr z zadania jest
    // danymi od uzytkownika, a `//host` w `Location` to przekierowanie na obcy serwer.
    const powrot = String(req.body?.powrot ?? '');
    const dokad = /^\/[^/]/.test(powrot) ? powrot : `/zamowienia/${id}`;
    return reply.redirect(dokad);
  });

app.post('/zamowienia/:id/faktura-allegro', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!fakturaAllegro) return reply.code(503).send('Kanał Allegro nie jest skonfigurowany — faktury stąd nie wyślesz.');
    try {
      await fakturaAllegro.wyslij(id);
    } catch (e) {
      // Nieudana proba MUSI zostawic slad: przy operacji, ktora czesciowo mogla sie udac
      // (POST przeszedl, plik nie), log jest jedynym miejscem, z ktorego da sie odtworzyc,
      // co naprawde poszlo do Allegro.
      dopiszLog(db, id, { akcja: 'faktura-allegro', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się wysłać faktury do Allegro: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });

}
