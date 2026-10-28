# Handoffs between colleagues

A colleague cannot see your files or your conversation. Everything they need must be in the request. Use the facts of the
ERP and CRM, with ids, quantities and dates, not summaries from memory.

## Request to Lara-agent (procurement)

- Material or part (SKU), quantity needed, **needed-by date**, why (the shortage or failure), the current KPI.
- Constraints: budget limit, supplier preferences of the requester.
- She returns: purchase order ids, quantities, supplier, arrival dates, cost, and the KPI after.

## Request to Cora-agent (production planning)

- Which orders are concerned (ids), what changed (machine back on a date, new supply on a date), what must not change
  (tier-A orders, existing priorities).
- She returns: which orders moved or were reprioritised, the new expected completion and delivery dates from the ERP, and the
  orders that are still late.

## Request to Horst-agent (sales)

- The orders for which a promise cannot be kept, with the **expected delivery dates as the ERP shows them**.
- He returns: which customers were told what, and which delivery dates were recorded in the CRM.

## Request to Max-agent (production)

- Factory, date range, the capacity shortfall in sofas per day or in total sofas, and the budget limit.
- He returns: the capacity measures booked (overtime, temporary workers), their cost, and the capacity per day afterwards.

## Request to Tom-agent (warehouse)

- Lot ids and the inspection or surveyor note; what is to be written off or released, and who confirmed it.
- He returns: quantities written off and released, the incident report number, the usable stock per SKU afterwards.
