import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api, currentUser, type Preset } from "./api.ts";
import { Nav } from "./Nav.tsx";
import { BYOK_KEY, numberWord, PROVIDER_ORDER, perThousand, providerName } from "./names.ts";
import { navigate } from "./router.ts";
import { SignIn } from "./SignIn.tsx";

interface Upload {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly documentId?: string;
  readonly pageCount?: number;
  readonly error?: string;
}

const section: CSSProperties = { borderTop: "1px solid var(--line)", display: "flex", gap: 80, padding: "48px 120px" };
const aside: CSSProperties = { display: "flex", flexDirection: "column", flexShrink: 0, gap: 8, width: 280 };
const h2: CSSProperties = { fontSize: 20, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: "24px" };
const note: CSSProperties = { color: "var(--muted)", fontSize: 14, lineHeight: "22px" };

const Check = ({ on, onClick }: { readonly on: boolean; readonly onClick: () => void }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onClick}
    style={{
      alignItems: "center",
      background: on ? "var(--accent)" : "#fff",
      border: on ? 0 : "1px solid #c9c9c9",
      borderRadius: 3,
      display: "flex",
      flexShrink: 0,
      height: 16,
      justifyContent: "center",
      width: 16,
    }}
  >
    {on && (
      <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
        <path d="M1 4l2.5 2.5L9 1" fill="none" stroke="#fff" strokeWidth="1.6" />
      </svg>
    )}
  </button>
);

const Tick = ({ children }: { readonly children: string }) => (
  <div style={{ alignItems: "center", display: "flex", gap: 8, fontSize: 14, lineHeight: "18px" }}>
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
    </svg>
    {children}
  </div>
);

const priceRange = (presets: ReadonlyArray<Preset>) => {
  const prices = [...new Set(presets.map((p) => perThousand(p.listPriceUsdPerPage)))];
  return prices.length === 1 ? prices[0] : `${prices.at(-1)}–${prices[0]}`.replace("–$", "–");
};

const ProviderRow = (props: {
  readonly provider: string;
  readonly presets: ReadonlyArray<Preset>;
  readonly selected: ReadonlySet<string>;
  readonly toggle: (id: string) => void;
  readonly apiKey: string | undefined;
  readonly setKey: (value: string) => void;
}) => {
  const { provider, presets, selected, toggle, apiKey, setKey } = props;
  const chosen = presets.filter((p) => selected.has(p.id));
  const byok = !presets.some((p) => p.hosted);
  const [open, setOpen] = useState(false);
  const on = chosen.length > 0;
  const needsKey = byok && on;
  const first = presets[0];
  if (first === undefined) return null;
  const label = presets.length > 1 && on ? `${chosen.length} of ${presets.length} modes` : (chosen[0] ?? first).mode;
  return (
    <div style={{ borderBottom: "1px solid var(--rule)", display: "flex", flexDirection: "column", gap: 12, padding: "16px 0" }}>
      <div style={{ alignItems: "center", display: "flex", gap: 16 }}>
        <Check
          on={on}
          onClick={() => {
            for (const p of on ? chosen : [first]) toggle(p.id);
          }}
        />
        <div style={{ flexShrink: 0, fontSize: 15, lineHeight: "18px", width: 240 }}>{providerName(provider)}</div>
        <div style={{ display: "flex", flexGrow: 1 }}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              alignItems: "center",
              border: `1px solid ${open ? "var(--ink)" : "var(--line)"}`,
              borderRadius: 4,
              color: open ? "var(--ink)" : "var(--muted)",
              display: "flex",
              fontSize: 14,
              gap: 8,
              height: 30,
              padding: "0 10px",
            }}
          >
            {label}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d={open ? "M2 6l3-3 3 3" : "M2 4l3 3 3-3"} fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
        <div
          style={{
            color: on || !byok ? "var(--muted)" : "var(--ink)",
            flexShrink: 0,
            fontSize: 14,
            textAlign: "right",
            width: 120,
          }}
        >
          {byok && !on ? (
            <button type="button" onClick={() => toggle(first.id)}>
              Add key
            </button>
          ) : (
            `${priceRange(on ? chosen : presets)} / 1k pp`
          )}
        </div>
      </div>
      {open && (
        <div style={{ alignItems: "center", display: "flex", gap: 8, paddingLeft: 24 }}>
          {presets.map((p) => {
            const active = selected.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                style={{
                  alignItems: "center",
                  border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
                  borderRadius: 999,
                  display: "flex",
                  fontSize: 12,
                  gap: 6,
                  height: 24,
                  padding: "0 9px",
                }}
              >
                {active && (
                  <svg width="9" height="7" viewBox="0 0 10 8" aria-hidden="true">
                    <path d="M1 4l2.5 2.5L9 1" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
                  </svg>
                )}
                {p.mode}
                <span style={{ color: "var(--muted)" }}>{perThousand(p.listPriceUsdPerPage)}</span>
              </button>
            );
          })}
          {presets.length > 1 && (
            <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 8 }}>Each mode is scored as its own entry.</span>
          )}
        </div>
      )}
      {needsKey && (
        <div style={{ alignItems: "center", display: "flex", gap: 40, paddingLeft: 24 }}>
          <input
            type="password"
            placeholder={`${providerName(provider)} API key`}
            value={apiKey ?? ""}
            onChange={(e) => setKey(e.target.value)}
            style={{
              border: "1px solid var(--accent)",
              borderRadius: 3,
              flexGrow: 1,
              fontSize: 14,
              height: 36,
              padding: "0 12px",
            }}
          />
          <span style={{ color: "var(--accent)", fontSize: 12, width: 72, textAlign: "right" }}>{apiKey ? "Key added" : ""}</span>
        </div>
      )}
    </div>
  );
};

export const Landing = () => {
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<ReadonlyArray<Upload>>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<ReadonlyArray<File> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.presets().then(
      (all) => {
        setPresets(all);
        setSelected(new Set(all.filter((p) => p.default).map((p) => p.id)));
      },
      (e: unknown) => setError(String(e)),
    );
  }, []);

  const groups = useMemo(() => {
    const byProvider = new Map<string, Preset[]>();
    for (const p of presets) byProvider.set(p.provider, [...(byProvider.get(p.provider) ?? []), p]);
    const entries = [...byProvider.entries()].sort(([a], [b]) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
    return {
      included: entries.filter(([, ps]) => ps.some((p) => p.hosted)),
      byok: entries.filter(([, ps]) => !ps.some((p) => p.hosted)),
    };
  }, [presets]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const upload = (files: ReadonlyArray<File>) => {
    for (const file of files) {
      const format = (file.name.split(".").pop() ?? "").toUpperCase();
      const id = crypto.randomUUID();
      setUploads((u) => [...u, { id, name: file.name, format }]);
      api.upload(file).then(
        (r) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...r } : x))),
        (e: unknown) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: String(e) } : x))),
      );
    }
  };

  const add = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    if (currentUser() === null) setPending(list);
    else upload(list);
  };

  const ready = uploads.filter((u) => u.documentId !== undefined);
  const pages = ready.reduce((n, u) => n + (u.pageCount ?? 0), 0);
  const chosen = presets.filter((p) => selected.has(p.id));
  const missingKey = chosen.some((p) => !p.hosted && !keys[p.provider]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const credentials = Object.fromEntries(
        [...new Set(chosen.filter((p) => !p.hosted).map((p) => p.provider))].map((provider) => [
          provider,
          { [BYOK_KEY[provider] ?? "API_KEY"]: keys[provider] ?? "" },
        ]),
      );
      const { shareId } = await api.createRun({
        documentIds: ready.flatMap((u) => (u.documentId ? [u.documentId] : [])),
        presetIds: chosen.map((p) => p.id),
        credentials,
      });
      navigate(`/r/${shareId}`);
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  };

  return (
    <div>
      <Nav />
      {pending && (
        <SignIn
          onDone={() => {
            upload(pending);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
      <section style={{ display: "flex", flexDirection: "column", gap: 20, padding: "112px 120px 72px" }}>
        <h1 style={{ fontSize: 64, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: "70px", margin: 0, maxWidth: 900 }}>
          Compare document parsers on your own documents.
        </h1>
        <p style={{ color: "var(--muted)", fontSize: 17, lineHeight: "27px", margin: 0, maxWidth: 620 }}>
          Every page is rendered to the same image and sent to each provider. A blind judge scores the outputs. The method and
          code are open source.
        </p>
        <div style={{ alignItems: "center", display: "flex", gap: 28, paddingTop: 20 }}>
          <Tick>Blind judging, provider names hidden</Tick>
          <Tick>Judge prompt and scoring code are public</Tick>
          <Tick>Every run is reproducible on your own hardware</Tick>
          <a className="u" style={{ fontSize: 14 }} href="https://github.com/reductoai/parsejudge/blob/main/docs/DESIGN.md">
            Read the methodology
          </a>
        </div>
      </section>

      <section style={section}>
        <div style={aside}>
          <div style={h2}>Documents</div>
          <div style={note}>PDF, DOCX or PPTX. Up to 50 pages per run.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              add(e.dataTransfer.files);
            }}
            style={{
              alignItems: "center",
              border: "1px dashed #c9c9c9",
              borderRadius: 4,
              display: "flex",
              fontSize: 15,
              gap: 10,
              height: 120,
              justifyContent: "center",
            }}
          >
            Drop files here <span style={{ color: "var(--muted)" }}>or browse</span>
          </button>
          <input ref={fileInput} type="file" multiple hidden accept=".pdf,.docx,.pptx" onChange={(e) => add(e.target.files)} />
          <div style={{ display: "flex", flexDirection: "column", paddingTop: 12 }}>
            {uploads.map((u) => (
              <div key={u.id} className="row" style={{ padding: "16px 0", fontSize: 14 }}>
                <div style={{ flexGrow: 1, fontSize: 15 }}>{u.name}</div>
                <div style={{ color: "var(--muted)", width: 100 }}>{u.format}</div>
                <div style={{ color: u.error ? "var(--bad)" : "var(--muted)", textAlign: "right", width: 100 }}>
                  {u.error ? "Failed" : u.pageCount === undefined ? "Reading…" : `${u.pageCount} pages`}
                </div>
                <button
                  type="button"
                  onClick={() => setUploads(uploads.filter((x) => x.id !== u.id))}
                  style={{ color: "var(--faint)", textAlign: "right", width: 80 }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={section}>
        <div style={aside}>
          <div style={h2}>Providers</div>
          <div style={note}>
            {numberWord(groups.included.length)} run free. The rest use your own API key, which is encrypted and deleted when the
            run ends. Pick one or more modes per provider to compare them.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div className="eyebrow" style={{ paddingBottom: 8 }}>
            Included
          </div>
          {groups.included.map(([provider, ps]) => (
            <ProviderRow
              key={provider}
              provider={provider}
              presets={ps}
              selected={selected}
              toggle={toggle}
              apiKey={keys[provider]}
              setKey={() => {}}
            />
          ))}
          <div className="eyebrow" style={{ padding: "36px 0 8px" }}>
            Bring your own key
          </div>
          {groups.byok.map(([provider, ps]) => (
            <ProviderRow
              key={provider}
              provider={provider}
              presets={ps}
              selected={selected}
              toggle={toggle}
              apiKey={keys[provider]}
              setKey={(value) => setKeys((k) => ({ ...k, [provider]: value }))}
            />
          ))}
        </div>
      </section>

      <footer
        style={{
          alignItems: "center",
          borderTop: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          padding: "36px 120px 72px",
        }}
      >
        <div style={{ display: "flex", gap: 44 }}>
          {[
            [pages, "pages"],
            [chosen.length, "provider modes"],
            [pages * chosen.length, "parses, judged blind"],
          ].map(([value, label]) => (
            <div key={String(label)} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: "32px" }}>{value}</span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{label}</span>
            </div>
          ))}
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 16 }}>
          {error && <span style={{ color: "var(--bad)", fontSize: 13 }}>{error}</span>}
          <button
            type="button"
            className="btn primary"
            style={{ height: 44, padding: "0 18px" }}
            disabled={starting || ready.length === 0 || chosen.length === 0 || missingKey}
            onClick={start}
          >
            Start evaluation <span aria-hidden="true">→</span>
          </button>
        </div>
      </footer>
    </div>
  );
};
