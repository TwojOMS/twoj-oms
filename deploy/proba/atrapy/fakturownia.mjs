// PRZ-119.04b — konto Fakturowni w bazie próby, czyszczone razem z nią przy resecie.
// Kształty: pomiary F04 (dokument/201), F07 (goła tablica), F09 (paid), F11 (422), F15 (correction).
// KSeF nie był mierzony (F13): gov_status=ok jest wyłącznie symulacją piaskownicy.
import PDFDocument from 'pdfkit';
import { createFakturowniaClient } from '../../../src/oms/fakturownia/client.js';
import { wymagajTrybuProby } from './tryb.mjs';

const kwota = (liczba) => Number(liczba).toFixed(2).replace(/0$/, '');

export function createTransportAtrapyFakturowni({ db, env = process.env, token = 'demo', teraz = () => new Date(),
  log = (...t) => console.log(...t) } = {}) {
  wymagajTrybuProby(env, 'atrapa Fakturowni');
  db.exec(`CREATE TABLE IF NOT EXISTS atrapa_fakturownia_dokumenty (id INTEGER PRIMARY KEY, dane_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS atrapa_fakturownia_klienci (id INTEGER PRIMARY KEY, dane_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS atrapa_fakturownia_liczniki (seria TEXT PRIMARY KEY, ostatni INTEGER NOT NULL);`);
  const wszystkie = tabela => db.prepare(`SELECT dane_json FROM ${tabela} ORDER BY id DESC`).all().map(w => JSON.parse(w.dane_json));
  const zapisz = (tabela, dok) => db.prepare(`INSERT INTO ${tabela} (id, dane_json) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET dane_json=excluded.dane_json`).run(dok.id, JSON.stringify(dok));
  const kolejny = seria => db.prepare(`INSERT INTO atrapa_fakturownia_liczniki (seria, ostatni) VALUES (?, 1)
    ON CONFLICT(seria) DO UPDATE SET ostatni=ostatni+1 RETURNING ostatni`).get(seria).ostatni;
  const dokumenty = () => wszystkie('atrapa_fakturownia_dokumenty');
  const zapiszDokument = dok => zapisz('atrapa_fakturownia_dokumenty', dok);
  const tokenApi = String(token ?? '');
  const slad = tekst => log(`atrapa Fakturowni: ${tekst} (piaskownica — nic nie poszło do Fakturowni ani KSeF)`);
  const json = (cialo, status = 200) => Response.json(cialo, { status });
  const dzien = () => teraz().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

  return async (adres, init = {}) => {
    const url = new URL(adres);
    const headers = new Headers(init.headers);
    if (!tokenApi.trim() || tokenApi === 'zle' || headers.get('Authorization') !== `Bearer ${tokenApi}`) {
      return new Response('Musisz być zalogowany, aby mieć dostęp do strony.', { status: 401 });
    }
    const method = init.method ?? 'GET';
    const p = url.searchParams;
    if (url.pathname === '/invoices.json' && method === 'POST') {
      const { invoice } = JSON.parse(init.body);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (invoice.oid && invoice.oid_unique === 'yes' && dokumenty().some(d => d.oid === invoice.oid)) {
          db.exec('COMMIT');
          return json({ code: 'error', message: { oid: ['- zostało już zajęte'] } }, 422);
        }
        const id = kolejny('id');
        const positions = (invoice.positions ?? []).map((pozycja, i) => {
          const brutto = Number(pozycja.total_price_gross ?? Number(pozycja.price_gross ?? 0) * Number(pozycja.quantity ?? 1));
          const netto = Math.round(brutto / (1 + (Number(pozycja.tax) || 0) / 100) * 100) / 100;
          const ilosc = Math.abs(Number(pozycja.quantity || 1));
          return { ...pozycja, id: i + 1, invoice_id: id, total_price_gross: kwota(brutto), total_price_net: kwota(netto),
            total_price_tax: kwota(brutto - netto), price_net: kwota(netto / ilosc), price_tax: kwota((brutto - netto) / ilosc),
            price_gross: kwota(brutto / ilosc), tax: String(pozycja.tax ?? 23) };
        });
        const brutto = positions.reduce((s, x) => s + Number(x.total_price_gross), 0);
        const netto = positions.reduce((s, x) => s + Number(x.total_price_net), 0);
        const data = invoice.issue_date ?? dzien();
        const client_id = kolejny('klient');
        zapisz('atrapa_fakturownia_klienci', { id: client_id, name: invoice.buyer_name ?? null, tax_no: invoice.buyer_tax_no ?? null });
        const numer = kolejny(invoice.kind === 'correction' ? 'korekta' : 'faktura');
        const dok = { ...invoice, id, client_id, number: invoice.number || (invoice.kind === 'correction' ? `K${numer}` : `${numer}/${data.slice(5, 7)}/${data.slice(0, 4)}`),
          kind: invoice.kind ?? 'vat', issue_date: data, sell_date: invoice.sell_date ?? data, payment_to: invoice.payment_to ?? data,
          currency: invoice.currency ?? 'PLN', status: invoice.status ?? 'issued', positions,
          price_gross: kwota(brutto), price_net: kwota(netto), price_tax: kwota(brutto - netto),
          paid: invoice.status === 'paid' ? kwota(brutto) : kwota(invoice.paid ?? 0),
          paid_date: invoice.status === 'paid' ? (invoice.paid_date ?? dzien()) : (invoice.paid_date ?? null),
          gov_status: null, created_at: teraz().toISOString(), updated_at: teraz().toISOString() };
        zapiszDokument(dok);
        db.exec('COMMIT');
        slad(`wystawiono ${dok.kind} ${dok.number}`);
        return json(dok, 201);
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    }
    if (url.pathname === '/invoices.json' && method === 'GET') {
      let lista = dokumenty();
      if (p.has('number')) lista = lista.filter(d => d.number === p.get('number'));
      if (p.has('kind')) lista = lista.filter(d => d.kind === p.get('kind'));
      const kinds = p.getAll('kinds[]');
      if (kinds.length) lista = lista.filter(d => kinds.includes(d.kind));
      // F07: API filtruje po dacie wystawienia również przy search_date_type=sell_date.
      if (p.has('date_from')) lista = lista.filter(d => d.issue_date >= p.get('date_from'));
      if (p.has('date_to')) lista = lista.filter(d => d.issue_date <= p.get('date_to'));
      const perPage = Math.max(1, Number(p.get('per_page') || 100));
      const start = (Math.max(1, Number(p.get('page') || 1)) - 1) * perPage;
      return json(lista.slice(start, start + perPage));
    }
    if (url.pathname === '/clients.json' && method === 'GET') {
      return json(wszystkie('atrapa_fakturownia_klienci').filter(k => !p.has('tax_no') || k.tax_no === p.get('tax_no')));
    }
    const trafienie = url.pathname.match(/^\/invoices\/(\d+)(\/change_status)?\.(json|pdf)$/);
    const wiersz = trafienie && db.prepare('SELECT dane_json FROM atrapa_fakturownia_dokumenty WHERE id = ?').get(Number(trafienie[1]));
    const dok = wiersz && JSON.parse(wiersz.dane_json);
    if (!dok) return json({ error: 'Not Found' }, 404);
    if (trafienie[2] && method === 'POST' && p.get('status') === 'paid') {
      dok.status = 'paid'; dok.paid = dok.price_gross; dok.paid_date = dzien();
      dok.updated_at = teraz().toISOString();
      zapiszDokument(dok);
      slad(`oznaczono zapłatę ${dok.number}`);
      // F09: change_status oddaje opis statusu; kwotę paid czytamy dopiero z dokumentu.
      return json({ id: dok.id, status: 'paid', approval_status: null, payment_status: 'paid', color_kind: 'paid',
        colors: ['bg-green-100 sm:bg-green-50', 'text-green-800 sm:text-green-700', 'border-green-500 sm:border-green-600/20', 'text-white bg-green-500'],
        percent_paid: 100, translation: 'Opłacona', approval_translation: null });
    }
    // PRZ-119.05: data zapłaty z zamówienia (klient po change_status). PUT niezmierzony — atrapa
    // przyjmuje wyłącznie `paid_date`, reszta pól dokumentu bez zmian.
    if (!trafienie[2] && method === 'PUT' && trafienie[3] === 'json') {
      const zmiana = JSON.parse(init.body ?? '{}')?.invoice ?? {};
      if (Object.keys(zmiana).join() !== 'paid_date') return json({ code: 'error', message: 'atrapa przyjmuje tylko paid_date' }, 422);
      dok.paid_date = zmiana.paid_date;
      dok.updated_at = teraz().toISOString();
      zapiszDokument(dok);
      slad(`zapisano datę zapłaty ${dok.number}`);
      return json(dok);
    }
    if (!trafienie[2] && method === 'GET' && trafienie[3] === 'pdf') {
      const pdf = new PDFDocument({ size: 'A4', compress: false });
      const czesci = [];
      const koniec = new Promise((resolve, reject) => {
        pdf.on('data', b => czesci.push(b)); pdf.on('end', resolve); pdf.on('error', reject);
      });
      pdf.text(`ATRAPA Fakturowni - dokument demonstracyjny ${dok.number}`);
      pdf.end();
      await koniec;
      return new Response(Buffer.concat(czesci), { headers: { 'Content-Type': 'application/pdf' } });
    }
    if (!trafienie[2] && method === 'GET') {
      if (p.get('send_to_ksef') === 'yes') {
        dok.gov_status = 'ok';
        dok.gov_id = `ATRAPA-${dzien().replaceAll('-', '')}-${dok.id}`;
        zapiszDokument(dok);
        slad(`symulacja wysyłki do KSeF ${dok.number}`);
      }
      return json(dok);
    }
    return json({ error: 'Not Found' }, 404);
  };
}

export function createAtrapaFakturowni(opcje = {}) {
  const klient = createFakturowniaClient({ token: opcje.token || 'demo', domena: 'demo',
    fetchImpl: createTransportAtrapyFakturowni(opcje) });
  // Jawna lista: nowa metoda klienta wymaga obsługi w atrapie i aktualizacji kontraktu.
  return {
    sprawdzPolaczenie: klient.sprawdzPolaczenie, listaFaktur: klient.listaFaktur,
    pobierzFakture: klient.pobierzFakture, pobierzPdf: klient.pobierzPdf, iluMaNumer: klient.iluMaNumer,
    znajdzKlientowPoNip: klient.znajdzKlientowPoNip, wystaw: klient.wystaw, wystawKorekte: klient.wystawKorekte,
    oznaczZaplacona: klient.oznaczZaplacona, wyslijDokumentDoKsef: klient.wyslijDokumentDoKsef,
  };
}
