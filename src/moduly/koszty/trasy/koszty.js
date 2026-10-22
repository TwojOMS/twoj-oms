import {
  kosztyMiesiaca, stanKosztow, odrzuconeKoszty, kosztPoNumerze,
  zapiszRecznyKoszt, zaktualizujRecznyKoszt, usunRecznyKoszt, przypnijKategorieDoDokumentu,
} from '../../../oms/db/koszty.js';
import { kategoriaDlaNip, przypnijKategorie, wszystkieKategorie } from '../../../oms/db/kategorie-kosztow.js';
import { dopiszFirmeReczna, firmaReczna, wszystkieFirmyReczne } from '../../../oms/db/firmy-reczne.js';
import { zlozWidok } from '../../../domena/lista-kosztow.js';
import { naWierszReczny } from '../../../domena/koszt-reczny.js';
import { TYPY_KOSZTU } from '../../../domena/typy-kosztow.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
import { uslugaKsefDostepna, powodNiedostepnosciKsef } from '../../../domena/konfiguracja-ksef-kosztow.js';
import { createZestawienieKosztow } from '../services/zestawienie-kosztow.js';

// Zakladka KOSZTY. Trasa jest CIENKA: parsuje zadanie, wola domene, renderuje — dokladnie
// jak siostrzana zakladka FAKTURY (routes/faktury.js). Reguly widoku miesiaca stoja
// w domain/lista-kosztow.js, zapytania w db/koszty.js, pobieranie w services/czuwacz-kosztow.js.
//
// ⚠️ TEN MODUL NICZEGO NIE LICZY I NICZEGO NIE WYSYLA. Kwoty przychodza z `zlozWidok` juz
// policzone (na groszach, calkowitych), a jedyne wywolanie „na zewnatrz" to `przebieg`
// czuwacza, ktory z KSeF wylacznie CZYTA.

// ⚠️ BIALA LISTA TYPOW, mimo `CHECK`-a w schema.sql. Bez niej nieznana wartosc z formularza
// dolatuje do bazy i wraca do operatora jako „SqliteError: CHECK constraint failed" —
// komunikat prawdziwy i bezuzyteczny (ta sama zasada, co przy `RODZAJE_PDF` w routes/faktury.js).
// ⚠️ LISTA JEST JEDNA NA CALY PANEL (domain/typy-kosztow.js) — druga kopia tutaj rozjechalaby
// sie z `CHECK`-iem w bazie przy pierwszym dolozeniu typu.
const TYPY = TYPY_KOSZTU;

// ⚠️ CZAS WARSZAWSKI, nie UTC. `new Date().toISOString().slice(0,7)` pierwszego dnia miesiaca
// o 01:30 czasu polskiego oddaje MIESIAC POPRZEDNI — zakladka otwieralaby sie wtedy na innym
// miesiacu, niz mowi kalendarz na scianie. Ta sama funkcja, co przy /faktury.
const biezacyMiesiac = () => dzienWarszawa(new Date().toISOString()).slice(0, 7);

// Miesiac przyniesiony PRZEZ FORMULARZ jest adresem powrotu, a nie pytaniem o pieniadze:
// popsuta wartosc ma oddac operatora na miesiac biezacy, a nie przewrocic akcje, ktora juz
// sie wykonala (kategoria przypieta, pobranie zrobione). W ADRESIE jest odwrotnie — patrz
// GET nizej: tam nieczytelny miesiac ODMAWIA, bo pusta lista klamalaby „nie bylo kosztow".
const miesiacPowrotu = (w) => (/^\d{4}-\d{2}$/.test(String(w ?? '')) ? String(w) : biezacyMiesiac());

// Zdanie o zakonczonym przebiegu. ⚠️ POMINIECIE NIE JEST POBRANIEM: przebieg wymuszony wciaz
// potrafi odbic sie od blokady „poprzedni przebieg jeszcze trwa" (services/czuwacz-kosztow.js),
// a „Pobrano nowych dokumentow: 0" znaczyloby wtedy „nic nowego nie ma" — czyli nieprawde.
function opisPrzebiegu(wynik) {
  if (wynik?.pominiety) return `Nic nie pobrano — ${wynik.powod}.`;
  const zdania = [`Pobrano nowych dokumentów: ${wynik?.nowych ?? 0}.`];
  if (wynik?.odrzuconych) {
    zdania.push(`Odłożonych do kwarantanny w tym przebiegu: ${wynik.odrzuconych} `
      + '— te dokumenty nie wchodzą do sumy miesiąca.');
  }
  if (wynik?.niedokonczone) {
    zdania.push('Pobranie nie doszło do końca — reszta pojedzie następnym przebiegiem, '
      + 'od miejsca, w którym stanął kursor.');
  }
  return zdania.join(' ');
}

// ⚠️ PACZKA Z DOKUMENTAMI (`GET /faktury/paczka`, zakladka FAKTURY) NIE MA NA TEJ ZAKLADCE
// ODNOSNIKA — zdjety 14.09.2026 decyzja „jedno wejscie do PDF”. Zamiast niego stoi
// `GET /koszty/zestawienie` (PRZ-086, na zyczenie wlasciciela 15.10): sama LISTA kosztow miesiaca
// w dwoch osobnych czesciach — z KSeF i dopisane recznie. Czyta wylacznie baze (zadnego KSeF,
// zadnego inFaktu), wiec dziala takze w panelu bez sekcji KSEF_* i nie potrzebuje `paczkaDlaBiura`.
export function zarejestrujTrasyKosztow(app, {
  db, czuwaczKosztow = null, wizualizacjaKosztu = null, paczkaDlaBiura = null,
  zestawienieKosztow = createZestawienieKosztow({ db }),
} = {}) {
  const ekran = (reply, miesiac, komunikat = null) => {
    const widok = zlozWidok({
      wiersze: kosztyMiesiaca(db, miesiac),
      kategoria: (nip) => kategoriaDlaNip(db, nip),
    });
    // ⚠️ KWARANTANNA JEDZIE NA EKRAN RAZEM Z SUMA (db/koszty.js: „to jest jedyne miejsce,
    // w ktorym widac dokumenty pominiete w sumie miesiaca"). Bez tego trwaly slad po
    // dokumencie, ktorego panel nie umial zapisac, zostaje trwaly I NIEWIDOCZNY, a suma
    // miesiaca po cichu nie zgadza sie z zestawieniem z KSeF.
    //
    // ⚠️ JEDNO ZAPYTANIE, A LICZBA Z DLUGOSCI LISTY. Osobny `liczbaOdrzuconych(db)` obok
    // pelnej listy dawalby dwie wartosci o tym samym, ktore nie maja jak sie zgodzic lepiej
    // niz jedna — a tabela i tak pokazuje wszystkie wiersze.
    const odrzucone = odrzuconeKoszty(db);
    return reply.view('koszty.ejs', {
      title: 'Koszty',
      miesiac,
      ...widok,
      stan: stanKosztow(db),
      kwarantanna: { ile: odrzucone.length, dokumenty: odrzucone },
      dostepneKategorie: wszystkieKategorie(db),
      // ⚠️ LISTA FIRM SPOZA KSeF — pole wyboru „Firma" w formularzu kosztu recznego. Za kazda
      // pozycja stoi nazwa sprzedawcy, kategoria i typ (db/firmy-reczne.js), czyli wszystko,
      // czego operator NIE MA wpisywac.
      firmy: wszystkieFirmyReczne(db),
      typy: TYPY,
      // Panel bez sekcji KSEF_* to tryb POPRAWNY (jak brak inFaktu przy /faktury): lustro
      // w bazie dalej sie oglada, tylko nie ma czym go odswiezyc — i przycisk ma tego
      // nie obiecywac.
      mozliwyOdswiez: uslugaKsefDostepna(czuwaczKosztow),
      // PRZ-108.10 (recenzja): token z ekranu jest, NIP-u firmy brak — ekran mówi to wprost zamiast „nie ma KSeF”.
      powodBrakuKsef: powodNiedostepnosciKsef(czuwaczKosztow),
      // Przycisk „PDF" ma sie pokazac WYLACZNIE wtedy, gdy jest skad wziac XML — panel bez
      // sekcji KSEF_* dalej oglada lustro w bazie, ale wizualizacji nie ma z czego narysowac
      // (ta sama zasada, co przy `mozliwyOdswiez` wyzej: przycisk nie obiecuje niemozliwego).
      mozliwyPdf: uslugaKsefDostepna(wizualizacjaKosztu),
      // ⚠️ TA WARTOSC JEDZIE Z `ekran`, A NIE Z SAMEGO `GET /koszty` — i to jest cala tresc
      // sprawy. Tym samym szablonem renderuje sie KAZDY ekran po akcji (przypiecie kategorii,
      // odswiezenie, wpis reczny, odmowa), wiec zmienna podana tylko w jednym miejscu
      // wywalilaby EJS-a przez ReferenceError dokladnie wtedy, gdy operator juz kliknal.
      mozliwaPaczka: Boolean(paczkaDlaBiura),
      komunikat,
    });
  };

  app.get('/koszty', async (req, reply) => {
    const miesiac = req.query.miesiac || biezacyMiesiac();
    try {
      return ekran(reply, miesiac);
    } catch (e) {
      // ⚠️ `kosztyMiesiaca` RZUCA na miesiacu w zlym formacie i ma rzucac (db/koszty.js, W2):
      // pusta lista znaczylaby „w tym miesiacu nie bylo kosztow", czyli falsz, ktorego nikt
      // nie ma jak zakwestionowac. Trasa zamienia to na zdanie dla czlowieka — literowka
      // w adresie nie ma prawa dac piecsetki. Blad TECHNICZNY leci dalej, do logu.
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(`Nie da się pokazać kosztów: ${komunikatDlaOperatora(e)}`);
    }
  });

  // ⚠️ MIESIAC W ADRESIE ODMAWIA (400), a nie wraca do biezacego — inaczej niz `GET /koszty` wyzej,
  // ktory ma tylko przelaczac widok. Tu powstaje PLIK dla ksiegowej: zestawienie za inny miesiac
  // niz zamowiony wyglada dokladnie tak samo jak poprawne.
  app.get('/koszty/zestawienie', async (req, reply) => {
    const miesiac = String(req.query.miesiac ?? '');
    if (!/^\d{4}-\d{2}$/.test(miesiac)) return reply.code(400).send(`„${miesiac}" to nie jest miesiąc w formacie RRRR-MM.`);
    let wynik;
    try {
      wynik = await zestawienieKosztow.zbuduj(miesiac);
    } catch (e) {
      // Blad TECHNICZNY leci dalej, do logu — jak przy kazdej innej trasie tego pliku.
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${wynik.nazwa}"`)
      .send(wynik.bajty);
  });

  // ⚠️⚠️ WIZUALIZACJA POBIERA XML Z KSeF NA ZADANIE, A NIE Z ARCHIWUM. Archiwum na produkcji
  // jest DZIS WYLACZONE (`KSEF_ARCHIWUM` nieustawione), wiec trasa oparta o `sciezka_pdf`
  // w bazie oddawalaby 404 na kazdym dokumencie — czyli przycisk widoczny i nieczynny.
  // Ta trasa dziala NIEZALEZNIE od tego, czy cokolwiek lezy na NAS-ie.
  //
  // ⚠️ TRASA NICZEGO NIE RYSUJE I NICZEGO NIE LICZY: sklada to `services/wizualizacja-kosztu.js`
  // (pobranie XML-a), `domain/koszt-xml.js` (pozycje) i `pdf/koszt-pdf.js` (rysunek).
  app.get('/koszty/:ksefNumber/pdf', async (req, reply) => {
    // PRZ-102.22: usługa z modułu odpowiada przy każdym żądaniu (token z Ustawień, bez restartu).
    if (!uslugaKsefDostepna(wizualizacjaKosztu)) {
      return reply.code(503).send(powodNiedostepnosciKsef(wizualizacjaKosztu) ?? 'Panel nie ma podpiętego KSeF — nie ma skąd pobrać dokumentu.');
    }
    let wynik;
    try {
      wynik = await wizualizacjaKosztu.pdf(req.params.ksefNumber);
    } catch (e) {
      // Nieznany numer KSeF i awaria po stronie KSeF to oba odmowy OPISANE dla czlowieka —
      // maja wrocic zdaniem, a nie piecsetka. Blad techniczny leci dalej, do logu.
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(`Nie udało się przygotować dokumentu: ${komunikatDlaOperatora(e)}`);
    }
    const nazwa = `koszt-${bezpiecznaNazwa(wynik.wiersz.numer_dokumentu || req.params.ksefNumber)}.pdf`;
    return reply.type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${nazwa}"`)
      .send(wynik.bajty);
  });

  app.post('/koszty/kategoria', async (req, reply) => {
    const { nip, kategoria, typ } = req.body ?? {};
    const miesiac = miesiacPowrotu(req.body?.miesiac);
    const nazwa = String(kategoria ?? '').trim();
    // ⚠️ DOKUMENT ZAMIAST NIP-U, gdy NIP-u nie ma (2026-08-13). Google, Meta czy Anthropic nie
    // maja polskiego NIP-u, a mapa kategorii jest nim KLUCZOWANA — bez tej galezi ich faktury
    // zostawaly by w pasie „bez kategorii" na zawsze. To ten SAM formularz i ta sama nazwa
    // kategorii; rozne jest wylacznie to, do czego decyzja sie przypina.
    const dokument = String(req.body?.ksefNumber ?? '').trim();
    if ((!nip && !dokument) || !nazwa || !TYPY.includes(typ)) {
      return reply.code(400).send('Niepoprawne dane kategorii: potrzebny jest NIP sprzedawcy '
        + 'albo dokument, do którego kategoria ma się przypiąć, nazwa kategorii i typ z listy: '
        + `${TYPY.join(', ')}.`);
    }
    try {
      // Przypiecie dziala dla WSZYSTKICH faktur tego NIP-u, takze juz lezacych w bazie —
      // kategoria dobiera sie przy odczycie, a nie kopiuje do wiersza kosztu.
      if (nip) przypnijKategorie(db, nip, nazwa, typ);
      else przypnijKategorieDoDokumentu(db, dokument, nazwa, typ);
      return ekran(reply, miesiac);
    } catch (e) {
      // NIP bez ani jednej cyfry odbija sie od `przypnijKategorie` — to odmowa opisana
      // dla czlowieka, wiec ma wrocic jako zdanie, a nie jako piecsetka.
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
  });

  // ⚠️ PRZEBIEG WYMUSZONY, ZAWSZE. Zwykly `przebieg()` sprawdza pore (raz na dobe, 3 w nocy
  // czasu Warszawy — services/czuwacz-kosztow.js), wiec przycisk wcisniety w dzien nie
  // zrobilby NIC i wygladalby na zepsuty.
  //
  // ⚠️ TA TRASA NIE MA WLASNEGO LIMITU CZASU i nie ma go dostac. Pelne logowanie do KSeF
  // potrafi trwac ~31 minut, a panel celowo stoi na `requestTimeout: 0` (web/server.js).
  app.post('/koszty/odswiez', async (req, reply) => {
    const miesiac = miesiacPowrotu(req.body?.miesiac);
    if (!uslugaKsefDostepna(czuwaczKosztow)) {
      return reply.code(503).send(powodNiedostepnosciKsef(czuwaczKosztow) ?? 'Panel nie ma podpiętego KSeF — nie ma skąd pobrać kosztów.');
    }
    let komunikat;
    try {
      komunikat = { zle: false, tresc: opisPrzebiegu(await czuwaczKosztow.przebieg({ wymuszony: true })) };
    } catch (e) {
      // ⚠️ AWARIA ZRODLA NIE GASI EKRANU. Lustro w bazie ma poprzedni stan, wiec operator
      // dostaje dane sprzed pobrania PLUS zdanie o tym, co poszlo nie tak.
      //
      // ⚠️ TRESC BLEDU IDZIE NA EKRAN WPROST, a nie przez `komunikatDlaOperatora` — i to jest
      // swiadome. Czuwacz zapisuje DOKLADNIE ten sam napis do `stan_kosztow.ostatni_blad`
      // (services/czuwacz-kosztow.js), a pas stanu tej zakladki go pokazuje; filtrowanie go
      // tutaj dawaloby dwa rozne zdania o jednej awarii na jednym ekranie. Poswiadczen ten
      // napis nie niesie: klient KSeF trzyma tokeny w naglowkach, nie w komunikatach
      // (niezmiennik 4.10).
      komunikat = { zle: true, tresc: e.message };
    }
    try {
      return ekran(reply, miesiac, komunikat);
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(`Nie da się pokazać kosztów: ${komunikatDlaOperatora(e)}`);
    }
  });

  // ⚠️⚠️ RECZNE FAKTURY KOSZTOWE (2026-08-13) — koszty, ktorych w KSeF NIE MA I NIE BEDZIE:
  // Facebook, Google, Anthropic, zakupy zagraniczne, paragony. Trasy sa CIENKIE jak reszta
  // tego pliku: co jest kosztem, rozstrzyga `naWierszReczny` (domain/koszt-reczny.js), a co
  // wolno ruszyc — `zapiszRecznyKoszt` / `zaktualizujRecznyKoszt` / `usunRecznyKoszt`
  // (db/koszty.js). Tutaj zostaje wylacznie parsowanie zadania i wybor ekranu powrotu.
  //
  // ⚠️ FORMULARZ MA TRZY POLA: `firma`, `dataWystawienia`, `kwota`. Definicje firmy podaje
  // slownik (db/firmy-reczne.js) i to JEDYNE, co ta trasa doklada do `req.body` — reszta,
  // z numerem dokumentu i kwotami wlacznie, powstaje w domenie.

  // ⚠️ MIESIAC POWROTU TO MIESIAC DOKUMENTU, a nie ten, z ktorego przyszedl formularz. Koszt
  // wpisany „za poprzedni miesiac" znikalby inaczej z oczu w chwili zapisania — a operator
  // bez potwierdzenia, ze cokolwiek sie stalo, wpisuje go po prostu drugi raz.
  const miesiacDokumentu = (data) => String(data ?? '').slice(0, 7);

  // Odmowa OPISANA dla czlowieka wraca EKRANEM z czerwonym pasem i kodem 400, a nie golym
  // napisem: komunikat oderwany od ekranu zostawia operatora z formularzem, ktorego nie widzi,
  // i bez wskazowki, ktore z trzech pol go odbilo.
  const odmowa = (reply, miesiac, e) => ekran(reply.code(400), miesiac, {
    zle: true, tresc: komunikatDlaOperatora(e),
  });

  // Firma przychodzi jako NAZWA z listy wyboru; slownik oddaje `undefined`, gdy takiej nie zna,
  // a odmowe formuluje `naWierszReczny` — razem z reszta sprawdzen wpisu recznego.
  const wpisReczny = (body) => naWierszReczny(body ?? {}, firmaReczna(db, body?.firma));

  app.post('/koszty/reczne', async (req, reply) => {
    try {
      const wiersz = wpisReczny(req.body);
      zapiszRecznyKoszt(db, wiersz);
      return ekran(reply, miesiacDokumentu(wiersz.dataWystawienia), {
        zle: false,
        tresc: `Dopisano koszt spoza KSeF: ${wiersz.numerDokumentu}, ${wiersz.brutto} zł.`,
      });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return odmowa(reply, miesiacPowrotu(req.body?.miesiac), e);
    }
  });

  // ⚠️ DOPISANIE FIRMY DO SLOWNIKA — dwa pola (nazwa + kategoria z listy) i ani jednego wiecej.
  // Typ kosztu dobiera sie z kategorii (db/kategorie-kosztow.js), bo ona juz go zna; trzecie
  // pole pozwalaloby tej samej kategorii miec tu inny typ niz w rozbiciu miesiaca.
  //
  // Wraca na TEN SAM miesiac, z ktorego przyszedl formularz: dopisanie firmy nie jest kosztem
  // i nie ma wlasnej daty, wiec nie ma dokad przenosic operatora.
  app.post('/koszty/firmy', async (req, reply) => {
    const miesiac = miesiacPowrotu(req.body?.miesiac);
    try {
      const nazwa = dopiszFirmeReczna(db, req.body?.nazwa, req.body?.kategoria);
      return ekran(reply, miesiac, {
        zle: false, tresc: `Firma „${nazwa}" jest już na liście — możesz dopisać jej koszt.`,
      });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return odmowa(reply, miesiac, e);
    }
  });

  // Ekran poprawki. ⚠️ ODMAWIA PRZY DOKUMENCIE Z KSeF — nie dlatego, ze ktos tam trafi
  // z ekranu (odnosnika przy takim wierszu nie ma), tylko dlatego, ze adres da sie wpisac
  // z reki, a formularz poprawki przy dokumencie z lustra bylby obietnica nie do spelnienia.
  app.get('/koszty/reczne/:klucz', async (req, reply) => {
    const wiersz = kosztPoNumerze(db, req.params.klucz);
    if (!wiersz || wiersz.zrodlo !== 'reczne') {
      return reply.code(404).send('Panel nie zna kosztu wpisanego ręcznie o takim numerze. '
        + 'Dokumentu pobranego z KSeF nie da się tu poprawić — panel jest lustrem KSeF-u.');
    }
    const firmy = wszystkieFirmyReczne(db);
    return reply.view('koszt-reczny.ejs', {
      title: 'Koszt spoza KSeF',
      wiersz,
      firmy,
      // ⚠️ FIRMA ODNAJDUJE SIE PO NAZWIE SPRZEDAWCY, bo tylko ona zostaje w wierszu kosztu
      // (kolumny „z ktorej pozycji slownika to jest" nie ma i nie ma byc — wiersz kosztu
      // trzyma FAKTY o dokumencie, a nie odnosnik do listy, ktora ktos moze pozniej zmienic).
      // Pusto znaczy „firmy juz nie ma na liscie": pole wyboru staje wtedy na pozycji pustej,
      // a operator wybiera swiadomie — panel nie ma prawa podstawic mu cudzej firmy.
      firma: firmy.find((f) => f.sprzedawca === wiersz.sprzedawca_nazwa)?.nazwa ?? '',
      miesiac: miesiacPowrotu(req.query.miesiac || miesiacDokumentu(wiersz.data_wystawienia)),
    });
  });

  app.post('/koszty/reczne/:klucz', async (req, reply) => {
    try {
      const wiersz = wpisReczny(req.body);
      zaktualizujRecznyKoszt(db, req.params.klucz, wiersz);
      return ekran(reply, miesiacDokumentu(wiersz.dataWystawienia), {
        zle: false, tresc: `Poprawiono koszt ${wiersz.numerDokumentu}.`,
      });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return odmowa(reply, miesiacPowrotu(req.body?.miesiac), e);
    }
  });

  // ⚠️ USUWANIE DOTYCZY WYLACZNIE WIERSZY RECZNYCH i pilnuje tego `usunRecznyKoszt`
  // (db/koszty.js), a nie ta trasa: dokument z KSeF skasowany z panelu wrocilby dopiero po
  // recznym cofnieciu kursora o miesiace, a do tego czasu suma miesiaca bylaby zanizona.
  app.post('/koszty/reczne/:klucz/usun', async (req, reply) => {
    const miesiac = miesiacPowrotu(req.body?.miesiac);
    try {
      usunRecznyKoszt(db, req.params.klucz);
      return ekran(reply, miesiac, { zle: false, tresc: 'Koszt usunięty.' });
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return odmowa(reply, miesiac, e);
    }
  });
}
