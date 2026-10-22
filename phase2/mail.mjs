import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
import {brandedMail} from '../viicasa-backend/src/platform-mail.js';
import {renderedAttachments} from './service-pdf.mjs';

export async function queueCommercialMail(tx,dedupe,recipient,mail){
  const id=randomUUID();const result=await tx.query('INSERT INTO commercial_mail(id,dedupe,recipient,subject,body,html,attachments,delivery_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dedupe) DO NOTHING RETURNING id',[id,dedupe,recipient.toLowerCase(),mail.subject,mail.body,mail.html,JSON.stringify(mail.attachments||[]),mail.delivery_scope||'standard']);return result.rows[0]?.id||(await tx.query('SELECT id FROM commercial_mail WHERE dedupe=$1',[dedupe])).rows[0].id;
}
export const serviceMail=({subject,title,paragraphs,details=[],actionUrl,actionLabel='Open my VII account'})=>brandedMail({subject:'[PHASE 2 DEMO] '+subject,title,kicker:'VII · VIILIFE',paragraphs,details,actionUrl,actionLabel,testNote:'Phase 2 review environment. Service dates, agreements and payments are for demonstration.'});

export async function deliverCommercialMail(db,config,transport){
  if(config.mailMode!=='smtp')return{mode:'outbox',sent:0,failed:0};
  const mailer=transport||nodemailer.createTransport({...config.smtp,connectionTimeout:10000,socketTimeout:20000});let sent=0,failed=0;
  try{
    const candidates=(await db.query("SELECT id FROM commercial_mail WHERE delivery_scope='standard' AND status IN ('pending','processing') AND next_attempt<=now() ORDER BY next_attempt LIMIT 25")).rows;
    for(const candidate of candidates){
      const message=await db.transaction(async tx=>{
        const m=(await tx.query('SELECT * FROM commercial_mail WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
        if(!m||m.delivery_scope!=='standard'||!['pending','processing'].includes(m.status)||new Date(m.next_attempt)>new Date())return null;
        if(m.dedupe.startsWith('stay:')&&config.stayMailEnabled!==true||m.dedupe.startsWith('channel-order:')&&config.channelMailEnabled!==true)return null;
        if(m.attempts>=10){await tx.query("UPDATE commercial_mail SET status='failed' WHERE id=$1",[m.id]);return null;}
        const lease=randomUUID();await tx.query("UPDATE commercial_mail SET status='processing',attempts=attempts+1,next_attempt=now()+interval '2 minutes',lease_token=$2 WHERE id=$1",[m.id,lease]);return{...m,lease,attempts:m.attempts+1};
      });if(!message)continue;
      let ok=false;try{await mailer.sendMail({from:config.mailFrom,to:message.recipient,subject:message.subject,text:message.body,html:message.html,attachments:await renderedAttachments(message.attachments),messageId:`<phase2-${message.id}@viicasa.mail>`});ok=true;}catch{}
      await db.query("UPDATE commercial_mail SET status=$3,sent_at=CASE WHEN $3='sent' THEN now() ELSE NULL END,last_error=$4,lease_token=NULL,next_attempt=now()+($5*interval '1 minute') WHERE id=$1 AND lease_token=$2",[message.id,message.lease,ok?'sent':message.attempts>=10?'failed':'pending',ok?null:'SMTP delivery failed',Math.min(60,2**message.attempts)]);
      if(ok)sent++;else failed++;
    }
  }finally{if(!transport)mailer.close?.();}return{mode:'smtp',sent,failed};
}
