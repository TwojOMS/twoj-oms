import { stanyKart } from '../../oms/db/stany-magazynowe.js';
import { czyFiltrStanu, klasaStanu, pasujeDoStanu } from '../../domena/niski-stan.js';
import { dzienWarszawa, fmtDataCzas } from '../../domena/format-daty.js';
import { STANY_PO_POLSKU, mozeWystawiacHurtem } from './oferty.js';
import { rodzajKanalu } from '../../domena/kanaly.js';
import { kanalyDostepnosciKart } from '../../oms/db/magazyn.js';
import { listaParametrow } from '../../oms/db/parametry-kart.js';
import { kluczBrakuParametru } from '../../domena/magazyn-filtry.js';
import { cenyZakupuNa } from '../../oms/db/ceny-zakupu.js';
import { BRAK_ZGODY_OFERT } from '../kanaly/services/oferty-allegro-ustawienia.ts';
import { liczbaZPrzymiotnikiem } from '../../domena/allegro-oferta.js';
import { liczbaOfertDoDecyzji } from '../../oms/db/oferty-kanalow.ts';
import { STAWKI_VAT } from '../../domena/vat.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../domena/allegro-oferta-z-karty.js';
import { nazwySlownika } from './services/slowniki-kart.js';
import { maDostepDoAdresu } from '../../domena/ekrany.js';
import { KATALOG_INTEGRACJI } from '../../domena/katalog-integracji.ts';

/**
 * Plakietki kolumny „Kanały” jednej karty — po jednej na polaczenie, w ktorym
 * karta jest dostepna (dwa konta Allegro = dwie plakietki). Rodzaj i litera z `typ` definicji
 * kanalu (`rodzajKanalu`, ta sama plakietka co na liscie zamowien), opis = etykieta polaczenia.
 * Lustro (`obecne`) daje Allegro/Woo; ERLI wylacznie z rejestru ofert: `aktywna` = zwykla
 * plakietka, kazdy inny stan = wyszarzona ze stanem (i bledem) w opisie. Kanal spoza definicji
 * (bez rodzaju) nie dostaje plakietki. Kolejnosc stala: po typie, potem po nazwie.
 * Oferta z rejestru na koncie innym niz ERLI (np. szkic Allegro, „do wysłania”) tez
 * dostaje plakietke ze stanem — chyba ze lustro juz pokazuje to konto jako dostepne.
 */
function plakietkiKanalow(obecne, oferty, definicje) {
  const nazwa = (kanal) => definicje.find((d) => d?.klucz === kanal)?.etykieta ?? kanal;
  const wynik = [];
  for (const kanal of obecne) {
    const rodzaj = rodzajKanalu(kanal, definicje);
    if (rodzaj && rodzaj.klucz !== 'erli')
      wynik.push({ rodzaj, nazwa: nazwa(kanal), opis: nazwa(kanal), aktywna: true });
  }
  const zRejestru = new Map();
  for (const o of oferty) {
    const rodzaj = rodzajKanalu(o.kanal, definicje);
    if (!rodzaj || (rodzaj.klucz !== 'erli' && obecne.includes(o.kanal))) continue;
    const byla = zRejestru.get(o.kanal);
    if (!byla || (o.stan === 'aktywna' && byla.stan !== 'aktywna')) zRejestru.set(o.kanal, o);
  }
  for (const [kanal, o] of zRejestru) {
    const aktywna = o.stan === 'aktywna';
    const stan = `${STANY_PO_POLSKU[o.stan] ?? o.stan}${o.blad ? `: ${o.blad}` : ''}`;
    wynik.push({
      rodzaj: rodzajKanalu(kanal, definicje),
      nazwa: nazwa(kanal),
      opis: aktywna ? nazwa(kanal) : `${nazwa(kanal)} — ${stan}`,
      aktywna,
    });
  }
  return wynik
    .sort((a, b) =>
      a.rodzaj.klucz < b.rodzaj.klucz ? -1 : a.rodzaj.klucz > b.rodzaj.klucz ? 1 : a.nazwa.localeCompare(b.nazwa, 'pl'),
    )
    .map(({ rodzaj, opis, aktywna }) => ({ klucz: rodzaj.klucz, znak: rodzaj.znak, opis, aktywna }));
}

// Kart na jednej stronie listy. Przy tysiącach wierszy sama przeglądarka liczy sekundy
// (dziesiątki tysięcy węzłów DOM), nawet gdy serwer odpowiada szybko.
const NA_STRONE = 100;

export function numeryStron(strona, stron) {
  if (stron <= 7) return Array.from({ length: stron }, (_, i) => i + 1);

  const promien = 2;
  const od = Math.max(2, strona - promien);
  const doNumeru = Math.min(stron - 1, strona + promien);
  const numery = [1];
  if (od > 2) numery.push(od === 3 ? 2 : null);
  for (let numer = od; numer <= doNumeru; numer++) numery.push(numer);
  if (doNumeru < stron - 1) numery.push(doNumeru === stron - 2 ? stron - 1 : null);
  numery.push(stron);
  return numery;
}

// Jak `cenaPolska`, ale z odstępem tysięcy także przy czterech cyfrach: polski Intl grupuje
// domyślnie dopiero od pięciu, a w kolumnie „1234,50” i „12 345,67” wyglądałyby na dwa formaty.
// Jeden formater na moduł: strona z tysiącem kart formatuje kilka tysięcy cen, a budowa
// `Intl.NumberFormat` przy każdej kosztuje więcej niż samo formatowanie.
const FORMAT_CENY = new Intl.NumberFormat('pl-PL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
});
export const cenaListy = (cena) => `${FORMAT_CENY.format(Number(cena))} zł`;

export function registerListaMagazynu(
  app,
  {
    db,
    magazyn,
    sklepy,
    definicje = /** @type {ReadonlyArray<{ klucz: string, typ?: string, etykieta?: string }>} */ ([]),
    pomoc,
    karta,
    trescAllegro,
    kontaErli = /** @returns {{ klucz: string }[]} */ () => [],
    kontaAllegro = /** @returns {{ klucz: string, zgoda?: boolean }[]} */ () => [],
  },
) {
  const {
    kartyZKanalami,
    kategorieDoFiltra,
    markiDoFiltra,
    SORTOWANIE_KART,
    BRAKI_ETYKIETY,
    filtryZZapytania,
    saJakiesFiltry,
    parametryUkryte,
    wartosciPol,
    adresMagazynu,
    POLA_FORMULARZA_FILTROW,
    NAGLOWKI_KANALOW,
    KOLUMNY_KANALOW,
    BEZ_SKLEPOW,
    opisPrzebiegu,
    opisPrzebieguTresci,
    linkiSortowania,
    wierszKarty,
    ileKart,
    opisZawezenia,
    liczbaNiepowiazanychOfertAllegro,
    adresKarty,
  } = pomoc;
  app.get('/magazyn', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false)
      return reply.view('pusta-strona.ejs', { ...BEZ_SKLEPOW, szerokosc: 'tabela' });

    // ⚠️ BIALA LISTA, nie `SORTOWANIE[x] ?? domyslne`. Ta druga postac oddaje funkcje
    // z `Object.prototype` przy `?sort=constructor` i konczy sie pieciusetka na glownym
    // ekranie. Klucze zapytania pomijają usunięte kolumny,
    // a `Set.has` nie zaglada do prototypu.
    const dozwolone = new Set(SORTOWANIE_KART.filter((klucz) => klucz !== 'braki'));
    const jawnySort = dozwolone.has(req.query.sort) ? req.query.sort : undefined;
    // Nierozpoznany kierunek WRACA DO ROSNACEGO, a nie odmawia: kolejnosc nie zawęża
    // zbioru, wiec literowka w adresie ma pokazac liste, a nie pusty ekran.
    const kier = String(req.query.kier ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';

    // Definicje parametrów raz na żądanie: sprawdzają filtr, rysują jego pola i pozycje „bez: …”.
    const parametry = listaParametrow(db);
    const filtry = filtryZZapytania(req.query, parametry);
    // Filtr stanu bez wybranej kolumny korzysta z kolejności stanów z bazy.
    const sort = jawnySort ?? (czyFiltrStanu(filtry.stan) ? undefined : 'nazwa');

    // ——— „ZAZNACZ WSZYSTKIE" BEZ JAVASCRIPTU ———
    // Stan pol wyboru chodzi ADRESEM, dokladnie tak samo, jak na liscie zamowien. Adres
    // USTAWIA stan poczatkowy przy renderze i na tym konczy sie jego rola: po zaladowaniu
    // strony to przegladarka pamieta, co jest odhaczone, a formularz wysyla przy zatwierdzeniu
    // stan pol Z TEJ CHWILI. Dzieki temu „zaznacz wszystkie, odhacz trzy, wykonaj na reszcie"
    // dziala bez ani jednej linii skryptu — i to jest cala roznica miedzy tym mechanizmem
    // a przyciskiem „dla wszystkich pasujacych", ktory jest CALY-ALBO-NIC.
    // ⚠️ Nierozpoznana wartosc NIE zaznacza (`=== '1'`, a nie „cokolwiek prawdziwego") —
    // to samo rozstrzygniecie, co przy zakresie akcji: czego panel nie rozumie, to znaczy
    // zbior WEZSZY, nigdy szerszy.
    const zaznaczWszystkie = String(req.query?.zaznacz ?? '') === '1';

    // ——— TRYB KOLUMN TABELI ———
    // ⚠️ BIALA LISTA DWOCH WARTOSCI, nieznana WRACA DO DOMYSLNEJ — tak samo jak kolejnosc,
    // a INACZEJ niz filtr (ten nierozpoznany oddaje pusto). Tryb nie zawęża zbioru, wiec
    // literowka w adresie ma pokazac liste w domyslnym ukladzie, a nie pusty ekran.
    // ⚠️ Porownanie do napisu, a nie `MAPA[x] ?? domyslne`: przy `?widok=constructor` ta
    // druga postac oddaje funkcje z `Object.prototype`, a przy powtorzonym parametrze
    // Fastify daje TABLICE — jedno i drugie odpada tutaj samo.
    const widok = req.query.widok === 'katalog' ? 'katalog' : 'porzadki';

    // Sortowanie i tryb kolumn NIE SA filtrami, ale jada tymi samymi formularzami: bez tych
    // pol klikniecie „Filtruj" na liscie ulozonej po wymiarze wracaloby do kolejnosci
    // domyslnej, a w trybie katalogowym — takze do kolumn porzadkow (reguła: filtry nie kasują frazy).
    // ⚠️ Tryb domyslny NIE jedzie ukrytym polem, tak samo jak nie wchodzi do adresu:
    // „/magazyn" i „/magazyn?widok=porzadki" maja zostac jednym adresem jednej rzeczy.
    const pokazWszystkie = String(req.query?.wszystkie ?? '') === '1';
    const stanUkryty = [
      ...(sort ? [{ name: 'sort', value: sort }] : []),
      { name: 'kier', value: kier },
      ...(widok === 'katalog' ? [{ name: 'widok', value: 'katalog' }] : []),
      ...(pokazWszystkie ? [{ name: 'wszystkie', value: '1' }] : []),
    ];

    // ⚠️ JEDEN ODCZYT NA CALY EKRAN. Liczba „pasujacych do zawezenia" w pasku hurtu MUSI byc
    // liczona TYM SAMYM zapytaniem, co lista — druga droga do tej liczby rozjechalaby sie
    // z pierwsza po cichu i czlowiek klikalby „ustaw N", dotykajac innego zbioru.
    const znalezione = kartyZKanalami(db, { fraza: filtry.fraza, filtry, sort, kier, kolumny: 'lista' });

    // ——— STRONY PO 100 ———
    // Strona tnie tylko to, co RYSUJEMY. Licznik pasujących, opis zawężenia i akcje „dla
    // wszystkich pasujących” dalej liczą z całego `znalezione` — człowiek ma wiedzieć, że
    // dotyka wszystkich kart zawężenia, a nie setki widocznej na ekranie.
    // „Zaznacz wszystkie” pokazuje całe zawężenie: zaznaczenie żyje w polach formularza,
    // więc zaznaczyć da się tylko to, co jest narysowane.
    // Numer spoza zakresu albo nie-liczba (także powtórzony parametr = tablica) wraca do
    // najbliższej istniejącej strony — numer strony nie zawęża zbioru, pusty ekran nic by nie mówił.
    const stron = Math.max(1, Math.ceil(znalezione.length / NA_STRONE));
    const calaLista = pokazWszystkie || zaznaczWszystkie || stron === 1;
    const zadanaStrona = /^\d+$/.test(String(req.query?.strona ?? '')) ? Number(req.query.strona) : 1;
    const strona = calaLista ? 1 : Math.min(Math.max(zadanaStrona, 1), stron);
    const naEkranie = calaLista ? znalezione : znalezione.slice((strona - 1) * NA_STRONE, strona * NA_STRONE);
    const adresListy = adresMagazynu(filtry, { sort, kier, widok });
    const zDopiskiem = (dopisek, adres = adresListy) => `${adres}${adres.includes('?') ? '&' : '?'}${dopisek}`;
    const adresStrony = (n) => (n > 1 ? zDopiskiem(`strona=${n}`) : adresListy);
    const stronicowanie =
      stron === 1
        ? null
        : calaLista
          ? { wszystkie: true, napis: `Wszystkie ${ileKart(znalezione.length)}`, adresStron: adresListy }
          : {
              wszystkie: false,
              napis: `Karty ${(strona - 1) * NA_STRONE + 1}–${(strona - 1) * NA_STRONE + naEkranie.length} z ${znalezione.length}`,
              poprzednia: strona > 1 ? adresStrony(strona - 1) : null,
              nastepna: strona < stron ? adresStrony(strona + 1) : null,
              numery: numeryStron(strona, stron).map((numer) =>
                numer === null ? { luka: true } : { numer, adres: adresStrony(numer), biezaca: numer === strona },
              ),
              adresWszystkich: zDopiskiem('wszystkie=1'),
            };
    // „Wystaw na…” — konta obu typów; konto Allegro bez zgody na oferty zostaje na liście, wyszarzone.
    const logoUslugi = (id) => KATALOG_INTEGRACJI.find((u) => u.id === id)?.logo ?? '';
    const kontaOfert = [
      ...kontaErli().map((k) => ({
        klucz: k.klucz,
        nazwa: k.nazwa || k.klucz,
        kanal: 'ERLI',
        logo: logoUslugi('erli'),
        sandbox: false,
        allegro: false,
        zgoda: true,
      })),
      ...kontaAllegro().map((k) => ({
        klucz: k.klucz,
        nazwa: k.nazwa || k.klucz,
        kanal: 'Allegro',
        logo: logoUslugi('allegro'),
        sandbox: k.srodowisko === 'sandbox',
        allegro: true,
        zgoda: k.zgoda !== false,
      })),
    ];
    // ⚠️ MIGAWKA KANAŁÓW RAZ NA ŻĄDANIE. Definicje, kolumny i nagłówki kanałów to „żywe” listy:
    // każdy odczyt (`.find`, `.length`, pętla) czyta definicje z bazy i odszyfrowuje tokeny.
    // Czytane w każdym wierszu dawały sekundy przy tysiącu kart; dalej tylko te kopie.
    const definicjeTeraz = [...definicje];
    const kolumnyKanalow = [...KOLUMNY_KANALOW];
    const naglowkiKanalow = [...NAGLOWKI_KANALOW];
    const pokazPlakietki = widok !== 'katalog' && definicjeTeraz.length > 0;
    const obecnosc = new Map();
    if (pokazPlakietki) {
      // Status publikacji liczy sie dla kazdego konta Allegro z definicji (te same, co plakietka) —
      // takze konta bez kompletnej konfiguracji, bo jego ENDED/INACTIVE nie moze wygladac na dostepne.
      const kanalyZeStatusem = definicjeTeraz
        .filter((d) => rodzajKanalu(d.klucz, definicjeTeraz)?.klucz === 'allegro')
        .map((d) => d.klucz);
      for (const { karta_id, kanal } of kanalyDostepnosciKart(
        db,
        naEkranie.map((w) => w.id),
        { kanalyZeStatusem },
      )) {
        (obecnosc.get(Number(karta_id)) ?? obecnosc.set(Number(karta_id), []).get(Number(karta_id))).push(kanal);
      }
    }

    // Adres TEJ listy — to on jedzie dalej jako `wroc` przy KAZDEJ karcie, ktora
    // z niej linkuje, zeby „Wróć do magazynu" trafil tu, a nie na zawsze goly „/magazyn".
    // ⚠️ BEZ `zaznacz`: stan pol wyboru nie ma sensu jako miejsce powrotu (checkbox jest
    // stanem PRZEGLADARKI po zaladowaniu strony, nie czyms, co adres ma odtwarzac).
    // Z numerem strony albo „wszystkie” — powrót z karty ma trafić tam, skąd człowiek wyszedł.
    const adresPowrotuListy = pokazWszystkie ? zDopiskiem('wszystkie=1') : calaLista ? adresListy : adresStrony(strona);

    // Stany magazynowe — wylacznie przy wlaczonym przelaczniku (Ustawienia → Magazyn). Wylaczone:
    // `stany.wlaczone === false`, kolumny i paska nie ma, ekran wygląda jak bez tej funkcji.
    const stany = stanyKart(db);
    const naStanie = (id) => (stany.wlaczone ? (stany.stany.get(Number(id))?.stan ?? 0) : null);
    const naMinusie = [...stany.stany.values()].filter(({ stan }) => pasujeDoStanu('minus', stan)).length;
    // Odnośnik w podsumowaniu prowadzi do całego aktywnego asortymentu z progiem.
    const zNiskimStanem = stany.wlaczone
      ? db
          .prepare(
            'SELECT id, prog_niskiego_stanu AS prog FROM karty_produktow WHERE wycofana = 0 AND prog_niskiego_stanu IS NOT NULL',
          )
          .all()
          .filter(({ id, prog }) => klasaStanu(naStanie(id), prog) === 'niski').length
      : 0;

    const zakladki = [
      { widok: 'porzadki', etykieta: 'Produkty' },
      { widok: 'katalog', etykieta: 'Ceny w kanałach' },
    ].map((zakladka) => {
      // Zmiana kolumn zachowuje widoczne karty i stan zaznaczenia.
      const adres = adresMagazynu(filtry, { sort, kier, zaznacz: zaznaczWszystkie, widok: zakladka.widok });
      const dopisek = pokazWszystkie ? 'wszystkie=1' : strona > 1 ? `strona=${strona}` : '';
      return {
        etykieta: zakladka.etykieta,
        adres: dopisek ? zDopiskiem(dopisek, adres) : adres,
        aktywna: zakladka.widok === widok,
      };
    });

    const cenyZakupu = widok === 'katalog' ? cenyZakupuNa(db, dzienWarszawa(new Date().toISOString())) : null;

    return reply.view('magazyn-lista.ejs', {
      szerokosc: 'tabela',
      title: 'Magazyn',
      // Ekrany stanów w kanałach tylko dla admina — link też.
      adminStanowKanalow: req.konto?.admin === true,
      kontaOfert: mozeWystawiacHurtem(req.konto) ? kontaOfert : [],
      liczbaProblemowOfert: req.konto?.admin ? liczbaOfertDoDecyzji(db) : 0,
      // Jedno zapytanie z licznikiem; zakonczone sa poza liczba, tak jak na ekranie powiazan.
      powiazania: (() => {
        const n = liczbaNiepowiazanychOfertAllegro(db);
        return {
          adres: '/magazyn/powiazania',
          etykieta:
            n > 0
              ? `Powiązania ofert (${liczbaZPrzymiotnikiem(n, ['niepowiązana', 'niepowiązane', 'niepowiązanych'])})`
              : 'Powiązania ofert',
        };
      })(),
      brakZgodyOfert: BRAK_ZGODY_OFERT,
      adresPowrotuListy,
      wiersze: naEkranie.map((w) => {
        const wiersz = wierszKarty(w, adresPowrotuListy, kolumnyKanalow);
        const stan = naStanie(w.id);
        // Wycofana karta nie wchodzi do licznika ani filtra niskiego stanu, więc nie dostaje też jego znacznika.
        const klasa = stan === null ? 'zwykly' : klasaStanu(stan, w.wycofana === 1 ? null : w.prog_niskiego_stanu);
        if (cenyZakupu) {
          const nettoGr = cenyZakupu.get(w.id);
          wiersz.cenaZakupuNetto = nettoGr == null ? null : cenaListy(nettoGr / 100);
          wiersz.stawkaVat = w.stawka_vat;
          wiersz.kanaly = wiersz.kanaly.map((k) => (k?.cena != null ? { ...k, cena: cenaListy(k.cena) } : k));
        }
        return {
          ...wiersz,
          cena: widok !== 'katalog' && w.cena_gr != null ? cenaListy(w.cena_gr / 100) : null,
          // Szybka zmiana ceny (public/szybka-cena.js): kwota do pola bez odstępów tysięcy i bez „zł” — w postaci,
          // którą przyjmuje parser karty — oraz odnośnik ołówka, który bez skryptu otwiera edycję danych karty.
          cenaDoPola: w.cena_gr != null ? (w.cena_gr / 100).toFixed(2).replace('.', ',') : '',
          adresEdycjiCeny: `${adresKarty(w.id, { edytuj: 'dane', wroc: adresPowrotuListy })}#dane-karty`,
          naStanie: stan,
          klasaStanu: klasa === 'zwykly' ? '' : ` stan-${klasa}`,
          opisNiskiegoStanu: klasa === 'niski' ? `niski stan — próg ${w.prog_niskiego_stanu} szt.` : null,
          plakietkiKanalow: pokazPlakietki
            ? plakietkiKanalow(obecnosc.get(Number(w.id)) ?? [], w.oferty ?? [], definicjeTeraz)
            : [],
        };
      }),
      stronicowanie,
      stany: stany.wlaczone
        ? {
            od: fmtDataCzas(stany.granica),
            naMinusie,
            zNiskimStanem,
            adresMinusa: adresMagazynu({ stan: 'minus' }, { widok }),
            adresNiskiegoStanu: adresMagazynu({ stan: 'niski' }, { widok }),
            bezKarty: stany.bezKarty,
            adresImportu: '/magazyn/stany/import',
            adresBezKarty: '/magazyn/stany/bez-karty',
          }
        : null,
      naglowkiKanalow,
      // Adres, stan aktywnosci i strzalka KAZDEGO naglowka sortujacego — policzone tutaj,
      // bo widok w tym module niczego nie rozstrzyga.
      sortowanie: linkiSortowania(sort, kier, filtry, zaznaczWszystkie, widok, pokazWszystkie),
      przebieg: opisPrzebiegu(magazyn.stan()),
      // Przycisk treści ofert tylko przy połączonym koncie Allegro (`null` = bez przycisku).
      trescAllegro: opisPrzebieguTresci(trescAllegro && trescAllegro.gotowy?.() !== false ? trescAllegro.stan() : null),

      widok,
      zakladki,
      // Firma bez kanałów nie ma czego pokazać w kolumnie „Kanały” — wtedy jej nie ma.
      kolumnaKanalow: pokazPlakietki,
      kolumnPustej:
        6 + (widok === 'katalog' ? naglowkiKanalow.length : Number(pokazPlakietki)) + Number(stany.wlaczone),
      // Co dzis zawęża liste — zdanie nad tabela, POLICZONE (widok niczego nie liczy).
      opisZawezenia: opisZawezenia(filtry, znalezione.length),
      // Liczba wynikow PRZY zawezeniu (pasek chipow) — TA SAMA odmiana trojformowa co
      // `ileKart` uzywa dwie linijki wyzej w `opisZawezenia`. Druga kopia w widoku
      // (dwuformowe „karta"/„kart") mowilaby przy dwoch wynikach „2 kart" zamiast
      // „2 karty" — widok niczego nie liczy, wiec liczebnik stoi tutaj.
      napisWynikuFiltra: ileKart(znalezione.length),

      // ——— ZAZNACZENIE ———
      zaznaczWszystkie,
      // Oba adresy skladane TU, z zachowaniem zawezenia I kolejnosci — inaczej „zaznacz
      // wszystkie" zdejmowaloby filtr i czlowiek zaznaczylby karty, ktorych nie widzial.
      // ⚠️ To NIE JEST teoretyczne: przy przejeciu numerow zaznaczenie prowadzi do zapisu
      // nieodwracalnego z panelu, a do przejecia bywa tylko czesc katalogu — „zaznacz wszystkie" bez zawezenia objeloby tez reszte.
      // ⚠️ TRYB KOLUMN JEDZIE Z NIMI. Stan pol wyboru pamieta przegladarka, ale sam odnosnik
      // PRZELADOWUJE strone — bez trybu „zaznacz wszystkie" przerzucaloby czlowieka
      // z katalogu do porzadkow w polowie zaznaczania.
      adresZaznaczWszystkie: adresMagazynu(filtry, { sort, kier, zaznacz: true, widok }),
      adresOdznaczWszystkie: adresMagazynu(filtry, { sort, kier, widok }),

      // ——— WYSZUKIWARKA I FILTRY ———
      filtry,
      // Wartosci POL formularza (ceny z powrotem w zlotowkach, brak jako pusty napis) —
      // liczy je domena, zeby widok nie musial wiedziec, ze filtry zyja w groszach.
      wartosci: wartosciPol(filtry),
      // ⚠️ CZY COKOLWIEK ZAWEZA LISTE. Od tego zalezy, CO MOWI PUSTA TABELA: „nie ma tu
      // jeszcze ani jednej karty produktu" przy aktywnym filtrze jest NIEPRAWDA i wyglada jak utrata
      // danych — katalog ma karty, a ekran twierdzi, ze jest pusty.
      filtrowane: saJakiesFiltry(filtry),
      // Oba formularze GET niosa nawzajem swoje wartosci ukrytymi polami — inaczej klikniecie
      // „Filtruj" gubiloby fraze, a wpisanie frazy gubiloby filtry (reguła: filtry nie kasują frazy).
      ukryteWFiltrach: [
        ...parametryUkryte(filtry, { pomin: [...POLA_FORMULARZA_FILTROW, 'stan'] }),
        ...stanUkryty.filter(({ name }) => name !== 'sort' || jawnySort),
      ],
      ukryteWSzukajce: [...parametryUkryte(filtry, { pomin: ['fraza'] }), ...stanUkryty],
      // „Wyczysc filtry" zdejmuje zawezenie, ale NIE kolejnosc ani NIE tryb kolumn —
      // ani jedno, ani drugie nie jest filtrem.
      adresBezFiltrow: adresMagazynu({}, { sort, kier, widok, wszystkie: pokazWszystkie }),
      // Pozycje pol wyboru. Etykiety kanalow z `adresKanalu` (ta sama funkcja, co w naglowku
      // kolumny), reszta ze slownikow domeny — druga mapa nazw rozjechalaby sie z pierwsza.
      kanalyDoFiltra: naglowkiKanalow,
      // Kolejność z Ustawień. Wybrany niesie typ, wartości i jednostkę — od nich zależy pole obok.
      parametryDoFiltra: parametry.map(({ id, nazwa }) => ({ id, nazwa })),
      parametrFiltra: parametry.find((p) => p.id === filtry.parametr) ?? null,
      // Każdy wymagany parametr to osobna pozycja braku — ta sama definicja, co `liczba_brakow`.
      brakiDoFiltra: [
        ...['sku', 'wymiary', 'kategoria', 'zdjecie', 'opis'].map((klucz) => ({
          klucz,
          etykieta: BRAKI_ETYKIETY[klucz],
        })),
        ...parametry
          .filter((p) => p.wymagany)
          .map((p) => ({ klucz: kluczBrakuParametru(p.id), etykieta: `bez: ${p.nazwa}` })),
        ...['cena_zakupu', 'komplet'].map((klucz) => ({ klucz, etykieta: BRAKI_ETYKIETY[klucz] })),
      ],
      kategorieDoFiltra: kategorieDoFiltra(db),
      markiDoHurtu: nazwySlownika(db, 'marki'),
      markiDoFiltra: markiDoFiltra(db),

      // ——— PASEK EDYCJI HURTEM ———
      // ⚠️ LICZBA PASUJACYCH JEST TU CALA UCZCIWOSCIA OPCJI „wszystkie pasujace". Czlowiek
      // ma wiedziec, ze dotyka setek kart, a nie 20, ktore widzi na ekranie — i musi to
      // byc TA SAMA liczba, co dlugosc listy nizej, bo obie biora sie z jednego odczytu.
      ilePasujacych: znalezione.length,
      // ⚠️ ZAWEZENIE JEDNYM POLEM, nie siedmioma osobnymi: formularz hurtowy ma WLASNE pola
      // (np. `marka`, `stawka_vat`), a nazwy filtrow i pol hurtu w jednym formularzu wracalyby
      // z Fastify jako TABLICA i kasowaly sie nawzajem (patrz `filtryZawezenia`). Skladane
      // z `adresMagazynu`, czyli z TEGO SAMEGO miejsca, co kazdy odnosnik ekranu.
      // ⚠️⚠️ JEDYNE MIEJSCE EKRANU BEZ TRYBU KOLUMN — i to nie jest przeoczenie. To pole
      // opisuje ZBIOR, ktorego dotknie akcja hurtowa, a tryb kolumn jest UKLADEM EKRANU:
      // wpuszczony tutaj jechalby razem z zawezeniem w zadanie zapisujace setki kart
      // i udawal kryterium wyboru. Dokladnie z tego samego powodu nie ma tu `zaznacz`
      // (patrz `adresMagazynu` w domenie) — a `sort`/`kier` nie ma, bo kolejnosc nie
      // zmienia zbioru.
      zawezenieHurtu: adresMagazynu(filtry).split('?')[1] ?? '',
      // Parametry własne do panelu edycji hurtem: lista ma pole wyboru z wartościami z definicji —
      // wpisany z pamięci tekst trasa i tak odrzuci, ale człowiek nie powinien musieć zgadywać.
      parametryKart: listaParametrow(db).map(({ id, nazwa, typ, jednostka, wartosci, wymagany }) => ({
        id,
        nazwa,
        typ,
        jednostka,
        wartosci,
        wymagany,
      })),
      // Odnośnik „dodaj parametr” w panelu prowadzi do Ustawień — tylko dla konta, które je otworzy.
      mozeUstawieniaMagazynu: maDostepDoAdresu(req.konto, '/magazyn/ustawienia'),
      // Ta sama lista stawek, co na karcie i w walidacji hurtu — druga kopia pozwoliłaby wybrać
      // stawkę, której trasa potem odmówi, albo schowałaby stawkę, którą trasa przyjmuje.
      stawkiDoHurtu: STAWKI_VAT.map((s) => ({ klucz: s, etykieta: `${s}%` })),
      // Ten sam limit, co sprawdza trasa i karta — przeglądarka nie pozwoli wpisać więcej.
      limitInformacjiBezpieczenstwa: LIMIT_INFORMACJI_BEZPIECZENSTWA,
    });
  });
}
