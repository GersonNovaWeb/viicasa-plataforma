// Original invoices, prices and paid receipts are never overwritten by this ledger.
export async function invoiceFinance(db,invoice){
  const row=(await db.query(`SELECT
    COALESCE((SELECT sum(amount_minor) FROM financial_entries WHERE invoice_id=$1 AND kind='credit'),0) AS credits,
    COALESCE((SELECT sum(amount_minor) FROM financial_entries WHERE invoice_id=$1 AND kind='refund'),0) AS refunds,
    COALESCE((SELECT sum(amount_minor) FROM service_invoice_payments WHERE invoice_id=$1 AND status='paid'),0) AS paid,
    COALESCE((SELECT sum(approved_minor) FROM financial_requests WHERE invoice_id=$1 AND kind='credit' AND status='approved'),0) AS reserved_credit,
    COALESCE((SELECT sum(approved_minor) FROM financial_requests WHERE invoice_id=$1 AND kind='refund' AND status='approved'),0) AS reserved_refund`,[invoice.id])).rows[0];
  const original=Number(invoice.total_minor),credits=Number(row.credits),refunds=Number(row.refunds),paid=Number(row.paid);
  return{original_minor:original,credits_minor:credits,refunds_minor:refunds,paid_minor:paid,net_total_minor:original-credits,
    due_minor:Math.max(0,original-credits-paid),net_received_minor:paid-refunds,
    reserved_credit_minor:Number(row.reserved_credit),reserved_refund_minor:Number(row.reserved_refund)};
}
export async function invoiceWithFinance(db,invoice){
  const finance=await invoiceFinance(db,invoice);
  return{...invoice,total_minor:finance.net_total_minor,original_total_minor:finance.original_minor,finance};
}
export function financeSummary(f){
  if(!f||!f.credits_minor&&!f.refunds_minor)return[];
  return[['Original invoice',f.original_minor],['Credit notes recorded',f.credits_minor],['Adjusted invoice amount',f.net_total_minor],['Payments recorded',f.paid_minor],['Demo refunds recorded',f.refunds_minor],['Net payment position',f.net_received_minor],['Outstanding balance',f.due_minor]];
}
