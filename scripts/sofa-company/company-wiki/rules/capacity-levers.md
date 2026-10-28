# Capacity levers

| Lever | Effect | Limits and cost |
|---|---|---|
| Overtime (`erp__request_overtime`) | +25 % output of the available staff | a factory tops out at 48 sofas a day; EUR 1,400 per factory and day |
| Temporary workers (`erp__request_temp_workers`) | 15 sofas a day each | start three workdays after the request; at most four; EUR 260 per worker and day |
| Moving an order to the other factory | the work moves, the other factory's own orders are delayed | only if the other factory has free capacity |
| New purchase order | material or part arrives later | lead time and express surcharge of the supplier |

## How to choose

- Decide by the KPI, not by machine or worker status: a factory can look normal and still be full.
- Before you move work, compare the free capacity of the other factory with its queue. Move as much as fits, not everything.
- A known absence of several days: temporary workers first, overtime only for the gap that remains. Overtime alone cannot
  replace a factory that has no workers.
- Simulate the combination before you propose it (`erp__simulate_change` accepts a list of changes).
