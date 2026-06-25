import {createWalletClient, custom} from "viem";
import {baseSepolia} from "viem/chains";

/** Returns window.ethereum or throws a friendly error if no wallet is injected. */
function getInjectedProvider() {
    if (typeof window === "undefined" || !window.ethereum) {
        throw new Error(
            "No EVM wallet found. Install MetaMask (or another injected wallet) and reload."
        );
    }
    return window.ethereum;
}

/**
 * Connects to the user's injected EVM wallet and switches to Base Sepolia.
 * Returns a viem WalletClient plus the connected address.
 */
export async function connectEvmWallet() {
    const provider = getInjectedProvider();

    const walletClient = createWalletClient({
        chain: baseSepolia,
        transport: custom(provider),
    });

    const [address] = await walletClient.requestAddresses();

    try {
        await walletClient.switchChain({id: 8453});
    } catch (err) {
        // const code = err?.code ?? err?.cause?.code;
        // if (code === 4902) {
        //     await provider.request({
        //         method: "wallet_addEthereumChain",
        //         params: [
        //             {
        //                 chainId: 8453,
        //                 chainName: "Base Sepolia",
        //                 nativeCurrency: {name: "Sepolia Ether", symbol: "ETH", decimals: 18},
        //                 rpcUrls: ["https://sepolia.base.org"],
        //                 blockExplorerUrls: ["https://sepolia.basescan.org"],
        //             },
        //         ],
        //     });
        // } else {
        //     throw err;
        // }
    }

    return {walletClient, address};
}

// Keep the old name as an alias for backward compatibility.
export const connectWallet = connectEvmWallet;