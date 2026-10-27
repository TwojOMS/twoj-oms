// PRZ-120 — jedyny test, który przepuszcza list przez PRAWDZIWY nodemailer. Wszystkie inne wstrzykują
// `transportFactory` (także atrapa poczty piaskownicy i demo), więc podbicie nodemailera nie ruszało żadnego testu.
// Serwer SMTP to atrapa na 127.0.0.1 w tym procesie — nic nie wychodzi na zewnątrz.
import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { createMailer } from '../../../src/core/poczta/smtp.js';

/** Najmniejszy serwer SMTP: AUTH PLAIN przyjęty, koperta i treść zapisane do `listy`. */
async function atrapaSerwera() {
  const listy = [];
  const serwer = net.createServer((gniazdo) => {
    let bufor = '';
    let dane = null;
    let koperta = { from: null, to: [], auth: false };
    const pisz = (t) => gniazdo.write(`${t}\r\n`);
    pisz('220 atrapa.invalid ESMTP');
    gniazdo.on('data', (kawalek) => {
      bufor += kawalek.toString('utf8');
      for (;;) {
        if (dane !== null) {
          const koniec = bufor.indexOf('\r\n.\r\n');
          if (koniec < 0) return;
          dane += bufor.slice(0, koniec);
          bufor = bufor.slice(koniec + 5);
          listy.push({ ...koperta, tresc: dane });
          dane = null;
          koperta = { from: null, to: [], auth: koperta.auth };
          pisz('250 2.0.0 przyjete');
          continue;
        }
        const nl = bufor.indexOf('\r\n');
        if (nl < 0) return;
        const linia = bufor.slice(0, nl);
        bufor = bufor.slice(nl + 2);
        const komenda = linia.toUpperCase();
        if (komenda.startsWith('EHLO')) { pisz('250-atrapa.invalid'); pisz('250-AUTH PLAIN LOGIN'); pisz('250 8BITMIME'); }
        else if (komenda.startsWith('AUTH PLAIN')) { koperta.auth = true; pisz('235 2.7.0 ok'); }
        else if (komenda.startsWith('MAIL FROM:')) { koperta.from = linia.slice(10).trim(); pisz('250 ok'); }
        else if (komenda.startsWith('RCPT TO:')) { koperta.to.push(linia.slice(8).trim()); pisz('250 ok'); }
        else if (komenda === 'DATA') { dane = ''; pisz('354 dalej'); }
        else if (komenda === 'QUIT') { pisz('221 pa'); gniazdo.end(); return; }
        else pisz('250 ok');
      }
    });
    gniazdo.on('error', () => {});
  });
  await new Promise((r) => serwer.listen(0, '127.0.0.1', r));
  return { listy, port: serwer.address().port, zamknij: () => new Promise((r) => serwer.close(r)) };
}

let zamknij = null;
afterEach(async () => { await zamknij?.(); zamknij = null; });

async function mailerNaAtrapie() {
  const s = await atrapaSerwera();
  zamknij = s.zamknij;
  const mailer = createMailer({
    smtp: { host: '127.0.0.1', port: s.port, user: 'sklep', pass: 'haslo-testowe' },
    mailFrom: 'Pracownia Półcień <sklep@przyklad.invalid>',
  });
  return { mailer, listy: s.listy };
}

describe('PRZ-120: prawdziwy nodemailer na atrapie serwera SMTP', () => {
  it('list z DW, polskim tematem, załącznikiem i wątkiem dojeżdża w całości', async () => {
    const { mailer, listy } = await mailerNaAtrapie();
    const wynik = await mailer.sendMail({
      to: 'Józef Łęcki <jozef@przyklad.invalid>',
      cc: ['ksiegowa@przyklad.invalid', 'magazyn@przyklad.invalid'],
      subject: 'Zamówienie 1042 — lampa „Żuraw” wysłana',
      text: 'Dzień dobry, paczka już jedzie.',
      html: '<p>Dzień dobry, paczka już jedzie.</p>',
      attachments: [{ filename: 'faktura-1042.pdf', content: Buffer.from('%PDF-1.4 atrapa'), contentType: 'application/pdf' }],
      inReplyTo: '<poprzedni-1042@przyklad.invalid>',
      references: ['<poprzedni-1042@przyklad.invalid>'],
    });
    expect(wynik.accepted).toEqual(['jozef@przyklad.invalid', 'ksiegowa@przyklad.invalid', 'magazyn@przyklad.invalid']);
    expect(listy).toHaveLength(1);
    const [list] = listy;
    expect(list.auth).toBe(true);
    expect(list.from).toBe('<sklep@przyklad.invalid>');
    expect(list.to).toEqual(['<jozef@przyklad.invalid>', '<ksiegowa@przyklad.invalid>', '<magazyn@przyklad.invalid>']);
    expect(list.tresc).toMatch(/^Cc: ksiegowa@przyklad\.invalid, magazyn@przyklad\.invalid\r$/m);
    expect(list.tresc).toMatch(/^In-Reply-To: <poprzedni-1042@przyklad\.invalid>\r$/m);
    expect(list.tresc).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(list.tresc).toContain('filename=faktura-1042.pdf');
    expect(list.tresc).toContain('Content-Type: text/html');
  });

  // Na nodemailer 10.1.2 oba poniższe listy szły do obcy@zly.invalid zamiast do jan@ (sprawdzone na VM 210, 26.10).
  it('średnik w cudzysłowie wewnątrz grupy nie robi z nazwy odbiorcy (GHSA-m943-m63m-w62w)', async () => {
    const { mailer, listy } = await mailerNaAtrapie();
    await mailer.sendMail({ to: 'Grupa: "Kowalski; obcy@zly.invalid" <jan@przyklad.invalid>;', subject: 's', text: 't' });
    expect(listy[0].to).toEqual(['<jan@przyklad.invalid>']);
  });

  it('zagnieżdżony komentarz nie wypuszcza adresu z komentarza (GHSA-8c8m-p3m8-cjg8)', async () => {
    const { mailer, listy } = await mailerNaAtrapie();
    await mailer.sendMail({ to: 'jan@przyklad.invalid (Jan (biuro) obcy@zly.invalid)', subject: 's', text: 't' });
    expect(listy[0].to).toEqual(['<jan@przyklad.invalid>']);
  });
});
