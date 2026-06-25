import {useCallback, useRef, useState} from "react";
import {connectEvmWallet} from "./lib/wallet.js";
import {
    connectPhantom,
    connectSolanaMetaMask,
    connectSolanaWalletConnect,
    toSolanaSigner,
} from "./lib/solanaSigner.js";
import {createPaymentFetch, readSettlement, formatUsdc} from "./lib/x402Client.js";
import logo from "./images/bejibun.png";

const RESOURCE_URL = import.meta.env.VITE_RESOURCE_SERVER_URL || "http://localhost:4021";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function shorten(value, lead = 6, tail = 4) {
    if (!value) return "";
    return value.length > lead + tail ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
}

function humanizeError(err) {
    const message = err?.message ?? String(err);
    if (/user rejected|user denied/i.test(message)) return "Signature request was cancelled in your wallet.";
    if (/insufficient/i.test(message)) return "Wallet doesn't have enough USDC.";
    return message;
}

const CHIP_STYLES = {
    request: {label: "→", className: "chip chip--neutral"},
    "status-402": {label: "402", className: "chip chip--amber"},
    wallet: {label: "✎", className: "chip chip--neutral"},
    signed: {label: "✓", className: "chip chip--green"},
    "status-200": {label: "200", className: "chip chip--green"},
    settled: {label: "⛓", className: "chip chip--green"},
    error: {label: "✕", className: "chip chip--red"},
};

function LogLine({entry}) {
    const style = CHIP_STYLES[entry.kind] ?? CHIP_STYLES.request;
    return (
        <div className="log-line">
            <span className={style.className}>{style.label}</span>
            <div className="log-line__body">
                <div className="log-line__text">{entry.text}</div>
                {entry.detail && <div className="log-line__detail">{entry.detail}</div>}
            </div>
        </div>
    );
}

function OutputBlock({result, endpointScheme, copied, onCopy}) {
    if (!result) return null;
    let displayText;
    if (typeof result === "object") {
        displayText = result.result !== undefined ? result.result : JSON.stringify(result, null, 2);
    } else {
        displayText = String(result);
    }
    return (
        <div className="output-block">
            <div className="output-block__header">
        <span className="output-block__label">
          {endpointScheme === "upto" ? "Generated — settled by usage" : "Response"}
        </span>
                {result.usage && (
                    <span className="output-block__meta">
            authorized {formatUsdc(result.usage.authorizedMaxAtomic)} · charged{" "}
                        {formatUsdc(result.usage.actualChargedAtomic)}
          </span>
                )}
                <button className={`copy-btn${copied ? " copy-btn--copied" : ""}`} onClick={onCopy}>
                    {copied ? "✓ Copied" : "Copy"}
                </button>
            </div>
            <div className="output-block__scroll">
                <pre className="output-block__pre">{displayText}</pre>
            </div>
        </div>
    );
}

function ParamsEditor({params, onChange}) {
    const addRow = () => onChange([...params, {key: "", value: "", enabled: true}]);
    const removeRow = (i) => onChange(params.filter((_, idx) => idx !== i));
    const updateRow = (i, field, val) => {
        const next = params.map((p, idx) => (idx === i ? {...p, [field]: val} : p));
        onChange(next);
    };
    return (
        <div className="params-editor">
            <div className="params-editor__header">
                <span className="params-editor__title">Query Params</span>
                <button className="params-add-btn" onClick={addRow}>+ Add</button>
            </div>
            {params.length === 0 && <div className="params-empty">No params yet. Click + Add to insert a row.</div>}
            {params.map((row, i) => (
                <div className="params-row" key={i}>
                    <input type="checkbox" className="params-check" checked={row.enabled}
                           onChange={(e) => updateRow(i, "enabled", e.target.checked)}/>
                    <input className="params-input" placeholder="Key" value={row.key}
                           onChange={(e) => updateRow(i, "key", e.target.value)}/>
                    <span className="params-eq">=</span>
                    <input className="params-input" placeholder="Value" value={row.value}
                           onChange={(e) => updateRow(i, "value", e.target.value)}/>
                    <button className="params-remove-btn" onClick={() => removeRow(i)}>✕</button>
                </div>
            ))}
        </div>
    );
}

function buildUrlWithParams(baseUrl, params) {
    const activeParams = params.filter((p) => p.enabled && p.key.trim());
    if (activeParams.length === 0) return baseUrl;
    try {
        const url = new URL(baseUrl);
        activeParams.forEach((p) => url.searchParams.set(p.key.trim(), p.value));
        return url.toString();
    } catch {
        const qs = activeParams
            .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
            .join("&");
        return baseUrl.includes("?") ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`;
    }
}

const SOL_LABELS = {phantom: "Phantom", metamask: "MetaMask", walletconnect: "WalletConnect"};

export default function App() {
    // Network selection: "evm" | "solana"
    const [network, setNetwork] = useState("evm");

    // EVM wallet state
    const [evmWallet, setEvmWallet] = useState(null);
    const [evmConnecting, setEvmConnecting] = useState(false);

    // Solana wallet state
    const [solWallet, setSolWallet] = useState(null); // { provider, pubkey, kind, adapter? }
    const [solConnecting, setSolConnecting] = useState(false);

    // Request state
    const [urlInput, setUrlInput] = useState(`${RESOURCE_URL}/api/quote`);
    const [method, setMethod] = useState("GET");
    const [params, setParams] = useState([]);
    const [activeTab, setActiveTab] = useState("params");
    const [isRequesting, setIsRequesting] = useState(false);
    const [log, setLog] = useState([]);
    const [result, setResult] = useState(null);
    const [detectedScheme, setDetectedScheme] = useState(null);
    const [settlement, setSettlement] = useState(null);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    const logRef = useRef(null);

    // --- EVM connect ----------------------------------------------------------
    const handleConnectEvm = useCallback(async () => {
        setEvmConnecting(true);
        setError(null);
        try {
            const {walletClient, address} = await connectEvmWallet();
            setEvmWallet({walletClient, address});
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setEvmConnecting(false);
        }
    }, []);

    // --- Solana connect -------------------------------------------------------
    const handleConnectSol = useCallback(async (kind) => {
        setSolConnecting(true);
        setError(null);
        try {
            const connectors = {
                phantom: connectPhantom,
                metamask: connectSolanaMetaMask,
                walletconnect: connectSolanaWalletConnect,
            };
            const conn = await connectors[kind]();
            setSolWallet({...conn, kind});
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setSolConnecting(false);
        }
    }, []);

    const handleDisconnectSol = useCallback(async () => {
        try {
            await solWallet?.adapter?.disconnect?.();
        } catch { /* ignore */
        }
        setSolWallet(null);
    }, [solWallet]);

    // --- Send request ---------------------------------------------------------
    const handleSend = useCallback(async () => {
        const isEvm = network === "evm";
        if (isEvm && !evmWallet) return;
        if (!isEvm && !solWallet) return;
        if (!urlInput.trim()) return;

        const rawUrl = urlInput.trim();
        const fullUrl = buildUrlWithParams(
            rawUrl.startsWith("http") ? rawUrl : `${RESOURCE_URL}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`,
            params
        );

        let path;
        try {
            path = new URL(fullUrl).pathname + new URL(fullUrl).search;
        } catch {
            path = fullUrl;
        }

        setDetectedScheme(null);
        setIsRequesting(true);
        setError(null);
        setSettlement(null);
        setResult(null);
        setCopied(false);

        const entries = [];
        const pushLog = (entry) => {
            entries.push({id: entries.length, ...entry});
            setLog([...entries]);
            setTimeout(() => logRef.current?.scrollTo({top: logRef.current.scrollHeight, behavior: "smooth"}), 50);
        };

        pushLog({kind: "request", text: `${method} ${path}`});

        const svmSigner = !isEvm && solWallet
            ? toSolanaSigner(solWallet.provider, solWallet.pubkey)
            : undefined;

        const {fetchWithPayment, httpClient} = createPaymentFetch({
            walletClient: isEvm ? evmWallet.walletClient : undefined,
            address: isEvm ? evmWallet.address : undefined,
            svmSigner,
            onEvent: (evt) => {
                if (evt.type === "payment-required") {
                    const r = evt.requirements;
                    if (r.scheme) setDetectedScheme(r.scheme);
                    pushLog({
                        kind: "status-402",
                        text: "402 Payment Required",
                        detail: `${r.scheme} · ${r.network} · ${formatUsdc(r.amount) ?? r.amount} → ${shorten(r.payTo)}`,
                    });
                    pushLog({
                        kind: "wallet",
                        text: isEvm
                            ? "Requesting signature in wallet (EIP-712)…"
                            : "Requesting Solana transaction signature…",
                    });
                } else if (evt.type === "payment-signed") {
                    pushLog({kind: "signed", text: "Payment authorization signed"});
                    pushLog({kind: "request", text: `${method} ${path}  (+ PAYMENT-SIGNATURE header)`});
                } else if (evt.type === "payment-failed") {
                    pushLog({kind: "error", text: `Payment failed: ${humanizeError(evt.error)}`});
                }
            },
        });

        try {
            const response = await fetchWithPayment(fullUrl, {method});
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(text || `Request failed with status ${response.status}`);
            }

            pushLog({kind: "status-200", text: "200 OK"});
            const data = await response.json();
            setResult(data);

            const settle = readSettlement(httpClient, response);
            if (settle) {
                setSettlement(settle);
                const explorerBase = isEvm
                    ? "https://sepolia.basescan.org/tx/"
                    : "https://solscan.io/tx/";
                pushLog({
                    kind: "settled",
                    text:
                        detectedScheme === "exact"
                            ? "Payment settled on-chain"
                            : "Payment settled on-chain (actual usage only)",
                    detail: settle.transaction ? `tx ${shorten(settle.transaction)}` : "confirmed by facilitator",
                });
                // store explorerBase for the link below
                settle._explorerBase = explorerBase;
            }
        } catch (err) {
            const message = humanizeError(err);
            pushLog({kind: "error", text: message});
            setError(message);
        } finally {
            setIsRequesting(false);
        }
    }, [network, evmWallet, solWallet, urlInput, method, params, detectedScheme]);

    const handleCopy = useCallback(() => {
        if (!result) return;
        const text =
            typeof result === "object" ? (result.result ?? JSON.stringify(result, null, 2)) : String(result);
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [result]);

    const previewUrl = params.some((p) => p.enabled && p.key.trim())
        ? buildUrlWithParams(urlInput, params)
        : null;

    const isEvm = network === "evm";
    const walletReady = isEvm ? !!evmWallet : !!solWallet;

    return (
        <div className="page">
            <header className="topbar">
                <div className="brand">
          <span className="brand__mark">
            <img src={logo} alt="Bejibun" width={32}/>
          </span>
                    <div>
                        <div className="brand__title">Bejibun x402 Playground</div>
                        <div className="brand__subtitle">A place for you to play with x402 protocol</div>
                    </div>
                </div>
                {isEvm ? (
                    evmWallet ? (
                        <div className="wallet-pill">
                            <span className="wallet-pill__dot"/>
                            {shorten(evmWallet.address)}
                        </div>
                    ) : (
                        <button className="btn btn--ghost" onClick={handleConnectEvm} disabled={evmConnecting}>
                            {evmConnecting ? "Connecting…" : "Connect EVM wallet"}
                        </button>
                    )
                ) : (
                    solWallet ? (
                        <div className="wallet-pill">
                            <span className="wallet-pill__dot"/>
                            {shorten(solWallet.pubkey)} · {SOL_LABELS[solWallet.kind] ?? solWallet.kind}
                        </div>
                    ) : null
                )}
            </header>

            <main className="layout">
                {/* LEFT: Request panel */}
                <section className="panel">
                    <div className="panel__header">
                        <span className="panel__eyebrow">Resources</span>
                        <h2>Send a payment request</h2>
                        <p className="panel__desc">
                            Enter any x402-protected endpoint. Choose your network, connect a wallet, and pay.
                        </p>
                    </div>

                    {/* Network selector */}
                    <div className="network-tabs">
                        <button
                            className={`network-tab${isEvm ? " network-tab--active" : ""}`}
                            onClick={() => {
                                setNetwork("evm");
                                setError(null);
                            }}
                        >
                            Base Sepolia (EVM)
                        </button>
                        <button
                            className={`network-tab${!isEvm ? " network-tab--active" : ""}`}
                            onClick={() => {
                                setNetwork("solana");
                                setError(null);
                            }}
                        >
                            Solana
                        </button>
                    </div>

                    {/* Wallet connect area */}
                    <div className="wallet-area">
                        {isEvm ? (
                            evmWallet ? (
                                <div className="wallet-connected">
                  <span className="wallet-pill wallet-pill--inline">
                    <span className="wallet-pill__dot"/>{shorten(evmWallet.address)}
                  </span>
                                    <button className="btn btn--ghost btn--sm"
                                            onClick={() => setEvmWallet(null)}>Disconnect
                                    </button>
                                </div>
                            ) : (
                                <button className="btn btn--ghost" onClick={handleConnectEvm} disabled={evmConnecting}>
                                    {evmConnecting ? "Connecting…" : "Connect EVM wallet (MetaMask / injected)"}
                                </button>
                            )
                        ) : (
                            solWallet ? (
                                <div className="wallet-connected">
                  <span className="wallet-pill wallet-pill--inline">
                    <span className="wallet-pill__dot"/>{shorten(solWallet.pubkey)} · {SOL_LABELS[solWallet.kind]}
                  </span>
                                    <button className="btn btn--ghost btn--sm"
                                            onClick={handleDisconnectSol}>Disconnect
                                    </button>
                                </div>
                            ) : (
                                <div className="sol-connect-row">
                                    <button className="btn btn--ghost" onClick={() => handleConnectSol("phantom")}
                                            disabled={solConnecting}>
                                        Phantom
                                    </button>
                                    <button className="btn btn--ghost" onClick={() => handleConnectSol("metamask")}
                                            disabled={solConnecting}>
                                        MetaMask (Solana)
                                    </button>
                                    <button className="btn btn--ghost" onClick={() => handleConnectSol("walletconnect")}
                                            disabled={solConnecting}>
                                        WalletConnect
                                    </button>
                                </div>
                            )
                        )}
                    </div>

                    <div className="request-card">
                        {/* Method + URL row */}
                        <div className="url-row">
                            <select className="method-select" value={method}
                                    onChange={(e) => setMethod(e.target.value)}>
                                {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <input
                                className="url-input"
                                type="text"
                                value={urlInput}
                                onChange={(e) => setUrlInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && walletReady && !isRequesting && handleSend()}
                                placeholder="https://api.example.com/endpoint"
                                spellCheck={false}
                                autoComplete="off"
                            />
                        </div>

                        {previewUrl && (
                            <div className="url-preview">
                                <span className="url-preview__label">Preview:</span>
                                <span className="url-preview__url">{previewUrl}</span>
                            </div>
                        )}

                        <div className="req-tabs">
                            <button
                                className={`req-tab${activeTab === "params" ? " req-tab--active" : ""}`}
                                onClick={() => setActiveTab("params")}
                            >
                                Params
                                {params.filter((p) => p.enabled && p.key.trim()).length > 0 && (
                                    <span className="req-tab__badge">
                    {params.filter((p) => p.enabled && p.key.trim()).length}
                  </span>
                                )}
                            </button>
                        </div>

                        {activeTab === "params" && <ParamsEditor params={params} onChange={setParams}/>}

                        <button
                            className="btn btn--primary send-btn"
                            onClick={handleSend}
                            disabled={!walletReady || isRequesting || !urlInput.trim()}
                        >
                            {isRequesting ? "Processing…" : "Send request & pay"}
                        </button>

                        {!walletReady && (
                            <p className="hint">
                                {isEvm ? "Connect an EVM wallet to send a payment." : "Connect a Solana wallet to send a payment."}
                            </p>
                        )}
                        {error && <div className="error-banner">{error}</div>}
                    </div>

                    <OutputBlock
                        result={result}
                        endpointScheme={detectedScheme}
                        copied={copied}
                        onCopy={handleCopy}
                    />

                    {settlement && (
                        <div className="settlement">
                            <div className="settlement__row">
                                <span>status</span>
                                <span>{settlement.success ? "settled" : "pending"}</span>
                            </div>
                            {settlement.transaction && (
                                <div className="settlement__row">
                                    <span>tx hash</span>
                                    <a
                                        href={`${settlement._explorerBase ?? "https://sepolia.basescan.org/tx/"}${settlement.transaction}`}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {shorten(settlement.transaction, 10, 8)}
                                    </a>
                                </div>
                            )}
                        </div>
                    )}

                    <p className="hint hint--muted">
                        {isEvm ? (
                            <>
                                Testnet funds:{" "}
                                <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">Base
                                    Sepolia ETH</a>
                                {" · "}
                                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle USDC
                                    faucet</a>.
                                {" "}Want <code>batch-settlement</code>?
                                See <code>scripts/batch-settlement-client.mjs</code>.
                            </>
                        ) : (
                            <>
                                Solana payments use mainnet USDC. Make sure your Solana wallet has USDC and SOL for
                                fees.
                                {" "}Requires <code>SOLANA_PAY_TO_ADDRESS</code> and CDP keys on the server.
                            </>
                        )}
                    </p>
                </section>

                {/* RIGHT: Log panel */}
                <section className="panel panel--log">
                    <div className="panel__header">
                        <span className="panel__eyebrow">HTTP exchange</span>
                        <h2>Live transcript</h2>
                    </div>
                    <div className="log" ref={logRef}>
                        {log.length === 0 && <div className="log__empty">Nothing sent yet.</div>}
                        {log.map((entry) => <LogLine key={entry.id} entry={entry}/>)}
                    </div>
                </section>
            </main>
        </div>
    );
}