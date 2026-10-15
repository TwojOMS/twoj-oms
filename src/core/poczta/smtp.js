import nodemailer from 'nodemailer';

export function createMailer({ smtp, mailFrom, transportFactory }) {
  const factory = transportFactory || (() => nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: { user: smtp.user, pass: smtp.pass },
  }));
  const transport = factory();

  // `cc` — adresy „do wiadomości". Lista albo string; PUSTĄ wartość odcinamy tutaj i nie
  // podajemy nodemailerowi w ogóle, bo nagłówek `Cc:` z pustą zawartością to nagłówek
  // uszkodzony — dokładnie ten sam powód, dla którego wysyłka nie podaje pustego In-Reply-To.
  async function sendMail({ to, cc, subject, text, html, attachments, from, inReplyTo, references }) {
    if (from && from !== mailFrom) throw new Error(`Illegal from address: ${from}`);
    const kopia = Array.isArray(cc) ? cc.filter(Boolean) : (String(cc ?? '').trim() || null);
    const doKoperty = Array.isArray(kopia) ? (kopia.length ? kopia : null) : kopia;
    try {
      return await transport.sendMail({ from: mailFrom, to, ...(doKoperty ? { cc: doKoperty } : {}), subject, text, html, attachments, inReplyTo, references });
    } catch (e) {
      const err = new Error('SMTP error'); err.code = e.code; throw err;
    }
  }
  return { sendMail };
}
