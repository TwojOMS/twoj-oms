// PRZ-076 — atrapa inFaktu dla piaskownicy oms-proba. Te same metody i kształty odpowiedzi co
// src/oms/infakt/client.js (pilnuje tego tests/instalacja/atrapy-kontrakt.test.js — prawdziwy klient dostaje
// przez fetchImpl surowe encje atrapy i ma oddać to samo). Nic nie wychodzi z procesu.
//
// Stan „konta inFakt” leży w tej samej bazie SQLite co demo, w dwóch tabelach atrapy (atrapa_infakt_*),
// więc `proba.ps1 reset` czyści go razem z bazą. Przy pierwszym użyciu atrapa zasiewa konto z tego,
// co generator zapisał w panelu: faktury ⨝ zamówienia (kwoty, nabywca, płatność) i korekty zwrotów.
//
// Zachowania przeniesione z komentarzy prawdziwego klienta (zmierzone na żywym API), nie wymyślone:
//   • lista oddaje surowe encje + `rodzaj` ('vat' | 'korekta'); kwoty w groszach;
//   • brak `sale_date`/`payment_date` przy wystawieniu = data wystawienia; `paid_price` zeruje `left_to_pay`;
//   • „oznacz zapłaconą” zmienia `status` i `paid_date`, a `left_to_pay` ZOSTAWIA (pułapka z 10.08.2026);
//   • korekta jest asynchroniczna: zlecenie oddaje referencję bez numeru, numer daje dopiero odczyt listy.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { daneFaktury } from '../../../src/domena/dane-faktury.js';
import { wymagajTrybuProby } from './tryb.mjs';

const FONTY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/moduly/faktury/pdf/fonty');
const DOBA = 86400000;
const dzienWarszawy = (chwila) => new Date(chwila).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const plusDni = (dzien, n) => new Date(Date.parse(`${dzien}T12:00:00Z`) + n * DOBA).toISOString().slice(0, 10);
const gr = (kwotaZl) => Math.round(Number(kwotaZl ?? 0) * 100);
const nettoZ = (brutto, stawka) => (Number.isFinite(Number(stawka)) ? Math.round(brutto / (1 + Number(stawka) / 100)) : brutto);

const SCHEMAT = `
  CREATE TABLE IF NOT EXISTS atrapa_infakt_dokumenty (
    uuid TEXT PRIMARY KEY, rodzaj TEXT NOT NULL CHECK (rodzaj IN ('vat','korekta')), dane_json TEXT NOT NULL,
    kolejnosc INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS atrapa_infakt_klienci (id INTEGER PRIMARY KEY AUTOINCREMENT, nip TEXT, dane_json TEXT NOT NULL);`;

function klientDokumentu(d, z) {
  const klient = (() => { try { return JSON.parse(z?.klient_json ?? '{}'); } catch { return {}; } })();
  return {
    client_company_name: d.firma ?? null, client_first_name: klient.first_name || null, client_last_name: klient.last_name || null,
    client_tax_code: d.nip ?? null, client_street: d.ulica ?? null, client_city: d.miasto ?? null,
    client_post_code: d.kod ?? null, client_country: d.kraj ?? 'PL',
  };
}

function sumy(services) {
  const gross = services.reduce((s, x) => s + Number(x.gross_price ?? 0), 0);
  const net = services.reduce((s, x) => s + nettoZ(Number(x.gross_price ?? 0), x.tax_symbol), 0);
  return { gross_price: gross, net_price: net, tax_price: gross - net };
}

/** @param {{ db: import('node:sqlite').DatabaseSync, teraz?: () => Date, log?: (...t: string[]) => void, env?: Record<string,string|undefined> }} o */
export function createAtrapaInfaktu({ db, teraz = () => new Date(), log = (...t) => console.log(...t), env = process.env }) {
  wymagajTrybuProby(env, 'atrapa inFaktu');
  db.exec(SCHEMAT);
  const ślad = (tekst) => log(`atrapa inFaktu: ${tekst} (piaskownica — nic nie poszło do inFaktu ani KSeF)`);

  const kolejny = () => (db.prepare('SELECT COALESCE(MAX(kolejnosc), 0) + 1 n FROM atrapa_infakt_dokumenty').get().n);
  const zapisz = (dok) => {
    db.prepare(`INSERT INTO atrapa_infakt_dokumenty (uuid, rodzaj, dane_json, kolejnosc) VALUES (?,?,?,?)
      ON CONFLICT(uuid) DO UPDATE SET dane_json = excluded.dane_json`).run(dok.uuid, dok.rodzaj, JSON.stringify(dok), dok._kolejnosc ?? kolejny());
    return dok;
  };
  const wszystkie = (rodzaj) => db.prepare('SELECT dane_json, kolejnosc FROM atrapa_infakt_dokumenty WHERE rodzaj = ? ORDER BY kolejnosc DESC')
    .all(rodzaj).map((w) => ({ ...JSON.parse(w.dane_json), _kolejnosc: w.kolejnosc }));
  const jeden = (uuid) => {
    const w = db.prepare('SELECT dane_json, kolejnosc FROM atrapa_infakt_dokumenty WHERE uuid = ?').get(String(uuid ?? ''));
    return w ? { ...JSON.parse(w.dane_json), _kolejnosc: w.kolejnosc } : null;
  };
  const surowy = ({ _kolejnosc, rodzaj, ...encja }) => encja;

  // ── zasiew z danych demo panelu ──────────────────────────────────────────────────────────────────
  let zasiane = false;
  function zasiej() {
    if (zasiane) return;
    zasiane = true;
    if (db.prepare('SELECT COUNT(*) n FROM atrapa_infakt_dokumenty').get().n > 0) return;
    // z.* NAJPIERW: zamówienie też ma kolumnę `numer` i stojąc po polach faktury nadpisałoby numer dokumentu.
    const faktury = db.prepare(`SELECT z.*, f.infakt_uuid, f.numer AS numer_faktury, f.utworzona_at AS faktura_at, f.ksef_numer
      FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE f.infakt_uuid IS NOT NULL ORDER BY f.id`).all();
    const pozycje = db.prepare('SELECT nazwa, ilosc, brutto_linii, vat FROM pozycje WHERE zamowienie_id = ? ORDER BY id');
    const wplaty = db.prepare('SELECT COALESCE(SUM(kwota), 0) suma, MAX(data) ostatnia FROM platnosci WHERE zamowienie_id = ?');
    const poNumerze = new Map();
    db.exec('BEGIN');
    try {
      for (const [i, f] of faktury.entries()) {
        // daneFaktury czyta zamówienie po odczycie (pole `klient`), nie surowy wiersz z `klient_json`.
        const d = daneFaktury({ ...f, klient: (() => { try { return JSON.parse(f.klient_json ?? '{}'); } catch { return {}; } })() });
        const dzien = dzienWarszawy(f.faktura_at);
        const services = pozycje.all(f.id).map((p) => ({ name: p.nazwa, quantity: Number(p.ilosc), gross_price: gr(p.brutto_linii),
          tax_symbol: String(p.vat ?? 23) }));
        const stawkaDostawy = services[0]?.tax_symbol ?? '23';
        if (gr(f.koszt_dostawy_brutto) > 0) services.push({ name: 'Wysyłka', quantity: 1, gross_price: gr(f.koszt_dostawy_brutto), tax_symbol: stawkaDostawy });
        const s = sumy(services);
        const w = wplaty.get(f.id);
        const zaplacona = Boolean(f.oplacone_at) || gr(w.suma) >= gr(f.kwota_brutto);
        const termin = Number(f.termin_platnosci) || 7;
        const dok = {
          uuid: f.infakt_uuid, number: f.numer_faktury, kind: 'vat', currency: 'PLN', rodzaj: 'vat', _kolejnosc: i + 1,
          invoice_date: dzien, sale_date: dzien, payment_date: plusDni(dzien, termin),
          payment_method: f.pobranie ? 'delivery' : 'transfer',
          status: zaplacona ? 'paid' : 'sent', paid_date: zaplacona ? dzienWarszawy(f.oplacone_at ?? w.ostatnia) : null,
          paid_price: zaplacona ? s.gross_price : 0, left_to_pay: zaplacona ? 0 : s.gross_price, ...s,
          ksef_number: f.ksef_numer ?? null, services, notes: 'ATRAPA piaskownicy — dokument demonstracyjny',
          ...klientDokumentu(d, f), created_at: f.faktura_at,
        };
        poNumerze.set(f.id, dok);
        zapisz(dok);
      }
      const korekty = db.prepare(`SELECT w.*, f.infakt_uuid FROM zwroty w JOIN faktury f ON f.zamowienie_id = w.zamowienie_id
        WHERE w.korekta_uuid IS NOT NULL ORDER BY w.id`).all();
      for (const [i, k] of korekty.entries()) {
        const faktura = jeden(k.infakt_uuid);
        if (!faktura) continue;
        const dzien = dzienWarszawy(k.korekta_zlecona_at ?? k.utworzony_at);
        const services = [{ name: 'Zwrot towaru (korekta)', quantity: -1, gross_price: -gr(k.kwota), tax_symbol: faktura.services?.[0]?.tax_symbol ?? '23' }];
        zapisz({ uuid: k.korekta_uuid, number: k.korekta_numer, kind: 'correction', currency: 'PLN', rodzaj: 'korekta',
          _kolejnosc: faktury.length + i + 1, invoice_date: dzien, sale_date: dzien, payment_date: dzien,
          corrected_invoice_number: faktura.number, corrected_invoice_date: faktura.invoice_date, correction_reason: 'Zwrot towaru',
          status: 'paid', left_to_pay: 0, ...sumy(services), services, payment_method: faktura.payment_method,
          client_company_name: faktura.client_company_name, client_first_name: faktura.client_first_name,
          client_last_name: faktura.client_last_name, client_tax_code: faktura.client_tax_code, ksef_number: null,
          notes: 'ATRAPA piaskownicy — dokument demonstracyjny', created_at: k.korekta_zlecona_at ?? k.utworzony_at });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); zasiane = false; throw e; }
  }

  // ── listy (ten sam filtr co zapytania ransacka w prawdziwym kliencie) ─────────────────────────────
  function lista(rodzaj, { od, do: doDaty, pole = 'invoice_date', order, filtry } = {}) {
    zasiej();
    let wiersze = wszystkie(rodzaj);
    if (od) wiersze = wiersze.filter((w) => (w[pole] ?? '') >= od);
    if (doDaty) wiersze = wiersze.filter((w) => (w[pole] ?? '') <= doDaty);
    if (filtry?.['q[left_to_pay_gt]'] !== undefined) wiersze = wiersze.filter((w) => Number(w.left_to_pay) > Number(filtry['q[left_to_pay_gt]']));
    if (order === 'payment_date asc') wiersze = wiersze.toSorted((a, b) => String(a.payment_date).localeCompare(String(b.payment_date)));
    return wiersze.map((w) => ({ ...surowy(w), rodzaj }));
  }
  const listaFaktur = async (zakres = {}) => lista('vat', zakres);
  const listaKorekt = async (zakres = {}) => lista('korekta', zakres);
  const listaNieoplaconych = async () => lista('vat', { filtry: { 'q[left_to_pay_gt]': '0' }, order: 'payment_date asc' });

  async function iluMaNumer(numer) {
    zasiej();
    return db.prepare("SELECT COUNT(*) n FROM atrapa_infakt_dokumenty WHERE json_extract(dane_json, '$.number') = ?").get(String(numer ?? '')).n;
  }

  // ── kartoteka ─────────────────────────────────────────────────────────────────────────────────────
  async function znajdzKlientaPoNip(nip) {
    if (!nip) return null;
    const wpisy = db.prepare('SELECT id FROM atrapa_infakt_klienci WHERE nip = ?').all(String(nip));
    if (wpisy.length > 1) throw bladOperatora(`W kartotece inFaktu jest ${wpisy.length} wpisów z NIP-em ${nip} — panel nie zgadnie, który jest nabywcą.`);
    return wpisy[0]?.id ?? null;
  }
  async function zalozKlienta(dane) {
    const r = db.prepare('INSERT INTO atrapa_infakt_klienci (nip, dane_json) VALUES (?, ?)').run(dane?.nip ?? null, JSON.stringify(dane ?? {}));
    return Number(r.lastInsertRowid);
  }

  // ── wystawienie ───────────────────────────────────────────────────────────────────────────────────
  function nastepnyNumer(dzien) {
    const [rok, miesiac] = dzien.split('-');
    const max = Math.max(0, ...wszystkie('vat').map((w) => Number(/^FV (\d+)\//.exec(w.number ?? '')?.[1] ?? 0)));
    return `FV ${max + 1}/${miesiac}/${rok}`;
  }

  async function wystaw(payload = {}) {
    zasiej();
    const services = Array.isArray(payload.services) ? payload.services : [];
    if (!services.length) throw bladOperatora('inFakt odrzucił fakturę (422): Faktura musi mieć co najmniej jedną pozycję', { status: 422 });
    const klient = db.prepare('SELECT dane_json FROM atrapa_infakt_klienci WHERE id = ?').get(Number(payload.client_id));
    if (!klient) throw bladOperatora('inFakt odrzucił fakturę (422): Nie znaleziono nabywcy', { status: 422 });
    const k = JSON.parse(klient.dane_json);
    const dzien = payload.invoice_date ?? dzienWarszawy(teraz());
    const numer = payload.number ?? nastepnyNumer(dzien);
    if (payload.number && await iluMaNumer(numer)) throw bladOperatora(`inFakt odrzucił fakturę (422): Numer ${numer} jest już zajęty`, { status: 422 });
    const s = sumy(services);
    const zaplacono = Math.min(Number(payload.paid_price ?? 0), s.gross_price);
    const dok = zapisz({
      uuid: randomUUID(), number: numer, kind: 'vat', currency: 'PLN', rodzaj: 'vat',
      invoice_date: dzien, sale_date: payload.sale_date ?? dzien, payment_date: payload.payment_date ?? dzien,
      payment_method: payload.payment_method ?? 'transfer', status: zaplacono >= s.gross_price ? 'paid' : 'sent',
      paid_date: zaplacono >= s.gross_price ? dzien : null, paid_price: zaplacono, left_to_pay: s.gross_price - zaplacono, ...s,
      ksef_number: null, ksef_data: null, services: structuredClone(services), notes: 'ATRAPA piaskownicy — dokument demonstracyjny',
      client_company_name: k.company_name ?? null, client_first_name: null, client_last_name: null, client_tax_code: k.nip ?? null,
      client_street: k.street ?? null, client_city: k.city ?? null, client_post_code: k.postal_code ?? null, client_country: k.country ?? 'PL',
      ...(payload.sales_kind ? { sales_kind: payload.sales_kind } : {}), created_at: teraz().toISOString(),
    });
    ślad(`wystawiono ${dok.number} na ${(s.gross_price / 100).toFixed(2)} zł`);
    return { uuid: dok.uuid, numer: dok.number, ksefStatus: dok.ksef_data ?? null };
  }

  async function wystawKorekte(payload = {}) {
    zasiej();
    const faktura = jeden(payload.corrected_invoice_uuid)
      ?? wszystkie('vat').find((w) => w.number === payload.corrected_invoice_number);
    if (!faktura) throw bladOperatora('inFakt odrzucił wystawienie korekty (404): nie ma faktury korygowanej', { status: 404 });
    const services = Array.isArray(payload.services) ? payload.services : [];
    const dzien = dzienWarszawy(teraz());
    const [rok, miesiac] = dzien.split('-');
    const n = wszystkie('korekta').length + 1;
    zapisz({ uuid: randomUUID(), number: `${n}/KOR/${miesiac}/${rok}`, kind: 'correction', currency: 'PLN', rodzaj: 'korekta',
      invoice_date: dzien, sale_date: dzien, payment_date: dzien, corrected_invoice_number: faktura.number,
      corrected_invoice_date: faktura.invoice_date, correction_reason: payload.correction_reason ?? null,
      status: 'paid', left_to_pay: 0, ...sumy(services), services: structuredClone(services), payment_method: faktura.payment_method,
      client_company_name: faktura.client_company_name, client_first_name: faktura.client_first_name,
      client_last_name: faktura.client_last_name, client_tax_code: faktura.client_tax_code, ksef_number: null,
      notes: 'ATRAPA piaskownicy — dokument demonstracyjny', created_at: teraz().toISOString() });
    ślad(`zlecono korektę faktury ${faktura.number} (numer pokaże odczyt listy, jak w inFakcie)`);
    // Jak w prawdziwym API: 201 z referencją zadania, bez uuid i numeru dokumentu.
    return { referencja: `atrapa-${randomUUID()}`, uuid: null, numer: null };
  }

  // ── PDF ───────────────────────────────────────────────────────────────────────────────────────────
  function pdfDokumentu(dok, typ) {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${dok.number} (atrapa)` } });
    doc.registerFont('zwykly', path.join(FONTY, 'DejaVuSans.ttf'));
    doc.registerFont('gruby', path.join(FONTY, 'DejaVuSans-Bold.ttf'));
    const czesci = [];
    doc.on('data', (c) => czesci.push(c));
    const koniec = new Promise((ok) => doc.on('end', ok));
    const zl = (g) => `${(Number(g) / 100).toFixed(2).replace('.', ',')} zł`;
    doc.font('gruby').fontSize(10).fillColor('#B42318')
      .text('ATRAPA PIASKOWNICY — dokument demonstracyjny, nie istnieje w inFakcie ani w KSeF', { align: 'center' });
    doc.moveDown().fillColor('#111').fontSize(16).text(`${dok.rodzaj === 'korekta' ? 'Faktura korygująca' : 'Faktura VAT'} ${dok.number}`);
    doc.font('zwykly').fontSize(9).fillColor('#555').text(`${typ === 'copy' ? 'kopia' : typ === 'duplicate' ? 'duplikat' : 'oryginał'}`);
    doc.moveDown().fillColor('#111').fontSize(10)
      .text(`Data wystawienia: ${dok.invoice_date}    Data sprzedaży: ${dok.sale_date}    Termin płatności: ${dok.payment_date}`);
    if (dok.corrected_invoice_number) doc.text(`Do faktury: ${dok.corrected_invoice_number} z ${dok.corrected_invoice_date}`);
    doc.moveDown().font('gruby').text('Nabywca');
    doc.font('zwykly').text([dok.client_company_name, [dok.client_first_name, dok.client_last_name].filter(Boolean).join(' ')]
      .filter(Boolean).join(' — ') || '—');
    if (dok.client_tax_code) doc.text(`NIP: ${dok.client_tax_code}`);
    if (dok.client_street) doc.text(`${dok.client_street}, ${dok.client_post_code ?? ''} ${dok.client_city ?? ''}`);
    doc.moveDown().font('gruby').text('Pozycje');
    doc.font('zwykly');
    for (const s of dok.services ?? []) doc.text(`${s.name} — ${s.quantity} szt. — ${zl(s.gross_price)} brutto (VAT ${s.tax_symbol})`);
    doc.moveDown().font('gruby')
      .text(`Razem: ${zl(dok.gross_price)} brutto (netto ${zl(dok.net_price)}, VAT ${zl(dok.tax_price)})`);
    doc.font('zwykly').text(`Pozostało do zapłaty: ${zl(dok.left_to_pay ?? 0)}`);
    if (dok.ksef_number) doc.text(`Numer KSeF (atrapa): ${dok.ksef_number}`);
    doc.end();
    return koniec.then(() => Buffer.concat(czesci));
  }
  async function pobierzPdfRodzaju(rodzaj, uuid, typ = 'original') {
    if (!uuid) throw bladOperatora('Ten dokument nie ma numeru w inFakcie.');
    zasiej();
    const dok = jeden(uuid);
    if (!dok || dok.rodzaj !== rodzaj) {
      throw bladOperatora('inFakt odrzucił pobranie PDF (404): Zasób którego szukasz nie został znaleziony', { status: 404 });
    }
    if (!['original', 'copy', 'duplicate'].includes(typ)) throw bladOperatora(`inFakt odrzucił pobranie PDF (422): ${typ}`, { status: 422 });
    return pdfDokumentu(dok, typ);
  }
  const pobierzPdf = (uuid, typ) => pobierzPdfRodzaju('vat', uuid, typ);
  const pobierzPdfKorekty = (uuid, typ = 'original') => pobierzPdfRodzaju('korekta', uuid, typ);

  // ── statusy ───────────────────────────────────────────────────────────────────────────────────────
  async function oznaczZaplacona(uuid, { paidDate } = {}) {
    if (!uuid) throw bladOperatora('Ta faktura nie ma numeru dokumentu w inFakcie.');
    zasiej();
    const dok = jeden(uuid);
    if (!dok || dok.rodzaj !== 'vat') throw bladOperatora('inFakt odrzucił oznaczenie faktury jako zapłaconej (404)', { status: 404 });
    // ⚠️ Jak w inFakcie: status i data, `left_to_pay` bez zmian (domena czekaNaPrzelew rozstrzyga po statusie).
    zapisz({ ...dok, status: 'paid', paid_date: paidDate ?? dzienWarszawy(teraz()) });
    ślad(`oznaczono ${dok.number} jako zapłaconą`);
    return { referencja: `atrapa-${randomUUID()}` };
  }

  async function pobierzFakture(uuid) {
    if (!uuid) throw bladOperatora('Ta faktura nie ma numeru dokumentu w inFakcie.');
    zasiej();
    const dok = jeden(uuid);
    if (!dok || dok.rodzaj !== 'vat') throw bladOperatora('inFakt odrzucił odczyt faktury (404): Zasób którego szukasz nie został znaleziony', { status: 404 });
    return { numer: dok.number ?? null, ksefNumer: dok.ksef_number || null, number: dok.number ?? null, invoice_date: dok.invoice_date ?? null,
      uuid: dok.uuid ?? uuid, services: dok.services ?? [], status: dok.status ?? null, left_to_pay: dok.left_to_pay ?? null };
  }

  async function wyslijDokumentDoKsef(uuid) {
    const czysty = String(uuid ?? '').trim();
    if (!czysty) throw bladOperatora('Nie ma czego wysłać do KSeF — pusty identyfikator dokumentu.', { status: 400 });
    zasiej();
    const dok = jeden(czysty);
    if (!dok) throw bladOperatora('inFakt odrzucił wysyłkę do KSeF (404): Zasób którego szukasz nie został znaleziony', { status: 404 });
    const numerKsef = `9991234563-${dok.invoice_date.replaceAll('-', '')}-ATRAPA${String(dok._kolejnosc).padStart(6, '0')}`;
    zapisz({ ...dok, ksef_number: numerKsef });
    ślad(`„wysłano” ${dok.number} do KSeF`);
    return { odpowiedzInfaktu: { atrapa: true, uuid: dok.uuid, request_created_at: teraz().toISOString() } };
  }

  /** Surowa encja (jak w odpowiedzi API) — dla testu kontraktu, który karmi nią prawdziwego klienta. */
  function surowaEncja(uuid) { zasiej(); const d = jeden(uuid); return d ? surowy(d) : null; }

  return {
    znajdzKlientaPoNip, zalozKlienta, wystaw, oznaczZaplacona, pobierzPdf, pobierzFakture,
    listaFaktur, listaKorekt, listaNieoplaconych, pobierzPdfKorekty, wyslijDokumentDoKsef,
    wystawKorekte, iluMaNumer, surowaEncja, atrapa: true,
  };
}

/** Atrapa VIES (src/oms/services/vies.js): numery demo z pulą 999 są „ważne”, reszta „nieważna”. */
export function createAtrapaVies({ env = process.env } = {}) {
  wymagajTrybuProby(env, 'atrapa VIES');
  return {
    async sprawdz(nip) {
      const m = /^([A-Z]{2})(999\d+)$/.exec(String(nip ?? '').replace(/\s/g, '').toUpperCase());
      if (!m) return { wynik: 'niewazny', nazwa: null, adres: null, dataZapytania: null, numerKonsultacji: null };
      return { wynik: 'wazny', nazwa: 'Kontrahent demonstracyjny (atrapa VIES)', adres: 'Musterstraße 1 (demo)',
        dataZapytania: new Date().toISOString().slice(0, 10), numerKonsultacji: `ATRAPA-${m[2]}` };
    },
    atrapa: true,
  };
}
