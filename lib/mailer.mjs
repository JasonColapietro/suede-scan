// Outbound email for the audit gate, via Resend's HTTP API.
//
// RESEND_FROM must be a sender on a domain verified in Resend before codes
// can reach arbitrary visitor inboxes — the onboarding@resend.dev fallback
// only delivers to the Resend account owner and exists so local and staging
// runs fail loudly instead of silently.

const FROM = () => process.env.RESEND_FROM || 'Suede Audit <onboarding@resend.dev>';
const LEAD_TO = () => process.env.AUDIT_LEAD_TO || 'info@suedeai.org';

async function send(message) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`resend ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

export function sendCode(email, code, host) {
  return send({
    from: FROM(),
    to: [email],
    subject: `${code} is your Suede Audit code`,
    text: [
      `Your verification code is ${code}.`,
      '',
      `Enter it on optimize.suedeai.ai to unlock the audit report for ${host}.`,
      'The code expires in 15 minutes. If you did not request an audit, ignore this email.',
    ].join('\n'),
  });
}

export function sendLead({ email, host, url, score, grade }) {
  return send({
    from: FROM(),
    to: [LEAD_TO()],
    reply_to: email,
    subject: `Audit lead: ${host} (${email})`,
    text: [
      `${email} verified their address and ran the free audit.`,
      '',
      `Site: ${url}`,
      `Score: ${score}${grade ? ` (grade ${grade})` : ''}`,
      '',
      'Sent by the optimize.suedeai.ai email gate. This notification is the only record.',
    ].join('\n'),
  });
}
