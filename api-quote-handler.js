// Cloudflare Worker for handling quote requests
// Deploy to a new worker or add to existing vistamount-booking worker

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const data = await request.json();
      
      // Validate required fields
      if (!data.fname || !data.email || !data.phone || !data.projectType) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
      }

      // Generate a quote request ID
      const quoteId = `QR-${Date.now().toString(36).toUpperCase()}`;

      // Send to Discord
      const discordMessage = {
        embeds: [
          {
            title: `📋 New Custom Quote Request #${quoteId}`,
            color: 0xf59e0b,
            fields: [
              {
                name: 'Customer Name',
                value: `${data.fname} ${data.lname}`,
                inline: true,
              },
              {
                name: 'Email',
                value: data.email,
                inline: true,
              },
              {
                name: 'Phone',
                value: data.phone,
                inline: true,
              },
              {
                name: 'Project Type',
                value: data.projectType,
                inline: true,
              },
              {
                name: 'Service Address',
                value: data.address,
                inline: false,
              },
              {
                name: 'Project Description',
                value: data.description || '(No description provided)',
                inline: false,
              },
              {
                name: 'Timeline',
                value: data.timeline || 'Not specified',
                inline: true,
              },
              {
                name: 'Budget',
                value: data.budget || 'Not specified',
                inline: true,
              },
              {
                name: 'Contact Preferences',
                value: `${data.contactPreferences.phone ? '☎️ Phone' : ''}${data.contactPreferences.email ? ' | 📧 Email' : ''}${data.contactPreferences.sms ? ' | 💬 SMS' : ''}`,
                inline: false,
              },
            ],
            footer: {
              text: `Request ID: ${quoteId}`,
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      // Post to Discord webhook
      const discordWebhook = 'https://discord.com/api/webhooks/1496069371330691264/YQ2hNEj5ocWl7PTJKqXlbB86aSNrJmJiumf69IUXWcPtyFqGn_OhpRbn9IHVCQL2BbPq';
      
      const discordResponse = await fetch(discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordMessage),
      });

      if (!discordResponse.ok) {
        console.error('Discord webhook failed:', discordResponse.status);
        return new Response(JSON.stringify({ error: 'Discord notification failed' }), { status: 500 });
      }

      // Send Pushover notification (when you add your key)
      // TODO: Add your Pushover user key and app token here
      // const pushoverResponse = await fetch('https://api.pushover.net/1/messages.json', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      //   body: new URLSearchParams({
      //     token: 'YOUR_PUSHOVER_APP_TOKEN',
      //     user: 'YOUR_PUSHOVER_USER_KEY',
      //     title: `New Quote Request #${quoteId}`,
      //     message: `${data.fname} ${data.lname} requested a quote for ${data.projectType}. Check Discord.`,
      //     priority: 1,
      //     sound: 'siren',
      //   }).toString(),
      // });

      return new Response(
        JSON.stringify({
          success: true,
          quoteId,
          message: 'Quote request submitted successfully',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
    }
  },
};
