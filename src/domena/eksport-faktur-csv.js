import { BOM_EXCELA } from './eksport-csv.js';
import { zl } from './kwoty.js';
import { wKsef } from './lista-faktur.js';

// Pola tekstowe chronimy przed formułą Excela przed cytowaniem CSV.
const pole = (v, tekst = true) => {
  let s = String(v ?? '');
  if (tekst && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const kwota = (v) => v == null || v === '' ? '' : zl(Number(v)).replace('.', ',');

export const nazwaPlikuZaznaczonych = (miesiac) => `lista-faktur-${miesiac}-zaznaczone.csv`;

export function csvZaznaczonych(wiersze) {
  const linie = [['Numer', 'Data wystawienia', 'Nabywca', 'NIP', 'Netto', 'VAT', 'Brutto', 'Numer KSeF', 'Stan płatności'].join(';')];
  for (const d of wiersze) {
    const nabywca = d.client_company_name || [d.client_first_name, d.client_last_name].filter(Boolean).join(' ');
    // PRZ-126.C09d: faktura zastąpiona przy złym NIP-ie — „—” jak korekta (saldo 0, ale nie zapłacona: wpłaty są na nowej).
    const platnosc = d.rodzaj === 'korekta' || d.stanZaplaty === 'zastapiona' ? '—'
      : ({ zaplacona: 'zapłacona', do_zaplaty: 'do zapłaty', nieznany: 'nie wiadomo' }[d.stanZaplaty] ?? 'nie wiadomo');
    linie.push([pole(d.number), pole(d.invoice_date), pole(nabywca), pole(d.client_tax_code),
      pole(kwota(d.net_price), false), pole(kwota(d.tax_price), false), pole(kwota(d.gross_price ?? 0), false),
      pole(wKsef(d) ? String(d.ksef_number).trim() : ''), pole(platnosc)].join(';'));
  }
  return BOM_EXCELA + linie.join('\r\n');
}
