// Maestro runScript: empty the local Supabase Mailpit so the flow reads only its own email.
var mailpit = typeof MAILPIT_URL !== 'undefined' ? MAILPIT_URL : 'http://127.0.0.1:54324';
http.request(mailpit + '/api/v1/messages', { method: 'DELETE' });
