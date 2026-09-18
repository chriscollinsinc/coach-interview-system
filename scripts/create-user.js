'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const [email, name, password, role = 'consultant'] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('usage: npm run create-user -- <email> "<name>" <password> [consultant|lead|admin]');
  process.exit(1);
}
(async () => {
  const row = await db.one(
    `insert into users (email,name,password_hash,role) values ($1,$2,$3,$4)
     on conflict (email) do update set name=excluded.name, password_hash=excluded.password_hash,
       role=excluded.role, active=true
     returning id,email,name,role`,
    [email.trim(), name, await bcrypt.hash(password, 12), role]);
  console.log('user ready:', row);
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
