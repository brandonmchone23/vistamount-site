// VistaMount Calendar Worker — patched to relay bookings to alert.vistamountaz.com

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DISCORD_WEBHOOK = 'REPLACE_DISCORD';
const ALERT_URL = 'https://alert.vistamountaz.com/booking-alert';
const ALERT_SECRET = 'vistamount-booking-alert';

// Twilio — voice call + SMS on every booking
const TWILIO_SID   = 'REPLACE_TWILIO_SID';
const TWILIO_TOKEN = 'REPLACE_TWILIO_TOKEN';
const TWILIO_FROM  = '+18339625204';     // VistaMount Twilio number
const OWNER_PHONE  = '+14802436961';     // Brandon's cell — receives call + SMS

async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function getAvailability(date, duration, token) {
  const start = new Date(`${date}T07:00:00-07:00`);
  const end = new Date(`${date}T19:00:00-07:00`);
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: 'primary' }, { id: 'cfcaa5473d6cf99844bc45da0e79fa2e3745b6e207b1316e9188fbc2b19ebc78@group.calendar.google.com' }] }),
  });
  const data = await res.json();
  const busy = Object.values(data.calendars || {}).flatMap(cal => cal.busy || []);
  const BUFFER = 60 * 60 * 1000;
  const slotTimes = [
    { label: 'Morning', start: '08:00', display: '8:00 AM' },
    { label: 'Late Morning', start: '10:00', display: '10:00 AM' },
    { label: 'Afternoon', start: '12:00', display: '12:00 PM' },
    { label: 'Mid Afternoon', start: '14:00', display: '2:00 PM' },
    { label: 'Late Afternoon', start: '16:00', display: '4:00 PM' },
  ];
  return slotTimes.map(slot => {
    const slotStart = new Date(`${date}T${slot.start}:00-07:00`);
    const slotEnd = new Date(slotStart.getTime() + duration * 60000);
    const conflict = busy.some(b => {
      const bs = new Date(new Date(b.start).getTime() - BUFFER);
      const be = new Date(new Date(b.end).getTime() + BUFFER);
      return slotStart < be && slotEnd > bs;
    });
    if (!conflict && slotEnd <= end) return { label: slot.label, time: slot.display, start: slotStart.toISOString(), end: slotEnd.toISOString() };
    return null;
  }).filter(Boolean);
}

async function createEvent(token, booking) {
  const { slotStart, slotEnd, name, phone, email, address, summary, notes } = booking;
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: `VistaMount — ${name}`,
      description: `Customer: ${name}\nPhone: ${phone}\nEmail: ${email}\nAddress: ${address}\n\nJob Summary:\n${summary}\n\nNotes: ${notes || 'None'}`,
      start: { dateTime: slotStart, timeZone: 'America/Phoenix' },
      end: { dateTime: slotEnd, timeZone: 'America/Phoenix' },
      location: address,
    }),
  });
  return res.json();
}

async function sendDiscordNotification(booking) {
  const { name, phone, email, address, summary, slotStart, slotEnd, confirmationNumber, totalPrice, quotedPrice } = booking;
  const price = totalPrice || quotedPrice || '';
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  const dateStr = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' });
  const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Phoenix' });
  const endStr = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Phoenix' });

  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '🔔 **NEW BOOKING**',
      embeds: [{
        color: 0x2D7FE8,
        fields: [
          { name: '👤 Customer', value: name, inline: true },
          { name: '📱 Phone', value: phone, inline: true },
          { name: '📧 Email', value: email || 'N/A', inline: true },
          { name: '📍 Address', value: address, inline: false },
          { name: '📅 Date', value: dateStr, inline: true },
          { name: '⏰ Time', value: `${timeStr} – ${endStr}`, inline: true },
          { name: '🔧 Job Details', value: summary || 'N/A', inline: false },
          { name: '💰 Quoted Price', value: price ? `$${price}` : 'N/A', inline: true },
          { name: '🎫 Confirmation', value: confirmationNumber || 'N/A', inline: true },
        ],
        footer: { text: 'VistaMount Booking System' },
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  return { status: res.status, body: await res.text() };
}

// NEW: fires Hue lights + Mac voice + sirens via local relay
async function sendBookingAlert(booking) {
  const { name, address, slotStart, totalPrice, quotedPrice, summary, confirmationNumber } = booking;
  const start = slotStart ? new Date(slotStart) : null;
  const dateStr = start ? start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' }) : '';
  const timeStr = start ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Phoenix' }) : '';
  const price = totalPrice || quotedPrice || '';

  return fetch(ALERT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Alert-Secret': ALERT_SECRET,
    },
    body: JSON.stringify({
      name: name || 'Customer',
      address: address || '',
      date: dateStr,
      time: timeStr,
      quotedPrice: String(price),
      confirmationNumber: confirmationNumber || '',
    }),
  });
}

// Format booking details for voice/SMS
function bookingSummary(booking) {
  const { name, address, slotStart, totalPrice, quotedPrice } = booking;
  const start = slotStart ? new Date(slotStart) : null;
  const dateStr = start ? start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Phoenix' }) : 'unscheduled';
  const timeStr = start ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Phoenix' }) : '';
  const price = totalPrice || quotedPrice || '';
  // Strip city/state for the call, keep just the street
  const street = (address || '').split(',')[0] || address || 'address not provided';
  return { name: name || 'Customer', dateStr, timeStr, price, street, fullAddress: address || '' };
}

// Twilio Basic Auth header
function twilioAuthHeader() {
  return 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
}

// Place outbound voice call that reads booking details
async function sendTwilioCall(booking) {
  const { name, dateStr, timeStr, price, street } = bookingSummary(booking);
  const phrase = `New Vista Mount booking. Customer: ${name}. ${dateStr} at ${timeStr}. Address: ${street}.${price ? ` Quoted ${price} dollars.` : ''}`;
  const twiml = `<Response><Pause length="1"/><Say voice="Polly.Joanna">${phrase}</Say><Pause length="1"/><Say voice="Polly.Joanna">Repeating. ${phrase}</Say></Response>`;
  const body = new URLSearchParams({ To: OWNER_PHONE, From: TWILIO_FROM, Twiml: twiml });
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: { 'Authorization': twilioAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// Send SMS backup with booking details
async function sendTwilioSms(booking) {
  const { name, dateStr, timeStr, price, fullAddress } = bookingSummary(booking);
  const { phone, confirmationNumber, summary } = booking;
  const msg =
    `🔔 NEW VISTAMOUNT BOOKING\n` +
    `${name}${phone ? ` — ${phone}` : ''}\n` +
    `${dateStr} ${timeStr}\n` +
    `${fullAddress}\n` +
    (summary ? `${summary}\n` : '') +
    (price ? `Quoted: $${price}\n` : '') +
    (confirmationNumber ? `Conf: ${confirmationNumber}` : '');
  const body = new URLSearchParams({ To: OWNER_PHONE, From: TWILIO_FROM, Body: msg });
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': twilioAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (url.pathname === '/availability' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      const duration = parseInt(url.searchParams.get('duration') || '120');
      if (!date) return new Response(JSON.stringify({ error: 'date required' }), { status: 400, headers: CORS });
      try {
        const token = await getAccessToken(env);
        const slots = await getAvailability(date, duration, token);
        return new Response(JSON.stringify({ slots }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/book' && request.method === 'POST') {
      try {
        const booking = await request.json();
        const token = await getAccessToken(env);
        const event = await createEvent(token, booking);
        const discordResult = await sendDiscordNotification(booking);
        // Fire all alerts async — don't block booking response
        ctx.waitUntil(sendBookingAlert(booking).catch(e => console.warn('alert relay failed:', e.message)));
        ctx.waitUntil(sendTwilioCall(booking).catch(e => console.warn('twilio call failed:', e.message)));
        ctx.waitUntil(sendTwilioSms(booking).catch(e => console.warn('twilio sms failed:', e.message)));
        return new Response(JSON.stringify({ success: true, eventId: event.id, discord: discordResult }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/test-discord' && request.method === 'GET') {
      try {
        const result = await sendDiscordNotification({
          name: 'Test User',
          phone: '4805551234',
          email: 'test@test.com',
          address: '123 Test St Phoenix AZ',
          summary: 'TVs:1 TV1:55/fixed/standard/drywall',
          slotStart: '2026-04-22T08:00:00-07:00',
          slotEnd: '2026-04-22T10:00:00-07:00',
          confirmationNumber: 'VM-TEST',
        });
        return new Response(JSON.stringify({ result }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // NEW: test endpoint to fire only the local relay
    if (url.pathname === '/test-alert' && request.method === 'GET') {
      try {
        const r = await sendBookingAlert({
          name: 'Worker Test',
          address: '123 Test St, Phoenix AZ',
          slotStart: '2026-05-22T08:00:00-07:00',
          totalPrice: '199',
          confirmationNumber: 'VM-WORKER-TEST',
        });
        return new Response(JSON.stringify({ relayStatus: r.status }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // NEW: test Twilio voice call only
    if (url.pathname === '/test-call' && request.method === 'GET') {
      try {
        const r = await sendTwilioCall({
          name: 'Twilio Test',
          address: '123 Test St, Phoenix, AZ',
          slotStart: '2026-05-22T08:00:00-07:00',
          totalPrice: '199',
        });
        const j = await r.json();
        return new Response(JSON.stringify({ status: r.status, sid: j.sid, callStatus: j.status, error: j.message }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // NEW: test Twilio SMS only
    if (url.pathname === '/test-sms' && request.method === 'GET') {
      try {
        const r = await sendTwilioSms({
          name: 'Twilio SMS Test',
          phone: '(602) 555-0199',
          address: '123 Test St, Phoenix, AZ',
          slotStart: '2026-05-22T08:00:00-07:00',
          totalPrice: '199',
          confirmationNumber: 'VM-SMS-TEST',
        });
        const j = await r.json();
        return new Response(JSON.stringify({ status: r.status, sid: j.sid, msgStatus: j.status, error: j.message }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/debug' && request.method === 'GET') {
      const date = url.searchParams.get('date') || '2026-04-17';
      try {
        const token = await getAccessToken(env);
        const start = new Date(date+'T07:00:00-07:00');
        const end = new Date(date+'T19:00:00-07:00');
        const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: 'primary' }] }),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { headers: CORS });
      }
    }

    return new Response(JSON.stringify({ status: 'VistaMount Calendar API' }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  },
};
