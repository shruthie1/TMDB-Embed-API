'use client';
import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '../../components/ui';

/**
 * Provider admin.
 *
 * The provider list changes constantly - of 24 candidates swept on
 * 2026-08-31, one was usable and several previously-working ones had died -
 * so adding or disabling one must not need a deploy.
 */
export default function ProvidersPage() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', shape: 'embed-slash', cdn: '', vantage: 'both' });
  // Per-provider test results, keyed by name. 'running' while in flight.
  const [tests, setTests] = useState({});
  // Iframe preview: which provider is open, and against which title.
  const [embed, setEmbed] = useState(null);
  const [embedId, setEmbedId] = useState('894803');
  // Some providers refuse to run sandboxed ("Sandbox Detected"). Dropping it
  // is a real concession, not a formality, so it is a per-preview choice.
  const [unsandboxed, setUnsandboxed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/providers');
      setData(await r.json());
      setError(null);
    } catch (e) { setError('Cannot reach the API.'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (method, path, body) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setError(j.error || `${r.status}`);
      else await load();
      return r.ok;
    } catch { setError('Request failed.'); return false; }
    finally { setBusy(false); }
  };

  const add = async (e) => {
    e.preventDefault();
    if (!form.name || !form.host) { setError('Name and host are required.'); return; }
    const ok = await act('POST', '/api/providers', form);
    if (ok) setForm({ name: '', host: '', shape: 'embed-slash', cdn: '', vantage: 'both' });
  };

  /** Run a real resolve against one provider and show what came back. */
  const test = async (name) => {
    setTests(t => ({ ...t, [name]: 'running' }));
    try {
      const r = await fetch(`/api/providers/${name}/test`, { method: 'POST' });
      const result = await r.json();
      setTests(t => ({ ...t, [name]: result }));
    } catch {
      setTests(t => ({ ...t, [name]: { ok: false, reason: 'request failed' } }));
    }
  };

  const testLabel = (r) => {
    if (r === 'running') return 'testing…';
    if (!r) return null;
    if (r.ok) return `working · ${(r.ms / 1000).toFixed(1)}s · ${r.bestResolution || '?'}`
      + (r.variants ? ` · ${r.variants} rungs` : '')
      + (r.audioTracks ? ` · ${r.audioTracks} audio` : '');
    return `failed at ${r.stage || '?'}${r.reason ? ' — ' + r.reason : ''}`;
  };

  /**
   * Open a provider's own player in an iframe.
   *
   * This is the only way to judge an embed: the url resolving proves nothing,
   * since what matters is whether THEIR player actually plays, what it costs
   * in ads, and whether it is bearable to sit in front of.
   */
  const openEmbed = async (name) => {
    setEmbed({ name, url: null, error: null });
    try {
      // /api/embed only ever existed on the VM resolver, which is gone.
      // Measured 2026-09-22: :8790 answers 404. Fail closed rather than
      // firing a request that cannot succeed.
      const r = { ok: false, json: async () => ({ error: 'embed lookup is not available' }) };
      const j = await r.json();
      const hit = (j.embeds ?? [])[0];
      setEmbed(hit ? { name, url: hit.url } : { name, error: 'Mark it as iframe first.' });
    } catch { setEmbed({ name, error: 'Could not reach the resolver.' }); }
  };

  const shape = data?.shapes?.find(s => s.id === form.shape);
  const preview = shape && form.host
    ? shape.movie.replace('{host}', form.host.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    : null;
  const previewTv = shape && form.host
    ? shape.tv.replace('{host}', form.host.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    : null;

  const pct = (h) => (h?.score == null ? '—' : `${Math.round(h.score * 100)}%`);

  return (
    <main className="prov">
      <h1>Providers</h1>
      <p className="prov-sub">
        Stream sources, tried in order. Health is measured from real resolves —
        a provider that stops working falls behind on its own.
      </p>

      {error && <p className="prov-err" role="alert">{error}</p>}

      <table className="prov-table">
        <thead>
          <tr><th>Provider</th><th>Status</th><th>CDN</th><th>VM</th><th>Client</th><th /></tr>
        </thead>
        <tbody>
          {(data?.providers ?? []).map(p => (
            <tr key={p.name} className={p.enabled ? '' : 'off'}>
              <td>
                <span className="prov-name">{p.name}</span>
                <span className="prov-url">{p.movieUrl}</span>
              </td>
              <td><span className={`pill pill-${p.status}`}>{p.status}</span></td>
              <td>{p.cdn || '—'}</td>
              <td className="num">{pct(p.health?.vm)}</td>
              <td className="num">{pct(p.health?.client)}</td>
              <td className="prov-actions">
                <button disabled={busy || tests[p.name] === 'running'}
                  onClick={() => test(p.name)}>Test</button>
                <button disabled={busy}
                  onClick={() => act('POST', `/api/providers/${p.name}/enabled?value=${p.enabled ? 0 : 1}`)}>
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                <button disabled={busy} className={p.iframeOk ? 'on' : ''}
                  title="Show this provider's own player in an iframe. Their player owns seeking, quality and language, and their ads come with it."
                  onClick={() => act('POST', `/api/providers/${p.name}/iframe?value=${p.iframeOk ? 0 : 1}`)}>
                  {p.iframeOk ? 'iframe on' : 'iframe'}
                </button>
                <button disabled={busy || !p.iframeOk}
                  title={p.iframeOk ? 'Open their player here' : 'Turn on iframe first'}
                  onClick={() => openEmbed(p.name)}>Preview</button>
                <button disabled={busy} className="danger"
                  onClick={() => confirm(`Remove ${p.name}?`) && act('DELETE', `/api/providers/${p.name}`)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {(data?.providers ?? []).filter(p => tests[p.name]).map(p => (
            <tr key={p.name + ':test'} className="prov-testrow">
              <td colSpan={6}>
                <span className={tests[p.name]?.ok ? 'ok' : tests[p.name] === 'running' ? '' : 'bad'}>
                  {p.name}: {testLabel(tests[p.name])}
                </span>
                {tests[p.name]?.cdn && <span className="prov-url"> {tests[p.name].cdn}</span>}
              </td>
            </tr>
          ))}
          {!data && Array.from({ length: 5 }, (_, i) => (
            <tr key={`provider-skeleton-${i}`} aria-hidden="true">
              <td><Skeleton variant="text" width="45%" /><Skeleton variant="text" width="75%" style={{ marginTop: 8 }} /></td>
              <td><Skeleton variant="text" width={62} /></td>
              <td><Skeleton variant="text" width={76} /></td>
              <td><Skeleton variant="text" width={38} /></td>
              <td><Skeleton variant="text" width={38} /></td>
              <td><Skeleton variant="text" width={190} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {!data && <section className="prov-add prov-add-skel" aria-hidden="true">
        <Skeleton variant="text" width={130} height="1.2em" />
        <div className="prov-row"><Skeleton width={240} height={38} /><Skeleton width={240} height={38} /></div>
        <Skeleton width={220} height={38} />
      </section>}

      {embed && (
        <div className="prov-preview-panel">
          <div className="prov-preview-head">
            <span><strong>{embed.name}</strong> — their player, in an iframe</span>
            <label className="prov-tmdb">tmdb
              <input value={embedId} onChange={e => setEmbedId(e.target.value.trim())}
                onBlur={() => embed.name && openEmbed(embed.name)} />
            </label>
            <button onClick={() => setEmbed(null)}>Close</button>
          </div>
          {embed.error && <p className="prov-note">{embed.error}</p>}
          {embed.url && (
            <>
              <p className="prov-note">
                Everything inside this frame belongs to {embed.name}: seeking,
                quality, audio, and any ads. Chitram cannot see or control it,
                and watch position is not recorded.
              </p>
              {/* `sandbox` omitted entirely when unsandboxed: an empty string
                  is the MOST restrictive value, not the least. */}
              <iframe key={String(unsandboxed)} className="prov-frame" src={embed.url}
                title={`${embed.name} player`}
                allow="autoplay; fullscreen; encrypted-media" referrerPolicy="no-referrer"
                {...(unsandboxed ? {} : {
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-presentation',
                })} />
              <label className="prov-sandbox">
                <input type="checkbox" checked={unsandboxed}
                  onChange={e => setUnsandboxed(e.target.checked)} />
                <span>
                  Drop the sandbox. Some players refuse to run without it —
                  mapple shows “Sandbox Detected”. Removing it lets their page
                  open popunders and navigate this tab, which is exactly what
                  our extractor blocks (popads, propeller, adsterra, exoclick).
                  Fine for a look; not something to ship on.
                </span>
              </label>
              <p className="prov-url">{embed.url}</p>
            </>
          )}
        </div>
      )}

      <form className="prov-add" onSubmit={add}>
        <h2>Add a provider</h2>
        <div className="prov-row">
          <label>Name<input value={form.name} placeholder="vidsomething"
            onChange={e => setForm(f => ({ ...f, name: e.target.value.trim() }))} /></label>
          <label>Host<input value={form.host} placeholder="vidsomething.net"
            onChange={e => setForm(f => ({ ...f, host: e.target.value.trim() }))} /></label>
        </div>

        <label className="prov-shape">URL format
          <select value={form.shape} onChange={e => setForm(f => ({ ...f, shape: e.target.value }))}>
            {(data?.shapes ?? []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        {shape && <p className="prov-note">{shape.note}</p>}

        {preview && (
          <pre className="prov-preview">{`movie  ${preview}\ntv     ${previewTv}`}</pre>
        )}

        <div className="prov-row">
          <label>CDN <span className="opt">(optional)</span>
            <input value={form.cdn} placeholder="leave blank if it varies"
              onChange={e => setForm(f => ({ ...f, cdn: e.target.value.trim() }))} /></label>
          <label>Reachable from
            <select value={form.vantage} onChange={e => setForm(f => ({ ...f, vantage: e.target.value }))}>
              <option value="both">Both</option>
              <option value="vm">Server only</option>
              <option value="client">Browser only</option>
            </select></label>
        </div>
        <p className="prov-note">
          Two providers on one CDN return the same stream, so the second is
          refused — it would cost a slot and fail alongside its twin.
        </p>
        <button type="submit" disabled={busy}>Add provider</button>
      </form>
    </main>
  );
}
