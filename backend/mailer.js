const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '172.17.0.1';
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const SENDER = process.env.SMTP_SENDER || 'noreply@sambruk.se';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

// Postal (smtp.sambruk.se) — auth required, plaintext only (it rejects STARTTLS),
// so ignoreTLS forces nodemailer to stay on the cleartext channel.
const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  ignoreTLS: true,
  ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
});

// Send a magic-link sign-in e-mail. Always logs the link so sign-in still
// works for testing even if outbound delivery is blocked/slow.
async function sendMagicLink(email, link) {
  console.log(`[magic-link] for ${email}: ${link}`);
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2>Logga in på Duellen</h2>
      <p>Klicka på knappen för att logga in. Länken gäller i 30 minuter och kan bara användas en gång.</p>
      <p><a href="${link}" style="display:inline-block;background:#6366f1;color:#fff;
        text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold">Logga in</a></p>
      <p style="color:#888;font-size:13px">Om du inte begärde detta kan du ignorera mejlet.</p>
      <p style="color:#888;font-size:13px">En tjänst från <a href="https://sambruk.se">Sambruk</a>.</p>
    </div>`;
  await transport.sendMail({
    from: `"Duellen (Sambruk)" <${SENDER}>`,
    to: email,
    subject: 'Din inloggningslänk till Duellen',
    text: `Logga in på Duellen: ${link}\n\nLänken gäller i 30 minuter och kan bara användas en gång.`,
    html,
  });
}

module.exports = { sendMagicLink };
