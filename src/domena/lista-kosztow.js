import { czyPLN } from './koszt-metadane.js';
import { grosze, zl } from './kwoty.js';

// Widok miesiaca kosztow: z listy wierszy (jak leza w bazie, `koszty.*`) robi sumy,
// rozbicie na kategorie, pas nieprzypisanych i liste dokumentow w obcej walucie.
// Czysta domena — bez bazy, bez sieci; wolno wolac na dowolnej tablicy obiektow o ksztalcie
// wiersza `koszty` (patrz `kosztyMiesiaca` w db/koszty.js).
//
// ⚠️⚠️ KWOTY WCHODZA JAKO NAPISY, bo `koszty.netto/vat/brutto` sa TEXT-em (niezmiennik 4.5,
// docs/oms/PRZEWODNIK.md: arytmetyka pieniedzy WYLACZNIE przez `grosze()`, nigdy na floatach —
// ta sama zasada, co przy `naWiersz` w koszt-metadane.js). Kazde sumowanie tutaj idzie wiec
// na liczbach calkowitych (grosze), a zamiana z powrotem na napis (`zl()`) dzieje sie DOPIERO
// na samym koncu, raz, tuz przed zwroceniem wyniku.
//
// ⚠️ REPREZENTACJA WYNIKU: kazde pole pieniezne w zwracanym obiekcie (`suma.*`,
// `kategorie[].netto`, `nieprzypisane.netto`, `obcaWaluta[].netto`) to NAPIS z dwoma
// miejscami po przecinku w postaci `zl()` — dokladnie taki, jaki widok wstawi na ekran BEZ
// zadnej dalszej arytmetyki (bez `toFixed`, bez dzielenia przez 100 po stronie szablonu).
// `pozycje` i `obcaWaluta[].netto` przepisuja `netto/vat/brutto` z surowego wiersza bazy —
// to juz sa napisy w tym samym ksztalcie ('1067.00'), wiec nie ma tu nic do przeliczenia; nie
// wchodza jednak do zadnej sumy w tym module, wiec przejscie przez `grosze()` sluzy tu tylko
// za straznik, ze to naprawde jest kwota (rzuci glosno na smieciu, zamiast policzyc go jako 0).
// ⚠️⚠️ DWIE DROGI DO KATEGORII, JEDNA REGULA PIERWSZENSTWA — I MIESZKA ONA TUTAJ (2026-08-13).
//
// Zwykla droga jest jedna: kategoria dobiera sie PO NIP-IE sprzedawcy (db/kategorie-kosztow.js)
// i obejmuje wszystkie faktury tego sprzedawcy, takze starsze. Sprzedawca BEZ polskiego NIP-u
// (Google, Meta, Anthropic — czyli dokladnie ci, ktorych faktur nie ma w KSeF) nie ma jednak
// jak trafic do tamtej mapy, bo jej kluczem glownym jest NIP. Takiemu dokumentowi kategorie
// przypina sie WPROST (`koszty.kategoria_dokumentu`).
//
// KATEGORIA DOKUMENTU WYGRYWA, bo jest BARDZIEJ SZCZEGOLOWA: ktos przypial ja do TEGO
// dokumentu reka, a mapa opisuje calego sprzedawce. NULL znaczy „nie przypisano" i oddaje
// glos mapie — nie gasi kategorii sprzedawcy.
//
// ⚠️ TO JEST JEDYNE MIEJSCE, W KTORYM TO ROZSTRZYGNIECIE ZAPADA. Druga kopia (np. w trasie
// albo w widoku) znaczylaby, ze ekran i suma miesiaca moga pokazac dwie rozne kategorie tego
// samego dokumentu — i to bez zadnego bledu.
//
// ⚠️ EKSPORTOWANE, BO CZYTELNIK JEST DRUGI (2026-08-14): rachunek zarzadczy
// (domain/rachunek-zarzadczy.js) rozbija koszty okresu na kategorie i musi pytac O TO SAMO.
// Zanim ta funkcja wyszla na zewnatrz, tamten modul pytal wylacznie mapy po NIP-ie — wiec
// koszty dopisane recznie (Google, Meta, Anthropic — czyli dokladnie te, ktorych w KSeF nie
// ma i dla ktorych pole kategorii dokumentu powstalo) wchodzily do rachunku jako
// „Nieprzypisane"/„drobne", podczas gdy zakladka KOSZTY pokazywala ich prawdziwa kategorie.
// Suma sie zgadzala, wiec nic nie krzyczalo — rozjezdzalo sie rozbicie i prog rentownosci.
export const kategoriaWiersza = (w, poNipie) => (
  w.kategoria_dokumentu
    ? { kategoria: w.kategoria_dokumentu, typ: w.typ_dokumentu }
    : poNipie(w.sprzedawca_nip)
);

export function zlozWidok({ wiersze, kategoria }) {
  const pln = wiersze.filter((w) => czyPLN({ waluta: w.waluta }));
  const obce = wiersze.filter((w) => !czyPLN({ waluta: w.waluta }));

  // ⚠️ ZALOZENIE DO POTWIERDZENIA POMIAREM (Zadanie 0, ktore ma dopisac §1.5 do
  // docs/superpowers/specs/2026-08-12-oms-koszty-ksef-design.md — na dzien pisania tego
  // kodu pomiar jeszcze sie nie odbyl). Zakladamy, ze KSeF podaje kwoty faktury korygujacej
  // JUZ ROZNICOWO, ze znakiem — korekta na minus po prostu wchodzi do sumy ponizej (i do
  // sumy kategorii) i ja pomniejsza, bez dodatkowego odejmowania po `rodzaj === 'Kor'`.
  // JESLI POMIAR POKAZE KWOTY PELNE (dodatnie): to WLASNIE TE DWIE PETLE (ponizej, przy
  // liczeniu `suma` i przy `nettoGr` w petli `pozycje`) trzeba zmienic — dopisac tam
  // odejmowanie dla wierszy z `w.rodzaj === 'Kor'` zamiast prostego dodawania. Nic innego
  // w tym pliku tej zmiany nie dotyczy.
  const sumaGr = pln.reduce((a, w) => ({
    netto: a.netto + grosze(w.netto, `netto (${w.ksef_number})`),
    vat: a.vat + grosze(w.vat, `vat (${w.ksef_number})`),
    brutto: a.brutto + grosze(w.brutto, `brutto (${w.ksef_number})`),
  }), { netto: 0, vat: 0, brutto: 0 });

  const wKategoriach = new Map();
  let nieprzypisaneIle = 0;
  let nieprzypisaneNettoGr = 0;

  const pozycje = pln.map((w) => {
    const k = kategoriaWiersza(w, kategoria);
    const nettoGr = grosze(w.netto, `netto (${w.ksef_number})`);
    if (!k) {
      nieprzypisaneIle += 1;
      nieprzypisaneNettoGr += nettoGr;
      return { ...w, kategoria: null, typ: null };
    }
    const stan = wKategoriach.get(k.kategoria) ?? { kategoria: k.kategoria, typ: k.typ, nettoGr: 0 };
    stan.nettoGr += nettoGr;
    wKategoriach.set(k.kategoria, stan);
    return { ...w, kategoria: k.kategoria, typ: k.typ };
  });

  // ⚠️ MIANOWNIK TO SUMA SKATEGORYZOWANA, nie suma miesiaca. Liczenie udzialu wzgledem
  // calosci przy nieprzypisanych dawaloby kolumne, ktora nie sumuje sie do 100% — a czlowiek
  // czytajacy taki wykres uzna to za wlasny blad w dodawaniu, nie za brak kategorii.
  const podstawaGr = [...wKategoriach.values()].reduce((a, k) => a + k.nettoGr, 0);
  const kategorie = [...wKategoriach.values()]
    .sort((a, b) => b.nettoGr - a.nettoGr)
    .map((k) => ({
      kategoria: k.kategoria,
      typ: k.typ,
      netto: zl(k.nettoGr),
      udzial: podstawaGr ? Math.round((k.nettoGr / podstawaGr) * 10000) / 100 : 0,
    }));

  return {
    pozycje,
    suma: { netto: zl(sumaGr.netto), vat: zl(sumaGr.vat), brutto: zl(sumaGr.brutto) },
    kategorie,
    nieprzypisane: { ile: nieprzypisaneIle, netto: zl(nieprzypisaneNettoGr) },
    // ⚠️ Z KLUCZEM I ZRODLEM, a nie samym numerem dokumentu (2026-08-13). Koszt wpisany
    // recznie jest po uproszczeniu formularza ZAWSZE w PLN (jedna kwota w zlotowkach —
    // domain/koszt-reczny.js), wiec tutaj trafic juz nie moze. Klucz zostaje dla wierszy
    // wpisanych PRZED tym uproszczeniem: bez niego ekran nie mialby czym zaadresowac
    // poprawki, a to jedyne miejsce, w ktorym dokument walutowy w ogole widac.
    obcaWaluta: obce.map((w) => ({
      klucz: w.ksef_number,
      zrodlo: w.zrodlo,
      numerDokumentu: w.numer_dokumentu,
      waluta: w.waluta,
      netto: zl(grosze(w.netto, `netto (${w.ksef_number})`)),
    })),
  };
}
