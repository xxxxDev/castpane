// The session cookie of a request that has not been through Express (a socket's
// upgrade), read with the same parser app.js uses (cookie-parser): the first of two
// cookies with one name, decoded the same way, and a j:{…} value dropped as app.js
// drops it. Two readers that disagreed on which of two session_id cookies counts would
// let one check pass on a cookie the other never looked at.
const cookieParser = require('cookie-parser');

const parse = cookieParser();

function sessionCookie(req) {
  if (typeof req?.cookies?.session_id === 'string') return req.cookies.session_id;
  const r = { headers: { cookie: req?.headers?.cookie || '' } };
  parse(r, {}, () => {});
  const value = r.cookies?.session_id;
  return typeof value === 'string' ? value : '';
}

module.exports = { sessionCookie };
