import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { createClient, OntologyError, type DueDiligenceStatement, type Supplier } from './liquid-sdk';

/*
 * Supplier due diligence (sample app, ADR-0050). A buyer records a supplier's due-diligence statement. Everything goes
 * through the generated app SDK: the app host signs the person in and forwards only this app's registered action
 * (submit_due_diligence_statement) and reads (Supplier, DueDiligenceStatement) to the enterprise core, where the
 * statement becomes an event with the person and the app as its actors.
 */

const client = createClient();

const page: CSSProperties = { fontFamily: 'system-ui, Segoe UI, sans-serif', maxWidth: 860, margin: '32px auto', padding: '0 16px', color: '#1d2733' };
const card: CSSProperties = { border: '1px solid #d7dde6', borderRadius: 10, padding: 16, marginBottom: 16, background: '#fff' };
const label: CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 4px' };
const field: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 8, fontSize: 14, border: '1px solid #b9c2cf', borderRadius: 6 };

export function App() {
  const [me, setMe] = useState<{ name: string; upn: string }>();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statements, setStatements] = useState<DueDiligenceStatement[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [statement, setStatement] = useState('');
  const [sanctions, setSanctions] = useState(false);
  const [signedBy, setSignedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const reload = async () => {
    const [s, d] = await Promise.all([client.objects.supplier.list(), client.objects.dueDiligenceStatement.list()]);
    setSuppliers(s);
    setStatements(d);
  };
  useEffect(() => {
    void client.me().then((m) => {
      setMe(m);
      setSignedBy((x) => x || m.name);
    });
    void reload().catch((e: unknown) => setMessage({ ok: false, text: String(e) }));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await client.actions.submitDueDiligenceStatement({ supplierId, statement, sanctionsChecked: sanctions, signedBy });
      setMessage({ ok: true, text: `Recorded as event ${r.seq ?? '–'}.` });
      setStatement('');
      setSanctions(false);
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof OntologyError ? `${err.status}: ${err.message}` : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const name = (id: string) => suppliers.find((s) => s.id === id)?.name ?? id;
  return (
    <div style={page}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ fontSize: 24 }}>Supplier due diligence</h1>
        <span style={{ fontSize: 13, color: '#5b6777' }}>
          {me ? `${me.name} (${me.upn})` : '…'} · <a href="auth/logout">sign out</a>
        </span>
      </header>
      <form style={card} onSubmit={(e) => void submit(e)}>
        <h2 style={{ fontSize: 17, margin: 0 }}>New statement</h2>
        <label style={label} htmlFor="supplier">
          Supplier
        </label>
        <select id="supplier" style={field} required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Choose a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.id})
            </option>
          ))}
        </select>
        <label style={label} htmlFor="statement">
          Statement of the supplier
        </label>
        <textarea id="statement" style={{ ...field, minHeight: 90 }} required value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. No conflict minerals; ILO core labour standards met; audit report 2026 in the supplier file." />
        <label style={{ ...label, fontWeight: 400 }}>
          <input type="checkbox" checked={sanctions} onChange={(e) => setSanctions(e.target.checked)} /> Screened against the sanctions lists
        </label>
        <label style={label} htmlFor="signed">
          Signed by
        </label>
        <input id="signed" style={field} required value={signedBy} onChange={(e) => setSignedBy(e.target.value)} />
        <button type="submit" disabled={busy} style={{ marginTop: 16, padding: '8px 16px', fontSize: 14, borderRadius: 6, border: 0, background: '#1f5fad', color: '#fff', cursor: 'pointer' }}>
          {busy ? 'Submitting…' : 'Submit statement'}
        </button>
        {message && <p style={{ color: message.ok ? '#2e7d32' : '#c62828', fontSize: 14 }}>{message.text}</p>}
      </form>
      <div style={card}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Statements ({statements.length})</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 8 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5b6777' }}>
              <th>Id</th>
              <th>Supplier</th>
              <th>Statement</th>
              <th>Sanctions</th>
              <th>Signed by</th>
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid #e3e8ef' }}>
                <td>{s.id}</td>
                <td>{name(s.supplier)}</td>
                <td>{s.statement}</td>
                <td>{s.sanctions_checked ? 'checked' : '—'}</td>
                <td>{s.signed_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 12, color: '#5b6777' }}>
        Built on the generated app SDK of ontology {client.ontology.name}@{client.ontology.version}, registered in the app registry of Liquid Enterprise.
      </p>
    </div>
  );
}
