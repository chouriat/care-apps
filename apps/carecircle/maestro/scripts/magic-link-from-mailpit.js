// Maestro runScript (GraalJS, runs on the test machine, not on the device).
// Reads the newest sign-in email for EMAIL from the local Supabase Mailpit, calls its
// verify link without following the redirect, and returns the app callback link
// (carecircle://auth/callback?code=...) in output.callbackUrl for openLink.
var mailpit = typeof MAILPIT_URL !== 'undefined' ? MAILPIT_URL : 'http://127.0.0.1:54324';
var search = http.get(mailpit + '/api/v1/search?query=' + encodeURIComponent('to:' + EMAIL));
var found = json(search.body).messages || [];
if (found.length === 0) throw new Error('No sign-in email in Mailpit yet');
var message = json(http.get(mailpit + '/api/v1/message/' + found[0].ID).body);
var link = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(message.HTML || '');
if (!link) throw new Error('The sign-in email has no verify link');
// The redirect goes to a custom scheme, so the HTTP client stops at the 303 and we read Location.
var verify = http.get(link[1].replace(/&amp;/g, '&'));
var headers = verify.headers || {};
var location = headers.location || headers.Location;
if (Array.isArray(location)) location = location[0];
if (!location || location.indexOf('carecircle://auth/callback') !== 0) {
  throw new Error('Verify did not redirect to the app (status ' + verify.status + ')');
}
if (location.indexOf('code=') === -1) throw new Error('Callback has no PKCE code');
output.callbackUrl = location;
