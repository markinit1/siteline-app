// Returns a calendar event (.ics) so the phone can add a booking-window reminder.
// Usage: /.netlify/functions/ics?start=20270409T150000Z&title=...&desc=...&url=...&uid=...
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.start || '');
  if (!m) return { statusCode: 400, body: 'Missing or invalid start time.' };

  const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const end = new Date(start.getTime() + 15 * 60000);
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = s => String(s || '').slice(0, 600)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const url = /^https:\/\//.test(q.url || '') ? q.url : '';
  const uid = String(q.uid || 'event').replace(/[^\w-]/g, '').slice(0, 80) + '@siteline';
  const title = text(q.title || 'Booking opens');

  // Lines longer than 75 bytes must be folded per the calendar spec.
  const fold = line => {
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
    }
    out.push(cur);
    return out.join('\r\n');
  };

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Siteline//Booking windows//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + stamp(new Date()),
    'DTSTART:' + stamp(start),
    'DTEND:' + stamp(end),
    'SUMMARY:' + title,
    'DESCRIPTION:' + text(q.desc),
    ...(url ? ['URL:' + url] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + title + ' tomorrow morning', 'TRIGGER:-PT12H', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + title + ' in 15 minutes', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="siteline-reminder.ics"',
      'Cache-Control': 'no-store'
    },
    body: lines.map(fold).join('\r\n') + '\r\n'
  };
};
