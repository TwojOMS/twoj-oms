import {
  mkdirSync, writeFileSync, renameSync, statSync, unlinkSync, existsSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { sciezkaArchiwumSprzedazy } from '../../../domena/nazwa-pliku-archiwum.js';
import { odciskDokumentu, rozstrzygnij, rodzajDokumentu } from '../../../domena/archiwum-sprzedazy.js';
import { wierszArchiwum, zapiszWiersz, oznaczSkasowana } from '../db/archiwum-sprzedazy.js';
import { bladOperatora } from '../../../domena/bledy.js';

// Archiwum PDF-ow faktur sprzedazowych i korekt na NAS-ie (spec 2026-09-02, Czesc B).
// Jeden dokument na raz; petle, budzet czasu i pore nocna trzyma czuwacz
// (services/czuwacz-archiwum-sprzedazy.js). Wzorzec i uzasadnienia: services/archiwum-kosztow.js.
//
// ⚠️⚠️ ZRODLEM PRAWDY JEST inFAKT. Plik na dysku i wiersz w bazie to lustro: awaria NAS-a nie
// przerywa niczego (blad zapisu jest zjadany i logowany, wiersz NIE powstaje, wiec dokument
// wraca nastepnej nocy sam). Blad POBRANIA z inFaktu leci wyzej — czuwacz liczy bledy z rzedu.

const PREFIKS_SKASOWANEJ = 'SKASOWANA_';

const maTresc = (pelna) => {
  try { return statSync(pelna).size > 0; } catch { return false; }
};

// Zapis atomowy: caly plik do `.tmp`, potem rename — na SMB polowiczny plik po zerwaniu
// polaczenia wygladalby jak gotowy dokument (adopcja sprawdza tylko rozmiar > 0).
//
// ⚠️ Sprzatanie `.tmp` przy bledzie jest best-effort (druga usterka w czasie usuwania smiecia
// nie ma prawa zamaskowac pierwotnego bledu zapisu — dlatego wlasny try/catch, ktory nic nie
// rzuca, a oryginalny blad leci dalej do wywolujacego).
function zapiszAtomowo(pelna, bajty) {
  mkdirSync(dirname(pelna), { recursive: true });
  const tmp = `${pelna}.tmp`;
  try {
    writeFileSync(tmp, bajty);
    renameSync(tmp, pelna);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* plik .tmp mogl nie powstac wcale — nic sie nie stalo */ }
    throw e;
  }
}

export async function zarchiwizujDokument({
  db, infakt, dokument, katalogBazowy, teraz = () => new Date(), log = console.error, usun = unlinkSync,
}) {
  const rodzaj = rodzajDokumentu(dokument);
  const sciezka = sciezkaArchiwumSprzedazy({ invoiceDate: dokument.invoice_date, numer: dokument.number });
  const pelna = join(katalogBazowy, sciezka);
  const wiersz = wierszArchiwum(db, dokument.uuid);
  let decyzja = rozstrzygnij({ dokument, wiersz });
  // Dokument oznaczony jako skasowany, ktory wrocil w inFakcie z tym samym odciskiem (np. byl
  // usuniety i przywrocony recznie) — bez tej bramki zostalby na zawsze „bez zmian" ze starym
  // wpisem skasowana_at, mimo ze inFakt znowu go widzi. Traktujemy jak zmiane: sciagamy na nowo
  // na czysta sciezke, a zapiszWiersz nizej czysci skasowana_at przy okazji (ON CONFLICT).
  if (decyzja === 'bez_zmian' && wiersz?.skasowana_at) decyzja = 'zmieniony';
  if (decyzja === 'bez_zmian') return { stan: 'bez_zmian', sciezka: wiersz.sciezka_pdf };

  const wierszDoZapisu = {
    uuid: dokument.uuid, rodzaj, numer: String(dokument.number ?? ''),
    invoiceDate: String(dokument.invoice_date ?? '').slice(0, 10),
    saleDate: dokument.sale_date ? String(dokument.sale_date).slice(0, 10) : null,
    odcisk: odciskDokumentu(dokument), sciezkaPdf: sciezka, zapisanyAt: teraz().toISOString(),
  };

  // ⚠️ ADOPCJA: foldery z 1.08.2026 maja juz ~292 pliki o dokladnie tych nazwach. Nowy
  // dokument z plikiem na dysku dostaje wiersz BEZ pobierania — inaczej pierwsza noc
  // sciagalaby cale archiwum od nowa. Adoptujemy TYLKO nowe: zmieniony odcisk znaczy, ze
  // plik na dysku moze byc stara wersja, wiec go nadpisujemy.
  if (decyzja === 'nowy' && maTresc(pelna)) {
    zapiszWiersz(db, wierszDoZapisu);
    return { stan: 'adoptowany', sciezka };
  }

  const bajty = rodzaj === 'korekta'
    ? await infakt.pobierzPdfKorekty(dokument.uuid)
    : await infakt.pobierzPdf(dokument.uuid);
  if (!Buffer.isBuffer(bajty) || bajty.subarray(0, 4).toString() !== '%PDF') {
    throw bladOperatora(`inFakt oddał coś, co nie jest PDF-em dla dokumentu ${dokument.number} — nie zapisano.`);
  }

  try {
    zapiszAtomowo(pelna, bajty);
  } catch (e) {
    log(`Archiwum sprzedazy: zapis dokumentu ${dokument.number} na NAS ("${sciezka}") sie nie udal `
      + `(${e.message}) — dokument wroci przy kolejnym przebiegu. inFakt ma go nadal.`);
    return { stan: 'blad_zapisu', sciezka };
  }

  // Zmiana daty wystawienia (albo powrot skasowanej) = inna sciezka; stary plik nie ma prawa
  // zostac jako drugi egzemplarz tego samego dokumentu (papier z obu trafilby do biura).
  //
  // ⚠️⚠️ WLASNY try/catch, POZA zapisem. Nowy plik juz lezy na dysku i wiersz jest gotowy do
  // zapisu — usuniecie starego pliku jest tylko porzadkiem. Gdyby to sprzatanie dzielilo
  // try/catch z zapisem, blad usuwania (np. stary plik otwarty przez program na komputerze
  // ksiegowej przez SMB) zamienilby udany zapis w `blad_zapisu` i cofnal caly przebieg —
  // dokument probowalby sie sciagac co noc od nowa, mimo ze na dysku jest juz poprawny.
  if (wiersz && wiersz.sciezka_pdf !== sciezka && existsSync(join(katalogBazowy, wiersz.sciezka_pdf))) {
    try {
      usun(join(katalogBazowy, wiersz.sciezka_pdf));
    } catch (e) {
      log(`Archiwum sprzedazy: nie udalo sie usunac starego pliku dokumentu ${dokument.number} `
        + `("${wiersz.sciezka_pdf}") — ${e.message}. Byc moze plik jest otwarty przez SMB; `
        + 'nowy plik i wiersz sa juz zapisane poprawnie.');
    }
  }

  zapiszWiersz(db, wierszDoZapisu);
  return { stan: decyzja === 'nowy' ? 'pobrany' : 'nadpisany', sciezka };
}

// Dokument zniknal z inFaktu. NIE kasujemy pliku — papier mogl juz pojsc do biura, a slad
// „byla taka faktura" jest cenniejszy niz porzadek na dysku. Nazwa mowi, co sie stalo.
export async function oznaczSkasowanyDokument({
  db, wiersz, katalogBazowy, teraz = () => new Date(), log = console.error, przemianuj = renameSync,
}) {
  const stara = wiersz.sciezka_pdf;
  const nowa = join(dirname(stara), `${PREFIKS_SKASOWANEJ}${basename(stara)}`).replace(/\\/g, '/');
  // Do bazy trafia sciezka SKASOWANA_ tylko, gdy przemianowanie sie udalo (albo plik juz
  // wczesniej zniknal z dysku — wtedy nie ma czego przemianowac). Gdy `renameSync` rzuci
  // (plik otwarty przez program na komputerze ksiegowej przez SMB), stary plik dalej lezy
  // pod stara nazwa — wiersz musi nadal na niego wskazywac, inaczej `sciezka_pdf` w bazie
  // klamalby o pliku, ktorego pod ta nazwa nie ma.
  let sciezkaDoZapisu = stara;
  try {
    if (existsSync(join(katalogBazowy, stara))) przemianuj(join(katalogBazowy, stara), join(katalogBazowy, nowa));
    sciezkaDoZapisu = nowa;
  } catch (e) {
    log(`Archiwum sprzedazy: nie udalo sie przemianowac pliku skasowanej faktury ${wiersz.numer} `
      + `(${e.message}) — zostaje pod dotychczasowa nazwa.`);
  }
  oznaczSkasowana(db, wiersz.uuid, { at: teraz().toISOString(), sciezkaPdf: sciezkaDoZapisu });
  return { sciezka: sciezkaDoZapisu };
}
