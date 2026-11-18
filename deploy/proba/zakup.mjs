// PRZ-160.E4.16 — symulator zakupu w piaskownicy. Kupujący „kupuje” kartę w kanale: atrapa kanału zdejmuje sztuki,
// a zamówienie trafia do bazy OMS tą samą funkcją, którą zapisuje poller (zapiszZamowienie). Anulowanie i opłata
// działają na zamówieniach z symulatora. Zwroty sztuk jak w kanale: Woo oddaje, ERLI nie, Allegro według
// ATRAPA_ALLEGRO_ODDAJE. Woo „pending” niczego nie zdejmuje w sklepie (W3) — dopiero `oplac`.
// Tylko OMS_TRYB=proba; nic stąd nie łączy się z prawdziwym kanałem. Poza obrazem demo (leży obok atrapy/).
//
//   node deploy/proba/zakup.mjs kup --kanal <klucz> --karta <id> --ilosc <n> [--status pending|processing]
//   node deploy/proba/zakup.mjs anuluj --zamowienie <id>
//   node deploy/proba/zakup.mjs oplac --zamowienie <id>
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { wymagajTrybuProby } from './atrapy/tryb.mjs';
import { createAtrapaWoo } from './atrapy/kanaly.mjs';
import { createSerwerOfertAllegro } from './atrapy/allegro-oferty.mjs';
import { createAtrapaErli } from './atrapy/erli.mjs';
import { KANALY } from '../../scripts/demo-dane-firma.mjs';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { kartaPoId, produktyKarty } from '../../src/oms/db/magazyn.js';
import { otworzBaze } from '../../src/core/baza.ts';

const ZNACZNIK = 'symulator-zakupu-E4.16';
const STATUS_ZAKUPU = { woo: 'processing', allegro: 'READY_FOR_PROCESSING', erli: 'purchased' };
const STATUS_ANULOWANIA = { woo: 'cancelled', allegro: 'CANCELLED', erli: 'cancelled' };

export function createZakup({ db, env = process.env, log = (...t) => console.log(...t), teraz = () => new Date() }) {
  wymagajTrybuProby(env, 'symulator zakupu');
  const cicho = () => {};

  function typKanalu(kanal) {
    const demo = KANALY.find((k) => k.klucz === kanal);
    if (demo) return demo.typ;
    if (db.prepare('SELECT 1 FROM konfiguracja_integracji WHERE integracja = ?').get(`erli:${kanal}`)) return 'erli';
    throw new Error(`Symulator zakupu: nieznany kanał „${kanal}”.`);
  }
  function atrapa(typ, kanal) {
    if (typ === 'woo') return createAtrapaWoo({ db, kanal, env, log: cicho });
    if (typ === 'allegro') return createSerwerOfertAllegro({ db, kanal, env, teraz });
    return createAtrapaErli({ db, kanal, env, log: cicho, teraz });
  }
  // Oferta karty w kanale: lustro kanału (Woo, Allegro), potem oferty wystawione z OMS (ERLI, Allegro).
  function cel(typ, kanal, kartaId) {
    const lustro = produktyKarty(db, kartaId).find((p) => p.kanal === kanal && !p.zniknal_at);
    if (lustro && typ === 'woo') {
      const wariant = lustro.wariant_id ? String(lustro.wariant_id) : null;
      return {
        id: wariant ?? String(lustro.produkt_id),
        pozycja: { produkt_id: String(lustro.produkt_id), oferta_id: null, wariant_id: wariant },
      };
    }
    if (lustro)
      return {
        id: String(lustro.produkt_id),
        pozycja: { produkt_id: null, oferta_id: String(lustro.produkt_id), wariant_id: null },
      };
    const oferta =
      typ === 'woo'
        ? null
        : db
            .prepare(
              `SELECT id_zewnetrzne FROM oferty_kanalow WHERE karta_id = ? AND kanal = ?
      ORDER BY id LIMIT 1`,
            )
            .get(kartaId, kanal);
    if (oferta)
      return {
        id: String(oferta.id_zewnetrzne),
        pozycja: { produkt_id: null, oferta_id: String(oferta.id_zewnetrzne), wariant_id: null },
      };
    throw new Error(`Symulator zakupu: karta ${kartaId} nie ma oferty w kanale „${kanal}”.`);
  }
  function zSymulatora(zamowienieId) {
    const w = db.prepare('SELECT sklep, anulowane, surowe_json FROM zamowienia WHERE id = ?').get(Number(zamowienieId));
    if (!w) throw new Error(`Symulator zakupu: nie ma zamówienia ${zamowienieId}.`);
    let surowe = null;
    try {
      surowe = JSON.parse(w.surowe_json);
    } catch {
      /* odmowa niżej */
    }
    if (surowe?.zrodlo !== ZNACZNIK)
      throw new Error(`Symulator zakupu: zamówienie ${zamowienieId} nie pochodzi z symulatora.`);
    return { sklep: w.sklep, anulowane: Number(w.anulowane) === 1, surowe };
  }

  async function kup({ kanal, karta, ilosc, status }) {
    const n = Number(ilosc);
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new Error('Symulator zakupu: ilość musi być dodatnią liczbą całkowitą.');
    const typ = typKanalu(kanal);
    const naStatus = status ?? STATUS_ZAKUPU[typ];
    if (naStatus !== STATUS_ZAKUPU[typ] && !(typ === 'woo' && naStatus === 'pending'))
      throw new Error('Symulator zakupu: status pending|processing dotyczy tylko Woo.');
    const kartaId = Number(karta);
    const k = kartaPoId(db, kartaId);
    if (!k) throw new Error(`Symulator zakupu: nie ma karty ${karta}.`);
    const c = cel(typ, kanal, kartaId);
    const a = atrapa(typ, kanal);
    // W3: Woo „pending” nie zdejmuje stanu w sklepie (OMS liczy go od razu).
    if (naStatus !== 'pending') await a.kup(c.id, n);
    const at = teraz().toISOString();
    const cenaGr = Number(k.cena_gr ?? 0);
    const kod = randomUUID().slice(0, 8);
    const model = {
      zrodlo_id: `sym-${kod}`,
      numer: `SYM-${kod.toUpperCase()}`,
      klient: {
        first_name: 'Kupujący',
        last_name: 'Testowy',
        email: 'kupujacy.testowy@polcien.example',
        phone: '',
        address_1: 'Ulica Przykładowa 5',
        postcode: '00-001',
        city: 'Warszawa',
        country: 'PL',
      },
      dostawa: {
        first_name: 'Kupujący',
        last_name: 'Testowy',
        address_1: 'Ulica Przykładowa 5',
        postcode: '00-001',
        city: 'Warszawa',
        country: 'PL',
      },
      metoda_wysylki: 'kurier',
      pobranie: false,
      kwota_pobrania: null,
      chce_fakture: 0,
      nip: null,
      kwota_brutto: (cenaGr * n) / 100,
      status_woo: naStatus,
      oplacone_at: naStatus === 'pending' ? null : at,
      anulowane: 0,
      utworzone_at: at,
      kupony: [],
      atrybucja: null,
      pozycje: [
        {
          zrodlo_id: '1',
          nazwa: k.nazwa,
          sku: k.sku ?? null,
          ilosc: n,
          cena_brutto: cenaGr / 100,
          brutto_linii: (cenaGr * n) / 100,
          vat: 23,
          ...c.pozycja,
        },
      ],
    };
    const surowe = { zrodlo: ZNACZNIK, typ, cel: c.id, model };
    const zamowienieId = zapiszZamowienie(db, kanal, model, surowe);
    log(`symulator zakupu: ${kanal} karta ${kartaId} × ${n} → zamówienie ${zamowienieId} (${naStatus})`);
    return { zamowienieId, numer: model.numer, status: naStatus };
  }

  async function anuluj({ zamowienie }) {
    const z = zSymulatora(zamowienie);
    if (z.anulowane) throw new Error(`Symulator zakupu: zamówienie ${zamowienie} jest już anulowane.`);
    const { typ, cel: id, model } = z.surowe;
    const n = model.pozycje[0].ilosc;
    // Woo oddaje tylko to, co zdjął (nie „pending”); ERLI nie oddaje; Allegro według ATRAPA_ALLEGRO_ODDAJE.
    if (!(typ === 'woo' && model.status_woo === 'pending')) await atrapa(typ, z.sklep).oddaj(id, n);
    const nowy = { ...model, anulowane: 1, status_woo: STATUS_ANULOWANIA[typ] };
    zapiszZamowienie(db, z.sklep, nowy, { ...z.surowe, model: nowy });
    log(`symulator zakupu: zamówienie ${zamowienie} anulowane`);
    return { zamowienieId: Number(zamowienie) };
  }

  async function oplac({ zamowienie }) {
    const z = zSymulatora(zamowienie);
    const { typ, cel: id, model } = z.surowe;
    if (z.anulowane || typ !== 'woo' || model.status_woo !== 'pending')
      throw new Error(`Symulator zakupu: opłacić można tylko nieanulowane zamówienie Woo w stanie pending.`);
    await atrapa(typ, z.sklep).kup(id, model.pozycje[0].ilosc);
    const nowy = { ...model, status_woo: 'processing', oplacone_at: teraz().toISOString() };
    zapiszZamowienie(db, z.sklep, nowy, { ...z.surowe, model: nowy });
    log(`symulator zakupu: zamówienie ${zamowienie} opłacone`);
    return { zamowienieId: Number(zamowienie) };
  }

  return { kup, anuluj, oplac };
}

function argumenty(lista) {
  const wynik = {};
  for (let i = 0; i < lista.length; i += 2) {
    if (!lista[i].startsWith('--') || lista[i + 1] === undefined)
      throw new Error(`Symulator zakupu: niepoprawny argument „${lista[i]}”.`);
    wynik[lista[i].slice(2)] = lista[i + 1];
  }
  return wynik;
}

/** CLI: odmowa poza próbą przed otwarciem bazy; baza z OMS_DB_PATH (musi istnieć — panel ją zakłada). */
export async function main(argv, env = process.env) {
  wymagajTrybuProby(env, 'symulator zakupu (CLI)');
  const [komenda, ...reszta] = argv;
  if (!['kup', 'anuluj', 'oplac'].includes(komenda))
    throw new Error(
      'Użycie: zakup.mjs kup --kanal <klucz> --karta <id> --ilosc <n> [--status pending|processing] | anuluj --zamowienie <id> | oplac --zamowienie <id>',
    );
  const a = argumenty(reszta);
  const sciezka = env.OMS_DB_PATH;
  if (!sciezka || !fs.existsSync(sciezka)) throw new Error('Symulator zakupu: brak bazy piaskownicy (OMS_DB_PATH).');
  const db = otworzBaze(sciezka);
  try {
    const zakup = createZakup({ db, env });
    if (komenda === 'kup') return await zakup.kup({ kanal: a.kanal, karta: a.karta, ilosc: a.ilosc, status: a.status });
    return await zakup[komenda]({ zamowienie: a.zamowienie });
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (w) => console.log(JSON.stringify(w)),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
