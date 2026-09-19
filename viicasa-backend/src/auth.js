import { one } from './db.js';
import { bearer, fail, hash, id, passwordHash, passwordMatches, token, audit } from './lib.js';
import { object, email, str } from './schemas.js';

export function guards(db) {
  return {
    guest: async request => {
      const guest = await one(db,'SELECT id FROM guests WHERE token_hash=$1 AND expires_at>now()',[bearer(request)]);
      if (!guest) fail(401,'La sesión de visitante expiró');
      request.guest = guest;
    },
    admin: (roles = ['admin','catalog','support','viewer']) => async request => {
      const user = await one(db,`SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[bearer(request)]);
      if (!user) fail(401,'Sesión administrativa inválida');
      if (!roles.includes(user.role)) fail(403,'No tienes permiso para esta operación');
      request.user = user;
    },
  };
}
export async function registerAuth(app, db, config, guard) {
  const dummyHash = await passwordHash(token());
  app.post('/v1/guest-sessions',{ schema: { tags: ['Sesiones'], summary: 'Crear sesión de visitante; conservar token en cliente' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },async (_,reply) => {
    const secret = token();
    const guest = await one(db,`INSERT INTO guests(id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING id,expires_at`,[id(),hash(secret)]);
    reply.code(201); return { ...guest, token: secret };
  });
  app.post('/v1/auth/login',{ schema: { tags: ['Acceso'], summary: 'Iniciar sesión administrativa', body: object({ email, password: str(128,1) }) },
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },async request => {
    const user = await one(db,'SELECT * FROM users WHERE email=$1',[request.body.email.toLowerCase()]);
    const matches = await passwordMatches(request.body.password,user?.password_hash || dummyHash);
    if (!user || !matches || !user.active) fail(401,'Credenciales incorrectas');
    const secret = token();
    await db.transaction(async tx => {
      await tx.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3*interval \'1 hour\'))',[hash(secret),user.id,config.sessionHours]);
      await audit(tx,user.id,'auth.login',user.id);
    });
    return { token: secret, expires_in: config.sessionHours*3600, user: { id:user.id,name:user.name,email:user.email,role:user.role } };
  });
  app.get('/v1/auth/me',{ preHandler: guard.admin(), schema:{ tags:['Acceso'],security:[{ bearerAuth:[] }] } },async request => request.user);
  app.post('/v1/auth/logout',{ preHandler: guard.admin(), schema:{ tags:['Acceso'],security:[{ bearerAuth:[] }] } },async (request,reply) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1',[bearer(request)]); reply.code(204).send();
  });
  app.post('/v1/auth/password',{ preHandler: guard.admin(), schema:{ tags:['Acceso'],security:[{ bearerAuth:[] }],
    body:object({ current_password:str(128),new_password:str(128,12) }) } },async (request,reply) => {
    const user = await one(db,'SELECT password_hash FROM users WHERE id=$1',[request.user.id]);
    if (!await passwordMatches(request.body.current_password,user.password_hash)) fail(401,'Contraseña actual incorrecta');
    const encoded = await passwordHash(request.body.new_password);
    await db.transaction(async tx => {
      await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[request.user.id,encoded]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1',[request.user.id]);
      await audit(tx,request.user.id,'auth.password_changed',request.user.id);
    });
    reply.code(204).send();
  });
}
