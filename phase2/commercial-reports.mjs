import {fail} from '../viicasa-backend/src/lib.js';
import {audit} from './api.mjs';

const zone='America/Vancouver';
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
export function reportFilters(query,user){
  if(!date(query.from)||!date(query.to)||query.to<query.from||(Date.parse(query.to)-Date.parse(query.from))/86400000>365)fail(400,'Choose a valid inclusive date range of at most 366 days.');
  const seller=query.seller_id||null;
  if(seller&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(seller))fail(400,'Invalid team member.');
  if(user.role!=='admin'&&seller&&seller!==user.id)fail(403,'You may only view your own report.');
  return{from:query.from,to:query.to,seller_id:user.role==='admin'?seller:user.id,timezone:zone,currency:'CAD'};
}
export function csvCell(value){const text=String(value??'');return '"'+(/^[\s\u0000-\u001f]*[=+@-]/.test(text)?"'"+text:text).replaceAll('"','""')+'"';}
const numeric=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
  if(!key.endsWith('_minor')&&!key.endsWith('_count'))return[key,value];
  const number=Number(value);if(!Number.isSafeInteger(number))fail(409,'Report totals exceed the supported integer range.');return[key,number];
}));
export async function commercialReport(db,filters){
  const args=[filters.from,filters.to,filters.seller_id];
  // Dates are inclusive Vancouver calendar days. Aggregations happen separately
  // so joins cannot multiply sales or leads. Current assignment/status is explicit.
  return db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const rows=(await tx.query(`WITH lead_totals AS (
      SELECT owner_id,count(*)::integer AS lead_count,count(*) FILTER(WHERE stage='won')::integer AS won_count,
      count(*) FILTER(WHERE stage NOT IN ('won','lost'))::integer AS open_count
      FROM crm_leads WHERE created_at>=($1::date::timestamp AT TIME ZONE 'America/Vancouver')
      AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Vancouver') GROUP BY owner_id
    ), sale_totals AS (
      SELECT seller_id,count(*)::integer AS sale_count,
      coalesce(sum(amount_minor) FILTER(WHERE status='paid'),0)::bigint AS paid_minor,
      coalesce(sum(amount_minor) FILTER(WHERE status='pending'),0)::bigint AS pending_sales_minor,
      coalesce(sum(effective_commission_minor) FILTER(WHERE status='paid' AND commission_status='pending'),0)::bigint AS pending_commission_minor,
      coalesce(sum(effective_commission_minor) FILTER(WHERE status='paid' AND commission_status='approved'),0)::bigint AS approved_commission_minor,
      coalesce(sum(COALESCE(commission_paid_minor,commission_minor)) FILTER(WHERE status='paid' AND commission_status='paid'),0)::bigint AS paid_commission_minor
      FROM commercial_commission_balances WHERE created_at>=($1::date::timestamp AT TIME ZONE 'America/Vancouver')
      AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Vancouver') GROUP BY seller_id
    ) SELECT u.id,u.name,u.role,u.active,u.deleted,u.goal_minor,
      coalesce(l.lead_count,0)::integer AS lead_count,coalesce(l.won_count,0)::integer AS won_count,coalesce(l.open_count,0)::integer AS open_count,
      coalesce(v.sale_count,0)::integer AS sale_count,coalesce(v.paid_minor,0)::bigint AS paid_minor,
      coalesce(v.pending_sales_minor,0)::bigint AS pending_sales_minor,coalesce(v.pending_commission_minor,0)::bigint AS pending_commission_minor,
      coalesce(v.approved_commission_minor,0)::bigint AS approved_commission_minor,coalesce(v.paid_commission_minor,0)::bigint AS paid_commission_minor
      FROM team_users u LEFT JOIN lead_totals l ON l.owner_id=u.id LEFT JOIN sale_totals v ON v.seller_id=u.id
      WHERE ($3::uuid IS NULL OR u.id=$3::uuid) AND (NOT u.deleted OR l.lead_count>0 OR v.sale_count>0) ORDER BY u.name,u.id`,args)).rows.map(numeric).map(row=>({...row,conversion_percent:row.lead_count?Math.round(row.won_count/row.lead_count*10000)/100:0,goal_percent:row.goal_minor?Math.round(row.paid_minor/row.goal_minor*10000)/100:null}));
    const totals={lead_count:0,won_count:0,open_count:0,sale_count:0,paid_minor:0,pending_sales_minor:0,pending_commission_minor:0,approved_commission_minor:0,paid_commission_minor:0};
    for(const row of rows)for(const key of Object.keys(totals)){totals[key]+=row[key];if(!Number.isSafeInteger(totals[key]))fail(409,'Report totals exceed the supported integer range.');}
    totals.conversion_percent=totals.lead_count?Math.round(totals.won_count/totals.lead_count*10000)/100:0;
    const monthly=(await tx.query(`SELECT to_char(created_at AT TIME ZONE 'America/Vancouver','YYYY-MM') AS month,
      count(*)::integer AS sale_count,coalesce(sum(amount_minor) FILTER(WHERE status='paid'),0)::bigint AS paid_minor
      FROM commercial_sales WHERE created_at>=($1::date::timestamp AT TIME ZONE 'America/Vancouver')
      AND created_at<(($2::date+1)::timestamp AT TIME ZONE 'America/Vancouver') AND ($3::uuid IS NULL OR seller_id=$3::uuid)
      GROUP BY month ORDER BY month`,args)).rows.map(numeric);
    return{filters,totals,items:rows,monthly,definitions:{sales:'Operations created in the selected period, using their current payment status; historical sale amounts are not reduced by refunds. Not a payment-date or accounting report.',leads:'Prospects created in the selected period, grouped by current owner and current stage.',commissions:'Pending/approved balances include supervised reductions. Paid commissions preserve the recorded payout amount (legacy records use original commission). Recovery balances are separate in Commission review. Cancelled and unpaid sales are excluded.',goals:'Current configured personal target. No monthly or period-specific target is inferred.'}};
  });
}
export function registerCommercialReports(app,{db,userGuard}){
  const query={type:'object',additionalProperties:false,required:['from','to'],properties:{from:{type:'string',maxLength:10},to:{type:'string',maxLength:10},seller_id:{type:'string',format:'uuid'}}};
  app.get('/api/commercial/reports',{preHandler:userGuard,schema:{querystring:query}},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return commercialReport(db,reportFilters(r.query,r.teamUser));});
  app.get('/api/commercial/reports/export',{preHandler:userGuard,schema:{querystring:query}},async(r,reply)=>{
    const report=await commercialReport(db,reportFilters(r.query,r.teamUser));
    const headers=['Name','Role','From','To','Currency','Prospects','Won','Open','Operations','Paid sales','Pending sales','Pending commission','Approved commission','Paid commission','Current personal goal','Conversion %'];
    const rows=report.items.map(x=>[x.name,x.role,report.filters.from,report.filters.to,'CAD',x.lead_count,x.won_count,x.open_count,x.sale_count,...['paid_minor','pending_sales_minor','pending_commission_minor','approved_commission_minor','paid_commission_minor','goal_minor'].map(k=>(x[k]/100).toFixed(2)),x.conversion_percent]);
    await audit(db,r.teamUser.id,'report.export','commercial',{...report.filters,row_count:rows.length});
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="viicasa-commercial-${report.filters.from}-${report.filters.to}.csv"`).type('text/csv; charset=utf-8').send('\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n'));
  });
}
