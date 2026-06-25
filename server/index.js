import "dotenv/config";
import express from "express";
import cors from "cors";
import {paymentMiddleware, setSettlementOverrides, x402ResourceServer} from "@x402/express";
import {HTTPFacilitatorClient} from "@x402/core/server";
import {ExactEvmScheme} from "@x402/evm/exact/server";
import {UptoEvmScheme} from "@x402/evm/upto/server";
import {BatchSettlementEvmScheme} from "@x402/evm/batch-settlement/server";
import {ExactSvmScheme} from "@x402/svm/exact/server";
import {facilitator} from "@coinbase/x402";

const PORT = Number(process.env.PORT) || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS;
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO_ADDRESS;
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

// CAIP-2 network identifiers
const EVM_NETWORK = "eip155:8453"; // Base Sepolia testnet
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet

if (!PAY_TO) {
    console.warn(
        "\n⚠️  PAY_TO_ADDRESS is not set. Copy server/.env.example to server/.env and add your Base wallet address.\n"
    );
}
if (!SOLANA_PAY_TO) {
    console.warn(
        "\n⚠️  SOLANA_PAY_TO_ADDRESS is not set. Add your Solana wallet address to server/.env for SVM support.\n"
    );
}

// Use CDP facilitator when CDP keys are present (required for Solana mainnet
// settlement), otherwise fall back to the public testnet facilitator for EVM.
const facilitatorClient = (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)
    ? new HTTPFacilitatorClient(facilitator)
    : new HTTPFacilitatorClient({url: FACILITATOR_URL});

const app = express();
app.use(express.json());

// Expose x402 payment headers to the browser (required for the client to read
// payment requirements and settlement receipts across origins).
app.use(
    cors({
        origin: CLIENT_ORIGIN,
        exposedHeaders: [
            "PAYMENT-REQUIRED",
            "PAYMENT-RESPONSE",
            "X-PAYMENT-RESPONSE",
            "WWW-Authenticate",
            "EXTENSION-RESPONSES",
        ],
        allowedHeaders: [
            "Content-Type",
            "PAYMENT-SIGNATURE",
            "X-PAYMENT",
            "Access-Control-Expose-Headers",
        ],
    })
);

// Register all schemes: EVM (exact, upto, batch-settlement) + SVM (exact).
const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(EVM_NETWORK, new ExactEvmScheme())
    .register(EVM_NETWORK, new UptoEvmScheme())
    .register(EVM_NETWORK, new BatchSettlementEvmScheme())
    .register(SOLANA_NETWORK, new ExactSvmScheme());

// --- Free route ---------------------------------------------------------
app.get("/api/health", (_req, res) => {
    res.json({status: "ok", evmNetwork: EVM_NETWORK, solanaNetwork: SOLANA_NETWORK, payTo: PAY_TO ?? null});
});

// --- Paid routes -----------------------------------------------------------
app.use(
    paymentMiddleware(
        {
            // exact (EVM): fixed price, paid in full every call.
            "GET /api/quote": {
                accepts: [
                    {
                        scheme: "exact",
                        price: "$0.001",
                        network: EVM_NETWORK,
                        payTo: PAY_TO,
                    },
                    {
                        scheme: "exact",
                        price: "$0.001",
                        network: SOLANA_NETWORK,
                        payTo: SOLANA_PAY_TO,
                    },
                ],
                description: "A single random market quote",
                mimeType: "application/json",
            },

            // upto (EVM only): client authorizes a maximum, server settles only what it used.
            "GET /api/generate": {
                accepts: {
                    scheme: "upto",
                    price: "$0.05",
                    network: EVM_NETWORK,
                    payTo: PAY_TO,
                },
                description: "AI text generation — billed by tokens actually generated",
                mimeType: "application/json",
            },

            // batch-settlement (EVM only): off-chain vouchers redeemed in one on-chain tx.
            "GET /api/tick": {
                accepts: {
                    scheme: "batch-settlement",
                    price: "$0.0005",
                    network: EVM_NETWORK,
                    payTo: PAY_TO,
                },
                description: "One metered tick, redeemed later as part of a batch",
                mimeType: "application/json",
            },
        },
        resourceServer
    )
);

const QUOTES = [
    "Buy low, sell high — easier said than done.",
    "The trend is your friend, until it ends.",
    "Time in the market beats timing the market.",
    "Markets can stay irrational longer than you can stay solvent.",
    "The four most dangerous words: this time it's different.",
];

app.get("/api/quote", (_req, res) => {
    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    res.json({quote, paidAt: new Date().toISOString()});
});

app.get("/api/generate", (_req, res) => {
    const maxAmountAtomic = 50_000;
    const actualUsage = Math.floor(Math.random() * (maxAmountAtomic + 1));
    const tokens = Math.floor(actualUsage / 50) + 10;

    setSettlementOverrides(res, {amount: String(actualUsage)});

    res.json({
        result: `Here is your generated text (${tokens} tokens)...`,
        usage: {
            authorizedMaxAtomic: String(maxAmountAtomic),
            actualChargedAtomic: String(actualUsage),
            tokens,
        },
    });
});

app.get("/api/tick", (_req, res) => {
    res.json({tick: Date.now(), note: "Settled later, batched with other ticks from this channel."});
});

app.listen(PORT, () => {
    console.log(`💸 x402 resource server listening on http://localhost:${PORT}`);
    console.log(`   Free:   GET /api/health`);
    console.log(`   exact:  GET /api/quote     ($0.001 EVM or Solana USDC)`);
    console.log(`   upto:   GET /api/generate  (up to $0.05 EVM, settled by usage)`);
    console.log(`   batch:  GET /api/tick      (up to $0.0005 EVM, redeemed in batches)`);
});