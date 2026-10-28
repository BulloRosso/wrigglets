# Customer notices

- Tell a customer only about orders whose **expected delivery date in the ERP is after the promised date**.
- A notice names the order, the new date **as the ERP shows it** and the reason in one sentence. Never promise a date that
  is still being planned.
- Record the new date in the CRM (`crm__update_delivery_date`) and send the notice (`crm__send_customer_notice`).
- Tier-A customers first, then customers with a late-delivery penalty.
- Short, polite, factual. Do not name suppliers as the culprit.
- Do not tell customers about internal measures (overtime, temporary workers, supplier changes).
