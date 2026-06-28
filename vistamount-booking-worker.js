// vistamount-booking worker — handles /phone-click (lead logging + Discord alert),
// plus legacy /availability and /book endpoints (the live site uses the separate
// vistamount-worker for those; these are kept for parity).
//
// Deploy:  wrangler deploy vistamount-booking-worker.js --name vistamount-booking --compatibility-date 2025-06-01

var DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1496069371330691264/YQ2hNEj5ocWl7PTJKqXlbB86aSNrJmJiumf69IUXWcPtyFqGn_OhpRbn9IHVCQL2BbPq";
var CALENDAR_ID = "vistamountphx@gmail.com";
var HCP_CALENDAR_ID = "cfcaa5473d6cf99844bc45da0e79fa2e3745b6e207b1316e9188fbc2b19ebc78@group.calendar.google.com";
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function getAccessToken(env) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  return data.access_token;
}

async function createCalendarEvent(env, eventData) {
  const accessToken = await getAccessToken(env);
  const confirmationNumber = eventData.confirmationNumber || "VM-XXXX";
  const line = "\u2501".repeat(34);
  const event = {
    summary: `VistaMount Appointment - ${eventData.name}`,
    description: `APPOINTMENT CONFIRMATION
Confirmation #: ${confirmationNumber}

${line}

CUSTOMER INFORMATION
Name: ${eventData.name}
Phone: ${eventData.phone}
Email: ${eventData.email}
Address: ${eventData.address}

${line}

SERVICE DETAILS
${eventData.summary || "TV mounting service"}

${eventData.notes ? "ADDITIONAL NOTES\n" + eventData.notes : ""}

${line}

Questions? Call (480) 903-4769`,
    start: { dateTime: eventData.slotStart, timeZone: "America/Phoenix" },
    end: { dateTime: eventData.slotEnd, timeZone: "America/Phoenix" },
    location: eventData.address
  };
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(event)
  });
  return response.json();
}

async function getAvailability(date, duration, env) {
  const accessToken = await getAccessToken(env);
  const start = new Date(`${date}T07:00:00-07:00`);
  const end = new Date(`${date}T19:00:00-07:00`);
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: CALENDAR_ID }, { id: HCP_CALENDAR_ID }] })
  });
  const data = await res.json();
  const busy = Object.values(data.calendars || {}).flatMap((cal) => cal.busy || []);
  const BUFFER = 60 * 60 * 1e3;
  const slotTimes = [
    { label: "Morning", start: "08:00", display: "8:00 AM" },
    { label: "Late Morning", start: "10:00", display: "10:00 AM" },
    { label: "Afternoon", start: "12:00", display: "12:00 PM" },
    { label: "Mid Afternoon", start: "14:00", display: "2:00 PM" },
    { label: "Late Afternoon", start: "16:00", display: "4:00 PM" }
  ];
  return slotTimes.map((slot) => {
    const slotStart = new Date(`${date}T${slot.start}:00-07:00`);
    const slotEnd = new Date(slotStart.getTime() + duration * 6e4);
    const conflict = busy.some((b) => {
      const bs = new Date(new Date(b.start).getTime() - BUFFER);
      const be = new Date(new Date(b.end).getTime() + BUFFER);
      return slotStart < be && slotEnd > bs;
    });
    if (!conflict && slotEnd <= end) return { label: slot.label, time: slot.display, start: slotStart.toISOString(), end: slotEnd.toISOString() };
    return null;
  }).filter(Boolean);
}

async function sendDiscordNotification(booking) {
  const { name, phone, email, address, summary, slotStart, slotEnd, confirmationNumber } = booking;
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Phoenix" });
  const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Phoenix" });
  const endStr = end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Phoenix" });
  return fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "\u{1F514} **NEW BOOKING**",
      embeds: [{
        color: 2981864,
        fields: [
          { name: "\u{1F464} Customer", value: name, inline: true },
          { name: "\u{1F4F1} Phone", value: phone, inline: true },
          { name: "\u{1F4E7} Email", value: email || "N/A", inline: true },
          { name: "\u{1F4CD} Address", value: address, inline: false },
          { name: "\u{1F4C5} Date", value: dateStr, inline: true },
          { name: "\u23F0 Time", value: `${timeStr} \u2013 ${endStr}`, inline: true },
          { name: "\u{1F527} Job Details", value: summary || "N/A", inline: false },
          { name: "\u{1F3AB} Confirmation", value: confirmationNumber || "N/A", inline: true }
        ],
        footer: { text: "VistaMount Booking System" },
        timestamp: new Date().toISOString()
      }]
    })
  });
}

async function handlePhoneClick(request, env, ctx) {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
  try {
    const body = await request.json();
    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/phone_click_events`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "apikey": env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({
        phone_number: body.phone_number || null,
        source_element: body.source_element || "unknown",
        page_url: body.page_url || null,
        page_title: body.page_title || null,
        referrer: body.referrer || null,
        gclid: body.gclid || null,
        gbraid: body.gbraid || null,
        wbraid: body.wbraid || null,
        utm_source: body.utm_source || null,
        utm_medium: body.utm_medium || null,
        utm_campaign: body.utm_campaign || null,
        utm_term: body.utm_term || null,
        utm_content: body.utm_content || null,
        attribution_captured_at: body.attribution_captured_at || null,
        user_agent: body.user_agent || null,
        ip_country: request.headers.get("cf-ipcountry") || null
      })
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error("phone-click insert failed:", insertRes.status, errText);
      return new Response(JSON.stringify({ ok: false, error: "db_insert_failed" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // ---- Discord alert on EVERY phone click (ad clicks flagged as hot leads) ----
    const fromAd = !!body.gclid;
    const ts = new Date().toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" });
    let channel;
    if (fromAd) channel = "Google Ad";
    else if (body.utm_source) channel = body.utm_source + (body.utm_medium ? " / " + body.utm_medium : "");
    else channel = "Direct / Organic";
    const fields = [
      { name: "Phone tapped", value: body.phone_number || "(call button)", inline: true },
      { name: "Time", value: ts, inline: true },
      { name: "Channel", value: channel, inline: true },
      { name: "Where", value: body.source_element || "unknown", inline: true },
      { name: "Country", value: request.headers.get("cf-ipcountry") || "-", inline: true }
    ];
    if (body.utm_campaign) fields.push({ name: "Campaign", value: body.utm_campaign, inline: true });
    if (fromAd) fields.push({ name: "GCLID", value: "`" + body.gclid.substring(0, 24) + "...`", inline: false });
    fields.push({ name: "Page", value: body.page_url || "-", inline: false });
    ctx.waitUntil(fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: fromAd ? "\u{1F4DE} **Phone click \u2014 from a Google Ad**" : "\u{1F4DE} **Phone click**",
        embeds: [{
          title: fromAd ? "Hot lead \u2014 watch your phone" : "Someone tapped your call button",
          description: fromAd
            ? "They clicked an ad, then tapped to call. They may ring any second."
            : "A visitor tapped to call (not from a paid ad).",
          color: fromAd ? 15844367 : 5793266,
          fields,
          footer: { text: "VistaMount \u2022 phone-click tracking" },
          timestamp: new Date().toISOString()
        }]
      })
    }).catch((e) => console.warn("phone-click discord failed:", e.message)));

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("phone-click error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/phone-click") return handlePhoneClick(request, env, ctx);

    if (url.pathname === "/availability" && request.method === "GET") {
      const date = url.searchParams.get("date");
      const duration = parseInt(url.searchParams.get("duration") || "120");
      if (!date) return new Response(JSON.stringify({ error: "date required" }), { status: 400, headers: CORS });
      try {
        const slots = await getAvailability(date, duration, env);
        return new Response(JSON.stringify({ slots }), { headers: { ...CORS, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === "/book" && request.method === "POST") {
      try {
        const booking = await request.json();
        const calendarEvent = await createCalendarEvent(env, booking);
        await sendDiscordNotification(booking);
        return new Response(JSON.stringify({ success: true, calendarEventId: calendarEvent.id }), { headers: { ...CORS, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === "/test-discord" && request.method === "GET") {
      try {
        await sendDiscordNotification({
          name: "Test User",
          phone: "(480) 555-1234",
          email: "test@test.com",
          address: "123 Test St Phoenix AZ 85001",
          summary: "TVs:1 TV1:55/fixed/standard/drywall",
          slotStart: "2026-04-22T08:00:00-07:00",
          slotEnd: "2026-04-22T10:00:00-07:00",
          confirmationNumber: "VM-TEST"
        });
        return new Response(JSON.stringify({ success: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // Quick way to verify phone-click alerts fire without an ad click
    if (url.pathname === "/test-phone-click" && request.method === "GET") {
      const fake = new Request("https://x/phone-click", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-ipcountry": "US" },
        body: JSON.stringify({ phone_number: "4809034769", source_element: "test", page_url: "https://vistamountaz.com/", utm_source: "test-endpoint" })
      });
      await handlePhoneClick(fake, env, ctx);
      return new Response(JSON.stringify({ success: true, note: "check Discord" }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ status: "VistaMount Booking API" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
};
